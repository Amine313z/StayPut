import type {
  DiscordChannelChoice,
  DiscordServerStatus,
  ExpiringLink,
  IntegrationsStatus,
  MemberTelegramStatus,
  TelegramGroupStatus,
} from '@stayput/core';
import type { WhopClient } from '@stayput/whop';
import type { CryptoKey } from 'jose';
import { withUser, type Db, type TransactionalDb } from './db';
import { discordInstallUrl, isSnowflake, type DiscordChannel, type DiscordClient } from './discord';
import type { Config } from './env';
import { DISCORD_INSTALL_TTL_SECONDS, sign } from './session';
import {
  TELEGRAM_LINK_TTL_SECONDS,
  botText,
  botTextFor,
  type BotLanguage,
  readTelegramMemberToken,
  readTelegramStartToken,
  telegramAction,
  telegramMemberLink,
  telegramMemberToken,
  telegramStartLink,
  telegramStartToken,
  telegramWebhookSecret,
  type TelegramClient,
} from './telegram';

/**
 * The activity sources beside Whop, for the routes of app.ts: Discord (SPEC Phase 2, 5) and
 * Telegram (decision of 2026-10-01). What the creator view reads goes through RLS (withUser);
 * what changes a connection runs as the Worker, after the route checked the user with Whop.
 */

/** Where Discord sends the creator back once the bot is added (declared on the Discord app). */
export const DISCORD_CALLBACK_PATH = '/auth/discord/callback';
/** Where Telegram sends the updates of the bot's groups. */
export const TELEGRAM_WEBHOOK_PATH = '/webhooks/telegram';

export interface LinkContext {
  config: Config;
  /** The Worker's own address (https://…): links come back to it. */
  origin: string;
  now: Date;
  discord: DiscordClient | null;
  telegram: TelegramClient | null;
  /** Signs the `state` of Discord's page; null without the Whop API key. */
  signingKey: CryptoKey | null;
  /** The language of the creator's StayPut: the bot answers the group in it. */
  language: BotLanguage | null;
}

/** Everything the creator view shows of Discord and Telegram, with the links to connect them. */
export async function readIntegrations(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  links: LinkContext,
): Promise<IntegrationsStatus> {
  const [stored, discordInstall, telegram] = await Promise.all([
    readConnections(db, userId, companyId),
    discordInstallLink(companyId, userId, links),
    telegramGroupLink(companyId, links),
  ]);
  return {
    discord: {
      available: discordAvailable(links.config),
      install: discordInstall,
      servers: stored.servers,
      linkedMembers: stored.linked.discord,
      unlinkedAuthors: stored.unlinked.discord,
    },
    telegram: {
      available: links.config.telegram !== null,
      addToGroup: telegram?.link ?? null,
      readsAllMessages: telegram?.readsAllMessages ?? false,
      groups: stored.groups,
      linkedMembers: stored.linked.telegram,
      unlinkedAuthors: stored.unlinked.telegram,
    },
    whopAppId: links.config.appId,
  };
}

/** Adding the bot to a server takes its token and the application's client secret. */
export function discordAvailable(config: Config): boolean {
  return config.discord !== null && config.discord.clientSecret !== null;
}

async function readConnections(db: TransactionalDb, userId: string, companyId: string) {
  return withUser(db, userId, async (tx) => {
    const guilds = await tx.query<{
      guild_id: string;
      name: string | null;
      channel_ids: string[];
      connected_at: Date | string;
    }>(
      `select guild_id, name, to_jsonb(channel_ids) as channel_ids, connected_at
         from stayput.discord_guilds where company_id = $1 order by connected_at, guild_id`,
      [companyId],
    );
    const streams = await tx.query<{
      stream: string;
      backfill_done: boolean;
      last_pass_at: Date | string | null;
      last_error: string | null;
    }>(
      `select stream, backfill_done, last_pass_at, last_error from stayput.sync_state
        where company_id = $1 and stream like 'discord_messages:%'`,
      [companyId],
    );
    const chats = await tx.query<{
      chat_id: string;
      title: string | null;
      connected_at: Date | string;
      left_at: Date | string | null;
      last_message_at: Date | string | null;
    }>(
      `select chat_id, title, connected_at, left_at, last_message_at from stayput.telegram_chats
        where company_id = $1 order by connected_at, chat_id`,
      [companyId],
    );
    const [linked] = await tx.query<{ discord: number; telegram: number }>(
      `select count(*) filter (where discord_user_id is not null)::int as discord,
              count(*) filter (where telegram_user_id is not null)::int as telegram
         from stayput.members where company_id = $1 and status = 'joined'`,
      [companyId],
    );
    const unlinked = await tx.query<{ platform: string; accounts: number }>(
      'select platform, accounts from stayput.unlinked_authors($1)',
      [companyId],
    );
    const byStream = new Map(streams.map((s) => [s.stream, s]));
    const servers: DiscordServerStatus[] = guilds.map((g) => ({
      guildId: g.guild_id,
      name: g.name,
      connectedAt: iso(g.connected_at) ?? '',
      channels: g.channel_ids.map((id) => {
        const state = byStream.get(`discord_messages:${id}`);
        return {
          id,
          backfillDone: state?.backfill_done ?? false,
          lastReadAt: iso(state?.last_pass_at ?? null),
          error: state?.last_error ?? null,
        };
      }),
    }));
    const groups: TelegramGroupStatus[] = chats.map((c) => ({
      chatId: c.chat_id,
      title: c.title,
      connectedAt: iso(c.connected_at) ?? '',
      active: c.left_at === null,
      lastMessageAt: iso(c.last_message_at),
    }));
    const count = (platform: string) => unlinked.find((u) => u.platform === platform)?.accounts;
    return {
      servers,
      groups,
      linked: { discord: linked?.discord ?? 0, telegram: linked?.telegram ?? 0 },
      unlinked: { discord: count('discord') ?? 0, telegram: count('telegram') ?? 0 },
    };
  });
}

/** Discord's page that adds the bot to a server for this company; null when unavailable. */
async function discordInstallLink(
  companyId: string,
  userId: string,
  links: LinkContext,
): Promise<ExpiringLink | null> {
  if (!discordAvailable(links.config) || !links.discord || !links.signingKey) return null;
  try {
    const exp = Math.floor(links.now.getTime() / 1000) + DISCORD_INSTALL_TTL_SECONDS;
    const state = await sign(
      { purpose: 'discord-install', companyId, userId, env: links.config.whopEnv, exp },
      links.signingKey,
    );
    const { id } = await links.discord.application();
    return {
      url: discordInstallUrl({
        applicationId: id,
        redirectUri: `${links.origin}${DISCORD_CALLBACK_PATH}`,
        state,
      }),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  } catch (error) {
    console.warn('Discord install link unavailable:', describe(error));
    return null;
  }
}

/** Telegram's link that adds the bot to a group for this company; null when unavailable. */
async function telegramGroupLink(
  companyId: string,
  links: LinkContext,
): Promise<{ link: ExpiringLink; readsAllMessages: boolean } | null> {
  const token = links.config.telegram?.botToken;
  if (!token || !links.telegram) return null;
  try {
    const bot = await links.telegram.bot();
    await ensureTelegramWebhook(links.telegram, links.origin, token);
    const exp = Math.floor(links.now.getTime() / 1000) + TELEGRAM_LINK_TTL_SECONDS;
    return {
      link: {
        url: telegramStartLink(
          bot.username,
          await telegramStartToken(companyId, exp, token, links.language),
        ),
        expiresAt: new Date(exp * 1000).toISOString(),
      },
      readsAllMessages: bot.readsAllMessages,
    };
  } catch (error) {
    console.warn('Telegram link unavailable:', describe(error));
    return null;
  }
}

const webhooksSet = new WeakMap<TelegramClient, string>();

/**
 * Tells Telegram where to send the bot's updates, once per client (per isolate): the first link
 * asked for sets it up, with the address the Worker is reached at (no setting to keep in sync).
 */
export async function ensureTelegramWebhook(
  telegram: TelegramClient,
  origin: string,
  botToken: string,
): Promise<void> {
  const url = `${origin}${TELEGRAM_WEBHOOK_PATH}`;
  if (webhooksSet.get(telegram) === url) return;
  await telegram.setWebhook(url, await telegramWebhookSecret(botToken));
  webhooksSet.set(telegram, url);
}

/**
 * The names of a server's channels as Discord just listed them, kept for the dashboards (0033):
 * Integrations › Discord names its channels without asking Discord on the way.
 */
export async function noteChannelNames(
  db: Db,
  companyId: string,
  guildId: string,
  channels: readonly DiscordChannel[],
  now: Date,
): Promise<void> {
  await db.query('select stayput.note_discord_channels($1, $2, $3::text::jsonb, $4::timestamptz)', [
    companyId,
    guildId,
    JSON.stringify(channels.map((c) => ({ id: c.id, name: c.name, category: c.category }))),
    now.toISOString(),
  ]);
}

/** The channels of a connected server, with the ones the company follows; null if not its. */
export async function readDiscordChannels(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  guildId: string,
  discord: DiscordClient,
  now: Date,
): Promise<DiscordChannelChoice[] | null> {
  const followed = await followedChannels(db, userId, companyId, guildId);
  if (!followed) return null;
  const channels = await discord.guildChannels(guildId);
  await noteChannelNames(db, companyId, guildId, channels, now);
  return channels.map((c) => ({ ...c, followed: followed.has(c.id) }));
}

async function followedChannels(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  guildId: string,
): Promise<Set<string> | null> {
  if (!isSnowflake(guildId)) return null;
  const [guild] = await withUser(db, userId, (tx) =>
    tx.query<{ channel_ids: string[] }>(
      `select to_jsonb(channel_ids) as channel_ids from stayput.discord_guilds
        where guild_id = $1 and company_id = $2`,
      [guildId, companyId],
    ),
  );
  return guild ? new Set(guild.channel_ids) : null;
}

/**
 * The channels the company follows on its server, among the readable channels of that server
 * only (a channel id of another server is ignored). Null when the server is not the company's.
 */
export async function chooseDiscordChannels(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  guildId: string,
  channelIds: readonly string[],
  discord: DiscordClient,
  now: Date,
): Promise<DiscordChannelChoice[] | null> {
  if (!(await followedChannels(db, userId, companyId, guildId))) return null;
  const channels = await discord.guildChannels(guildId);
  await noteChannelNames(db, companyId, guildId, channels, now);
  const wanted = new Set(channelIds);
  const chosen = channels.filter((c) => c.readable && wanted.has(c.id)).map((c) => c.id);
  await db.query('select stayput.set_discord_channels($1, $2, $3)', [
    companyId,
    guildId,
    chosen.join(','),
  ]);
  const followed = new Set(chosen);
  return channels.map((c) => ({ ...c, followed: followed.has(c.id) }));
}

/**
 * Back from Discord: the server the bot was added to joins the company. On a server new to the
 * company, every channel the bot can read is followed; the creator narrows it down afterwards.
 */
export async function connectDiscordServer(
  db: Db,
  discord: DiscordClient,
  input: { companyId: string; userId: string; code: string; redirectUri: string; now: Date },
): Promise<{ guildId: string; name: string | null; followed: number }> {
  const { guildId, guildName } = await discord.exchangeCode(input.code, input.redirectUri);
  const [row] = await db.query<{ followed: number }>(
    'select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz) as followed',
    [input.companyId, guildId, guildName, input.userId, input.now.toISOString()],
  );
  let followed = row?.followed ?? 0;
  const channels = await discord.guildChannels(guildId);
  await noteChannelNames(db, input.companyId, guildId, channels, input.now);
  if (followed === 0) {
    const readable = channels.filter((c) => c.readable);
    const [set] = await db.query<{ n: number }>(
      'select stayput.set_discord_channels($1, $2, $3) as n',
      [input.companyId, guildId, readable.map((c) => c.id).join(',')],
    );
    followed = set?.n ?? 0;
  }
  return { guildId, name: guildName, followed };
}

/** The company stops reading a server; the bot leaves it. False when it was not the company's. */
export async function disconnectDiscordServer(
  db: Db,
  discord: DiscordClient | null,
  companyId: string,
  guildId: string,
): Promise<boolean> {
  if (!isSnowflake(guildId)) return false;
  const [row] = await db.query<{ gone: boolean }>(
    'select stayput.disconnect_discord_guild($1, $2) as gone',
    [companyId, guildId],
  );
  if (!row?.gone) return false;
  await discord?.leaveGuild(guildId).catch((error: unknown) => {
    console.warn(`The bot could not leave Discord server ${guildId}:`, describe(error));
  });
  return true;
}

/** The company stops counting a Telegram group; the bot leaves it. */
export async function disconnectTelegramGroup(
  db: Db,
  telegram: TelegramClient | null,
  companyId: string,
  chatId: string,
): Promise<boolean> {
  if (!/^-?[0-9]{1,20}$/.test(chatId)) return false;
  const [row] = await db.query<{ gone: boolean }>(
    'select stayput.disconnect_telegram_chat($1, $2) as gone',
    [companyId, chatId],
  );
  if (!row?.gone) return false;
  await telegram?.leaveChat(chatId).catch((error: unknown) => {
    console.warn(`The bot could not leave Telegram group ${chatId}:`, describe(error));
  });
  return true;
}

/** What the bot does after an update was filed: a reply, and leaving a group it cannot serve. */
export interface TelegramFollowUp {
  reply?: { chatId: string; text: string };
  leave?: string;
}

/** A Telegram update into the database: group links, messages, the bot's own membership. */
export async function fileTelegramUpdate(
  db: Db,
  botToken: string,
  update: unknown,
  now: Date,
  {
    botUsername = null,
    memberSpace = false,
  }: { botUsername?: string | null; memberSpace?: boolean } = {},
): Promise<TelegramFollowUp> {
  const action = telegramAction(update, { botUsername });
  const nowSeconds = Math.floor(now.getTime() / 1000);
  switch (action.kind) {
    case 'message':
      if (action.topicId && action.topicName) {
        await db.query('select stayput.note_telegram_topic($1, $2, $3, $4::timestamptz)', [
          action.chatId,
          action.topicId,
          action.topicName,
          action.at.toISOString(),
        ]);
      }
      await db.query(
        'select stayput.record_telegram_message($1, $2, $3, $4::timestamptz, $5, $6, $7)',
        [
          action.chatId,
          action.fromId,
          action.messageId,
          action.at.toISOString(),
          action.name,
          action.username,
          action.topicId,
        ],
      );
      return {};
    case 'topic':
      await db.query('select stayput.note_telegram_topic($1, $2, $3, $4::timestamptz)', [
        action.chatId,
        action.topicId,
        action.name,
        action.at.toISOString(),
      ]);
      return {};
    case 'link': {
      const link = await readTelegramStartToken(action.token, nowSeconds, botToken);
      // The creator's StayPut language first: Telegram does not always say theirs.
      const language = link.language ?? action.language;
      if (!link.companyId) {
        return {
          reply: { chatId: action.chatId, text: botText('groupLinkExpired', language) },
          leave: action.chatId,
        };
      }
      await db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
        link.companyId,
        action.chatId,
        action.title,
        now.toISOString(),
      ]);
      return {
        reply: { chatId: action.chatId, text: botTextFor('groupLinked', language, memberSpace) },
      };
    }
    case 'people':
      await db.query(
        'select stayput.telegram_people($1, $2::text::jsonb, $3::text::jsonb, $4::timestamptz)',
        [
          action.chatId,
          JSON.stringify(action.joined),
          JSON.stringify(action.left),
          action.at.toISOString(),
        ],
      );
      return {};
    case 'membership':
      await db.query('select stayput.telegram_chat_membership($1, $2, $3::timestamptz)', [
        action.chatId,
        action.present,
        now.toISOString(),
      ]);
      return {};
    case 'migrate':
      await db.query('select stayput.migrate_telegram_chat($1, $2)', [
        action.fromChatId,
        action.toChatId,
      ]);
      return {};
    case 'private_start': {
      const read = action.token
        ? await readTelegramMemberToken(action.token, nowSeconds, botToken)
        : null;
      const language = read?.language ?? action.language;
      const member = read?.member ?? null;
      if (!member) {
        const text =
          action.token && memberSpace
            ? botText('memberLinkInvalid', language)
            : botTextFor('help', language, memberSpace);
        return { reply: { chatId: action.chatId, text } };
      }
      const [row] = await db.query<{ status: string }>(
        'select stayput.link_telegram_member($1, $2, $3, $4::timestamptz) as status',
        [member.companyId, member.userId, action.fromId, now.toISOString()],
      );
      const text = botText(row?.status === 'linked' ? 'memberLinked' : 'memberUnknown', language);
      return { reply: { chatId: action.chatId, text } };
    }
    case 'ignore':
      return {};
  }
}

const experienceCompanies = new Map<string, string>();

/** The company an experience belongs to (Whop never moves one), remembered per isolate. */
export async function companyOfExperience(
  whop: WhopClient,
  experienceId: string,
): Promise<string | null> {
  const known = experienceCompanies.get(experienceId);
  if (known) return known;
  const experience = await whop.request<{ company?: { id?: unknown } } | undefined>(
    'GET',
    `/experiences/${encodeURIComponent(experienceId)}`,
  );
  const companyId = experience?.company?.id;
  if (typeof companyId !== 'string' || !/^biz_[A-Za-z0-9]+$/.test(companyId)) return null;
  if (experienceCompanies.size >= 1_000) experienceCompanies.clear();
  experienceCompanies.set(experienceId, companyId);
  return companyId;
}

/** Whether a member can link their Telegram account, has done so, and the link to do it. */
export async function readMemberTelegram(
  db: Db,
  input: {
    companyId: string;
    userId: string;
    now: Date;
    config: Config;
    telegram: TelegramClient | null;
    origin: string;
    /** The language of the member's StayPut: the bot answers them in it. */
    language?: BotLanguage | null;
  },
): Promise<MemberTelegramStatus> {
  const [row] = await db.query<{ groups: boolean; linked: boolean }>(
    `select exists (select 1 from stayput.telegram_chats
                     where company_id = $1 and left_at is null) as groups,
            exists (select 1 from stayput.members
                     where company_id = $1 and user_id = $2
                       and telegram_user_id is not null) as linked`,
    [input.companyId, input.userId],
  );
  const token = input.config.telegram?.botToken;
  const available = Boolean(row?.groups && token && input.telegram);
  let link: ExpiringLink | null = null;
  if (available && token && input.telegram) {
    try {
      const bot = await input.telegram.bot();
      await ensureTelegramWebhook(input.telegram, input.origin, token);
      const exp = Math.floor(input.now.getTime() / 1000) + TELEGRAM_LINK_TTL_SECONDS;
      link = {
        url: telegramMemberLink(
          bot.username,
          await telegramMemberToken(
            input.companyId,
            input.userId,
            exp,
            token,
            input.language ?? null,
          ),
        ),
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    } catch (error) {
      console.warn('Telegram member link unavailable:', describe(error));
    }
  }
  return {
    available,
    linked: row?.linked ?? false,
    link,
    whopAppId: input.config.appId,
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
