import type {
  AccountPlatform,
  AccountsView,
  PeopleView,
  PlatformActivityView,
} from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';
import type { DiscordClient } from './discord';
import type { TelegramClient } from './telegram';

/**
 * The Discord and Telegram accounts StayPut saw writing, and the members they are (decision of
 * 2026-10-01): an account joins its member through the member's Whop profile (Discord), the
 * member's own link (Telegram), its name (StayPut, when one member surely matches) or the
 * creator's choice. Only the accounts' names are kept for that, never what they wrote.
 */

/** Names asked of Discord or Telegram per request: each is a call. */
export const NAMES_PER_REQUEST = 10;

export interface AccountClients {
  discord: DiscordClient | null;
  telegram: TelegramClient | null;
}

/** The accounts a creator sees (ask for the names StayPut lacks first: `fillNames`). */
export async function accountsView(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<AccountsView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: AccountsView | null }>('select stayput.platform_accounts_view($1) as view', [
      companyId,
    ]),
  );
  return row?.view ?? null;
}

/**
 * Accounts seen before StayPut kept names, or whose message came without them: Discord tells a
 * user's names, Telegram those of someone in one of the bot's groups. Noting them may tie the
 * account to its member by name.
 */
export async function fillNames(db: Db, companyId: string, clients: AccountClients): Promise<void> {
  const missing = await db.query<{
    platform: AccountPlatform;
    account_id: string;
    chat_id: string | null;
  }>('select platform, account_id, chat_id from stayput.accounts_without_names($1, $2)', [
    companyId,
    NAMES_PER_REQUEST,
  ]);
  for (const account of missing) {
    let names: { name: string | null; username: string | null } | null = null;
    try {
      if (account.platform === 'discord' && clients.discord) {
        names = await clients.discord.user(account.account_id);
      } else if (account.platform === 'telegram' && clients.telegram && account.chat_id) {
        names = await clients.telegram.chatMember(account.chat_id, account.account_id);
      }
    } catch (error) {
      // Someone who left the group, an outage: the names wait for the next message.
      console.error('Account names not read:', error instanceof Error ? error.message : error);
      continue;
    }
    if (!names?.name && !names?.username) continue;
    await db.query('select stayput.note_account($1, $2, $3, $4, $5, null)', [
      companyId,
      account.platform,
      account.account_id,
      names.name,
      names.username,
    ]);
  }
}

/** What StayPut saw on Discord and Telegram over 30 days; null for someone not of the team. */
export async function readPlatformActivity(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<PlatformActivityView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: PlatformActivityView | null }>(
      'select stayput.platform_activity($1, $2::timestamptz) as view',
      [companyId, now.toISOString()],
    ),
  );
  return row?.view ?? null;
}

/** How long a server's or a group's head count holds before it is read again. */
export const HEAD_COUNT_MAX_AGE_SECONDS = 10 * 60;
/** Servers and groups counted again per request at most: each is a call or two. */
const HEAD_COUNTS_PER_REQUEST = 4;

/**
 * Everyone StayPut knows on the company's Discord servers and Telegram groups (the founder,
 * 2026-10-01: « je veux qu'on puisse voir les membres »); how many people the servers and groups
 * have, and the groups' administrators (Telegram lists no one else), are read by `countPlaces`.
 */
export async function peopleView(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<PeopleView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: PeopleView | null }>(
      'select stayput.platform_people($1, $2::timestamptz) as view',
      [companyId, now.toISOString()],
    ),
  );
  return row?.view ?? null;
}

/**
 * How many people each server and group has, read again when older than 10 minutes. A failure
 * keeps the last count, stamped, so that a group the bot can no longer read is not asked again
 * at each reading.
 */
export async function countPlaces(
  db: Db,
  companyId: string,
  clients: AccountClients,
  now: Date,
): Promise<void> {
  const before = new Date(now.getTime() - HEAD_COUNT_MAX_AGE_SECONDS * 1000).toISOString();
  const places = await db.query<{ platform: AccountPlatform; place: string }>(
    `select 'discord' as platform, guild_id as place from stayput.discord_guilds
      where company_id = $1 and (member_count_at is null or member_count_at < $2::timestamptz)
     union all
     select 'telegram', chat_id from stayput.telegram_chats
      where company_id = $1 and left_at is null
        and (member_count_at is null or member_count_at < $2::timestamptz)
     order by 1, 2
     limit ${HEAD_COUNTS_PER_REQUEST}`,
    [companyId, before],
  );
  const at = now.toISOString();
  for (const { platform, place } of places) {
    if (platform === 'discord' && clients.discord) {
      const count = await clients.discord.memberCount(place).catch((error: unknown) => {
        console.error('Discord head count not read:', describe(error));
        return null;
      });
      await db.query('select stayput.discord_guild_count($1, $2, $3::timestamptz)', [
        place,
        count,
        at,
      ]);
    } else if (platform === 'telegram' && clients.telegram) {
      const telegram = clients.telegram;
      const [count, admins] = await Promise.all([
        telegram.memberCount(place),
        telegram.administrators(place),
      ]).catch((error: unknown) => {
        console.error('Telegram head count not read:', describe(error));
        return [null, []] as const;
      });
      await db.query(
        'select stayput.telegram_chat_people($1, $2, $3::text::jsonb, $4::timestamptz)',
        [place, count, JSON.stringify(admins), at],
      );
    }
  }
}

/** The account a creator names in a request, when it is one. */
export function accountOf(body: unknown): { platform: AccountPlatform; accountId: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { platform, accountId } = body as Record<string, unknown>;
  if (typeof accountId !== 'string') return null;
  if (platform === 'discord' && /^[0-9]{5,25}$/.test(accountId)) {
    return { platform, accountId };
  }
  if (platform === 'telegram' && /^[0-9]{1,20}$/.test(accountId)) {
    return { platform, accountId };
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
