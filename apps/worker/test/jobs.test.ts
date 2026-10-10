import type { QueryValue, WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { groupAt, runScheduled, SCHEDULE, type JobContext, type JobGroup } from '../src/cron';
import type { ClosableDb } from '../src/db';
import { readConfig } from '../src/env';
import { member, membership, message, payment, variant } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Every job of every group, as the cron runs them in production (runScheduled, SCHEDULE), against
 * the real migrations (PGlite) and a community Whop serves: none fails, each is recorded in
 * Settings › Status (job_runs), nothing lands in the error log, and each does its part (members
 * read, chats named, scores, actions planned in manual mode, nothing sent).
 */

let t: TestDb;
const C = 'biz_Jobs1';
// Monday 5 October 2026: the sync at 7:05, the weekly jobs at 7:30, the hourly ones at 8:00 UTC.
const SYNC_AT = new Date('2026-10-05T07:05:00Z');
const WEEKLY_AT = new Date('2026-10-05T07:30:00Z');
const HOURLY_AT = new Date('2026-10-05T08:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [
    C,
    SYNC_AT.toISOString(),
  ]);
  // Its team opened StayPut: the cron reads it.
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', $2::timestamptz)`,
    [C, SYNC_AT.toISOString()],
  );
});
afterAll(() => t.close());

/** Whop for this community: its lists page by page, and every other call answered. */
function fakeWhop() {
  const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T12:00:00.000Z`;
  const lists: Record<string, unknown[]> = {
    '/variants': [variant('plan_JobsV1')],
    '/members': [1, 2, 3].map((i) =>
      member(`mber_Jobs${i}`, `user_Jobs${i}`, {
        joined_at: day(i),
        created_at: day(i),
        // The third went quiet a month ago: someone at risk.
        most_recent_action_at: i === 3 ? day(4) : day(28),
      }),
    ),
    '/memberships': [1, 2, 3].map((i) =>
      membership(`mem_Jobs${i}`, `user_Jobs${i}`, {
        account: { id: C },
        plan_id: 'plan_JobsV1',
        created_at: day(i),
      }),
    ),
    '/payments': [1, 2, 3].map((i) =>
      payment(`pay_Jobs${i}`, {
        membership_id: `mem_Jobs${i}`,
        member_id: `mber_Jobs${i}`,
        created_at: day(i),
      }),
    ),
    '/chat_channels': [{ id: 'chat_Jobs1', experience: { id: 'exp_Jobs1', name: 'General' } }],
    '/messages?chat_Jobs1': [29, 28, 27].map((d) =>
      message(`msg_Jobs${d}`, `user_Jobs${(d % 2) + 1}`, day(d)),
    ),
  };
  const calls: string[] = [];
  const whop = {
    env: 'sandbox',
    listPageRaw(path: string, query: Record<string, QueryValue> = {}) {
      const scope = query.channel_id ?? query.experience_id ?? query.course_id;
      const key = scope ? `${path}?${String(scope)}` : path;
      calls.push(`list ${key}`);
      return Promise.resolve(
        JSON.stringify({
          data: lists[key] ?? [],
          page_info: { end_cursor: null, has_next_page: false },
        }),
      );
    },
    getRaw(path: string) {
      calls.push(`get ${path}`);
      return Promise.resolve(JSON.stringify({ id: path.split('/').pop(), username: null }));
    },
    request: vi.fn((method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path === '/permissions') return Promise.resolve({ data: [{ granted: true }] });
      return Promise.resolve(path === '/support_channels' ? { id: 'supp_Jobs' } : {});
    }),
  } as unknown as WhopClient;
  return { whop, calls };
}

const run = async (group: JobGroup, now: Date, whop: WhopClient) => {
  expect(groupAt(now)).toBe(group);
  const ctx: JobContext = {
    config: readConfig({}),
    db: t.db as ClosableDb,
    whop,
    syncWhop: whop,
    discord: null,
    telegram: null,
    now,
  };
  return runScheduled(group, SCHEDULE, ctx);
};

describe('the cron’s jobs, for real', () => {
  it('runs every job of every group without a failure, each recorded', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { whop, calls } = fakeWhop();

    const sync = await run('sync', SYNC_AT, whop);
    expect(sync).toEqual({ ran: SCHEDULE.sync.map((j) => j.name), failed: [] });
    const weekly = await run('weekly', WEEKLY_AT, whop);
    expect(weekly).toEqual({ ran: SCHEDULE.weekly.map((j) => j.name), failed: [] });
    const hourly = await run('hourly', HOURLY_AT, whop);
    expect(hourly).toEqual({ ran: SCHEDULE.hourly.map((j) => j.name), failed: [] });
    info.mockRestore();

    // Settings › Status: every job ran once, well; the error log is empty.
    const runs = await t.db.query<{ job: string; runs: number; failures: number }>(
      'select job, runs, failures from stayput.job_runs order by job',
    );
    const every = [...SCHEDULE.sync, ...SCHEDULE.weekly, ...SCHEDULE.hourly].map((j) => j.name);
    expect(runs.map((r) => r.job).sort()).toEqual([...every].sort());
    expect(runs.every((r) => r.runs === 1 && r.failures === 0)).toBe(true);
    const [errors] = await t.db.query<{ n: number }>(
      'select count(*)::int as n from stayput.error_log',
    );
    expect(errors?.n).toBe(0);

    // The sync read the community from Whop, its chat by name (Integrations › Whop).
    const [members] = await t.db.query<{ n: number }>(
      'select count(*)::int as n from stayput.members where company_id = $1',
      [C],
    );
    expect(members?.n).toBe(3);
    expect(calls).toContain('list /members');
    const [place] = await t.db.query<{ name: string }>(
      `select name from stayput.whop_places where company_id = $1 and id = 'chat_Jobs1'`,
      [C],
    );
    expect(place?.name).toBe('General');

    // The hour scored every member; a new community is in manual mode: nothing went to Whop
    // but the access check.
    const [scored] = await t.db.query<{ n: number }>(
      'select count(*)::int as n from stayput.member_risk where company_id = $1',
      [C],
    );
    expect(scored?.n).toBe(3);
    expect(calls.filter((c) => /^(POST|PATCH) /.test(c))).toEqual([]);
  });
});
