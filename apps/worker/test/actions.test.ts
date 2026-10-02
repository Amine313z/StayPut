import type { WhopClient } from '@stayput/whop';
import { WhopApiError } from '@stayput/whop';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeDueActions,
  prepareActions,
  runAction,
  scheduleDecisions,
  type DueAction,
  type ScheduleContext,
} from '../src/actions';
import { DiscordApiError, type DiscordClient } from '../src/discord';
import type { TelegramClient } from '../src/telegram';
import { createTestDb, type TestDb } from './helpers/db';

// 1 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-01T08:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;
async function company(
  over: {
    mode?: 'auto' | 'manual';
    dryRun?: boolean;
    demo?: boolean;
    experience?: string | null;
  } = {},
) {
  n += 1;
  const id = `biz_Act${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, mode, timezone, locale, is_demo, experience_id)
     values ($1, 'Le Club', $2, 'Europe/Paris', 'fr', $3, $4)`,
    [
      id,
      over.mode ?? 'auto',
      over.demo ?? false,
      over.experience === undefined ? 'exp_Club1' : over.experience,
    ],
  );
  await t.db.query(
    `insert into stayput.company_settings (company_id, dry_run) values ($1, $2)
     on conflict (company_id) do update set dry_run = excluded.dry_run`,
    [id, over.dryRun ?? false],
  );
  return id;
}

async function member(
  companyId: string,
  over: { name?: string; admin?: boolean; left?: boolean; doNotContact?: boolean } = {},
) {
  n += 1;
  const id = `mber_Act${n}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                  access_level, do_not_contact)
     values ($1, $2, $3, $4, '2026-08-01T00:00:00Z', $5, $6, $7)`,
    [
      id,
      companyId,
      `user_Act${n}`,
      over.name ?? 'Ana Lopez',
      over.left ? 'left' : 'joined',
      over.admin ? 'admin' : 'customer',
      over.doNotContact ?? false,
    ],
  );
  return id;
}

async function payment(
  companyId: string,
  memberId: string,
  over: { status: string; at: string; retryable?: boolean; next?: string; recovery?: string },
) {
  n += 1;
  const id = `pay_Act${n}`;
  await t.db.query(
    `insert into stayput.payments (id, company_id, member_id, amount, currency, status, retryable,
                                   next_payment_attempt_at, recovery_url, whop_created_at)
     values ($1, $2, $3, 49, 'usd', $4, $5, $6::timestamptz, $7, $8::timestamptz)`,
    [
      id,
      companyId,
      memberId,
      over.status,
      over.retryable ?? true,
      over.next ?? null,
      over.recovery ?? null,
      over.at,
    ],
  );
  return id;
}

async function risk(
  companyId: string,
  memberId: string,
  over: { level: string; previous?: string; since: string; newcomer?: boolean },
) {
  await t.db.query(
    `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores, level_since,
                                      previous_level, computed_at, inactive_newcomer)
     values ($1, $2, 75, $3, '{}', $4::timestamptz, $5, $4::timestamptz, $6)`,
    [companyId, memberId, over.level, over.since, over.previous ?? null, over.newcomer ?? false],
  );
}

async function activity(companyId: string, memberId: string, at: string, title?: string) {
  await t.db.query(
    `insert into stayput.activity_events (company_id, member_id, type, occurred_at, metadata)
     values ($1, $2, $3, $4::timestamptz, $5::text::jsonb)`,
    [
      companyId,
      memberId,
      title ? 'lesson_completed' : 'message',
      at,
      JSON.stringify(title ? { lesson_title: title } : {}),
    ],
  );
}

const plan = async (companyId: string) =>
  (
    await t.db.query<{ planned: number }>(
      'select stayput.plan_actions($1, $2::timestamptz) as planned',
      [companyId, NOW.toISOString()],
    )
  )[0]?.planned;

interface Row {
  type: string;
  status: string;
  dedupe_key: string;
  send_at: string | null;
  blocked_reason: string | null;
  result: Record<string, unknown> | null;
  attempts: number;
  errors: number;
}
const rows = (companyId: string) =>
  t.db.query<Row>(
    `select type, status, dedupe_key, send_at::text as send_at, blocked_reason, result, attempts,
            jsonb_array_length(error_log) as errors
       from stayput.actions where company_id = $1 order by dedupe_key`,
    [companyId],
  );

describe('the triggers', () => {
  it('plan each action from recent state, once, for the members it may concern', async () => {
    const c = await company();
    const secure = await member(c);
    const failed = await member(c);
    const whopRetries = await member(c);
    const leaving = await member(c);
    const high = await member(c);
    const newcomer = await member(c);
    const team = await member(c, { admin: true });
    const gone = await member(c, { left: true });
    const old = await member(c);
    const pay3ds = await payment(c, secure, {
      status: 'requires_action',
      at: hoursAgo(1),
      recovery: 'https://whop.com/checkout/confirm',
    });
    const payFailed = await payment(c, failed, { status: 'failed', at: hoursAgo(2) });
    const payWhop = await payment(c, whopRetries, {
      status: 'failed',
      at: hoursAgo(2),
      next: '2026-10-03T00:00:00Z',
    });
    await payment(c, team, { status: 'failed', at: hoursAgo(2) });
    await payment(c, gone, { status: 'failed', at: hoursAgo(2) });
    await payment(c, old, { status: 'failed', at: hoursAgo(24 * 10) });
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, product_id, plan_id, status,
                                        cancel_at_period_end, current_period_end)
       values ('mem_Act1', $1, $2, 'prod_Act1', 'plan_Act1', 'active', true,
               '2026-10-20T00:00:00Z')`,
      [c, leaving],
    );
    await risk(c, high, { level: 'high', previous: 'medium', since: hoursAgo(3) });
    await risk(c, old, { level: 'high', previous: 'medium', since: hoursAgo(24 * 5) });
    await risk(c, newcomer, { level: 'low', since: hoursAgo(1), newcomer: true });

    expect(await plan(c)).toBe(7);
    const planned = (await rows(c)).map((r) => [r.dedupe_key, r.status, r.send_at]);
    expect(planned.sort()).toEqual(
      [
        ['exit_survey:mem_Act1:2026-10-20', 'proposed', '2026-10-01 08:00:00+00'],
        // Its time is the golden hour: the Worker sets it.
        [`high_risk_message:${high}:2026-10-01`, 'proposed', null],
        [`payment_action_notice:${pay3ds}`, 'proposed', '2026-10-01 08:00:00+00'],
        [`payment_failed_notice:${payFailed}`, 'proposed', '2026-10-01 08:00:00+00'],
        [`payment_failed_notice:${payWhop}`, 'proposed', '2026-10-01 08:00:00+00'],
        // 24 h after the failure; none for the payment Whop retries itself, and the 72 h retry
        // waits for the first.
        [`payment_retry:${payFailed}:1`, 'proposed', '2026-10-02 06:00:00+00'],
        [`welcome_message:${newcomer}`, 'proposed', '2026-10-01 08:00:00+00'],
      ].sort(),
    );
    // Planned once.
    expect(await plan(c)).toBe(0);
    // A demonstration community is never acted on.
    expect(await plan(await company({ demo: true }))).toBe(0);
  });
});

describe('scheduling through the guardrails', () => {
  it('schedules in automatic mode, a follow-up at the golden hour, one message at a time', async () => {
    const c = await company();
    const evening = await member(c);
    const both = await member(c);
    // Evening activity in Paris over the last 30 days: 20:xx local is 18:xx UTC.
    for (const day of [3, 9, 15]) {
      await activity(c, evening, new Date(Date.UTC(2026, 8, 30 - day, 18, 30)).toISOString());
    }
    await risk(c, evening, { level: 'high', previous: 'medium', since: hoursAgo(2) });
    // A new member who has not started, whose score also turned high: one message, not two.
    await risk(c, both, { level: 'high', previous: 'low', since: hoursAgo(1), newcomer: true });

    expect(await prepareActions(t.db, c, NOW)).toEqual({ planned: 3, scheduled: 2, blocked: 1 });
    const byKey = new Map((await rows(c)).map((r) => [r.dedupe_key, r]));
    expect(byKey.get(`high_risk_message:${evening}:2026-10-01`)).toMatchObject({
      status: 'scheduled',
      send_at: '2026-10-01 18:00:00+00',
    });
    expect(byKey.get(`high_risk_message:${both}:2026-10-01`)).toMatchObject({
      status: 'scheduled',
      // No activity: the creator's default hour, 19:00 in Paris.
      send_at: '2026-10-01 17:00:00+00',
    });
    expect(byKey.get(`welcome_message:${both}`)).toMatchObject({
      status: 'blocked_by_guardrail',
      blocked_reason: 'message_spacing',
    });
  });

  it('waits for the creator in manual mode, then schedules what they approved', async () => {
    const c = await company({ mode: 'manual' });
    const ana = await member(c);
    await risk(c, ana, { level: 'low', since: hoursAgo(1), newcomer: true });
    expect(await prepareActions(t.db, c, NOW)).toEqual({ planned: 1, scheduled: 0, blocked: 0 });
    expect((await rows(c))[0]?.status).toBe('proposed');
    await t.db.query(
      `update stayput.actions set status = 'approved', approved_at = $2::timestamptz,
              approved_by = 'user_Creator1' where company_id = $1`,
      [c, NOW.toISOString()],
    );
    expect(await prepareActions(t.db, c, NOW)).toEqual({ planned: 0, scheduled: 1, blocked: 0 });
    expect((await rows(c))[0]).toMatchObject({ status: 'scheduled' });
  });

  it('blocks an action with the reason: the « never contact » list, the stops', async () => {
    const c = await company();
    const quiet = await member(c, { doNotContact: true });
    await risk(c, quiet, { level: 'low', since: hoursAgo(1), newcomer: true });
    await prepareActions(t.db, c, NOW);
    expect((await rows(c))[0]).toMatchObject({
      status: 'blocked_by_guardrail',
      blocked_reason: 'do_not_contact',
    });

    const stopped = await company();
    await risk(stopped, await member(stopped), {
      level: 'low',
      since: hoursAgo(1),
      newcomer: true,
    });
    await t.db.query(
      'update stayput.company_settings set kill_switch = true where company_id = $1',
      [stopped],
    );
    await prepareActions(t.db, stopped, NOW);
    expect((await rows(stopped))[0]).toMatchObject({ blocked_reason: 'kill_switch' });
  });

  it('skips what it does not know, and never schedules twice', () => {
    const context: ScheduleContext = {
      mode: 'auto',
      timezone: 'UTC',
      globalKillSwitch: false,
      settings: {
        maxMessagesPer5Days: 1,
        maxMessagesPerMonth: 4,
        maxPaymentRetries: 2,
        monthlyPromoCap: 10,
        maxFreeDaysPerQuarter: 14,
        quietHoursStart: 22,
        quietHoursEnd: 8,
        dryRun: false,
        killSwitch: false,
        defaultSendHour: 19,
      },
      promosLast30: 0,
      actions: [
        {
          id: 'a',
          type: 'mystery',
          memberId: 'm',
          sendAt: NOW.toISOString(),
          freeDays: null,
          doNotContact: false,
          messages: [],
          paymentRetries: 0,
          activePromo: false,
          freeDaysLast90: 0,
          hours: null,
        },
      ],
    };
    expect(scheduleDecisions(context, NOW.getTime())).toEqual([]);
  });
});

describe('running the actions', () => {
  // The run takes what is due across companies: each test starts from its own actions only.
  beforeEach(async () => {
    await t.db.query(`update stayput.actions set status = 'cancelled' where status = 'scheduled'`);
  });

  function fakeWhop(answer: (path: string) => unknown = () => ({})) {
    const calls: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
    const whop = {
      request: vi.fn(
        (method: string, path: string, options?: { body?: unknown; idempotencyKey?: string }) => {
          calls.push({ method, path, body: options?.body, key: options?.idempotencyKey });
          const result = answer(path);
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
      ),
    } as unknown as WhopClient;
    return { whop, calls };
  }

  /** A new member to welcome, and another whose payment failed 30 hours ago. */
  async function scheduled(over: { dryRun?: boolean; experience?: string | null } = {}) {
    const c = await company(over);
    const ana = await member(c, { name: 'Ana Lopez' });
    await risk(c, ana, { level: 'low', since: hoursAgo(1), newcomer: true });
    const bo = await member(c, { name: 'Bo' });
    await activity(c, bo, '2026-09-19T09:00:00Z', 'Chart patterns');
    const failed = await payment(c, bo, { status: 'failed', at: hoursAgo(30) });
    await prepareActions(t.db, c, NOW);
    return { c, ana, bo, failed };
  }

  const userOf = (memberId: string) => `user_Act${memberId.replace('mber_Act', '')}`;

  it('simulates in test mode: the message it would send, nothing sent', async () => {
    const { c } = await scheduled({ dryRun: true });
    const { whop, calls } = fakeWhop();
    expect(await executeDueActions(t.db, whop, NOW)).toEqual({ simulated: 3 });
    expect(calls).toEqual([]);
    const byType = new Map((await rows(c)).map((r) => [r.type, r]));
    expect(byType.get('welcome_message')).toMatchObject({
      status: 'simulated',
      result: {
        message: {
          title: 'Bienvenue, Ana',
          body: 'Content de t’avoir dans Le Club. Le meilleur premier pas : présente-toi à la communauté, puis lance la première leçon.',
        },
      },
    });
    expect(byType.get('payment_failed_notice')).toMatchObject({
      status: 'simulated',
      result: { message: { title: 'Ton paiement n’est pas passé' } },
    });
    expect(byType.get('payment_retry')).toMatchObject({ status: 'simulated' });
  });

  it('sends through Whop: a notification to each member, the payment charged again', async () => {
    const { c, ana, bo, failed } = await scheduled();
    const { whop, calls } = fakeWhop();
    expect(await executeDueActions(t.db, whop, NOW)).toEqual({ sent: 3 });
    const key = expect.stringMatching(/^stayput-action-/) as string;
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: 'POST',
          path: '/notifications',
          body: {
            experience_id: 'exp_Club1',
            user_ids: [userOf(ana)],
            title: 'Bienvenue, Ana',
            content: expect.stringContaining('Le Club') as string,
          },
          key,
        },
        {
          method: 'POST',
          path: '/notifications',
          body: {
            experience_id: 'exp_Club1',
            user_ids: [userOf(bo)],
            title: 'Ton paiement n’est pas passé',
            content: expect.stringContaining('Salut Bo,') as string,
          },
          key,
        },
        { method: 'POST', path: `/payments/${failed}/retry`, body: undefined, key },
      ]),
    );
    expect((await rows(c)).map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
  });

  it('cancels what no longer holds, and tries an outage again an hour later', async () => {
    const { c, failed } = await scheduled();
    // Bo paid in the meantime: no « your payment failed », no retry.
    await t.db.query(`update stayput.payments set status = 'paid' where id = $1`, [failed]);
    const { whop } = fakeWhop((path) =>
      path === '/notifications'
        ? new WhopApiError(503, 'unavailable', 'try later', { method: 'POST', path })
        : {},
    );
    expect(await executeDueActions(t.db, whop, NOW)).toEqual({ cancelled: 2, retried: 1 });
    const byType = new Map((await rows(c)).map((r) => [r.type, r]));
    expect(byType.get('payment_retry')).toMatchObject({
      status: 'cancelled',
      result: { reason: 'payment_no_longer_failed' },
    });
    expect(byType.get('payment_failed_notice')).toMatchObject({ status: 'cancelled' });
    expect(byType.get('welcome_message')).toMatchObject({
      status: 'scheduled',
      send_at: '2026-10-01 09:00:00+00',
      attempts: 1,
      errors: 1,
    });
  });

  it('fails for good on a refusal, and blocks what a stop now forbids', async () => {
    const { c } = await scheduled();
    const refused = fakeWhop(
      (path) =>
        new WhopApiError(403, 'forbidden', 'missing permission notification:create', {
          method: 'POST',
          path,
        }),
    );
    expect(await executeDueActions(t.db, refused.whop, NOW)).toEqual({ failed: 3 });
    expect((await rows(c)).map((r) => [r.status, r.errors])).toEqual([
      ['failed', 1],
      ['failed', 1],
      ['failed', 1],
    ]);

    const later = await scheduled();
    await t.db.query(`update stayput.app_settings set kill_switch = true`);
    try {
      expect(await executeDueActions(t.db, fakeWhop().whop, NOW)).toEqual({
        blocked_by_guardrail: 3,
      });
    } finally {
      await t.db.query(`update stayput.app_settings set kill_switch = false`);
    }
    expect((await rows(later.c)).map((r) => r.blocked_reason)).toEqual([
      'global_kill_switch',
      'global_kill_switch',
      'global_kill_switch',
    ]);
  });

  it('waits for StayPut to know its experience in the community', async () => {
    const { c } = await scheduled({ experience: null });
    expect(await executeDueActions(t.db, fakeWhop().whop, NOW)).toEqual({ retried: 2, sent: 1 });
    const welcome = (await rows(c)).find((r) => r.type === 'welcome_message');
    expect(welcome).toMatchObject({ status: 'scheduled', attempts: 1, errors: 1 });
  });

  /** An offer a member accepted, as due_actions gives it. */
  const offer = (over: Partial<DueAction> = {}): DueAction => ({
    id: '7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6',
    companyId: 'biz_X',
    createdAt: '2026-10-01T08:00:00.000Z',
    type: 'pause_offer',
    attempts: 0,
    content: { days: 30, keep: true },
    globalKillSwitch: false,
    killSwitch: false,
    dryRun: false,
    locale: 'en',
    timezone: 'Europe/Paris',
    quietHoursStart: 22,
    quietHoursEnd: 8,
    experienceId: 'exp_X',
    templates: {},
    member: { userId: 'user_X', doNotContact: false, joined: true },
    payment: null,
    membership: {
      id: 'mem_X1',
      canceling: true,
      ended: false,
      productId: 'prod_X1',
      planId: 'plan_X1',
      currency: 'EUR',
      periodEnd: '2026-10-20T00:00:00.000Z',
    },
    values: {},
    ...over,
  });

  it('applies an accepted offer: the membership kept with consent, then the pause', async () => {
    const at = NOW.getTime();
    const { whop, calls } = fakeWhop();
    expect(await runAction(offer(), whop, at)).toEqual({
      status: 'sent',
      result: { kept: true, resumes_at: '2026-10-31T08:00:00.000Z' },
    });
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/memberships/mem_X1',
        body: { cancel_at_period_end: false },
        key: 'stayput-action-7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6-keep',
      },
      {
        method: 'POST',
        path: '/memberships/mem_X1/pause',
        body: { until: '2026-10-31T08:00:00.000Z' },
        key: 'stayput-action-7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6-pause',
      },
    ]);

    // Free days without consent to stay: the cancellation stands, the days are added.
    const extend = fakeWhop();
    await runAction(
      offer({ type: 'extend_offer', content: { days: 7, keep: false } }),
      extend.whop,
      at,
    );
    expect(extend.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/memberships/mem_X1/extend', { days: 7 }],
    ]);
    // Help and the affiliate invitation: the creator follows up, nothing to ask Whop.
    const help = fakeWhop();
    expect(
      await runAction(offer({ type: 'coaching_offer', content: { keep: false } }), help.whop, at),
    ).toEqual({ status: 'sent', result: {} });
    expect(help.calls).toEqual([]);
  });

  it('creates a single-use promo code, the same on every attempt, simulated in test mode', async () => {
    const at = NOW.getTime();
    const promo = offer({ type: 'promo_offer', content: { percentOff: 20, months: 3 } });
    const { whop, calls } = fakeWhop();
    const sent = await runAction(promo, whop, at);
    expect(sent).toMatchObject({
      status: 'sent',
      result: {
        code: expect.stringMatching(/^STAY-[A-HJ-NP-Z2-9]{8}$/) as string,
        expires_at: '2026-10-08T08:00:00.000Z',
        percent_off: 20,
        months: 3,
      },
    });
    const code = (sent as unknown as { result: { code: string } }).result.code;
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/promo_codes',
        body: {
          account_id: 'biz_X',
          code,
          amount_off: 20,
          promo_type: 'percentage',
          promo_duration_months: 3,
          base_currency: 'eur',
          new_users_only: false,
          one_per_customer: true,
          stock: 1,
          expires_at: '2026-10-08T08:00:00.000Z',
          product_id: 'prod_X1',
        },
        key: 'stayput-action-7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6-promo',
      },
    ]);
    // Tried again an hour later, after an outage: the same code.
    const again = await runAction(promo, fakeWhop().whop, at + 3_600_000);
    expect((again as unknown as { result: { code: string } }).result.code).toBe(code);
    // In test mode: computed, nothing asked of Whop.
    const test = fakeWhop();
    expect(await runAction({ ...promo, dryRun: true }, test.whop, at)).toMatchObject({
      status: 'simulated',
      result: { code },
    });
    expect(test.calls).toEqual([]);
  });

  /** A former member's follow-up, 7 days after they left the paid product mem_X1 belongs to. */
  const followup = (over: Partial<DueAction> = {}) =>
    offer({
      type: 'alumni_followup',
      locale: 'fr',
      content: { step: 7, departed_at: '2026-09-24T10:00:00.000Z' },
      values: { first_name: 'Ana', creator_name: 'Le Club' },
      membership: { ...offer().membership!, canceling: false, ended: true },
      alumni: { status: 'entered', experienceId: 'exp_Alu1', percentOff: 20, months: 3 },
      ...over,
    });

  it('sends an Alumni follow-up: a return code for the product left, then the news', async () => {
    const at = NOW.getTime();
    const { whop, calls } = fakeWhop((path) =>
      path === '/promo_codes' ? { id: 'promo_R1', expires_at: '2026-10-08T08:00:05.000Z' } : {},
    );
    const sent = await runAction(followup(), whop, at);
    const code = (sent as unknown as { result: { code: string } }).result.code;
    expect(code).toMatch(/^STAY-[A-HJ-NP-Z2-9]{8}$/);
    const message = {
      title: 'Des nouvelles de Le Club',
      body:
        'Salut Ana, il s’est passé beaucoup de choses depuis ton départ. Voici un code de retour ' +
        `si tu as envie de revenir : ${code} (-20\u00a0% pendant 3 mois, valable 7 jours).`,
    };
    // The code Whop made, with the expiry it answered.
    expect(sent).toEqual({
      status: 'sent',
      result: {
        message,
        step: 7,
        code,
        expires_at: '2026-10-08T08:00:05.000Z',
        percent_off: 20,
        months: 3,
        promo_created: true,
        promo_code_id: 'promo_R1',
      },
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/promo_codes',
        body: {
          account_id: 'biz_X',
          code,
          amount_off: 20,
          promo_type: 'percentage',
          promo_duration_months: 3,
          base_currency: 'eur',
          new_users_only: false,
          one_per_customer: true,
          stock: 1,
          expires_at: '2026-10-08T08:00:00.000Z',
          product_id: 'prod_X1',
        },
        key: 'stayput-action-7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6-promo',
      },
      {
        method: 'POST',
        path: '/notifications',
        // Through the Alumni space, the only one a former member can still open.
        body: {
          experience_id: 'exp_Alu1',
          user_ids: ['user_X'],
          title: message.title,
          content: message.body,
        },
        key: 'stayput-action-7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6-notify',
      },
    ]);

    // In test mode: the message and the code it would send, nothing asked of Whop.
    const test = fakeWhop();
    expect(await runAction(followup({ dryRun: true }), test.whop, at)).toEqual({
      status: 'simulated',
      result: {
        message,
        step: 7,
        code,
        expires_at: '2026-10-08T08:00:00.000Z',
        percent_off: 20,
        months: 3,
      },
    });
    expect(test.calls).toEqual([]);

    // Whop refuses the code (a permission missing): no notification without it.
    const refused = fakeWhop((path) =>
      path === '/promo_codes'
        ? new WhopApiError(403, 'forbidden', 'missing permission promo_code:create', {
            method: 'POST',
            path,
          })
        : {},
    );
    expect(await runAction(followup(), refused.whop, at)).toMatchObject({
      status: 'failed',
      retry: false,
    });
    expect(refused.calls.map((c) => c.path)).toEqual(['/promo_codes']);
  });

  it('sends only the notification when an outage stopped it after the code was made', async () => {
    const at = NOW.getTime();
    const down = fakeWhop((path) =>
      path === '/promo_codes'
        ? { id: 'promo_R2', expires_at: '2026-10-08T08:00:00.000Z' }
        : new WhopApiError(503, 'unavailable', 'try later', { method: 'POST', path }),
    );
    const first = await runAction(followup(), down.whop, at);
    // Tried again later, with what this attempt keeps: the code and its expiry.
    expect(first).toMatchObject({
      status: 'failed',
      retry: true,
      result: { promo_created: true, promo_code_id: 'promo_R2' },
    });
    const kept = (first as { result: Record<string, unknown> }).result;

    // An hour later, the creator having changed the discount meanwhile: the code already made
    // is the one sent, with its own discount and expiry, and Whop is not asked for another.
    const again = fakeWhop();
    const retried = await runAction(
      followup({
        attempts: 1,
        result: kept,
        alumni: { status: 'entered', experienceId: 'exp_Alu1', percentOff: 30, months: 1 },
      }),
      again.whop,
      at + 3_600_000,
    );
    expect(retried).toEqual({ status: 'sent', result: kept });
    expect(again.calls.map((c) => c.path)).toEqual(['/notifications']);
    expect(again.calls[0]?.body).toMatchObject({
      content: expect.stringContaining(`${String(kept.code)} (-20`) as string,
    });
  });

  it('never calls back a former member who came back or left the Alumni', async () => {
    const at = NOW.getTime();
    const status = (s: string) => ({
      alumni: { status: s, experienceId: 'exp_Alu1', percentOff: 20, months: 3 },
    });
    expect(await runAction(followup(status('returned')), null, at)).toEqual({
      status: 'cancelled',
      result: { reason: 'member_returned' },
    });
    expect(await runAction(followup(status('left')), null, at)).toEqual({
      status: 'cancelled',
      result: { reason: 'left_alumni' },
    });
    // The space is gone: nothing to send it through.
    expect(
      await runAction(
        followup({
          alumni: { status: 'entered', experienceId: null, percentOff: 20, months: 3 },
        }),
        null,
        at,
      ),
    ).toEqual({ status: 'failed', error: 'the Alumni space is not ready', retry: false });
  });

  it('drops an offer whose membership ended, and what no longer holds', async () => {
    const at = NOW.getTime();
    expect(
      await runAction(offer({ membership: { ...offer().membership!, ended: true } }), null, at),
    ).toEqual({ status: 'cancelled', result: { reason: 'membership_ended' } });
    expect(await runAction(offer({ membership: null }), null, at)).toEqual({
      status: 'cancelled',
      result: { reason: 'membership_ended' },
    });
    expect(
      await runAction(offer({ member: { ...offer().member, joined: false } }), null, at),
    ).toEqual({ status: 'cancelled', result: { reason: 'member_left' } });
    expect(
      await runAction(
        offer({ type: 'exit_survey', membership: { ...offer().membership!, canceling: false } }),
        null,
        at,
      ),
    ).toEqual({ status: 'cancelled', result: { reason: 'cancellation_withdrawn' } });
  });

  it('keeps a message for the end of the quiet hours, in the zone the creator has now', async () => {
    const { c } = await scheduled({ dryRun: true });
    // Scheduled for 10:00 in Paris; the creator now lives in Tokyo, where it is 17:00, and keeps
    // quiet from 16:00 to 18:00.
    await t.db.query(`update stayput.companies set timezone = 'Asia/Tokyo' where id = $1`, [c]);
    await t.db.query(
      `update stayput.company_settings set quiet_hours_start = 16, quiet_hours_end = 18
        where company_id = $1`,
      [c],
    );
    const { whop, calls } = fakeWhop();
    // The two messages wait for 18:00 in Tokyo; the payment retry is not a message and runs.
    expect(await executeDueActions(t.db, whop, NOW)).toEqual({ postponed: 2, simulated: 1 });
    expect(calls).toEqual([]);
    expect((await rows(c)).map((r) => [r.type, r.status, r.send_at, r.attempts, r.errors])).toEqual(
      [
        ['payment_failed_notice', 'scheduled', '2026-10-01 09:00:00+00', 0, 0],
        ['payment_retry', 'simulated', expect.any(String), 1, 0],
        ['welcome_message', 'scheduled', '2026-10-01 09:00:00+00', 0, 0],
      ],
    );
    // Their time comes again at 18:00 in Tokyo: they run.
    expect(await executeDueActions(t.db, whop, new Date('2026-10-01T09:00:00Z'))).toEqual({
      simulated: 2,
    });
  });
});

describe('the company time zone', () => {
  const zone = async (companyId: string, timezone: string, onlyIfUnset: boolean) =>
    (
      await t.db.query<{ zone: string | null }>(
        'select stayput.set_company_timezone($1, $2, $3, $4::timestamptz) as zone',
        [companyId, timezone, onlyIfUnset, NOW.toISOString()],
      )
    )[0]?.zone;
  const state = async (companyId: string) =>
    (
      await t.db.query<{ timezone: string; set: boolean; dirty: string | null }>(
        `select c.timezone, c.timezone_set_at is not null as set,
                s.stats_dirty_since::text as dirty
           from stayput.companies c
           left join stayput.company_sync s on s.company_id = c.id
          where c.id = $1`,
        [companyId],
      )
    )[0];

  it('takes the browser zone once, then only the creator changes it', async () => {
    const c = await company();
    await t.db.query(
      `update stayput.companies set timezone = 'UTC', timezone_set_at = null where id = $1`,
      [c],
    );
    // The first creator's browser sets it, and the activity is counted again in that zone.
    expect(await zone(c, 'America/Montreal', true)).toBe('America/Montreal');
    expect(await state(c)).toEqual({
      timezone: 'America/Montreal',
      set: true,
      dirty: '2026-07-03 08:00:00+00',
    });
    // Another browser, elsewhere, changes nothing.
    expect(await zone(c, 'Asia/Tokyo', true)).toBe('America/Montreal');
    // The creator does.
    expect(await zone(c, 'Europe/Paris', false)).toBe('Europe/Paris');
    expect((await state(c))?.timezone).toBe('Europe/Paris');
  });

  it('refuses a zone Postgres does not know, and an unknown company', async () => {
    const c = await company();
    expect(await zone(c, 'Mars/Olympus', false)).toBeNull();
    expect((await state(c))?.timezone).toBe('Europe/Paris');
    await expect(zone('biz_Nobody', 'Europe/Paris', false)).rejects.toThrow(/unknown company/);
  });
});

describe('the announcement of a milestone (SPEC Phase 5, point 4)', () => {
  const announcement = (over: Partial<DueAction> = {}): DueAction => ({
    id: '7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6',
    companyId: 'biz_X',
    createdAt: '2026-10-01T08:00:00.000Z',
    type: 'milestone_announcement',
    attempts: 0,
    content: {
      platform: 'discord',
      channel_id: '920000000000000002',
      channel: '#wins',
      goal_title: 'Signer 10 clients',
      percent: 50,
    },
    globalKillSwitch: false,
    killSwitch: false,
    dryRun: false,
    locale: 'fr',
    timezone: 'Europe/Paris',
    quietHoursStart: 22,
    quietHoursEnd: 8,
    experienceId: 'exp_X',
    templates: {},
    member: { userId: 'user_X', doNotContact: false, joined: true },
    payment: null,
    membership: null,
    values: { first_name: 'Lina' },
    ...over,
  });
  const text = '🎉 Lina a atteint 50 % de son objectif : « Signer 10 clients » !';
  // At 23:00 in Paris: an announcement is no message to the member, quiet hours do not hold it.
  const at = Date.parse('2026-10-01T21:00:00Z');

  it('posts on Discord, mentioning nobody, at any hour', async () => {
    const posted: [string, string, string][] = [];
    const discord = {
      sendMessage: (channel: string, content: string, nonce: string) => {
        posted.push([channel, content, nonce]);
        return Promise.resolve();
      },
    } as unknown as DiscordClient;
    expect(await runAction(announcement(), null, at, { discord })).toEqual({
      status: 'sent',
      result: { text, platform: 'discord', channel: '#wins' },
    });
    expect(posted).toEqual([['920000000000000002', text, '7f3c2a109b4e4c1d8e2fa1b2c3d4e5f6']]);
  });

  it('posts in a Telegram group, or a Whop chat with its idempotency key', async () => {
    const sent: [string, string][] = [];
    const telegram = {
      sendMessage: (chat: string, content: string) => {
        sent.push([chat, content]);
        return Promise.resolve();
      },
    } as unknown as TelegramClient;
    const content = { ...announcement().content, platform: 'telegram', channel_id: '-1009' };
    expect(await runAction(announcement({ content }), null, at, { telegram })).toMatchObject({
      status: 'sent',
    });
    expect(sent).toEqual([['-1009', text]]);

    const calls: { path: string; body: unknown; key?: string }[] = [];
    const whop = {
      request: (
        _method: string,
        path: string,
        options: { body: unknown; idempotencyKey: string },
      ) => {
        calls.push({ path, body: options.body, key: options.idempotencyKey });
        return Promise.resolve({});
      },
    } as unknown as WhopClient;
    const chat = { ...announcement().content, platform: 'whop', channel_id: 'chat_Wins1' };
    await runAction(announcement({ content: chat, locale: 'en' }), whop, at);
    expect(calls).toEqual([
      {
        path: '/messages',
        body: {
          channel_id: 'chat_Wins1',
          content: '🎉 Lina reached 50% of their goal: “Signer 10 clients”!',
        },
        key: 'stayput-action-7f3c2a10-9b4e-4c1d-8e2f-a1b2c3d4e5f6',
      },
    ]);
  });

  it('is simulated in test mode, stopped like any action, and says what is missing', async () => {
    expect(await runAction(announcement({ dryRun: true }), null, at)).toEqual({
      status: 'simulated',
      result: { text, platform: 'discord', channel: '#wins' },
    });
    expect(await runAction(announcement({ killSwitch: true }), null, at)).toEqual({
      status: 'blocked_by_guardrail',
      reason: 'kill_switch',
    });
    expect(
      await runAction(
        announcement({ member: { userId: 'user_X', doNotContact: true, joined: true } }),
        null,
        at,
      ),
    ).toEqual({ status: 'blocked_by_guardrail', reason: 'do_not_contact' });
    // No Discord bot set up: nothing to post with, final.
    expect(await runAction(announcement(), null, at)).toEqual({
      status: 'failed',
      error: 'discord is not set up',
      retry: false,
    });
  });

  it('tries Discord again after an outage, never after a refusal', async () => {
    const failing = (status: number) =>
      ({
        sendMessage: () => Promise.reject(new DiscordApiError(status, `POST: ${status}`)),
      }) as unknown as DiscordClient;
    expect(await runAction(announcement(), null, at, { discord: failing(503) })).toMatchObject({
      status: 'failed',
      retry: true,
    });
    expect(await runAction(announcement(), null, at, { discord: failing(403) })).toMatchObject({
      status: 'failed',
      retry: false,
    });
  });
});

describe('the buddies’ introductions (SPEC Phase 5, point 8)', () => {
  beforeEach(async () => {
    await t.db.query(`update stayput.actions set status = 'cancelled' where status = 'scheduled'`);
  });

  it('introduce each one to the other at their golden hour, as a follow-up', async () => {
    const c = await company();
    await t.db.query('select stayput.save_buddies($1, true)', [c]);
    const ana = await member(c, { name: 'Ana Lopez' });
    await risk(c, ana, { level: 'low', since: hoursAgo(48) });
    const lea = await member(c, { name: 'Léa Martin' });
    await t.db.query(`update stayput.members set joined_at = $2::timestamptz where id = $1`, [
      lea,
      hoursAgo(30),
    ]);
    // The member space off (V1), nobody is paired.
    expect(await prepareActions(t.db, c, NOW)).toMatchObject({ planned: 0 });
    const prepared = await prepareActions(t.db, c, NOW, { memberSpace: true });
    expect(prepared).toMatchObject({ planned: 2, scheduled: 2, blocked: 0 });
    const intros = await t.db.query<{ type: string; member_id: string; send_at: string }>(
      `select type, member_id, send_at::text as send_at from stayput.actions
        where company_id = $1 and trigger = 'buddy_pair' order by type`,
      [c],
    );
    // Nothing known of their hours: the creator's default, 19:00 in Paris.
    expect(intros).toEqual([
      { type: 'buddy_intro', member_id: lea, send_at: '2026-10-01 17:00:00+00' },
      { type: 'mentor_intro', member_id: ana, send_at: '2026-10-01 17:00:00+00' },
    ]);

    const calls: { path: string; body: unknown }[] = [];
    const whop = {
      request: (_method: string, path: string, options?: { body?: unknown }) => {
        calls.push({ path, body: options?.body });
        return Promise.resolve({});
      },
    } as unknown as WhopClient;
    expect(await executeDueActions(t.db, whop, new Date('2026-10-01T17:00:00Z'))).toEqual({
      sent: 2,
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          path: '/notifications',
          body: {
            experience_id: 'exp_Club1',
            user_ids: [`user_Act${lea.replace('mber_Act', '')}`],
            title: 'Ton binôme t’attend, Léa',
            content:
              'Bienvenue dans Le Club ! Ana est membre depuis un moment et va t’aider à bien démarrer. Dis-lui bonjour dans la communauté.',
          },
        },
        {
          path: '/notifications',
          body: {
            experience_id: 'exp_Club1',
            user_ids: [`user_Act${ana.replace('mber_Act', '')}`],
            title: 'Un nouveau à accueillir, Ana',
            content:
              'Léa vient d’arriver dans Le Club. Tu connais le chemin : dis-lui bonjour et partage ton meilleur premier pas. Si ton binôme est toujours là dans 30 jours, tu gagnes le badge Mentor.',
          },
        },
      ]),
    );
  });

  it('name the buddy in words when Whop gave them no name', async () => {
    const intro = (type: 'buddy_intro' | 'mentor_intro', locale: string): DueAction => ({
      id: '1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d',
      companyId: 'biz_X',
      createdAt: '2026-10-01T08:00:00.000Z',
      type,
      attempts: 0,
      content: { pair_id: 'p', buddy_id: 'mber_X', buddy_name: null },
      globalKillSwitch: false,
      killSwitch: false,
      dryRun: true,
      locale,
      timezone: 'Europe/Paris',
      quietHoursStart: 22,
      quietHoursEnd: 8,
      experienceId: 'exp_X',
      templates: {},
      member: { userId: 'user_X', doNotContact: false, joined: true },
      payment: null,
      membership: null,
      values: { first_name: 'Lina', creator_name: 'Le Club' },
    });
    const at = Date.parse('2026-10-01T10:00:00Z');
    expect(await runAction(intro('buddy_intro', 'fr'), null, at)).toMatchObject({
      status: 'simulated',
      result: { message: { body: expect.stringContaining('Ton binôme est membre') as string } },
    });
    expect(await runAction(intro('mentor_intro', 'en'), null, at)).toMatchObject({
      status: 'simulated',
      result: { message: { body: expect.stringMatching(/^A new member just joined/) as string } },
    });
  });
});
