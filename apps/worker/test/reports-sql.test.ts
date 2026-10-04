import { WhopApiError, type WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dashboardOf } from '../src/dashboard';
import { makeWeeklyReport, readWeeklyReports, sendWeeklyReports } from '../src/reports';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0035, the Monday report (SPEC Phase 6.9): due on Monday from 8:00 where each
 * community is, the week that just ended in its own calendar, sent once to its team, retried
 * when Whop refuses, kept as made, read under RLS.
 */

// Monday 5 October 2026, 08:00 in Paris (UTC+2): the week of 28 September has just ended.
const MONDAY_8 = new Date('2026-10-05T06:00:00Z');
const hours = (from: Date, n: number) => new Date(from.getTime() + n * 3_600_000);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

async function community(
  over: { zone?: string; locale?: string; demo?: boolean; installed?: string; off?: boolean } = {},
) {
  n += 1;
  const c = `biz_Week${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale, is_demo, installed_at)
     values ($1, 'Le Club', $2, $3, $4, $5::timestamptz)`,
    [
      c,
      over.zone ?? 'Europe/Paris',
      over.locale ?? 'fr',
      over.demo ?? false,
      over.installed ?? '2026-09-01T00:00:00Z',
    ],
  );
  await t.db.query(
    `insert into stayput.company_settings (company_id, options)
     values ($1, jsonb_build_object('weekly_report', $2::boolean))`,
    [c, !over.off],
  );
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', now())`,
    [c],
  );
  return c;
}

async function member(
  c: string,
  name: string,
  over: { left?: string; price?: number; admin?: boolean } = {},
) {
  const id = `mber_${name}${n}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                  access_level)
     values ($1, $2, $3, $4, '2026-06-01T00:00:00Z', $5, $6)`,
    [id, c, `user_${name}${n}`, name, over.left ? 'left' : 'joined', over.admin ? 'admin' : null],
  );
  if (over.price !== undefined || over.left) {
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status,
                                        current_period_end)
       values ($1, $2, $3, $4, 'prod_Club', 'plan_Month', $5, 'eur', 30, $6, $7::timestamptz)`,
      [
        `mem_${name}${n}`,
        c,
        id,
        `user_${name}${n}`,
        over.price ?? 49,
        over.left ? 'expired' : 'active',
        over.left ?? '2026-10-20T00:00:00Z',
      ],
    );
  }
  return id;
}

async function save(c: string, memberId: string, category: string, amount: number, at: string) {
  n += 1;
  await t.db.query(
    `insert into stayput.saves (company_id, member_id, save_type, category, amount, currency,
                                payment_id, saved_at)
     values ($1, $2, $3, $4, $5, 'eur', $6, $7::timestamptz)`,
    [
      c,
      memberId,
      category === 'direct' ? 'payment_recovered' : 'renewal_after_message',
      category,
      amount,
      `pay_Week${n}`,
      at,
    ],
  );
}

async function answer(c: string, memberId: string, reason: string, at: string) {
  await t.db.query(
    `insert into stayput.exit_surveys (company_id, member_id, reason, outcome, created_at,
                                       answered_at)
     values ($1, $2, $3, 'declined', $4::timestamptz, $4::timestamptz)`,
    [c, memberId, reason, at],
  );
}

const due = async (at: Date) =>
  (
    await t.db.query<{ company_id: string; week_start: string }>(
      `select company_id, to_char(week_start, 'YYYY-MM-DD') as week_start
         from stayput.weekly_reports_due($1::timestamptz, 100)`,
      [at.toISOString()],
    )
  ).map((r) => `${r.company_id} ${r.week_start}`);

function fakeWhop(answer: () => unknown = () => ({})) {
  const calls: { path: string; body: unknown; key: string | undefined }[] = [];
  const whop = {
    request: vi.fn(
      (_method: string, path: string, options?: { body?: unknown; idempotencyKey?: string }) => {
        calls.push({ path, body: options?.body, key: options?.idempotencyKey });
        const result = answer();
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    ),
  } as unknown as WhopClient;
  return { whop, calls };
}

const refusal = () =>
  new WhopApiError(403, 'forbidden', 'missing notification:create', {
    method: 'POST',
    path: '/notifications',
  });

describe('the Monday report', () => {
  it('is due on Monday from 8:00 where each community is, once a week', async () => {
    const paris = await community();
    const york = await community({ zone: 'America/New_York' });
    const tokyo = await community({ zone: 'Asia/Tokyo' });
    const ours = (list: string[]) =>
      list.filter((r) => [paris, york, tokyo].some((c) => r.startsWith(`${c} `)));
    // Sunday 23:59 in Paris is Monday 06:59 in Tokyo: nobody yet. Monday 07:59 in Paris is
    // 14:59 in Tokyo: Tokyo only.
    expect(ours(await due(new Date('2026-10-04T21:59:00Z')))).toEqual([]);
    expect(ours(await due(hours(MONDAY_8, -0.02)))).toEqual([`${tokyo} 2026-09-28`]);
    // 08:00 in Paris is 02:00 in New York: Paris and Tokyo only.
    expect(ours(await due(MONDAY_8))).toEqual([`${paris} 2026-09-28`, `${tokyo} 2026-09-28`]);
    // 08:00 in New York (12:00 UTC).
    expect(ours(await due(new Date('2026-10-05T12:00:00Z')))).toContain(`${york} 2026-09-28`);
    // Tuesday in Paris: a report never sent is not sent a day late.
    expect(ours(await due(new Date('2026-10-06T06:00:00Z')))).not.toContain(`${paris} 2026-09-28`);
  });

  it('never goes to a demo community, one turned off, or one installed that Monday', async () => {
    const demo = await community({ demo: true });
    const off = await community({ off: true });
    const fresh = await community({ installed: '2026-10-05T05:00:00Z' });
    const list = await due(MONDAY_8);
    for (const c of [demo, off, fresh]) expect(list.join()).not.toContain(c);
  });

  it('counts the week in the community’s calendar: saves, departures, answers', async () => {
    const c = await community();
    const lea = await member(c, 'Lea', { price: 49 });
    const paul = await member(c, 'Paul', { price: 99 });
    const ana = await member(c, 'Ana', { price: 29 });
    // Lea saved twice in the week (once as a member), Paul influenced.
    await save(c, lea, 'direct', 49, '2026-09-30T10:00:00Z');
    await save(c, lea, 'direct', 49, '2026-10-02T10:00:00Z');
    await save(c, paul, 'influenced', 99, '2026-10-03T10:00:00Z');
    // Sunday 27 September 23:30 in Paris, and Monday 5 October 00:30: other weeks.
    await save(c, ana, 'direct', 29, '2026-09-27T21:30:00Z');
    await save(c, ana, 'direct', 29, '2026-10-04T22:30:00Z');
    // Zoé left on Saturday; Max three weeks ago; the team's own departures never count.
    const zoe = await member(c, 'Zoe', { left: '2026-10-03T09:00:00Z' });
    await member(c, 'Max', { left: '2026-09-14T09:00:00Z' });
    await member(c, 'Staff', { left: '2026-10-01T09:00:00Z', admin: true });
    await answer(c, zoe, 'too_expensive', '2026-09-29T10:00:00Z');
    await answer(c, paul, 'too_expensive', '2026-10-01T10:00:00Z');
    await answer(c, ana, 'no_time', '2026-10-02T10:00:00Z');
    await answer(c, ana, 'no_results', '2026-09-20T10:00:00Z');

    const report = await makeWeeklyReport(t.db, c, '2026-09-28', 'Europe/Paris', MONDAY_8);
    const home = await t.db.transaction((tx) => dashboardOf(tx, c, MONDAY_8));
    expect(report).toEqual({
      weekStart: '2026-09-28',
      currency: 'EUR',
      saved: { members: 1, direct: 98, influenced: 99 },
      lost: 1,
      reasons: [
        { reason: 'too_expensive', count: 2 },
        { reason: 'no_time', count: 1 },
      ],
      // The week's priority is the dashboard's that morning.
      priority: home!.priority,
    });
  });

  it('goes to the team once, in the community’s language, and is kept as made', async () => {
    const c = await community();
    const lea = await member(c, 'Lea', { price: 49 });
    await save(c, lea, 'direct', 49, '2026-09-30T10:00:00Z');
    const { whop, calls } = fakeWhop();
    const run = await sendWeeklyReports(t.db, whop, MONDAY_8, 100);
    expect(run.sent).toContain(c);
    const mine = calls.filter((call) => (call.body as { account_id: string }).account_id === c);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      path: '/notifications',
      key: `stayput-weekly-${c}-2026-09-28`,
      body: { account_id: c, title: 'Votre rapport du lundi' },
    });
    expect((mine[0]!.body as { content: string }).content).toMatch(
      /^La semaine dernière : 1 membre sauvé, 49,00\s€ sauvés, 0 membre perdu\./,
    );
    // An hour later: already sent, nothing goes.
    const later = fakeWhop();
    await sendWeeklyReports(t.db, later.whop, hours(MONDAY_8, 1), 100);
    expect(
      later.calls.filter((call) => (call.body as { account_id: string }).account_id === c),
    ).toEqual([]);

    const view = await readWeeklyReports(t.db, 'user_Owner', c, hours(MONDAY_8, 1));
    expect(view).toMatchObject({
      enabled: true,
      // The next one: Monday 12 October, 08:00 in Paris.
      nextAt: '2026-10-12T06:00:00.000Z',
      timezone: 'Europe/Paris',
    });
    expect(view!.reports).toHaveLength(1);
    expect(view!.reports[0]).toMatchObject({
      weekStart: '2026-09-28',
      saved: { members: 1, direct: 49, influenced: 0 },
      sentAt: MONDAY_8.toISOString(),
      failed: false,
    });
    // Nobody outside the team reads it.
    expect(await readWeeklyReports(t.db, 'user_Stranger', c, MONDAY_8)).toBeNull();
  });

  it('tries again the next hours when Whop refuses, the same report, 3 times at most', async () => {
    const c = await community({ locale: 'en' });
    const lea = await member(c, 'Lea', { price: 49 });
    await save(c, lea, 'direct', 49, '2026-09-30T10:00:00Z');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = fakeWhop(refusal);
    expect((await sendWeeklyReports(t.db, refused.whop, MONDAY_8, 100)).failed).toContain(c);
    // A save counted later in that week changes nothing: the report is kept as first made.
    await save(c, lea, 'direct', 49, '2026-10-01T10:00:00Z');
    const back = fakeWhop();
    await sendWeeklyReports(t.db, back.whop, hours(MONDAY_8, 1), 100);
    const sent = back.calls.find((call) => (call.body as { account_id: string }).account_id === c);
    expect((sent!.body as { content: string }).content).toMatch(
      /^Last week: 1 member saved, €49\.00 saved, 0 members lost\./,
    );
    errors.mockRestore();

    // Refused three times: it stays unsent, and says so.
    const other = await community({ locale: 'en' });
    for (const hour of [0, 1, 2, 3]) {
      await sendWeeklyReports(t.db, fakeWhop(refusal).whop, hours(MONDAY_8, hour), 100);
    }
    const [row] = await t.db.query<{ attempts: number; error: string; sent_at: Date | null }>(
      `select attempts, error, sent_at from stayput.weekly_reports where company_id = $1`,
      [other],
    );
    expect(row).toMatchObject({ attempts: 3, sent_at: null });
    expect(row!.error).toContain('403 forbidden');
    const view = await readWeeklyReports(t.db, 'user_Owner', other, hours(MONDAY_8, 4));
    expect(view!.reports[0]).toMatchObject({ sentAt: null, failed: true });
  });

  it('is turned off and on by the team', async () => {
    const c = await community();
    await t.db.query('select stayput.save_weekly_report_setting($1, false)', [c]);
    expect((await due(MONDAY_8)).join()).not.toContain(c);
    expect((await readWeeklyReports(t.db, 'user_Owner', c, MONDAY_8))!.enabled).toBe(false);
    await t.db.query('select stayput.save_weekly_report_setting($1, true)', [c]);
    expect(await due(MONDAY_8)).toContain(`${c} 2026-09-28`);
  });
});
