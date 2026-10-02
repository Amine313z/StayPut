import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROFILES,
  planActionsNow,
  removeSeed,
  runSeed,
  seedMembers,
} from '../../../scripts/seed/sandbox-members';
import { runJourney } from '../../../scripts/seed/member-journey';
import { readMembers } from '../src/members';
import { readPublicProof } from '../src/space';
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
    for (const m of [...ofProfile('newcomer'), ...ofProfile('inactive_newcomer')]) {
      expect(m.joinedAt.getTime()).toBeGreaterThan(NOW.getTime() - 8 * DAY);
    }
    for (const m of ofProfile('inactive_newcomer')) {
      expect(await messages(m.memberId, 8, 0), m.name).toBe(0);
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

  it('gives each trigger of the actions something to act on (SPEC Phase 4)', async () => {
    expect(await planActionsNow(t.db, COMPANY, NOW)).toBeGreaterThanOrEqual(8);
    const planned = await t.db.query<{ type: string; n: number }>(
      `select type, count(*)::int as n from stayput.actions where company_id = $1
        group by type order by type`,
      [COMPANY],
    );
    expect(Object.fromEntries(planned.map((row) => [row.type, row.n]))).toMatchObject({
      // Declined 30, 10 and 5 hours ago; StayPut retries only the one Whop leaves to it.
      payment_failed_notice: 3,
      payment_retry: 1,
      // An active member's renewal waiting for the bank's check.
      payment_action_notice: 1,
      exit_survey: 3,
    });
  });

  it('gives fresh payment problems on a company seeded days before', async () => {
    // Whop never changes when a payment was created: an earlier run's payments keep their date.
    // Payment ids are Whop's, unique across companies: a database of its own.
    const other = await createTestDb();
    try {
      await other.db.query('select stayput.ensure_company($1, $2::timestamptz)', [
        COMPANY,
        NOW.toISOString(),
      ]);
      await runSeed(other.db, COMPANY, new Date(NOW.getTime() - 5 * DAY));
      await runSeed(other.db, COMPANY, NOW);
      const problems = await other.db.query<{ status: string }>(
        `select status from stayput.payments where company_id = $1 and id like 'pay\\_seed%x%'
          order by status`,
        [COMPANY],
      );
      // Only this run's: three declined renewals and one waiting for the bank.
      expect(problems.map((p) => p.status)).toEqual([
        'failed',
        'failed',
        'failed',
        'requires_action',
      ]);
      await other.db.query('select stayput.plan_actions($1, $2::timestamptz)', [
        COMPANY,
        NOW.toISOString(),
      ]);
      const planned = await other.db.query<{ type: string; n: number }>(
        `select type, count(*)::int as n from stayput.actions where company_id = $1
          group by type order by type`,
        [COMPANY],
      );
      expect(Object.fromEntries(planned.map((row) => [row.type, row.n]))).toMatchObject({
        payment_failed_notice: 3,
        payment_retry: 1,
        payment_action_notice: 1,
      });
    } finally {
      await other.close();
    }
  });

  it('walks a fake member from the goal to the testimonial card (SPEC Phase 5)', async () => {
    const lines = await runJourney(t.db, COMPANY, NOW, 'https://stayput.test');
    expect(lines.slice(0, 5)).toEqual([
      '### Le parcours de Léa Moreau',
      expect.stringMatching(/^1\. Objectif fixé : 0 € → 3 000 € d’ici le \d{4}-\d{2}-\d{2}\.$/),
      '2. Résultat 800 € — jalons : 25 % — badges : first_result, milestone_25',
      '3. Résultat 1650 € (capture : justified) — jalons : 50 % — badges : first_proof, milestone_50',
      '4. Résultat 2400 € — jalons : 75 % — badges : milestone_75',
    ]);
    const url = /^5\. Carte témoignage créée : (https:\/\/stayput\.test\/v\/[0-9a-f-]{36})$/.exec(
      lines[5] ?? '',
    )?.[1];
    expect(url).toBeDefined();
    // Its public page, as anyone opening the card's QR code reads it.
    expect(await readPublicProof(t.db, url!.slice(-36))).toMatchObject({
      level: 'justified',
      display: {
        goal: 'Atteindre 3 000 € de chiffre d’affaires mensuel',
        value: 1650,
        progress: 55,
        name: 'Léa Moreau',
      },
    });
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
      'goals',
      'results',
      'proofs',
      'member_badges',
    ]) {
      expect(await count(table), table).toBe(0);
    }
  });
});
