import { WhopApiError, type QueryValue, type WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscordApiError, type DiscordClient } from '../src/discord';
import {
  STREAMS,
  planPass,
  summarize,
  syncDueCompanies,
  syncIfFree,
  type Stream,
  type StreamState,
  type SyncContext,
} from '../src/sync';
import { member, membership, message, payment, variant } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The synchronization engine (src/sync.ts) against a fake Whop serving raw pages, and the real
 * migrations (PGlite): backfill, resuming at the cursor, reading only what is new, the budget.
 */

const NOW = new Date('2026-10-01T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

/**
 * Whop's lists, keyed by path and scope (`/messages?chat_C1`), served `pageSize` at a time; and
 * user profiles (GET /users/{id}), unknown users answered 404.
 */
function fakeWhop(lists: Record<string, unknown[]>, pageSize = 2) {
  const calls: string[] = [];
  const failures: Record<string, WhopApiError> = {};
  const profiles: Record<string, unknown> = {};
  const client = {
    env: 'sandbox',
    getRaw(path: string) {
      calls.push(path);
      const failure = failures[path];
      if (failure) return Promise.reject(failure);
      const profile = profiles[path.replace('/users/', '')];
      if (!profile) {
        return Promise.reject(
          new WhopApiError(404, 'not_found', 'no such user', { method: 'GET', path }),
        );
      }
      return Promise.resolve(JSON.stringify(profile));
    },
    listPageRaw(
      path: string,
      query: Record<string, QueryValue> = {},
      cursor: { after?: string | null } = {},
    ) {
      const scope = query.channel_id ?? query.experience_id ?? query.course_id;
      const key = scope ? `${path}?${String(scope)}` : path;
      calls.push(cursor.after ? `${key}@${cursor.after}` : key);
      const failure = failures[key];
      if (failure) return Promise.reject(failure);
      const items = lists[key] ?? [];
      const start = cursor.after ? Number(cursor.after) : 0;
      const next = start + pageSize < items.length ? String(start + pageSize) : null;
      return Promise.resolve(
        JSON.stringify({
          data: items.slice(start, start + pageSize),
          page_info: { end_cursor: next, has_next_page: next !== null },
        }),
      );
    },
  } as unknown as WhopClient;
  return { client, calls, failures, lists, profiles };
}

/** Discord channels (id → messages, newest first), served 100 a page before a message. */
function fakeDiscord(channels: Record<string, unknown[]>) {
  const calls: string[] = [];
  const failures: Record<string, DiscordApiError> = {};
  const client = {
    messagesRaw(channelId: string, before: string | null) {
      calls.push(before ? `${channelId}@${before}` : channelId);
      const failure = failures[channelId];
      if (failure) return Promise.reject(failure);
      const messages = (channels[channelId] ?? []) as { id: string }[];
      const start = before ? messages.findIndex((m) => m.id === before) + 1 : 0;
      return Promise.resolve(JSON.stringify(messages.slice(start, start + 100)));
    },
  } as unknown as DiscordClient;
  return { client, calls, failures };
}

/** A Discord message by `author`, `hoursAgo` before NOW. */
const discordMessage = (id: number, author: string, hoursAgo: number) => ({
  id: String(id),
  type: 0,
  timestamp: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  author: { id: author, bot: false },
});

/** The company connects a Discord server and follows these channels. */
async function followDiscord(companyId: string, guild: string, channels: string[]) {
  await t.db.query('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
    companyId,
    guild,
    'Server',
    'user_owner',
    NOW.toISOString(),
  ]);
  await t.db.query('select stayput.set_discord_channels($1, $2, $3)', [
    companyId,
    guild,
    channels.join(','),
  ]);
}

/** A company with ids of its own (Whop ids never repeat across companies). */
async function company() {
  companies += 1;
  const id = `biz_Y${companies}`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [id, NOW.toISOString()]);
  // Its team opened StayPut: the cron reads it.
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_owner', $2::timestamptz)`,
    [id, NOW.toISOString()],
  );
  const u = (base: string) => `${base}Y${companies}`;
  return { id, u };
}

/** A small community: 3 members, their memberships and payments, one chat channel. */
function community(u: (base: string) => string): Record<string, unknown[]> {
  const day = (d: number, h = 12) => `2026-09-${String(d).padStart(2, '0')}T${h}:00:00.000Z`;
  return {
    '/variants': [variant(u('plan_V1'))],
    '/members': [3, 2, 1].map((i) =>
      member(u(`mber_M${i}`), u(`user_U${i}`), { created_at: day(i), joined_at: day(i) }),
    ),
    '/memberships': [3, 2, 1].map((i) =>
      membership(u(`mem_S${i}`), u(`user_U${i}`), { plan_id: u('plan_V1'), created_at: day(i) }),
    ),
    '/payments': [3, 2, 1].map((i) =>
      payment(u(`pay_P${i}`), {
        membership_id: u(`mem_S${i}`),
        member_id: u(`mber_M${i}`),
        created_at: day(i),
      }),
    ),
    '/chat_channels': [{ id: u('chat_C1') }],
    [`/messages?${u('chat_C1')}`]: [29, 28, 27, 26, 25].map((d) =>
      message(u(`msg_${d}`), u(`user_U${d % 3}`), day(d)),
    ),
  };
}

const context = (
  whop: WhopClient,
  now = NOW,
  budget = 40,
  discord: DiscordClient | null = null,
): SyncContext => ({
  db: t.db,
  whop,
  discord,
  now,
  budget: { left: budget },
});

const count = async (table: string, companyId: string) =>
  (
    await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.${table} where company_id = $1`,
      [companyId],
    )
  )[0]?.n;

describe('planPass', () => {
  const stream = (over: Partial<Stream> = {}): Stream => ({
    name: 'payments',
    kind: 'payments',
    path: '/payments',
    query: () => ({}),
    stop: 'oldest',
    everyHours: 1,
    backfillDays: 90,
    ...over,
  });
  const state = (over: Partial<StreamState> = {}): StreamState => ({
    stream: 'payments',
    cursor: null,
    highWater: new Date('2026-10-01T10:00:00Z'),
    backfillDone: true,
    lastPassAt: new Date('2026-10-01T11:00:00Z'),
    lastCompletePassAt: new Date('2026-09-01T00:00:00Z'),
    lastError: null,
    ...over,
  });

  it('starts with the backfill: 90 days back, a complete pass', () => {
    expect(planPass(stream(), undefined, NOW)).toEqual({
      cursor: null,
      start: true,
      until: new Date('2026-07-03T12:00:00Z'),
      complete: true,
    });
  });

  it('resumes a pass under way from its cursor', () => {
    expect(planPass(stream(), state({ cursor: 'c9' }), NOW)).toMatchObject({
      cursor: 'c9',
      start: false,
    });
  });

  it('then reads back to what it already has, once the stream is due', () => {
    expect(planPass(stream(), state({ lastPassAt: hours(-0.5) }), NOW)).toBeNull();
    // Due a few minutes early rather than a whole run late.
    expect(planPass(stream(), state({ lastPassAt: hours(-0.95) }), NOW)).toMatchObject({
      until: new Date('2026-10-01T10:00:00Z'),
      complete: false,
    });
  });

  it('reads the whole list again when a complete pass is due, or for a list in no order', () => {
    expect(
      planPass(stream({ completeEveryHours: 24, backfillDays: undefined }), state(), NOW),
    ).toMatchObject({ until: null, complete: true });
    expect(planPass(stream({ stop: 'end' }), state(), NOW)).toMatchObject({
      until: null,
      complete: true,
    });
  });

  it('tries a refused stream again within the hour, or at once when asked', () => {
    const daily = stream({ stop: 'end', everyHours: 24 });
    const refused = state({ lastPassAt: hours(-0.5), lastError: '403 forbidden' });
    expect(planPass(daily, state({ lastPassAt: hours(-2) }), NOW)).toBeNull();
    expect(planPass(daily, refused, NOW)).toBeNull();
    expect(planPass(daily, { ...refused, lastPassAt: hours(-1) }, NOW)).toMatchObject({
      start: true,
    });
    expect(planPass(daily, refused, NOW, { retryFailed: true })).toMatchObject({ start: true });
    // Asking to retry what failed leaves the streams that did not fail alone.
    expect(
      planPass(daily, state({ lastPassAt: hours(-2) }), NOW, { retryFailed: true }),
    ).toBeNull();
  });

  it('lists every stream once, account-wide ones before the scoped ones they open', () => {
    const names = STREAMS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.indexOf('chat_channels')).toBeLessThan(names.indexOf('messages'));
    expect(names.indexOf('forums')).toBeLessThan(names.indexOf('forum_posts'));
    expect(names.indexOf('courses')).toBeLessThan(names.indexOf('lesson_interactions'));
    expect(names.indexOf('members')).toBeLessThan(names.indexOf('messages'));
  });
});

describe('syncing a company', () => {
  it('reads every list the first time, the channels it finds included', async () => {
    const { id, u } = await company();
    const whop = fakeWhop(community(u));
    const result = await syncIfFree(context(whop.client), id, 0);
    expect(result?.stopped).toBeNull();
    expect(Object.values(result?.streams ?? {}).every((o) => o === 'caught_up')).toBe(true);
    expect(await count('members', id)).toBe(3);
    expect(await count('memberships', id)).toBe(3);
    expect(await count('payments', id)).toBe(3);
    // Message of day 27 is by user_U0, who is not a member: it waits in pending_activity.
    expect(await count('activity_events', id)).toBe(4);
    expect(whop.calls).toContain(`/messages?${u('chat_C1')}@4`);
    expect(
      (
        await t.db.query<{ price: string }>(
          'select price::text from stayput.memberships where company_id = $1 limit 1',
          [id],
        )
      )[0]?.price,
    ).toBe('49.00');
  });

  it('stops when the budget is spent, then goes on from the cursor', async () => {
    const { id, u } = await company();
    const whop = fakeWhop(community(u));
    const first = await syncIfFree(context(whop.client, NOW, 3), id, 0);
    expect(first?.calls).toBe(3);
    expect(whop.calls).toEqual(['/variants', '/members', '/members@2']);

    whop.calls.length = 0;
    await syncIfFree(context(whop.client, new Date(NOW.getTime() + 600_000), 3), id, 0);
    // The members pass had ended; memberships start, from the top.
    expect(whop.calls).toEqual(['/memberships', '/memberships@2', '/payments']);
  });

  it('later reads only what is new, and nothing before a stream is due', async () => {
    const { id, u } = await company();
    const data = community(u);
    const whop = fakeWhop(data);
    await syncIfFree(context(whop.client), id, 0);

    whop.calls.length = 0;
    await syncIfFree(context(whop.client, hours(0.5)), id, 0);
    expect(whop.calls).toEqual([]);

    // An hour later, a new member and a new message: one page each is enough.
    data['/members']!.unshift(
      member(u('mber_M4'), u('user_U4'), { created_at: '2026-10-01T12:30:00.000Z' }),
    );
    data[`/messages?${u('chat_C1')}`]!.unshift(
      message(u('msg_new'), u('user_U4'), '2026-10-01T12:40:00.000Z'),
    );
    whop.calls.length = 0;
    await syncIfFree(context(whop.client, hours(1)), id, 0);
    expect(whop.calls).toEqual([
      '/members',
      '/memberships',
      '/payments',
      '/support_channels',
      `/messages?${u('chat_C1')}`,
    ]);
    expect(await count('members', id)).toBe(4);
    expect(
      await t.db.query('select 1 from stayput.activity_events where external_id = $1', [
        u('msg_new'),
      ]),
    ).toHaveLength(1);
  });

  it('reads a refused list again as soon as the dashboard asks', async () => {
    const { id, u } = await company();
    const whop = fakeWhop(community(u));
    whop.failures['/members'] = new WhopApiError(403, 'forbidden', 'member:basic:read', {
      method: 'GET',
      path: '/members',
    });
    await syncIfFree(context(whop.client), id, 0);
    expect(await count('members', id)).toBe(0);

    // The creator approves the permission; ten minutes later the dashboard opens.
    delete whop.failures['/members'];
    whop.calls.length = 0;
    await syncIfFree(context(whop.client, new Date(NOW.getTime() + 600_000)), id, 0, {
      retryFailed: true,
    });
    expect(whop.calls).toEqual(['/members', '/members@2']);
    expect(await count('members', id)).toBe(3);
  });

  it('records a refused list and goes on with the others', async () => {
    const { id, u } = await company();
    const whop = fakeWhop(community(u));
    whop.failures['/support_channels'] = new WhopApiError(403, 'forbidden', 'support_chat:read', {
      method: 'GET',
      path: '/support_channels',
    });
    const result = await syncIfFree(context(whop.client), id, 0);
    expect(result?.streams.support_channels).toBe('failed');
    expect(result?.streams[`messages:${u('chat_C1')}`]).toBe('caught_up');
    const [state] = await t.db.query<{ last_error: string }>(
      `select last_error from stayput.sync_state
        where company_id = $1 and stream = 'support_channels'`,
      [id],
    );
    expect(state?.last_error).toMatch(/^403 .*support_chat:read/);
  });

  it('stops the whole run when Whop refuses the key or asks to slow down', async () => {
    const { id, u } = await company();
    const whop = fakeWhop(community(u));
    whop.failures['/members'] = new WhopApiError(429, 'rate_limited', 'slow down', {
      method: 'GET',
      path: '/members',
    });
    const result = await syncIfFree(context(whop.client), id, 0);
    expect(result?.stopped).toMatch(/429/);
    expect(whop.calls).toEqual(['/variants', '/members']);
    expect(summarize(result!)).toMatch(/members failed; stopped: Whop asks to slow down/);
  });
});

describe('the cron run', () => {
  it('shares its budget among the companies that waited longest', async () => {
    const a = await company();
    const whopA = fakeWhop(community(a.u));
    // Company A was read 2 hours ago; B never was: B goes first.
    await syncIfFree(context(whopA.client, hours(-2)), a.id, 0);
    const b = await company();
    const lists = { ...community(a.u), ...community(b.u) };
    const whop = fakeWhop(lists);
    const results = await syncDueCompanies(context(whop.client, NOW, 6), 100);
    const order = results.map((r) => r.companyId).filter((c) => c === a.id || c === b.id);
    expect(order[0]).toBe(b.id);
    expect(results.reduce((n, r) => n + r.calls, 0)).toBe(6);
  });
});

describe('Discord', () => {
  it('reads the channels a creator follows, after Whop, 100 messages a page', async () => {
    const { id, u } = await company();
    const guild = `91000${companies}`;
    const channel = `92000${companies}`;
    await followDiscord(id, guild, [channel]);
    // 150 messages, one an hour; the author of every third one linked it on Whop as user_U1.
    const author = `93000${companies}`;
    const messages = Array.from({ length: 150 }, (_, i) =>
      discordMessage(9_000_000 - i, i % 3 === 0 ? author : `94000${companies}`, i + 1),
    );
    const discord = fakeDiscord({ [channel]: messages });
    const whop = fakeWhop(community(u));
    whop.profiles[u('user_U1')] = {
      id: u('user_U1'),
      social_accounts: [{ platform: 'discord', external_id: author }],
    };

    // Without the bot, the channel waits.
    const without = await syncIfFree(context(whop.client), id, 0);
    expect(without?.streams[`discord_messages:${channel}`]).toBeUndefined();

    const result = await syncIfFree(context(whop.client, hours(1), 40, discord.client), id, 0);
    expect(result?.streams[`discord_messages:${channel}`]).toBe('caught_up');
    expect(discord.calls).toEqual([channel, `${channel}@${messages[99]!.id}`]);
    // The Whop profiles were read after the channels: the member's messages are theirs.
    expect(result?.profiles).toBe(3);
    const [counted] = await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.activity_events
        where company_id = $1 and type = 'discord_message' and member_id = $2`,
      [id, u('mber_M1')],
    );
    expect(counted?.n).toBe(50);
    expect(summarize(result!)).toMatch(/3 profile\(s\) read/);

    // Three hours later, only the newest page, back to what it has.
    messages.unshift(discordMessage(9_000_001, author, -3.5));
    discord.calls.length = 0;
    await syncIfFree(context(whop.client, hours(4), 40, discord.client), id, 0);
    expect(discord.calls).toEqual([channel]);
  });

  it("leaves Discord for the next run when it refuses the bot's token, Whop goes on", async () => {
    const { id, u } = await company();
    const channels = [`95000${companies}1`, `95000${companies}2`];
    await followDiscord(id, `96000${companies}`, channels);
    const discord = fakeDiscord({});
    discord.failures[channels[0]!] = new DiscordApiError(401, '401: Unauthorized');
    const ctx = context(fakeWhop(community(u)).client, NOW, 40, discord.client);
    const result = await syncIfFree(ctx, id, 0);
    expect(result?.stopped).toBeNull();
    expect(result?.streams.members).toBe('caught_up');
    expect(result?.streams[`discord_messages:${channels[0]!}`]).toBe('failed');
    expect(discord.calls).toEqual([channels[0]]);
    expect(ctx.discordPaused).toMatch(/Discord refuses the key \(401\)/);
  });

  it('records a channel the bot cannot read, and forgets one deleted on Discord', async () => {
    const { id, u } = await company();
    const guild = `97000${companies}`;
    const [hidden, deleted] = [`98000${companies}1`, `98000${companies}2`];
    await followDiscord(id, guild, [hidden, deleted]);
    const discord = fakeDiscord({});
    discord.failures[hidden] = new DiscordApiError(403, 'Missing Access');
    discord.failures[deleted] = new DiscordApiError(404, 'Unknown Channel');
    await syncIfFree(context(fakeWhop(community(u)).client, NOW, 40, discord.client), id, 0);
    const states = await t.db.query<{ stream: string; last_error: string | null }>(
      `select stream, last_error from stayput.sync_state
        where company_id = $1 and stream like 'discord%'`,
      [id],
    );
    expect(states).toEqual([
      { stream: `discord_messages:${hidden}`, last_error: '403 Missing Access' },
    ]);
    const [server] = await t.db.query<{ channel_ids: string[] }>(
      'select to_jsonb(channel_ids) as channel_ids from stayput.discord_guilds where guild_id = $1',
      [guild],
    );
    expect(server?.channel_ids).toEqual([hidden]);
  });

  it('reads ten Whop profiles a run at most, and marks the users Whop does not know', async () => {
    const { id, u } = await company();
    await followDiscord(id, `99000${companies}`, []);
    const whop = fakeWhop(community(u));
    const discord = fakeDiscord({});
    // community() has 3 members: user_U1 linked a Discord account, the others are unknown.
    whop.profiles[u('user_U1')] = {
      id: u('user_U1'),
      social_accounts: [{ platform: 'discord', external_id: `88000${companies}` }],
    };
    const first = await syncIfFree(context(whop.client, NOW, 40, discord.client), id, 0);
    expect(first?.profiles).toBe(3);
    const linked = await t.db.query<{ user_id: string; discord_user_id: string | null }>(
      `select user_id, discord_user_id from stayput.members
        where company_id = $1 and discord_checked_at is not null order by user_id`,
      [id],
    );
    expect(linked).toEqual([
      { user_id: u('user_U1'), discord_user_id: `88000${companies}` },
      { user_id: u('user_U2'), discord_user_id: null },
      { user_id: u('user_U3'), discord_user_id: null },
    ]);
    // Read again a week later, not before.
    const again = await syncIfFree(context(whop.client, hours(3), 40, discord.client), id, 0);
    expect(again?.profiles).toBe(0);
  });
});
