import { DEFAULT_SAVE_RATE, DEFAULT_STAY } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readInsightsOverview } from '../src/analytics';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Analytics › Overview (brief v4 §9.5): the forecast's figures (SPEC 6.5), the departure
 * survey's reasons (SPEC 6.8) and the members' activity, read under RLS as the team, every
 * figure checked against a community built by hand.
 */

// 15 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-15T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();
const date = (n: number) => days(n).slice(0, 10);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const C = 'biz_Ana1';
const EMPTY = 'biz_Ana2';

async function company(id: string) {
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale, mode)
     values ($1, 'Le Club', 'Europe/Paris', 'fr', 'manual')`,
    [id],
  );
  // RLS checks the team's access against the database's own clock (is_company_admin).
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', now())`,
    [id],
  );
}

async function member(
  name: string,
  options: {
    price?: number;
    currency?: string;
    level?: string;
    left?: number;
    canceling?: boolean;
    admin?: boolean;
  } = {},
) {
  const id = `mber_${name}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                  access_level)
     values ($1, $2, $3, $4, $5::timestamptz, $6, $7)`,
    [
      id,
      C,
      `user_${name}`,
      name,
      days(-200),
      options.left === undefined ? 'joined' : 'left',
      options.admin ? 'admin' : null,
    ],
  );
  if (options.price !== undefined || options.left !== undefined) {
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status,
                                        cancel_at_period_end, current_period_end)
       values ($1, $2, $3, $4, 'prod_Club', 'plan_Month', $5, $6, 30, $7, $8, $9::timestamptz)`,
      [
        `mem_${name}`,
        C,
        id,
        `user_${name}`,
        options.price ?? 19,
        options.currency ?? 'eur',
        options.left !== undefined ? 'expired' : options.canceling ? 'canceling' : 'active',
        !!options.canceling,
        days(options.left ?? 20),
      ],
    );
  }
  if (options.level) {
    await t.db.query(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                        level_since, computed_at)
       values ($1, $2, 50, $3, '{}', $4::timestamptz, $4::timestamptz)`,
      [C, id, options.level, days(-1)],
    );
  }
  return id;
}

async function scored(memberId: string, level: string, ago: number) {
  await t.db.query(
    `insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores,
                                      computed_at, day)
     values ($1, $2, 50, $3, '{}', $4::timestamptz, $5::date)`,
    [C, memberId, level, days(-ago), date(-ago)],
  );
}

async function sent(memberId: string, type: string, ago: number, status = 'sent') {
  await t.db.query(
    `insert into stayput.actions (company_id, member_id, type, status, trigger, send_at, sent_at)
     values ($1, $2, $3, $4, 'test', $5::timestamptz, $5::timestamptz)`,
    [C, memberId, type, status, days(-ago)],
  );
}

describe('Analytics › Overview (brief v4 §9.5)', () => {
  beforeAll(async () => {
    await company(C);
    await company(EMPTY);
    // Paying now: the team aside, the euro members (the community's currency) by level.
    await member('Owner', { admin: true, price: 500, level: 'high' });
    await member('Lea', { price: 49, level: 'high' });
    await member('Paul', { price: 99, level: 'scheduled_departure', canceling: true });
    await member('Ines', { price: 29, level: 'low' });
    // Not scored yet: counted with the members at low risk.
    await member('Zoe', { price: 29 });
    await member('Mia', { price: 59, level: 'medium' });
    await member('Sam', { price: 10, currency: 'usd', level: 'high' });

    // History from 61 days ago. Twelve members at medium risk 30 days ago, three of whom left
    // since: 75 % stayed. Six at high risk 60 and 30 days ago: too few to judge.
    const past = [];
    for (let i = 1; i <= 12; i++) {
      past.push(await member(`P${i}`, i > 9 ? { left: -10 } : {}));
    }
    for (const id of past) await scored(id, 'medium', 30);
    for (const id of past.slice(0, 3)) await scored(id, 'high', 60);
    await scored(past[0]!, 'low', 61);
    for (const id of ['mber_Lea', 'mber_Mia', 'mber_Ines']) await scored(id, 'high', 30);

    // StayPut reached ten members at risk between 90 and 14 days ago, four of whom it saved.
    for (const [i, id] of past.slice(0, 10).entries()) {
      await sent(id, i % 2 ? 'high_risk_message' : 'payment_retry', 40);
      if (i < 4) {
        await t.db.query(
          `insert into stayput.saves (company_id, member_id, save_type, category, amount, currency,
                                      payment_id, saved_at)
           values ($1, $2, 'payment_recovered', 'direct', 49, 'EUR', $3, $4::timestamptz)`,
          [C, id, `pay_S${i}`, days(-35)],
        );
      }
    }
    // Not judged: too recent, a welcome, simulated in test mode.
    await sent(past[10]!, 'high_risk_message', 3);
    await sent(past[11]!, 'welcome_message', 40);
    await sent('mber_Lea', 'high_risk_message', 40, 'simulated');

    // The departure survey: six answers in 90 days, one older, one never answered.
    const answers: [string, string | null, number][] = [
      ['Lea', 'too_expensive', 2],
      ['Paul', 'too_expensive', 10],
      ['Mia', 'too_expensive', 30],
      ['Ines', 'no_time', 5],
      ['Zoe', 'no_time', 60],
      ['Sam', 'other', 1],
      ['P1', 'no_results', 100],
      ['P2', null, 1],
    ];
    for (const [name, reason, ago] of answers) {
      await t.db.query(
        `insert into stayput.exit_surveys (company_id, member_id, reason, created_at, answered_at)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
        [C, `mber_${name}`, reason, days(-ago - 1), reason ? days(-ago) : null],
      );
    }

    // What members did: Ines two days ago, Lea today; the team and older days never count.
    await t.db.query(
      `insert into stayput.member_stats_daily (company_id, member_id, day, messages, reactions,
                                               forum_posts, lessons_completed, stayput_actions)
       values ($1, 'mber_Ines', $2::date, 4, 1, 0, 0, 3),
              ($1, 'mber_Lea', $3::date, 2, 0, 1, 1, 0),
              ($1, 'mber_Owner', $2::date, 50, 0, 0, 0, 0),
              ($1, 'mber_Ines', $4::date, 9, 0, 0, 0, 0)`,
      [C, date(-2), date(0), date(-31)],
    );
  });

  it('sums what each risk level brings in a month, in the community’s currency', async () => {
    const view = await readInsightsOverview(t.db, 'user_Owner', C, NOW);
    expect(view!.currency).toBe('EUR');
    expect(view!.revenue).toEqual({ low: 58, medium: 59, high: 49, scheduled_departure: 99 });
  });

  it('uses the community’s own month where 10 members tell it, StayPut’s elsewhere', async () => {
    const view = await readInsightsOverview(t.db, 'user_Owner', C, NOW);
    expect(view!.calibrated).toEqual(['medium']);
    expect(view!.stay).toEqual({ ...DEFAULT_STAY, medium: 0.75 });
  });

  it('measures what acting saved: four of the ten members at risk reached', async () => {
    const view = await readInsightsOverview(t.db, 'user_Owner', C, NOW);
    expect(view!.saveRate).toBe(0.4);
    expect(view!.saveRateObserved).toBe(true);
  });

  it('counts the departure survey’s answers of 90 days, the most frequent first', async () => {
    const view = await readInsightsOverview(t.db, 'user_Owner', C, NOW);
    expect(view!.reasons).toEqual([
      { reason: 'too_expensive', count: 3 },
      { reason: 'no_time', count: 2 },
      { reason: 'other', count: 1 },
    ]);
  });

  it('gives the 30 days of activity, every day, the team aside', async () => {
    const view = await readInsightsOverview(t.db, 'user_Owner', C, NOW);
    expect(view!.activity).toHaveLength(30);
    expect(view!.activity[0]!.day).toBe(date(-29));
    expect(view!.activity.at(-1)).toEqual({ day: date(0), actions: 4, members: 1 });
    expect(view!.activity.at(-3)).toEqual({ day: date(-2), actions: 5, members: 1 });
    expect(view!.activity.reduce((total, d) => total + d.actions, 0)).toBe(9);
  });

  it('starts from StayPut’s figures for a new community', async () => {
    const view = await readInsightsOverview(t.db, 'user_Owner', EMPTY, NOW);
    expect(view).toEqual({
      currency: null,
      revenue: { low: 0, medium: 0, high: 0, scheduled_departure: 0 },
      stay: DEFAULT_STAY,
      calibrated: [],
      saveRate: DEFAULT_SAVE_RATE,
      saveRateObserved: false,
      reasons: [],
      activity: expect.any(Array) as unknown,
    });
    expect(view!.activity.every((d) => d.actions === 0 && d.members === 0)).toBe(true);
  });

  it('is the team’s only', async () => {
    await expect(readInsightsOverview(t.db, 'user_Stranger', C, NOW)).resolves.toBeNull();
  });
});
