import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAlumni } from '../src/alumni';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0039, the Alumni's own figures (SPEC Phase 6.13): who is in it, the share who came
 * back, and what those who came back paid since they entered it.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function community(id: string) {
  await t.db.query(`insert into stayput.companies (id, name) values ($1, 'Club')`, [id]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', now())`,
    [id],
  );
}

async function alumnus(
  company: string,
  tag: string,
  status: 'entered' | 'left' | 'returned',
  enteredAt: string,
) {
  const member = `mber_${tag}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, status) values ($1, $2, $3, 'joined')`,
    [member, company, `user_${tag}`],
  );
  await t.db.query(
    `insert into stayput.alumni_members (company_id, member_id, entry_mode, departed_at,
                                         entered_at, status)
     values ($1, $2, 'link', $3::timestamptz - interval '2 days', $3::timestamptz, $4)`,
    [company, member, enteredAt, status],
  );
  return member;
}

let payments = 0;
async function paid(
  company: string,
  member: string,
  amount: number,
  paidAt: string,
  over: { currency?: string; status?: string } = {},
) {
  payments += 1;
  await t.db.query(
    `insert into stayput.payments (id, company_id, member_id, amount, currency, status, paid_at,
                                   whop_created_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
    [
      `pay_Alu${payments}`,
      company,
      member,
      amount,
      over.currency ?? 'usd',
      over.status ?? 'paid',
      paidAt,
    ],
  );
}

describe('the Alumni’s figures', () => {
  it('counts who came back and what they paid since they entered the Alumni', async () => {
    await community('biz_AluMoney');
    const back = await alumnus('biz_AluMoney', 'AluBack', 'returned', '2026-08-01T10:00:00Z');
    // Paid before entering the Alumni: their old membership, not money recovered.
    await paid('biz_AluMoney', back, 49, '2026-07-15T10:00:00Z');
    await paid('biz_AluMoney', back, 49, '2026-09-01T10:00:00Z');
    await paid('biz_AluMoney', back, 49, '2026-10-01T10:00:00Z');
    // Refunded: never counted.
    await paid('biz_AluMoney', back, 49, '2026-09-15T10:00:00Z', { status: 'refunded' });
    const vip = await alumnus('biz_AluMoney', 'AluVip', 'returned', '2026-09-10T10:00:00Z');
    await paid('biz_AluMoney', vip, 149, '2026-09-20T10:00:00Z');
    await paid('biz_AluMoney', vip, 30, '2026-09-21T10:00:00Z', { currency: 'eur' });
    // Still in the Alumni or gone from it: what they paid is not a return.
    const still = await alumnus('biz_AluMoney', 'AluStill', 'entered', '2026-09-01T10:00:00Z');
    await paid('biz_AluMoney', still, 49, '2026-09-05T10:00:00Z');
    await alumnus('biz_AluMoney', 'AluGone', 'left', '2026-08-20T10:00:00Z');

    const view = await readAlumni(t.db, 'user_Owner', 'biz_AluMoney');
    expect(view).toMatchObject({
      entered: 1,
      left: 1,
      returned: 2,
      returnRate: 0.5,
      recovered: { amount: 247, currency: 'usd', otherCurrencies: true },
    });
  });

  it('has no rate and no money before anyone entered, and nothing for a stranger', async () => {
    await community('biz_AluNone');
    expect(await readAlumni(t.db, 'user_Owner', 'biz_AluNone')).toMatchObject({
      entered: 0,
      left: 0,
      returned: 0,
      returnRate: null,
      recovered: null,
    });
    expect(await readAlumni(t.db, 'user_Stranger', 'biz_AluMoney')).toBeNull();
  });
});
