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
    const old = await member('Old', -120, { price: 19, status: 'left', endedAt: -60 });
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
    // Lea: a renewal after a message (not money StayPut saved itself), and a payment saved on
    // 15 September at 19:36 in Paris, 30 calendar days ago: neither is in « members saved ».
    await save(lea, 'influenced', 49, -5, 'pay_E');
    await save(lea, 'direct', 49, -29.6, 'pay_F');
    // 7 July: before the 90 days, in the first month of the chart.
    await save(old, 'direct', 19, -100, 'pay_G');

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
    const { revenueHistory, ...rest } = view!;
    expect(rest).toEqual({
      currency: 'EUR',
      saved: {
        thisMonth: { direct: 49, influenced: 78, saves: 3 },
        lastMonth: { direct: 69 },
        otherCurrencies: false,
      },
      // Lea 49, Paul 99, Ines 29, Zoe 29, Calm 15: never the team's own membership.
      monthlyRevenue: 221,
      atRisk: { revenue: 163, members: 3, departures: 1, high: 2 },
      // Here 30 days ago: Lea, Paul, Ines, Max (who left 10 days ago), Calm. Still here: 4.
      retention30: { rate: 0.8, kept: 4, base: 5 },
      members: { total: 5, newLast7Days: 1 },
      memberActivity30d: 5,
      // The pause action applies an accepted offer: no survey or creator offer made one here.
      // Saved: Ines alone, twice (the chart's last 30 days, 16 September to today).
      stayputActions30d: {
        total: 3,
        messages: 1,
        paymentRetries: 1,
        offers: 1,
        pauses: 0,
        saved: 1,
      },
      mode: 'manual',
      testMode: true,
      riskHistory: [
        { day: days(-2).slice(0, 10), departure: 0, high: 1, medium: 1, low: 2 },
        { day: days(-1).slice(0, 10), departure: 1, high: 2, medium: 0, low: 1 },
      ],
      gettingStarted: { discord: false, automation: false, reviewed: false, guardrails: false },
      welcomed: false,
      // Approving the survey protects 99 a month; messaging Lea (Calm: never contact) 49.
      priority: { kind: 'approve', actions: 1, members: 1, revenue: 99 },
    });

    // In the community's calendar, from the 1st of the month 89 days ago (18 July) to today:
    // each month whole, so that its balance adds up from its 1st.
    expect(revenueHistory).toHaveLength(107);
    expect(revenueHistory[0]?.day).toBe('2026-07-01');
    expect(revenueHistory.at(-1)?.day).toBe('2026-10-15');
    const on = (day: string) => revenueHistory.find((d) => d.day === day);
    expect(on('2026-07-07')).toEqual({ day: '2026-07-07', saved: 19, atRisk: null });
    expect(on('2026-09-15')).toEqual({ day: '2026-09-15', saved: 49, atRisk: null });
    // The month's days add up to the hero's figure.
    const october = revenueHistory.filter((d) => d.day.startsWith('2026-10'));
    expect(october.reduce((total, d) => total + d.saved, 0)).toBe(rest.saved.thisMonth.direct);
    // Today: the live figure of the hero row (Lea 49, Paul 99, Calm 15).
    expect(on('2026-10-15')).toEqual({ day: '2026-10-15', saved: 0, atRisk: 163 });
    // Yesterday: 49 saved; Lea and Calm high, Paul leaving.
    expect(on('2026-10-14')).toEqual({ day: '2026-10-14', saved: 49, atRisk: 163 });
    // The day before: only Lea high; the influenced 29 is not money StayPut saved itself.
    expect(on('2026-10-13')).toEqual({ day: '2026-10-13', saved: 0, atRisk: 49 });
    // Before the first score, no risk figure rather than a zero.
    expect(on('2026-09-25')).toEqual({ day: '2026-09-25', saved: 20, atRisk: null });
    expect(on('2026-08-16')).toEqual({ day: '2026-08-16', saved: 999, atRisk: null });
  });

  it('counts the pauses offered and what the setup checklist has done', async () => {
    const lea = 'mber_Lea';
    await t.db.query(
      `insert into stayput.exit_surveys (company_id, member_id, reason, offer_type, created_at,
                                         answered_at)
       values ($1, $2, 'no_time', 'pause_offer', $3::timestamptz, $3::timestamptz),
              ($1, $2, 'no_time', 'pause_offer', $4::timestamptz, $4::timestamptz),
              ($1, $2, 'too_expensive', 'promo_offer', $3::timestamptz, $3::timestamptz)`,
      [C, lea, days(-3), days(-45)],
    );
    await t.db.query(
      `insert into stayput.creator_offers (company_id, member_id, membership_id, kind, terms,
                                           created_by, created_at, expires_at)
       values ($1, $2, 'mem_Lea', 'pause_offer', '{"days": 30}', 'user_Owner', $3::timestamptz,
               $3::timestamptz + interval '7 days')`,
      [C, lea, days(-1)],
    );
    await t.db.query(
      `insert into stayput.discord_guilds (guild_id, company_id, connected_at)
       values ('123456789', $1, $2::timestamptz)`,
      [C, days(-2)],
    );
    await t.db.query(
      `update stayput.company_settings set guardrails_saved_at = $2::timestamptz,
              at_risk_reviewed_at = $2::timestamptz where company_id = $1`,
      [C, days(-1)],
    );
    const view = await readDashboard(t.db, 'user_Owner', C, NOW);
    // The survey 3 days ago and the creator's own offer; not the one 45 days ago, not a promo.
    expect(view?.stayputActions30d.pauses).toBe(2);
    // Manual mode and nothing approved by hand yet: no automation running.
    expect(view?.gettingStarted).toEqual({
      discord: true,
      automation: false,
      reviewed: true,
      guardrails: true,
    });
    // The welcome was not seen yet: it opens by itself (brief v4 §10).
    expect(view?.welcomed).toBe(false);
    await t.db.query(`select stayput.getting_started_done($1, 'welcomed', $2::timestamptz)`, [
      C,
      days(-1),
    ]);
    expect((await readDashboard(t.db, 'user_Owner', C, NOW))?.welcomed).toBe(true);
    await t.db.query(
      `update stayput.company_settings set welcomed_at = null where company_id = $1`,
      [C],
    );
    await t.db.query(`update stayput.companies set mode = 'auto' where id = $1`, [C]);
    expect((await readDashboard(t.db, 'user_Owner', C, NOW))?.gettingStarted.automation).toBe(true);
    await t.db.query(`update stayput.companies set mode = 'manual' where id = $1`, [C]);
    await t.db.query(`delete from stayput.discord_guilds where company_id = $1`, [C]);
    await t.db.query(
      `update stayput.company_settings set guardrails_saved_at = null, at_risk_reviewed_at = null
        where company_id = $1`,
      [C],
    );
    await t.db.query(`delete from stayput.creator_offers where company_id = $1`, [C]);
    await t.db.query(`delete from stayput.exit_surveys where company_id = $1`, [C]);
  });

  it('offers a pause to the members leaving, then turns to those nobody reached', async () => {
    await t.db.query(
      `update stayput.actions set status = 'cancelled' where company_id = $1 and status = 'proposed'`,
      [C],
    );
    // Paul leaves at the end of his period: a pause protects his 99 a month.
    const view = await readDashboard(t.db, 'user_Owner', C, NOW);
    expect(view?.priority).toEqual({ kind: 'pause', memberIds: ['mber_Paul'], revenue: 99 });
    // Offered one already: nothing more to offer him; Lea, at high risk, nobody reached.
    await t.db.query(
      `insert into stayput.creator_offers (company_id, member_id, membership_id, kind, terms,
                                           created_by, created_at, expires_at)
       values ($1, 'mber_Paul', 'mem_Paul', 'pause_offer', '{"days": 30}', 'user_Owner',
               $2::timestamptz, $2::timestamptz + interval '7 days')`,
      [C, days(-1)],
    );
    expect((await readDashboard(t.db, 'user_Owner', C, NOW))?.priority).toEqual({
      kind: 'message',
      memberIds: ['mber_Lea'],
      revenue: 49,
    });
  });

  it('retries the failed payments, and is never calm while one stays unpaid', async () => {
    // Lea was written to yesterday: nobody left to reach.
    await action('mber_Lea', 'high_risk_message', 'sent', -1, 'relance');
    // Zoe's last payment failed yesterday; Whop can retry it and plans nothing itself.
    await t.db.query(
      `insert into stayput.payments (id, company_id, member_id, amount, currency, status,
                                     retryable, whop_created_at)
       values ('pay_Zoe1', $1, 'mber_Zoe', 29, 'eur', 'failed', true, $2::timestamptz)`,
      [C, days(-1)],
    );
    const read = async () => (await readDashboard(t.db, 'user_Owner', C, NOW))?.priority;
    expect(await read()).toEqual({ kind: 'retry', payments: 1, revenue: 29 });
    // A retry under way: nothing to do but look at her, still unpaid.
    await t.db.query(
      `insert into stayput.actions (company_id, member_id, type, status, trigger, subject_id,
                                    send_at)
       values ($1, 'mber_Zoe', 'payment_retry', 'scheduled', 'payment_failed', 'pay_Zoe1',
               $2::timestamptz)`,
      [C, NOW.toISOString()],
    );
    expect(await read()).toEqual({ kind: 'review', filter: 'failed', members: 1, revenue: 29 });
    // She paid: Paul, who leaves with his offer open, is what is left to look at.
    await t.db.query(
      `insert into stayput.payments (id, company_id, member_id, amount, currency, status,
                                     whop_created_at, paid_at)
       values ('pay_Zoe2', $1, 'mber_Zoe', 29, 'eur', 'paid', $2::timestamptz, $2::timestamptz)`,
      [C, days(-0.5)],
    );
    expect(await read()).toEqual({
      kind: 'review',
      filter: 'cancelling',
      members: 1,
      revenue: 99,
    });
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

describe('the chart’s days, in the community’s calendar (fix prompt v4.1, block 2)', () => {
  // 3 October 2026, 16:00 in Paris, 10:00 in New York.
  const AT = new Date('2026-10-03T14:00:00Z');

  /** A community in `zone`, one member paying 49 a month, saves at the given UTC moments. */
  async function community(id: string, zone: string, saves: Record<string, string>) {
    await t.db.query(
      `insert into stayput.companies (id, name, timezone, locale, mode)
       values ($1, 'Le Club', $2, 'en', 'manual')`,
      [id, zone],
    );
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_Owner', now())`,
      [id],
    );
    const ana = `mber_${id.slice(4)}`;
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status)
       values ($2, $1, $3, 'Ana', '2026-06-01T00:00:00Z', 'joined')`,
      [id, ana, `user_${id.slice(4)}`],
    );
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status,
                                        current_period_end)
       values ($2, $1, $3, $4, 'prod_Club', 'plan_Month', 49, 'usd', 30, 'active',
               '2026-10-20T00:00:00Z')`,
      [id, `mem_${id.slice(4)}`, ana, `user_${id.slice(4)}`],
    );
    for (const [payment, savedAt] of Object.entries(saves)) {
      // As the attribution writes them: the payment's currency, in Whop's lowercase.
      await t.db.query(
        `insert into stayput.saves (company_id, member_id, save_type, category, amount, currency,
                                    payment_id, saved_at)
         values ($1, $2, 'payment_recovered', 'direct', 49, 'usd', $3, $4::timestamptz)`,
        [id, ana, payment, savedAt],
      );
    }
    const view = (await readDashboard(t.db, 'user_Owner', id, AT))!;
    const on = (day: string) => view.revenueHistory.find((d) => d.day === day)?.saved;
    return { view, on };
  }

  it('counts a save at 00:30 and one at 23:30 on their own day, east of UTC', async () => {
    const { view, on } = await community('biz_Paris1', 'Europe/Paris', {
      // 30 September, 23:30 in Paris (21:30 UTC): September's.
      pay_Paris1: '2026-09-30T21:30:00Z',
      // 1 October, 00:30 in Paris (still 30 September in UTC): October's.
      pay_Paris2: '2026-09-30T22:30:00Z',
      // 2 October, 23:30 in Paris (21:30 UTC).
      pay_Paris3: '2026-10-02T21:30:00Z',
    });
    expect(on('2026-09-30')).toBe(49);
    expect(on('2026-10-01')).toBe(49);
    expect(on('2026-10-02')).toBe(49);
    expect(on('2026-10-03')).toBe(0);
    expect(view.revenueHistory.at(-1)?.day).toBe('2026-10-03');
    // The hero's month and the chart's days are the same saves, whatever the currency's case.
    expect(view.currency).toBe('USD');
    expect(view.saved.thisMonth).toMatchObject({ direct: 98, saves: 2 });
    expect(view.saved.lastMonth.direct).toBe(49);
    const october = view.revenueHistory.filter((d) => d.day.startsWith('2026-10'));
    expect(october.reduce((total, d) => total + d.saved, 0)).toBe(view.saved.thisMonth.direct);
  });

  it('counts a save at 00:30 and one at 23:30 on their own day, west of UTC', async () => {
    const { view, on } = await community('biz_NewYork1', 'America/New_York', {
      // 30 September, 23:30 in New York (already 1 October in UTC): September's.
      pay_NewYork1: '2026-10-01T03:30:00Z',
      // 1 October, 00:30 in New York (04:30 UTC): October's.
      pay_NewYork2: '2026-10-01T04:30:00Z',
      // 3 October, 00:30 in New York: today's.
      pay_NewYork3: '2026-10-03T04:30:00Z',
    });
    expect(on('2026-09-30')).toBe(49);
    expect(on('2026-10-01')).toBe(49);
    expect(on('2026-10-02')).toBe(0);
    expect(on('2026-10-03')).toBe(49);
    expect(view.saved.thisMonth.direct).toBe(98);
    expect(view.saved.lastMonth.direct).toBe(49);
  });
});
