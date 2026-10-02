import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordSaves } from '../src/saves';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0027, the money StayPut saved (SPEC Phase 6.4): the facts the database gathers, the
 * decision of packages/core, and what is kept, a payment counted once.
 */

const NOW = new Date('2026-10-01T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

async function community() {
  n += 1;
  const c = `biz_Save${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale) values ($1, 'Le Club', 'Europe/Paris', 'fr')`,
    [c],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);

  const member = async (name: string, price = 49) => {
    const id = `mber_${name}${n}`;
    const membership = `mem_${name}${n}`;
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status)
       values ($1, $2, $3, $4, $5::timestamptz, 'joined')`,
      [id, c, `user_${name}${n}`, name, days(-120)],
    );
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status)
       values ($1, $2, $3, $4, 'prod_Club', 'plan_Month', $5, 'eur', 30, 'active')`,
      [membership, c, id, `user_${name}${n}`, price],
    );
    return { id, membership };
  };

  const payment = async (
    id: string,
    who: { id: string; membership: string },
    status: string,
    paidAt: number | null,
    amount = 49,
  ) => {
    await t.db.query(
      `insert into stayput.payments (id, company_id, membership_id, member_id, amount, currency,
                                     status, paid_at, whop_created_at)
       values ($1, $2, $3, $4, $5, 'eur', $6, $7::timestamptz, $8::timestamptz)`,
      [
        `${id}${n}`,
        c,
        who.membership,
        who.id,
        amount,
        status,
        paidAt === null ? null : days(paidAt),
        days(paidAt ?? -3),
      ],
    );
    return `${id}${n}`;
  };

  const action = async (
    who: { id: string },
    type: string,
    status: 'sent' | 'simulated',
    sentAt: number,
    subject: string | null = null,
  ) => {
    const [row] = await t.db.query<{ id: string }>(
      `insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                    subject_id, send_at, sent_at)
       values ($1, $2, $3, $4, 'test', 'service', $5, $6::timestamptz, $6::timestamptz)
       returning id`,
      [c, who.id, type, status, subject, days(sentAt)],
    );
    return row!.id;
  };

  const activity = async (who: { id: string }, type: string, at: number) => {
    await t.db.query(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at)
       values ($1, $2, $3, $4::timestamptz)`,
      [c, who.id, type, days(at)],
    );
  };

  const saves = () =>
    t.db.query<{
      save_type: string;
      category: string;
      amount: string;
      currency: string;
      payment_id: string;
      proof: string[];
    }>(
      `select save_type, category, amount::text, currency, payment_id, proof
         from stayput.saves where company_id = $1 order by saved_at`,
      [c],
    );

  return { c, member, payment, action, activity, saves };
}

describe('the money StayPut saved, kept in the database', () => {
  it('keeps a recovered payment once, and never one of a simulated action', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const failed = await club.payment('pay_Failed', lea, 'failed', null);
    const notice = await club.action(lea, 'payment_failed_notice', 'sent', -2, failed);
    const paid = await club.payment('pay_Ok', lea, 'succeeded', -1);
    // In test mode nothing went out: the payment that followed is not StayPut's doing.
    const noe = await club.member('Noe');
    await club.action(noe, 'payment_retry', 'simulated', -2, null);
    await club.payment('pay_Noe', noe, 'succeeded', -1);

    expect(await recordSaves(t.db, club.c, new Date(NOW))).toBe(1);
    expect(await club.saves()).toEqual([
      {
        save_type: 'payment_recovered',
        category: 'direct',
        amount: '49.00',
        currency: 'EUR',
        payment_id: paid,
        proof: [notice, failed, paid],
      },
    ]);
    // The next hour finds nothing new.
    expect(await recordSaves(t.db, club.c, new Date(NOW.getTime() + 3_600_000))).toBe(0);
    expect(await club.saves()).toHaveLength(1);
  });

  it('keeps apart the renewal of a member at risk who came back after the message', async () => {
    const club = await community();
    const zoe = await club.member('Zoe', 29);
    const message = await club.action(zoe, 'high_risk_message', 'sent', -20);
    // Reading the message in StayPut is not coming back; a message in the community is.
    await club.activity(zoe, 'stayput_open', -19);
    await club.activity(zoe, 'message', -12);
    const renewal = await club.payment('pay_Renewal', zoe, 'succeeded', -5, 29);

    expect(await recordSaves(t.db, club.c, new Date(NOW))).toBe(1);
    expect(await club.saves()).toEqual([
      {
        save_type: 'renewal_after_message',
        category: 'influenced',
        amount: '29.00',
        currency: 'EUR',
        payment_id: renewal,
        proof: [message, renewal],
      },
    ]);
  });

  it('claims nothing for a member who only read the message', async () => {
    const club = await community();
    const max = await club.member('Max');
    await club.action(max, 'high_risk_message', 'sent', -20);
    await club.activity(max, 'stayput_open', -19);
    await club.payment('pay_Max', max, 'succeeded', -5);
    expect(await recordSaves(t.db, club.c, new Date(NOW))).toBe(0);
  });
});
