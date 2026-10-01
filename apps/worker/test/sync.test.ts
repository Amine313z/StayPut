import { WhopApiError, type QueryValue, type WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** Whop's lists, keyed by path and scope (`/messages?chat_C1`), served `pageSize` at a time. */
function fakeWhop(lists: Record<string, unknown[]>, pageSize = 2) {
  const calls: string[] = [];
  const failures: Record<string, WhopApiError> = {};
  const client = {
    env: 'sandbox',
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
  return { client, calls, failures, lists };
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

const context = (whop: WhopClient, now = NOW, budget = 40): SyncContext => ({
  db: t.db,
  whop,
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
