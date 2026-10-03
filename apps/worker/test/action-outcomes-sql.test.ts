import type { ActionRow } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readActions } from '../src/action-views';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * What came of each action of the History (fix prompt v4.1, block 4), read under RLS as the
 * team: the money saved through it, a payment still failing, a pause until its end, a member
 * who came back after it, one with no reply yet, one who left since.
 */

const NOW = new Date('2026-10-15T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();
const C = 'biz_Outcome1';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale, mode)
     values ($1, 'Le Club', 'Europe/Paris', 'fr', 'manual')`,
    [C],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [C]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Boss', now())`,
    [C],
  );
});
afterAll(() => t.close());

async function member(name: string, status: 'joined' | 'left' = 'joined') {
  const id = `mber_${name}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status)
     values ($1, $2, $3, $4, $5::timestamptz, $6)`,
    [id, C, `user_${name}`, name, days(-90), status],
  );
  await t.db.query(
    `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                      price, currency, billing_period_days, status,
                                      current_period_end)
     values ($1, $2, $3, $4, 'prod_Club', 'plan_Month', 49, 'usd', 30, $5, $6::timestamptz)`,
    [
      `mem_${name}`,
      C,
      id,
      `user_${name}`,
      status === 'left' ? 'canceled' : 'active',
      status === 'left' ? days(-2) : days(20),
    ],
  );
  return id;
}

async function action(
  memberId: string,
  type: string,
  sentAgo: number,
  result: Record<string, unknown> | null = null,
) {
  const [row] = await t.db.query<{ id: string }>(
    `insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                  send_at, sent_at, result)
     values ($1, $2, $3, 'sent', 'test', 'relance', $4::timestamptz, $4::timestamptz, $5::jsonb)
     returning id`,
    [C, memberId, type, days(-sentAgo), result === null ? null : JSON.stringify(result)],
  );
  return row!.id;
}

async function payment(memberId: string, id: string, status: string, ago: number) {
  await t.db.query(
    `insert into stayput.payments (id, company_id, membership_id, member_id, amount, currency,
                                   status, paid_at, whop_created_at)
     values ($1, $2, $3, $4, 49, 'usd', $5, $6::timestamptz, $6::timestamptz)`,
    [id, C, memberId.replace('mber_', 'mem_'), memberId, status, days(-ago)],
  );
}

describe('the History says what came of each action', () => {
  it('reads the save, the payment, the pause, the activity and the departure after it', async () => {
    // Clara's payment failed, StayPut retried it, it came in: saved through the retry.
    const clara = await member('Clara');
    await payment(clara, 'pay_Clara1', 'succeeded', 1);
    const retry = await action(clara, 'payment_retry', 1.1);
    await t.db.query(
      `insert into stayput.saves (company_id, member_id, action_id, save_type, category, amount,
                                  currency, payment_id, saved_at)
       values ($1, $2, $3, 'payment_recovered', 'direct', 49, 'usd', 'pay_Clara1',
               $4::timestamptz)`,
      [C, clara, retry, days(-1)],
    );
    // Elena's retry failed again.
    const elena = await member('Elena');
    await payment(elena, 'pay_Elena1', 'failed', 0.5);
    await action(elena, 'payment_retry', 0.6);
    // Juliette paused for 30 days.
    const juliette = await member('Juliette');
    await action(juliette, 'pause_offer', 0.2, { resumes_at: days(30) });
    // Victor came back after StayPut's message; Rose did not, yet.
    const victor = await member('Victor');
    await action(victor, 'high_risk_message', 2);
    await t.db.query(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id)
       values ($1, $2, 'message', $3::timestamptz, 'msg-victor-1')`,
      [C, victor, days(-1)],
    );
    const rose = await member('Rose');
    await t.db.query(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id)
       values ($1, $2, 'message', $3::timestamptz, 'msg-rose-1')`,
      [C, rose, days(-6)],
    );
    await action(rose, 'creator_message', 3);
    // Sabrina left after the offer.
    const sabrina = await member('Sabrina', 'left');
    await action(sabrina, 'promo_offer', 9);

    const page = await readActions(t.db, 'user_Boss', C, 'history', NOW);
    const outcome = (memberId: string) =>
      page?.actions.find((a: ActionRow) => a.member.id === memberId)?.outcome;
    expect(outcome(clara)).toEqual({ kind: 'recovered', amount: 49, currency: 'usd' });
    expect(outcome(elena)).toEqual({ kind: 'still_failing' });
    expect(outcome(juliette)).toEqual({ kind: 'paused', until: days(30) });
    expect(outcome(victor)).toEqual({ kind: 'came_back' });
    expect(outcome(rose)).toEqual({ kind: 'no_reply' });
    expect(outcome(sabrina)).toEqual({ kind: 'left' });
    // The lists of what waits say nothing of it.
    const queue = await readActions(t.db, 'user_Boss', C, 'queue', NOW);
    expect(queue?.actions.every((a) => a.outcome === undefined)).toBe(true);
  });
});
