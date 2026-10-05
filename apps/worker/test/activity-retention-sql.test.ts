import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0041 (SPEC Phase 8.4): a member's detailed activity is kept 12 months, then only its
 * daily counts; and those counts are never computed again from events partly gone.
 */

const NOW = new Date('2026-10-05T09:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await t.db.query(
    `insert into stayput.companies (id, name, timezone) values ('biz_Ret', 'Club', 'UTC')`,
  );
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, status)
     values ('mber_Ret', 'biz_Ret', 'user_Ret', 'joined')`,
  );
  for (const [days, n] of [
    [400, 1],
    [370, 2],
    [30, 3],
  ] as const) {
    for (let i = 0; i < n; i++) {
      await t.db.query(
        `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id)
         values ('biz_Ret', 'mber_Ret', 'message', $1::timestamptz, $2)`,
        [daysAgo(days), `ret_${days}_${i}`],
      );
    }
  }
  await t.db.query(
    `select stayput.refresh_activity_stats('biz_Ret', $1::timestamptz, $2::timestamptz)`,
    [daysAgo(500), daysAgo(380)],
  );
});
afterAll(() => t.close());

const counts = async () =>
  (
    await t.db.query<{ day: string; messages: number }>(
      `select to_char(day, 'YYYY-MM-DD') as day, messages from stayput.member_stats_daily
        where company_id = 'biz_Ret' order by day`,
    )
  ).map((r) => `${r.day}:${r.messages}`);

describe('the activity kept', () => {
  it('deletes the events older than 12 months, and keeps their counts', async () => {
    // Counted while they were recent (the setup's run, 380 days ago).
    const before = await counts();
    expect(before).toEqual(['2025-08-31:1', '2025-09-30:2', '2026-09-05:3']);
    const refreshFromFarBack = () =>
      t.db.query(
        `select stayput.refresh_activity_stats('biz_Ret', $1::timestamptz, $2::timestamptz)`,
        [daysAgo(500), NOW.toISOString()],
      );
    await refreshFromFarBack();
    expect(await counts()).toEqual(before);
    const [purged] = await t.db.query<{ count: number }>(
      'select stayput.purge_old_activity($1::timestamptz) as count',
      [NOW.toISOString()],
    );
    expect(purged?.count).toBe(3);
    // Asked again from far back: the days whose events are gone keep their counts.
    await refreshFromFarBack();
    expect(await counts()).toEqual(before);
    const [left] = await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.activity_events where company_id = 'biz_Ret'`,
    );
    expect(left?.n).toBe(3);
  });
});
