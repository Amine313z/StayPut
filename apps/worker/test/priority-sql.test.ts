import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareActions } from '../src/actions';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0029, « Retry now », the action of the day for failed payments (brief v3 §6.2): which
 * payments StayPut may have Whop charge again at once, and the retries brought forward or added,
 * approved by the click and still through the guardrails.
 */

const NOW = new Date('2026-10-15T08:00:00Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

async function community(mode: 'auto' | 'manual' = 'manual') {
  n += 1;
  const c = `biz_Retry${n}`;
  // Payment ids are unique across communities: each community's own, by a suffix.
  const suffix = `Z${n}`;
  const pay = (local: string) => `${local}${suffix}`;
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale, mode)
     values ($1, 'Le Club', 'Europe/Paris', 'fr', $2)`,
    [c, mode],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);
  const member = async (
    name: string,
    over: { status?: string; admin?: boolean; dnc?: boolean } = {},
  ) => {
    const id = `mber_${name}${n}`;
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                    access_level, do_not_contact)
       values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`,
      [
        id,
        c,
        `user_${name}${n}`,
        name,
        at(-24 * 60),
        over.status ?? 'joined',
        over.admin ? 'admin' : null,
        !!over.dnc,
      ],
    );
    return id;
  };
  const payment = async (
    memberId: string,
    id: string,
    over: { status?: string; retryable?: boolean; whopRetry?: boolean; hoursAgo?: number } = {},
  ) => {
    await t.db.query(
      `insert into stayput.payments (id, company_id, member_id, amount, currency, status,
                                     retryable, next_payment_attempt_at, whop_created_at)
       values ($1, $2, $3, 49, 'usd', $4, $5, $6::timestamptz, $7::timestamptz)`,
      [
        pay(id),
        c,
        memberId,
        over.status ?? 'failed',
        over.retryable ?? true,
        over.whopRetry ? at(24) : null,
        at(-(over.hoursAgo ?? 2)),
      ],
    );
  };
  const retry = async (
    memberId: string,
    paymentId: string,
    status: string,
    sendAt: number,
    attempt = 1,
  ) => {
    await t.db.query(
      `insert into stayput.actions (company_id, member_id, type, status, trigger, subject_id,
                                    dedupe_key, send_at, sent_at, blocked_reason, content)
       values ($1, $2, 'payment_retry', $3, 'payment_failed', $4, $5, $6::timestamptz,
               $7::timestamptz,
               case when $3 = 'blocked_by_guardrail' then 'payment_retry_cap' end,
               jsonb_build_object('payment_id', $4::text, 'attempt', $8::int))`,
      [
        c,
        memberId,
        status,
        pay(paymentId),
        `payment_retry:${pay(paymentId)}:${attempt}`,
        at(sendAt),
        status === 'sent' || status === 'simulated' ? at(sendAt) : null,
        attempt,
      ],
    );
  };
  const toRetry = async () =>
    (
      await t.db.query<{ payment_id: string; planned: string | null; attempt: number }>(
        `select payment_id, planned, attempt from stayput.payments_to_retry($1, $2::timestamptz)
          order by payment_id`,
        [c, NOW.toISOString()],
      )
    ).map((r) => ({
      payment: r.payment_id.slice(0, -suffix.length),
      planned: r.planned !== null,
      attempt: r.attempt,
    }));
  const retryNow = async () =>
    (
      await t.db.query<{ queued: number }>(
        'select stayput.retry_failed_payments($1, $2, $3::timestamptz) as queued',
        [c, 'user_Owner1', NOW.toISOString()],
      )
    )[0]?.queued;
  const retries = async (paymentId: string) =>
    (
      await t.db.query<{
        status: string;
        send_at: string;
        approved_by: string | null;
        key: string;
      }>(
        `select status, send_at::text, approved_by, dedupe_key as key from stayput.actions
          where company_id = $1 and type = 'payment_retry' and subject_id = $2
          order by created_at, dedupe_key`,
        [c, pay(paymentId)],
      )
    ).map((r) => ({ ...r, key: r.key.replace(suffix, '') }));
  return { c, member, payment, retry, toRetry, retryNow, retries };
}

describe('the failed payments StayPut may retry now', () => {
  it('is the last failed payment of a member, Whop retrying nothing itself', async () => {
    const club = await community();
    const ana = await club.member('Ana');
    const ben = await club.member('Ben');
    const cleo = await club.member('Cleo');
    const dan = await club.member('Dan');
    await club.payment(ana, 'pay_Ana1');
    // Ben paid since: his old failure is over.
    await club.payment(ben, 'pay_Ben1', { hoursAgo: 48 });
    await club.payment(ben, 'pay_Ben2', { status: 'paid', hoursAgo: 1 });
    // Whop retries Cleo's itself; Dan's cannot be retried.
    await club.payment(cleo, 'pay_Cleo1', { whopRetry: true });
    await club.payment(dan, 'pay_Dan1', { retryable: false });
    expect(await club.toRetry()).toEqual([{ payment: 'pay_Ana1', planned: false, attempt: 1 }]);
  });

  it('never for the team, a member gone or on the « never contact » list', async () => {
    const club = await community();
    for (const [name, over] of [
      ['Owner', { admin: true }],
      ['Gone', { status: 'left' }],
      ['Calm', { dnc: true }],
    ] as const) {
      await club.payment(await club.member(name, over), `pay_${name}`);
    }
    expect(await club.toRetry()).toEqual([]);
  });

  it('brings a planned retry forward, not one due within the hour, never a third', async () => {
    const club = await community();
    const ana = await club.member('Ana');
    const ben = await club.member('Ben');
    const cleo = await club.member('Cleo');
    await club.payment(ana, 'pay_Ana1');
    await club.retry(ana, 'pay_Ana1', 'scheduled', 22);
    await club.payment(ben, 'pay_Ben1');
    await club.retry(ben, 'pay_Ben1', 'scheduled', 0.5);
    await club.payment(cleo, 'pay_Cleo1', { hoursAgo: 100 });
    await club.retry(cleo, 'pay_Cleo1', 'sent', -76, 1);
    await club.retry(cleo, 'pay_Cleo1', 'sent', -28, 2);
    expect(await club.toRetry()).toEqual([{ payment: 'pay_Ana1', planned: true, attempt: 1 }]);
  });

  it('never tries again an attempt the guardrails stopped', async () => {
    const club = await community();
    const ana = await club.member('Ana');
    await club.payment(ana, 'pay_Ana1');
    await club.retry(ana, 'pay_Ana1', 'blocked_by_guardrail', 22);
    expect(await club.toRetry()).toEqual([]);
  });
});

describe('« Retry now »', () => {
  it('brings the planned retries forward and adds the missing ones, approved by the click', async () => {
    const club = await community();
    const ana = await club.member('Ana');
    const ben = await club.member('Ben');
    await club.payment(ana, 'pay_Ana1');
    await club.retry(ana, 'pay_Ana1', 'proposed', 22);
    await club.payment(ben, 'pay_Ben1', { hoursAgo: 80 });
    await club.retry(ben, 'pay_Ben1', 'sent', -56, 1);

    expect(await club.retryNow()).toBe(2);
    expect(await club.retries('pay_Ana1')).toEqual([
      {
        status: 'approved',
        send_at: (await t.db.query<{ v: string }>('select $1::timestamptz::text as v', [at(0)]))[0]
          ?.v,
        approved_by: 'user_Owner1',
        key: 'payment_retry:pay_Ana1:1',
      },
    ]);
    expect((await club.retries('pay_Ben1')).map((r) => [r.status, r.key, r.approved_by])).toEqual([
      ['sent', 'payment_retry:pay_Ben1:1', null],
      ['approved', 'payment_retry:pay_Ben1:2', 'user_Owner1'],
    ]);
    // Under way now: a second click changes nothing.
    expect(await club.retryNow()).toBe(0);
  });

  it('still goes through the guardrails', async () => {
    const club = await community();
    const ana = await club.member('Ana');
    await club.payment(ana, 'pay_Ana1');
    await t.db.query(
      'update stayput.company_settings set kill_switch = true where company_id = $1',
      [club.c],
    );
    expect(await club.retryNow()).toBe(1);
    await prepareActions(t.db, club.c, NOW);
    expect((await club.retries('pay_Ana1')).map((r) => r.status)).toEqual(['blocked_by_guardrail']);
  });
});
