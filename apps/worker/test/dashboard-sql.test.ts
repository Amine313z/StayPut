import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDashboard, readFeed } from '../src/dashboard';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The home of the dashboard (SPEC Phase 6.2): the money first, read under RLS as the team, every
 * figure checked against a community built by hand.
 */

// 15 October 2026, 10:00 in Paris: the month began on 30 September at 22:00 UTC.
const NOW = new Date('2026-10-15T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const C = 'biz_Home1';

async function member(
  name: string,
  joined: number,
  options: {
    price?: number;
    status?: 'joined' | 'left';
    endedAt?: number;
    canceling?: boolean;
    level?: string;
    admin?: boolean;
    dnc?: boolean;
  } = {},
) {
  const id = `mber_${name}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                  access_level, do_not_contact)
     values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`,
    [
      id,
      C,
      `user_${name}`,
      name,
      days(joined),
      options.status ?? 'joined',
      options.admin ? 'admin' : null,
      !!options.dnc,
    ],
  );
  if (options.price !== undefined) {
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status,
                                        cancel_at_period_end, current_period_end, canceled_at)
       values ($1, $2, $3, $4, 'prod_Club', 'plan_Month', $5, 'eur', 30, $6, $7,
               $8::timestamptz, $9::timestamptz)`,
      [
        `mem_${name}`,
        C,
        id,
        `user_${name}`,
        options.price,
        options.status === 'left' ? 'expired' : options.canceling ? 'canceling' : 'active',
        !!options.canceling,
        days(options.endedAt ?? 20),
        options.canceling ? days(-1) : null,
      ],
    );
  }
  if (options.level) {
    await t.db.query(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                        level_since, computed_at)
       values ($1, $2, $3, $4, '{}', $5::timestamptz, $5::timestamptz)`,
      [C, id, options.level === 'low' ? 10 : 80, options.level, days(-1)],
    );
  }
  return id;
}

async function action(memberId: string, type: string, status: string, at: number, kind = 'none') {
  await t.db.query(
    `insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                  send_at, sent_at)
     values ($1, $2, $3, $4, 'test', $5, $6::timestamptz, $7::timestamptz)`,
    [
      C,
      memberId,
      type,
      status,
      kind,
      days(at),
      status === 'sent' || status === 'simulated' ? days(at) : null,
    ],
  );
}

async function save(memberId: string, category: string, amount: number, at: number, id: string) {
  await t.db.query(
    `insert into stayput.saves (company_id, member_id, save_type, category, amount, currency,
                                payment_id, saved_at)
     values ($1, $2, $3, $4, $5, 'EUR', $6, $7::timestamptz)`,
    [
      C,
      memberId,
      category === 'direct' ? 'payment_recovered' : 'renewal_after_message',
      category,
      amount,
      id,
      days(at),
    ],
  );
}

describe('the home of the dashboard', () => {
  beforeAll(async () => {
    await t.db.query(
      `insert into stayput.companies (id, name, timezone, locale, mode)
       values ($1, 'Le Club', 'Europe/Paris', 'fr', 'manual')`,
      [C],
    );
    await t.db.query(
      `insert into stayput.company_settings (company_id, dry_run) values ($1, true)`,
      [C],
    );
    // RLS checks the team's access against the database's own clock (is_company_admin).
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_Owner', now())`,
      [C],
    );
    await member('Owner', -200, { admin: true, price: 500, level: 'high' });
    const lea = await member('Lea', -60, { price: 49, level: 'high' });
    const paul = await member('Paul', -60, {
      price: 99,
      canceling: true,
      level: 'scheduled_departure',
    });
    const ines = await member('Ines', -40, { price: 29, level: 'low' });
    await member('Max', -45, { price: 19, status: 'left', endedAt: -10 });
    await member('Old', -90, { price: 19, status: 'left', endedAt: -60 });
    await member('Zoe', -3, { price: 29, level: 'low' });
    await member('Calm', -70, { price: 15, level: 'high', dnc: true });

    await t.db.query(
      `insert into stayput.member_stats_daily (company_id, member_id, day, messages, reactions)
       values ($1, $2, $3::date, 4, 1), ($1, 'mber_Owner', $3::date, 50, 0)`,
      [C, ines, days(-2).slice(0, 10)],
    );
    // StayPut proposes a departure survey to Paul; it did three things over 30 days.
    await action(paul, 'exit_survey', 'proposed', 0, 'service');
    await action(ines, 'high_risk_message', 'simulated', -2, 'relance');
    await action(ines, 'payment_retry', 'sent', -3);
    await action(ines, 'pause_offer', 'sent', -4);
    await action(lea, 'welcome_message', 'sent', -40, 'relance');

    await save(ines, 'direct', 49, -1, 'pay_A');
    await save(ines, 'influenced', 29, -2, 'pay_B');
    await save(ines, 'direct', 20, -20, 'pay_C');
    await save(ines, 'direct', 999, -60, 'pay_D');

    for (const [day, levels] of [
      [-1, ['high', 'high', 'scheduled_departure', 'low']],
      [-2, ['high', 'medium', 'low', 'low']],
    ] as const) {
      const ids = [lea, 'mber_Calm', paul, ines];
      for (const [i, level] of levels.entries()) {
        await t.db.query(
          `insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores,
                                            computed_at, day)
           values ($1, $2, 50, $3, '{}', $4::timestamptz, $5::date)`,
          [C, ids[i], level, days(day), days(day).slice(0, 10)],
        );
      }
    }
  });

  it('puts the money first: saved this month, at risk, members at risk, retention', async () => {
    const view = await readDashboard(t.db, 'user_Owner', C, NOW);
    expect(view).toEqual({
      currency: 'EUR',
      saved: {
        thisMonth: { direct: 49, influenced: 29, saves: 2 },
        lastMonth: { direct: 20 },
        otherCurrencies: false,
      },
      // Lea 49, Paul 99, Ines 29, Zoe 29, Calm 15: never the team's own membership.
      monthlyRevenue: 221,
      atRisk: { revenue: 163, members: 3, departures: 1, high: 2 },
      // Here 30 days ago: Lea, Paul, Ines, Max (who left 10 days ago), Calm. Still here: 4.
      retention30: { rate: 0.8, kept: 4, base: 5 },
      members: { total: 5, newLast7Days: 1 },
      memberActivity30d: 5,
      stayputActions30d: { total: 3, messages: 1, paymentRetries: 1, offers: 1 },
      mode: 'manual',
      testMode: true,
      riskHistory: [
        { day: days(-2).slice(0, 10), departure: 0, high: 1, medium: 1, low: 2 },
        { day: days(-1).slice(0, 10), departure: 1, high: 2, medium: 0, low: 1 },
      ],
      // Approving the survey protects 99 a month; messaging Lea (Calm: never contact) 49.
      priority: { kind: 'approve', actions: 1, members: 1, revenue: 99 },
    });
  });

  it('turns to the members at high risk nobody reached once nothing waits', async () => {
    await t.db.query(
      `update stayput.actions set status = 'cancelled' where company_id = $1 and status = 'proposed'`,
      [C],
    );
    const view = await readDashboard(t.db, 'user_Owner', C, NOW);
    expect(view?.priority).toEqual({ kind: 'message', memberIds: ['mber_Lea'], revenue: 49 });
  });

  it('is the team’s only', async () => {
    await expect(readDashboard(t.db, 'user_Stranger', C, NOW)).resolves.toBeNull();
  });

  it('tells what just happened, newest first, never the team’s own doings', async () => {
    const { items } = await readFeed(t.db, 'user_Owner', C, NOW);
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort().reverse());
    expect(items.some((i) => i.memberId === 'mber_Owner')).toBe(false);
    expect(items.find((i) => i.event === 'saved')).toMatchObject({
      by: 'stayput',
      amount: 49,
      currency: 'EUR',
    });
    expect(items.find((i) => i.event === 'message_simulated')).toMatchObject({
      by: 'stayput',
      memberName: 'Ines',
    });
    expect(items.find((i) => i.event === 'joined' && i.memberName === 'Zoe')).toBeDefined();
    expect(items.find((i) => i.event === 'cancellation_scheduled')).toMatchObject({
      memberName: 'Paul',
    });
  });
});
