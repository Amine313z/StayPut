import { base64Url } from '@stayput/whop';

/**
 * Telegram, an optional activity source (decision of 2026-10-01). StayPut has one bot; a creator
 * adds it to their group with a link StayPut makes for their company, and Telegram then sends
 * every message of the group to the Worker (POST /webhooks/telegram). Telegram lets no bot read
 * a group's past: activity counts from the bot's arrival on. Only the author and the date are
 * kept. Whop shows no one's Telegram account to apps: a member links theirs by opening the bot
 * with a link StayPut signed for them (the member view).
 */

export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/** A link to add the bot to a group, or to link one's account, is valid for an hour. */
export const TELEGRAM_LINK_TTL_SECONDS = 60 * 60;

/** The languages the bot speaks. */
export type BotLanguage = 'fr' | 'en';

/** The language StayPut's interface sent (`?lang=`), when the bot speaks it. */
export function botLanguage(value: unknown): BotLanguage | null {
  return value === 'fr' || value === 'en' ? value : null;
}

/** Telegram's limit on the parameter of a `?start=` or `?startgroup=` link. */
const START_PARAMETER_MAX = 64;

export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TelegramBot {
  username: string;
  /**
   * Privacy mode is off (BotFather → /setprivacy → Disable): the bot receives every message of
   * its groups, not only the commands meant for it.
   */
  readsAllMessages: boolean;
}

/** Someone on Telegram, as StayPut keeps them: an id and names, never a bot. */
export interface TelegramPerson {
  id: string;
  name: string | null;
  username: string | null;
}

export interface TelegramClient {
  /** The bot, read once per isolate (getMe). */
  bot(): Promise<TelegramBot>;
  /** The bot leaves a group (the creator disconnected it). */
  leaveChat(chatId: string): Promise<void>;
  /** Where Telegram sends the updates, with the secret it repeats in a header. */
  setWebhook(url: string, secret: string): Promise<void>;
  /** A short message from the bot (a group was linked, an account was linked). */
  sendMessage(chatId: string, text: string): Promise<void>;
  /** The names of someone in a group the bot is in (getChatMember). */
  chatMember(
    chatId: string,
    userId: string,
  ): Promise<{ name: string | null; username: string | null }>;
  /** How many people a group has (getChatMemberCount). */
  memberCount(chatId: string): Promise<number | null>;
  /** A group's administrators who are people (getChatAdministrators): the only list it gives. */
  administrators(chatId: string): Promise<TelegramPerson[]>;
}

export function createTelegramClient(options: { botToken: string; fetch?: Fetch }): TelegramClient {
  const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  let bot: Promise<TelegramBot> | null = null;

  async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await send(`${TELEGRAM_API_BASE_URL}/bot${options.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (cause) {
      // The URL holds the token: never repeat it, only the method.
      throw new TelegramApiError(0, `${method}: ${cause instanceof Error ? cause.name : 'error'}`);
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
      description?: unknown;
    } | null;
    if (!response.ok || !body?.ok) {
      const description = typeof body?.description === 'string' ? body.description : '';
      throw new TelegramApiError(response.status, `${method}: ${response.status} ${description}`);
    }
    return body.result;
  }

  return {
    bot() {
      bot ??= call('getMe').then((result) => {
        const me = (result ?? {}) as { username?: unknown; can_read_all_group_messages?: unknown };
        if (typeof me.username !== 'string') {
          throw new TelegramApiError(200, 'getMe: no username');
        }
        return { username: me.username, readsAllMessages: me.can_read_all_group_messages === true };
      });
      bot.catch(() => {
        bot = null;
      });
      return bot;
    },
    async leaveChat(chatId) {
      await call('leaveChat', { chat_id: chatId });
    },
    async setWebhook(url, secret) {
      await call('setWebhook', {
        url,
        secret_token: secret,
        // chat_member: who joins and leaves a group, sent to a bot that administers it.
        allowed_updates: ['message', 'my_chat_member', 'chat_member'],
      });
    },
    async sendMessage(chatId, text) {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
      });
    },
    async chatMember(chatId, userId) {
      const result = (await call('getChatMember', {
        chat_id: chatId,
        user_id: Number(userId),
      })) as {
        user?: { first_name?: unknown; last_name?: unknown; username?: unknown };
      } | null;
      const text = (value: unknown) =>
        typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      const user = result?.user;
      const name = [text(user?.first_name), text(user?.last_name)].filter(Boolean).join(' ');
      return { name: name || null, username: text(user?.username) };
    },
    async memberCount(chatId) {
      const count = await call('getChatMemberCount', { chat_id: chatId });
      return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
    },
    async administrators(chatId) {
      const result = await call('getChatAdministrators', { chat_id: chatId });
      return Array.isArray(result)
        ? result.flatMap((admin) => {
            const who = telegramPerson((admin as { user?: unknown } | null)?.user);
            return who ? [who] : [];
          })
        : [];
    },
  };
}

/** A Telegram `User` as StayPut keeps it; null for a bot or something else. */
export function telegramPerson(value: unknown): TelegramPerson | null {
  if (typeof value !== 'object' || value === null) return null;
  const user = value as Record<string, unknown>;
  if (user.is_bot === true) return null;
  const id = typeof user.id === 'number' && Number.isSafeInteger(user.id) ? String(user.id) : null;
  if (!id) return null;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const name = [text(user.first_name), text(user.last_name)].filter(Boolean).join(' ');
  return { id, name: name || null, username: text(user.username) };
}

const encoder = new TextEncoder();

async function hmac(secret: string, purpose: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${purpose}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

/**
 * The secret Telegram repeats in `X-Telegram-Bot-Api-Secret-Token` on each update: derived from
 * the bot's token, so that no other secret has to be stored. 64 hexadecimal characters.
 */
export async function telegramWebhookSecret(botToken: string): Promise<string> {
  const mac = await hmac(botToken, 'telegram-webhook-v1', 'stayput');
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The parameter of the link that adds the bot to a group for a company (`?startgroup=`):
 * Telegram allows 64 characters among A-Z, a-z, 0-9, _ and -. It carries the company, an expiry,
 * the language of the creator's StayPut (the bot answers the group in it: Telegram does not
 * always say the creator's) and a signature:
 * `<company id without biz_>_<expiry, base 36>[_<fr|en>]_<signature>`.
 */
export async function telegramStartToken(
  companyId: string,
  expiresAt: number,
  botToken: string,
  language: BotLanguage | null = null,
): Promise<string> {
  const tail = companyId.replace(/^biz_/, '');
  const expiry = expiresAt.toString(36);
  const mac = await hmac(botToken, 'telegram-start-v1', signedPart([companyId, expiry], language));
  return fitting(`${tail}_${expiry}${languagePart(language)}_${base64Url(mac).slice(0, 22)}`);
}

/**
 * What a start parameter says: the company when this bot signed it and it has not expired, null
 * otherwise; and the language it was made in, read even then (it only picks the bot's words).
 */
export async function readTelegramStartToken(
  token: string,
  nowSeconds: number,
  botToken: string,
): Promise<{ companyId: string | null; language: BotLanguage | null }> {
  const match = /^([A-Za-z0-9]{1,40})_([0-9a-z]{1,10})(?:_(fr|en))?_([A-Za-z0-9_-]{22})$/.exec(
    token,
  );
  if (!match) return { companyId: null, language: null };
  const [, tail = '', expiry = '', lang, signature = ''] = match;
  const language = botLanguage(lang);
  const companyId = `biz_${tail}`;
  const expected = base64Url(
    await hmac(botToken, 'telegram-start-v1', signedPart([companyId, expiry], language)),
  ).slice(0, 22);
  const valid = timingSafeEqual(expected, signature) && parseInt(expiry, 36) > nowSeconds;
  return { companyId: valid ? companyId : null, language };
}

/**
 * The parameter of the link a member opens to link their Telegram account (`?start=`), for a
 * company, in the language of the member's StayPut:
 * `<user id without user_>_<company id without biz_>_<expiry>[_<fr|en>]_<signature>`.
 */
export async function telegramMemberToken(
  companyId: string,
  userId: string,
  expiresAt: number,
  botToken: string,
  language: BotLanguage | null = null,
): Promise<string> {
  const user = userId.replace(/^user_/, '');
  const company = companyId.replace(/^biz_/, '');
  const expiry = expiresAt.toString(36);
  const mac = await hmac(
    botToken,
    'telegram-member-v1',
    signedPart([userId, companyId, expiry], language),
  );
  return fitting(
    `${user}_${company}_${expiry}${languagePart(language)}_${base64Url(mac).slice(0, 16)}`,
  );
}

/**
 * What a member link says: the member and company when this bot signed it and it has not
 * expired, null otherwise; and the language it was made in, read even then.
 */
export async function readTelegramMemberToken(
  token: string,
  nowSeconds: number,
  botToken: string,
): Promise<{
  member: { companyId: string; userId: string } | null;
  language: BotLanguage | null;
}> {
  const match =
    /^([A-Za-z0-9]{1,30})_([A-Za-z0-9]{1,30})_([0-9a-z]{1,10})(?:_(fr|en))?_([A-Za-z0-9_-]{16})$/.exec(
      token,
    );
  if (!match) return { member: null, language: null };
  const [, user = '', company = '', expiry = '', lang, signature = ''] = match;
  const language = botLanguage(lang);
  const userId = `user_${user}`;
  const companyId = `biz_${company}`;
  const expected = base64Url(
    await hmac(botToken, 'telegram-member-v1', signedPart([userId, companyId, expiry], language)),
  ).slice(0, 16);
  const valid = timingSafeEqual(expected, signature) && parseInt(expiry, 36) > nowSeconds;
  return { member: valid ? { companyId, userId } : null, language };
}

/**
 * What a link's signature covers. A link without a language signs what links signed before
 * languages existed, so those stay valid for their hour.
 */
function signedPart(parts: readonly string[], language: BotLanguage | null): string {
  return (language ? [...parts, language] : parts).join(':');
}

function languagePart(language: BotLanguage | null): string {
  return language ? `_${language}` : '';
}

function fitting(token: string): string {
  if (token.length > START_PARAMETER_MAX) {
    throw new Error(`a Telegram start parameter holds ${START_PARAMETER_MAX} characters at most`);
  }
  return token;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** The link a creator opens to add the bot to one of their groups. */
export function telegramStartLink(botUsername: string, token: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?startgroup=${token}`;
}

/** The link a member opens to link their Telegram account. */
export function telegramMemberLink(botUsername: string, token: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${token}`;
}

/** What an update asks of StayPut. */
export type TelegramAction =
  | { kind: 'link'; chatId: string; title: string | null; token: string; language: string | null }
  | {
      kind: 'message';
      chatId: string;
      fromId: string;
      messageId: string;
      at: Date;
      /** The author's first and last names, and username: for the creator to recognize them. */
      name: string | null;
      username: string | null;
    }
  | { kind: 'membership'; chatId: string; present: boolean }
  /** People joined or left a group: its service messages, or `chat_member` (bot is admin). */
  | { kind: 'people'; chatId: string; joined: TelegramPerson[]; left: string[]; at: Date }
  | { kind: 'migrate'; fromChatId: string; toChatId: string }
  /** `/start` in a private chat: with the parameter of a member link, or without one. */
  | {
      kind: 'private_start';
      chatId: string;
      fromId: string;
      token: string | null;
      language: string | null;
    }
  | { kind: 'ignore' };

// The parts of a message that make it something a person wrote or sent; service messages
// (someone joined, the title changed…) have none of them.
const CONTENT_FIELDS = [
  'text',
  'caption',
  'photo',
  'video',
  'video_note',
  'voice',
  'audio',
  'document',
  'animation',
  'sticker',
  'poll',
  'contact',
  'location',
  'venue',
  'dice',
];

/** Reads a Telegram update (Bot API `Update`). */
export function telegramAction(update: unknown): TelegramAction {
  const record = (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const id = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
  const root = record(update);

  const people = record(root?.chat_member);
  if (people) {
    const chat = record(people.chat);
    const chatId = id(chat?.id);
    const before = record(people.old_chat_member);
    const after = record(people.new_chat_member);
    const who = telegramPerson(after?.user);
    const date = typeof people.date === 'number' ? people.date : null;
    if (!chatId || !isGroup(chat?.type) || !who || date === null) return { kind: 'ignore' };
    const [was, is] = [inGroup(before), inGroup(after)];
    // A change of rights (promoted, restricted) says nothing of joining or leaving.
    if (was === is) return { kind: 'ignore' };
    return {
      kind: 'people',
      chatId,
      joined: is ? [who] : [],
      left: is ? [] : [who.id],
      at: new Date(date * 1000),
    };
  }

  const change = record(root?.my_chat_member);
  if (change) {
    const chat = record(change.chat);
    const status = record(change.new_chat_member)?.status;
    const chatId = id(chat?.id);
    if (!chatId || !isGroup(chat?.type)) return { kind: 'ignore' };
    return {
      kind: 'membership',
      chatId,
      present: status === 'member' || status === 'administrator',
    };
  }

  const message = record(root?.message);
  const chat = record(message?.chat);
  const chatId = id(chat?.id);
  if (!message || !chatId) return { kind: 'ignore' };
  const from = record(message.from);
  const fromId = id(from?.id);
  const language = typeof from?.language_code === 'string' ? from.language_code : null;
  const text = typeof message.text === 'string' ? message.text : '';
  const start = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(text);

  if (chat?.type === 'private') {
    if (!start || !fromId || from?.is_bot === true) return { kind: 'ignore' };
    return { kind: 'private_start', chatId, fromId, token: start[1] ?? null, language };
  }
  if (!isGroup(chat?.type)) return { kind: 'ignore' };

  const migratedTo = id(message.migrate_to_chat_id);
  if (migratedTo) return { kind: 'migrate', fromChatId: chatId, toChatId: migratedTo };

  if (start?.[1]) {
    return {
      kind: 'link',
      chatId,
      title: typeof chat?.title === 'string' ? chat.title : null,
      token: start[1],
      language,
    };
  }

  const messageId = id(message.message_id);
  const date = typeof message.date === 'number' ? message.date : null;
  // Someone joined or left: Telegram's service message, the only news of a member who never
  // writes (a bot sees no list of a group's members).
  const joined = Array.isArray(message.new_chat_members)
    ? message.new_chat_members.flatMap((user) => {
        const who = telegramPerson(user);
        return who ? [who] : [];
      })
    : [];
  const leaving = telegramPerson(message.left_chat_member);
  if ((joined.length > 0 || leaving) && date !== null) {
    return {
      kind: 'people',
      chatId,
      joined,
      left: leaving ? [leaving.id] : [],
      at: new Date(date * 1000),
    };
  }
  if (!fromId || from?.is_bot === true || !messageId || date === null) return { kind: 'ignore' };
  // Sent on behalf of a chat, not by a person: a channel's post that Telegram copies into the
  // channel's discussion group, an anonymous administrator, someone writing as their channel.
  // `from` then holds a stand-in account that must not count as a member.
  if ('sender_chat' in message || message.is_automatic_forward === true) {
    return { kind: 'ignore' };
  }
  if (!CONTENT_FIELDS.some((field) => field in message)) return { kind: 'ignore' };
  const nonEmpty = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  const name = [nonEmpty(from?.first_name), nonEmpty(from?.last_name)].filter(Boolean).join(' ');
  return {
    kind: 'message',
    chatId,
    fromId,
    messageId,
    at: new Date(date * 1000),
    name: name || null,
    username: nonEmpty(from?.username),
  };
}

function isGroup(type: unknown): boolean {
  return type === 'group' || type === 'supergroup';
}

/** A `ChatMember` that is in the group: its owner, an administrator, a member, or restricted. */
function inGroup(member: Record<string, unknown> | null): boolean {
  const status = member?.status;
  return (
    status === 'creator' ||
    status === 'administrator' ||
    status === 'member' ||
    (status === 'restricted' && member?.is_member === true)
  );
}

/** What the bot says, in French for a French-speaking Telegram user, in English otherwise. */
export const BOT_TEXTS = {
  groupLinked: {
    fr: '✅ Ce groupe est relié à StayPut. Seuls l’auteur et l’heure des messages sont comptés, jamais leur contenu. Pour que votre activité compte, ouvrez StayPut dans la communauté Whop et touchez « Relier mon Telegram ».',
    en: '✅ This group is now linked to StayPut. Only who wrote and when is counted, never what was written. For your activity to count, open StayPut in the Whop community and tap “Link my Telegram”.',
  },
  groupLinkExpired: {
    fr: 'Ce lien a expiré : demandez-en un nouveau dans StayPut (Sources d’activité → Telegram).',
    en: 'This link has expired: get a new one in StayPut (Activity sources → Telegram).',
  },
  memberLinked: {
    fr: '✅ C’est fait : vos messages dans les groupes Telegram de la communauté comptent maintenant. Vous pouvez délier votre compte à tout moment depuis StayPut.',
    en: '✅ Done: your messages in the community’s Telegram groups now count. You can unlink your account at any time from StayPut.',
  },
  memberUnknown: {
    fr: 'StayPut ne vous connaît pas encore dans cette communauté : réessayez dans une heure, le temps de la synchronisation.',
    en: 'StayPut does not know you in this community yet: try again in an hour, once it has synced.',
  },
  memberLinkInvalid: {
    fr: 'Ce lien a expiré ou n’est pas valable : ouvrez StayPut dans la communauté Whop et touchez « Relier mon Telegram ».',
    en: 'This link has expired or is not valid: open StayPut in the Whop community and tap “Link my Telegram”.',
  },
  help: {
    fr: 'Je compte l’activité des groupes Telegram reliés à StayPut (l’auteur et l’heure, jamais le contenu). Pour relier votre compte, ouvrez StayPut dans votre communauté Whop.',
    en: 'I count activity in the Telegram groups linked to StayPut (who and when, never the content). To link your account, open StayPut in your Whop community.',
  },
} as const;

export function botText(name: keyof typeof BOT_TEXTS, language: string | null): string {
  return BOT_TEXTS[name][language?.toLowerCase().startsWith('fr') ? 'fr' : 'en'];
}
