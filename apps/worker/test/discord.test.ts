import { describe, expect, it } from 'vitest';
import {
  DISCORD_BOT_PERMISSIONS,
  DiscordApiError,
  createDiscordClient,
  discordInstallUrl,
  readableChannels,
} from '../src/discord';

/** Discord's API (v10) as the bot sees it, from a table of answers; records every call. */
function fakeDiscord(answers: Record<string, () => Response>) {
  const calls: { method: string; url: string; headers: Headers; body: string }[] = [];
  const fetch = (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push({
      method: init.method ?? 'GET',
      url: `${url.pathname}${url.search}`,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    });
    const answer = answers[`${init.method ?? 'GET'} ${url.pathname}`];
    return Promise.resolve(answer ? answer() : json({ message: 'Unknown' }, 404));
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const GUILD = '900000000000000001';
const BOT = '800000000000000001';
const APP = '700000000000000001';
const ROLE = '900000000000000099';

describe('the Discord client', () => {
  it('reads a page of messages as is, newest first, before a message', async () => {
    const page = '[{"id":"123456","author":{"id":"55555"}}]';
    const discord = fakeDiscord({
      'GET /api/v10/channels/111111/messages': () => new Response(page),
    });
    const client = createDiscordClient({ botToken: 'bot-token', fetch: discord.fetch });
    expect(await client.messagesRaw('111111', null)).toBe(page);
    expect(await client.messagesRaw('111111', '123456')).toBe(page);
    expect(discord.calls.map((c) => c.url)).toEqual([
      '/api/v10/channels/111111/messages?limit=100',
      '/api/v10/channels/111111/messages?limit=100&before=123456',
    ]);
    expect(discord.calls[0]!.headers.get('authorization')).toBe('Bot bot-token');
    expect(discord.calls[0]!.headers.get('user-agent')).toMatch(/^DiscordBot \(/);
  });

  it('reads a server member list by account, 1000 a page, and its head count', async () => {
    const page = '[{"user":{"id":"55555","username":"ana"},"joined_at":null}]';
    const discord = fakeDiscord({
      [`GET /api/v10/guilds/${GUILD}/members`]: () => new Response(page),
      [`GET /api/v10/guilds/${GUILD}`]: () => json({ id: GUILD, approximate_member_count: 42 }),
    });
    const client = createDiscordClient({ botToken: 'bot-token', fetch: discord.fetch });
    expect(await client.membersRaw(GUILD, null)).toBe(page);
    expect(await client.membersRaw(GUILD, '55555')).toBe(page);
    expect(await client.memberCount(GUILD)).toBe(42);
    expect(discord.calls.map((c) => c.url)).toEqual([
      `/api/v10/guilds/${GUILD}/members?limit=1000`,
      `/api/v10/guilds/${GUILD}/members?limit=1000&after=55555`,
      `/api/v10/guilds/${GUILD}?with_counts=true`,
    ]);
    // Without the Server Members Intent, Discord refuses the list.
    const refused = createDiscordClient({
      botToken: 't',
      fetch: fakeDiscord({
        [`GET /api/v10/guilds/${GUILD}/members`]: () =>
          json({ message: 'Missing Access', code: 50001 }, 403),
      }).fetch,
    });
    await expect(refused.membersRaw(GUILD, null)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Missing Access') as string,
    });
  });

  it('never puts anything but a Discord id in a path', async () => {
    const discord = fakeDiscord({});
    const client = createDiscordClient({ botToken: 't', fetch: discord.fetch });
    await expect(client.messagesRaw('../users/@me', null)).rejects.toMatchObject({ status: 400 });
    await expect(client.messagesRaw('111111', '1 OR 1')).rejects.toMatchObject({ status: 400 });
    await expect(client.leaveGuild('abc')).rejects.toBeInstanceOf(DiscordApiError);
    expect(discord.calls).toEqual([]);
  });

  it("reports Discord's refusals with their status, and how long to wait", async () => {
    const discord = fakeDiscord({
      'GET /api/v10/channels/111111/messages': () =>
        json({ message: 'Missing Access', code: 50001 }, 403),
      'GET /api/v10/channels/222222/messages': () =>
        json({ message: 'You are being rate limited.' }, 429, { 'retry-after': '1.5' }),
      'GET /api/v10/channels/333333/messages': () => new Response('{"not":"a list"}'),
    });
    const client = createDiscordClient({ botToken: 'secret-token', fetch: discord.fetch });
    const refused = await client.messagesRaw('111111', null).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 403, retryAfterMs: null });
    expect(String(refused)).toContain('Missing Access');
    expect(String(refused)).not.toContain('secret-token');
    await expect(client.messagesRaw('222222', null)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1500,
    });
    await expect(client.messagesRaw('333333', null)).rejects.toMatchObject({ status: 200 });
  });

  it('reads the application once, and its bot', async () => {
    const discord = fakeDiscord({
      'GET /api/v10/applications/@me': () => json({ id: APP, bot: { id: BOT } }),
    });
    const client = createDiscordClient({ botToken: 't', fetch: discord.fetch });
    expect(await client.application()).toEqual({ id: APP, botId: BOT });
    expect(await client.application()).toEqual({ id: APP, botId: BOT });
    expect(discord.calls).toHaveLength(1);
  });

  it("lists a server's text channels, with the ones the bot can read", async () => {
    const discord = fakeDiscord({
      'GET /api/v10/applications/@me': () => json({ id: APP, bot: { id: BOT } }),
      [`GET /api/v10/guilds/${GUILD}/channels`]: () =>
        json([
          { id: '400', type: 4, name: 'Community', position: 0 },
          { id: '401', type: 0, name: 'general', position: 1, parent_id: '400' },
          {
            id: '402',
            type: 0,
            name: 'staff',
            position: 2,
            parent_id: '400',
            permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }],
          },
          { id: '403', type: 2, name: 'voice', position: 3 },
          { id: '404', type: 5, name: 'announcements', position: 0 },
        ]),
      [`GET /api/v10/guilds/${GUILD}/roles`]: () =>
        json([
          { id: GUILD, permissions: '66560' },
          { id: ROLE, permissions: '0' },
        ]),
      [`GET /api/v10/guilds/${GUILD}/members/${BOT}`]: () => json({ roles: [ROLE] }),
    });
    const client = createDiscordClient({ botToken: 't', fetch: discord.fetch });
    expect(await client.guildChannels(GUILD)).toEqual([
      { id: '404', name: 'announcements', category: null, readable: true },
      { id: '401', name: 'general', category: 'Community', readable: true },
      { id: '402', name: 'staff', category: 'Community', readable: false },
    ]);
  });

  it('exchanges the code for the server, then revokes the token it got', async () => {
    const discord = fakeDiscord({
      'GET /api/v10/applications/@me': () => json({ id: APP, bot: { id: BOT } }),
      'POST /api/v10/oauth2/token': () =>
        json({ access_token: 'user-token', guild: { id: GUILD, name: 'My server' } }),
      'POST /api/v10/oauth2/token/revoke': () => new Response('{}'),
    });
    const client = createDiscordClient({
      botToken: 't',
      clientSecret: 'shh',
      fetch: discord.fetch,
    });
    expect(
      await client.exchangeCode('the-code', 'https://w.example/auth/discord/callback'),
    ).toEqual({ guildId: GUILD, guildName: 'My server' });
    const [, exchange, revoke] = discord.calls;
    expect(exchange!.headers.get('authorization')).toBe(`Basic ${btoa(`${APP}:shh`)}`);
    expect(Object.fromEntries(new URLSearchParams(exchange!.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://w.example/auth/discord/callback',
    });
    expect(new URLSearchParams(revoke!.body).get('token')).toBe('user-token');
  });

  it('refuses an exchange without the client secret, or that names no server', async () => {
    const discord = fakeDiscord({
      'GET /api/v10/applications/@me': () => json({ id: APP }),
      'POST /api/v10/oauth2/token': () => json({ access_token: 'x' }),
    });
    const withoutSecret = createDiscordClient({ botToken: 't', fetch: discord.fetch });
    await expect(withoutSecret.exchangeCode('c', 'https://w')).rejects.toThrow(/CLIENT_SECRET/);
    const client = createDiscordClient({ botToken: 't', clientSecret: 's', fetch: discord.fetch });
    await expect(client.exchangeCode('c', 'https://w')).rejects.toThrow(/no server/);
  });
});

describe('readableChannels', () => {
  const base = { guildId: GUILD, botId: BOT, botRoles: [ROLE] };
  const channel = (overwrites: unknown[] = []) => ({
    id: '500',
    type: 0,
    name: 'c',
    permission_overwrites: overwrites,
  });
  const readable = (roles: { id: string; permissions: string }[], overwrites: unknown[] = []) =>
    readableChannels({ ...base, roles, channels: [channel(overwrites)] })[0]!.readable;

  it('needs both View Channel and Read Message History', () => {
    expect(readable([{ id: GUILD, permissions: '1024' }])).toBe(false);
    expect(readable([{ id: GUILD, permissions: '65536' }])).toBe(false);
    expect(readable([{ id: GUILD, permissions: DISCORD_BOT_PERMISSIONS }])).toBe(true);
    // Through the bot's own role.
    expect(
      readable([
        { id: GUILD, permissions: '0' },
        { id: ROLE, permissions: '66560' },
      ]),
    ).toBe(true);
  });

  it('applies the overwrites in Discord order: @everyone, roles, then the bot', () => {
    const roles = [{ id: GUILD, permissions: '66560' }];
    const hidden = { id: GUILD, type: 0, allow: '0', deny: '1024' };
    expect(readable(roles, [hidden])).toBe(false);
    expect(readable(roles, [hidden, { id: ROLE, type: 0, allow: '1024', deny: '0' }])).toBe(true);
    expect(
      readable(roles, [
        hidden,
        { id: ROLE, type: 0, allow: '1024', deny: '0' },
        { id: BOT, type: 1, allow: '0', deny: '65536' },
      ]),
    ).toBe(false);
    // A role overwrite for a role the bot does not have changes nothing.
    expect(readable(roles, [{ id: '42424242', type: 0, allow: '0', deny: '1024' }])).toBe(true);
  });

  it('lets an administrator read everything, whatever the overwrites', () => {
    expect(
      readable(
        [{ id: GUILD, permissions: '8' }],
        [{ id: GUILD, type: 0, allow: '0', deny: '66560' }],
      ),
    ).toBe(true);
  });

  it('reads permission sets beyond 53 bits', () => {
    const huge = String((1n << 60n) | 66560n);
    expect(readable([{ id: GUILD, permissions: huge }])).toBe(true);
  });
});

describe('discordInstallUrl', () => {
  it('asks for the bot with its two permissions, as a code grant coming back to StayPut', () => {
    const url = new URL(
      discordInstallUrl({
        applicationId: APP,
        redirectUri: 'https://w.example/auth/discord/callback',
        state: 'signed.state',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP,
      scope: 'bot identify',
      permissions: '66560',
      response_type: 'code',
      redirect_uri: 'https://w.example/auth/discord/callback',
      state: 'signed.state',
      integration_type: '0',
    });
  });
});
