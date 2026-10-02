/**
 * Discord, an optional activity source (SPEC Phase 2, 5). StayPut has one Discord application
 * whose bot a creator adds to their server; the bot only reads who wrote in the chosen channels,
 * and when. Shapes and endpoints: Discord's API v10 (checked against discord-api-types).
 */

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;

/** All the bot asks of a server: View Channels and Read Message History. */
export const DISCORD_BOT_PERMISSIONS = String(VIEW_CHANNEL | READ_MESSAGE_HISTORY);

/** Text and announcement channels: the ones whose messages count. */
const READABLE_CHANNEL_TYPES = new Set([0, 5]);
const CATEGORY = 4;

export class DiscordApiError extends Error {
  override readonly name = 'DiscordApiError';

  constructor(
    readonly status: number,
    message: string,
    /** How long Discord asked to wait (429), when it said so. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface DiscordChannel {
  id: string;
  name: string;
  /** The category the channel is filed under, if any. */
  category: string | null;
  /** The bot can see the channel and read its history (roles and overwrites computed). */
  readable: boolean;
  /** The bot can post in it: where a milestone can be announced (SPEC Phase 5). */
  writable?: boolean;
}

export interface DiscordClient {
  /**
   * One page of a channel's messages, newest first, before message `before` (the first page when
   * null): Discord's JSON as is, for Postgres to read (ingest_page).
   */
  messagesRaw(channelId: string, before: string | null): Promise<string>;
  /**
   * One page of a server's member list, sorted by account, after account `after` (the first page
   * when null), 1000 at most: Discord's JSON as is (ingest_page). Discord gives it only to an
   * application with the Server Members Intent turned on (403 otherwise).
   */
  membersRaw(guildId: string, after: string | null): Promise<string>;
  /** How many people a server has, as Discord counts them (no intent needed). */
  memberCount(guildId: string): Promise<number | null>;
  /** The text channels of a server the bot is in, in Discord's order. */
  guildChannels(guildId: string): Promise<DiscordChannel[]>;
  /** The bot leaves a server (the creator disconnected it). */
  leaveGuild(guildId: string): Promise<void>;
  /**
   * The bot posts a message, mentioning nobody. `nonce` makes Discord refuse a second post of
   * the same message within minutes (a retry after a lost answer).
   */
  sendMessage(channelId: string, content: string, nonce: string): Promise<void>;
  /** A Discord account's display name and username (GET /users/{id}). */
  user(userId: string): Promise<{ name: string | null; username: string | null }>;
  /** The application's id and its bot's user id, read once per isolate. */
  application(): Promise<{ id: string; botId: string }>;
  /**
   * The server the bot was just added to (exchangeDiscordCode); needs the application's client
   * secret.
   */
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ guildId: string; guildName: string | null }>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const USER_AGENT = 'DiscordBot (https://stayput.chezbenz18.workers.dev, 1.0)';

export function createDiscordClient(options: {
  botToken: string;
  clientSecret?: string | null;
  fetch?: Fetch;
}): DiscordClient {
  const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  let application: Promise<{ id: string; botId: string }> | null = null;

  async function call(method: string, path: string, body?: unknown): Promise<string> {
    let response: Response;
    try {
      response = await send(`${DISCORD_API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${options.botToken}`,
          'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new DiscordApiError(0, cause instanceof Error ? cause.message : String(cause));
    }
    const text = await response.text();
    if (response.ok) return text;
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new DiscordApiError(
      response.status,
      `${method} ${path.split('?')[0]}: ${response.status} ${errorMessage(text) ?? response.statusText}`,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    );
  }

  async function json<T>(path: string): Promise<T> {
    const text = await call('GET', path);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DiscordApiError(200, `GET ${path}: not JSON`);
    }
  }

  const client: DiscordClient = {
    async messagesRaw(channelId, before) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', snowflake(before));
      const path = `/channels/${snowflake(channelId)}/messages?${query.toString()}`;
      const text = await call('GET', path);
      if (!/^\s*\[/.test(text)) throw new DiscordApiError(200, 'not a list of messages');
      return text;
    },
    async membersRaw(guildId, after) {
      const query = new URLSearchParams({ limit: '1000' });
      if (after) query.set('after', snowflake(after));
      const text = await call('GET', `/guilds/${snowflake(guildId)}/members?${query.toString()}`);
      if (!/^\s*\[/.test(text)) throw new DiscordApiError(200, 'not a list of members');
      return text;
    },
    async memberCount(guildId) {
      const guild = await json<{ approximate_member_count?: unknown }>(
        `/guilds/${snowflake(guildId)}?with_counts=true`,
      );
      const count = guild.approximate_member_count;
      return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
    },
    async guildChannels(guildId) {
      const id = snowflake(guildId);
      const [channels, roles, app] = await Promise.all([
        json<RawChannel[]>(`/guilds/${id}/channels`),
        json<RawRole[]>(`/guilds/${id}/roles`),
        client.application(),
      ]);
      const bot = await json<{ roles?: unknown }>(`/guilds/${id}/members/${app.botId}`);
      return readableChannels({
        guildId: id,
        botId: app.botId,
        botRoles: Array.isArray(bot.roles) ? bot.roles.filter(isString) : [],
        roles,
        channels,
      });
    },
    async leaveGuild(guildId) {
      await call('DELETE', `/users/@me/guilds/${snowflake(guildId)}`);
    },
    async sendMessage(channelId, content, nonce) {
      await call('POST', `/channels/${snowflake(channelId)}/messages`, {
        content,
        allowed_mentions: { parse: [] },
        nonce: nonce.slice(0, 25),
        enforce_nonce: true,
      });
    },
    async user(userId) {
      const user = await json<{ global_name?: unknown; username?: unknown }>(
        `/users/${snowflake(userId)}`,
      );
      const text = (value: unknown) =>
        typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      return { name: text(user.global_name), username: text(user.username) };
    },
    application() {
      application ??= json<{ id?: unknown; bot?: { id?: unknown } }>('/applications/@me').then(
        (app) => {
          if (typeof app.id !== 'string') throw new DiscordApiError(200, 'no application id');
          return { id: app.id, botId: typeof app.bot?.id === 'string' ? app.bot.id : app.id };
        },
      );
      application.catch(() => {
        application = null;
      });
      return application;
    },
    async exchangeCode(code, redirectUri) {
      if (!options.clientSecret) throw new DiscordApiError(0, 'DISCORD_CLIENT_SECRET is not set');
      return exchangeDiscordCode({
        applicationId: (await client.application()).id,
        clientSecret: options.clientSecret,
        code,
        redirectUri,
        fetch: send,
      });
    },
  };
  return client;
}

interface RawChannel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  position?: unknown;
  parent_id?: unknown;
  permission_overwrites?: unknown;
}

interface RawRole {
  id?: unknown;
  permissions?: unknown;
}

interface Overwrite {
  id: string;
  type: number;
  allow: bigint;
  deny: bigint;
}

/**
 * The text channels of a server, in Discord's order (categories, then position), each with
 * whether the bot can read it: its roles' permissions, then the channel's overwrites
 * (@everyone, the roles, the bot itself), as Discord computes them.
 */
export function readableChannels(input: {
  guildId: string;
  botId: string;
  botRoles: readonly string[];
  roles: readonly RawRole[];
  channels: readonly RawChannel[];
}): DiscordChannel[] {
  const rolePermissions = new Map<string, bigint>();
  for (const role of input.roles) {
    if (typeof role.id === 'string') rolePermissions.set(role.id, bits(role.permissions));
  }
  let base = rolePermissions.get(input.guildId) ?? 0n;
  for (const role of input.botRoles) base |= rolePermissions.get(role) ?? 0n;
  const administrator = (base & ADMINISTRATOR) === ADMINISTRATOR;

  const allowed = (channel: RawChannel, needed: bigint) => {
    if (administrator) return true;
    const overwrites = new Map(readOverwrites(channel).map((o) => [`${o.type}:${o.id}`, o]));
    let permissions = base;
    const everyone = overwrites.get(`0:${input.guildId}`);
    if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;
    let allow = 0n;
    let deny = 0n;
    for (const role of input.botRoles) {
      const overwrite = overwrites.get(`0:${role}`);
      if (overwrite) {
        allow |= overwrite.allow;
        deny |= overwrite.deny;
      }
    }
    permissions = (permissions & ~deny) | allow;
    const own = overwrites.get(`1:${input.botId}`);
    if (own) permissions = (permissions & ~own.deny) | own.allow;
    return (permissions & needed) === needed;
  };

  const position = (c: RawChannel) => (typeof c.position === 'number' ? c.position : 0);
  const categories = new Map<string, RawChannel>();
  for (const c of input.channels) {
    if (typeof c.id === 'string' && Number(c.type) === CATEGORY) categories.set(c.id, c);
  }
  const parentOf = (c: RawChannel) =>
    typeof c.parent_id === 'string' ? categories.get(c.parent_id) : undefined;
  // Discord lists channels without a category first, then each category's, by position.
  const order = (c: RawChannel) => {
    const parent = parentOf(c);
    return [parent ? 1 : 0, parent ? position(parent) : 0, position(c)];
  };
  return input.channels
    .filter((c) => typeof c.id === 'string' && READABLE_CHANNEL_TYPES.has(Number(c.type)))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    })
    .map((c) => {
      const parent = parentOf(c);
      return {
        id: c.id as string,
        name: typeof c.name === 'string' ? c.name : '',
        category: parent && typeof parent.name === 'string' ? parent.name : null,
        readable: allowed(c, VIEW_CHANNEL | READ_MESSAGE_HISTORY),
        writable: allowed(c, VIEW_CHANNEL | SEND_MESSAGES),
      };
    });
}

function readOverwrites(channel: RawChannel): Overwrite[] {
  if (!Array.isArray(channel.permission_overwrites)) return [];
  return (channel.permission_overwrites as Record<string, unknown>[])
    .filter((o) => typeof o.id === 'string')
    .map((o) => ({
      id: o.id as string,
      type: Number(o.type),
      allow: bits(o.allow),
      deny: bits(o.deny),
    }));
}

/** A permission set as Discord writes it: a decimal string (64 bits and more). */
function bits(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Discord's page where a creator adds StayPut's bot to a server they manage. */
export function discordInstallUrl(input: {
  applicationId: string;
  redirectUri: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: input.applicationId,
    // `identify` beside `bot` turns the bot's authorization into a code grant: StayPut then
    // learns the server from Discord itself (the token answer), not from the address bar.
    scope: 'bot identify',
    permissions: DISCORD_BOT_PERMISSIONS,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    state: input.state,
    integration_type: '0',
  });
  return `https://discord.com/oauth2/authorize?${query.toString()}`;
}

/**
 * The server the bot was just added to, as Discord answers the code exchange (checked by
 * Discord: the code proves it). The user's token is revoked at once: StayPut keeps none.
 */
export async function exchangeDiscordCode(input: {
  applicationId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetch?: Fetch;
}): Promise<{ guildId: string; guildName: string | null }> {
  const send: Fetch = input.fetch ?? ((url, init) => fetch(url, init));
  const authorization = `Basic ${btoa(`${input.applicationId}:${input.clientSecret}`)}`;
  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(fields).toString(),
  });
  let response: Response;
  try {
    response = await send(
      `${DISCORD_API_BASE_URL}/oauth2/token`,
      form({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri }),
    );
  } catch (cause) {
    throw new DiscordApiError(0, cause instanceof Error ? cause.message : String(cause));
  }
  const text = await response.text();
  if (!response.ok) {
    throw new DiscordApiError(response.status, errorMessage(text) ?? 'code exchange refused');
  }
  let body: { access_token?: unknown; guild?: { id?: unknown; name?: unknown } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new DiscordApiError(200, 'the code exchange answer is not JSON');
  }
  if (typeof body.access_token === 'string') {
    await send(
      `${DISCORD_API_BASE_URL}/oauth2/token/revoke`,
      form({ token: body.access_token, token_type_hint: 'access_token' }),
    ).catch(() => undefined);
  }
  const guildId = body.guild?.id;
  if (typeof guildId !== 'string' || !/^[0-9]{5,25}$/.test(guildId)) {
    throw new DiscordApiError(200, 'Discord named no server');
  }
  return { guildId, guildName: typeof body.guild?.name === 'string' ? body.guild.name : null };
}

function errorMessage(text: string): string | null {
  try {
    const body = JSON.parse(text) as { message?: unknown; error_description?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error_description === 'string') return body.error_description;
  } catch {
    // Not JSON: no message to quote.
  }
  return null;
}

/** A Discord id: digits only, so that a path can never be rewritten. */
export function isSnowflake(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9]{5,25}$/.test(id);
}

function snowflake(id: string): string {
  if (!isSnowflake(id)) throw new DiscordApiError(400, `not a Discord id: ${String(id)}`);
  return id;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
