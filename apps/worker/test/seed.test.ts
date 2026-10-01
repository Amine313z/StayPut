import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILES, removeSeed, runSeed, seedMembers } from '../../../scripts/seed/sandbox-members';
import { readMembers } from '../src/members';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * scripts/seed-sandbox.ts (SPEC Phase 2, 6): the fake members go through the same SQL functions
 * as Whop's data, show the five profiles the next phases are tested on, and leave entirely.
 */

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const COMPANY = 'biz_SeedTest';
const DAY = 86_400_000;
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [
    COMPANY,
    NOW.toISOString(),
  ]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_owner', now())`,
    [COMPANY],
  );
  await runSeed(t.db, COMPANY, NOW);
});
afterAll(() => t.close());

/** Messages of a member between `from` and `to` days ago. */
async function messages(memberId: string, from: number, to: number) {
  const [row] = await t.db.query<{ n: number }>(
    `select count(*)::int as n from stayput.activity_events
      where company_id = $1 and member_id = $2 and type = 'message'
        and occurred_at <= $3::timestamptz and occurred_at > $4::timestamptz`,
    [
      COMPANY,
      memberId,
      new Date(NOW.getTime() - to * DAY).toISOString(),
      new Date(NOW.getTime() - from * DAY).toISOString(),
    ],
  );
  return row?.n ?? 0;
}

const ofProfile = (profile: string) => seedMembers(NOW).filter((m) => m.profile === profile);

describe('the sandbox seed', () => {
  it('makes 25 members, each with a membership, payments and a history', async () => {
    const total = PROFILES.reduce((n, [, count]) => n + count, 0);
    expect(total).toBe(25);
    const page = await readMembers(t.db, 'user_owner', COMPANY, NOW);
    expect(page.summary).toMatchObject({
      members: 25,
      liveMemberships: 25,
      scheduledCancellations: 3,
      failedPayments: 3,
    });
    expect(page.summary.activity30d).toBeGreaterThan(200);
    expect(page.members.every((m) => m.membership?.price === 49)).toBe(true);
  });

  it('gives each profile its pattern of activity', async () => {
    for (const m of ofProfile('active')) {
      expect(await messages(m.memberId, 14, 0), m.name).toBeGreaterThan(5);
    }
    for (const m of ofProfile('declining')) {
      const before = await messages(m.memberId, 60, 31);
      const lately = await messages(m.memberId, 14, 0);
      expect(before, m.name).toBeGreaterThan(lately * 4);
    }
    for (const m of ofProfile('inactive')) {
      expect(await messages(m.memberId, 21, 0), m.name).toBe(0);
      expect(await messages(m.memberId, 60, 22), m.name).toBeGreaterThan(0);
    }
    for (const m of ofProfile('newcomer')) {
      expect(m.joinedAt.getTime()).toBeGreaterThan(NOW.getTime() - 8 * DAY);
    }
  });

  it('computes the daily statistics of the history', async () => {
    const [stats] = await t.db.query<{ days: number; messages: number }>(
      `select count(distinct day)::int as days, sum(messages)::int as messages
         from stayput.member_stats_daily where company_id = $1`,
      [COMPANY],
    );
    expect(stats?.days).toBeGreaterThan(50);
    const [events] = await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.activity_events
        where company_id = $1 and type = 'message'`,
      [COMPANY],
    );
    expect(stats?.messages).toBe(events?.n);
  });

  it('is the same members when run again, and leaves without a trace', async () => {
    await runSeed(t.db, COMPANY, NOW);
    const count = async (table: string) =>
      (
        await t.db.query<{ n: number }>(
          `select count(*)::int as n from stayput.${table} where company_id = $1`,
          [COMPANY],
        )
      )[0]?.n;
    expect(await count('members')).toBe(25);

    expect(await removeSeed(t.db, COMPANY, NOW)).toEqual({
      members: 25,
      memberships: 25,
      payments: expect.any(Number) as number,
    });
    for (const table of [
      'members',
      'memberships',
      'payments',
      'activity_events',
      'member_stats_daily',
      'activity_hours',
      'pending_activity',
      'plans',
    ]) {
      expect(await count(table), table).toBe(0);
    }
  });
});
