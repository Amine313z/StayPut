import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Isolation between creators, and between members, enforced by Postgres itself: every query
 * here runs as a Whop user through withUser, the way the Worker reads for the dashboard and the
 * member view.
 */

let t: TestDb;

const ALICE = 'user_alice'; // admin of company A, verified now
const BOB = 'user_bob'; // admin of company B, verified now
const CAROL = 'user_carol'; // was admin of A, not verified for two days
const MEMBER_A1 = 'user_memberA1';
const MEMBER_A2 = 'user_memberA2';

beforeAll(async () => {
  t = await createTestDb();
  await t.exec(`
    insert into stayput.companies (id, name) values ('biz_A', 'Company A'), ('biz_B', 'Company B');
    insert into stayput.company_settings (company_id) values ('biz_A'), ('biz_B');
    insert into stayput.company_admins (company_id, user_id, verified_at) values
      ('biz_A', '${ALICE}', now()),
      ('biz_B', '${BOB}', now()),
      ('biz_A', '${CAROL}', now() - interval '2 days');
    insert into stayput.members (id, company_id, user_id) values
      ('mber_A1', 'biz_A', '${MEMBER_A1}'),
      ('mber_A2', 'biz_A', '${MEMBER_A2}'),
      ('mber_B1', 'biz_B', 'user_memberB1');
    insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id, status)
    values ('mem_A1', 'biz_A', 'mber_A1', '${MEMBER_A1}', 'prod_A', 'plan_A', 'active'),
           ('mem_B1', 'biz_B', 'mber_B1', 'user_memberB1', 'prod_B', 'plan_B', 'active');
    insert into stayput.payments (id, company_id, membership_id, member_id, amount, currency,
                                  status, whop_created_at)
    values ('pay_A1', 'biz_A', 'mem_A1', 'mber_A1', 29, 'usd', 'paid', now()),
           ('pay_B1', 'biz_B', 'mem_B1', 'mber_B1', 49, 'usd', 'paid', now());
    insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores, computed_at)
    values ('biz_A', 'mber_A1', 72, 'high', '{}', now()),
           ('biz_B', 'mber_B1', 10, 'low', '{}', now());
    insert into stayput.goals (id, company_id, member_id, title, target_value, unit) values
      ('00000000-0000-4000-8000-0000000000a1', 'biz_A', 'mber_A1', 'Run 10 km', 10, 'km'),
      ('00000000-0000-4000-8000-0000000000a2', 'biz_A', 'mber_A2', 'Read 12 books', 12, 'books'),
      ('00000000-0000-4000-8000-0000000000b1', 'biz_B', 'mber_B1', 'Save 1000', 1000, 'usd');
    insert into stayput.rescue_challenges (company_id, target_member_id, created_at)
    values ('biz_A', 'mber_A1', now());
    insert into stayput.benchmarks (niche, period_month, metric, value, contributors, computed_at)
    values ('fitness', '2026-09-01', 'retention_30', 0.81, 7, now()),
           ('trading', '2026-09-01', 'retention_30', 0.64, 3, now());
  `);
});
afterAll(() => t.close());

const ids = async (userId: string, sql: string) =>
  (await withUser(t.db, userId, (tx) => tx.query<{ id: string }>(sql))).map((r) => r.id).sort();

describe('a creator', () => {
  it('sees their own company only', async () => {
    expect(await ids(ALICE, 'select id from stayput.companies')).toEqual(['biz_A']);
    expect(await ids(BOB, 'select id from stayput.companies')).toEqual(['biz_B']);
  });

  it("sees their company's rows in every table, and none of another company's", async () => {
    const tables: Record<string, string> = {
      company_settings: 'select company_id as id from stayput.company_settings',
      members: 'select id from stayput.members',
      memberships: 'select id from stayput.memberships',
      payments: 'select id from stayput.payments',
      risk_scores: 'select member_id as id from stayput.risk_scores',
      goals: 'select member_id as id from stayput.goals',
      rescue_challenges: 'select target_member_id as id from stayput.rescue_challenges',
    };
    for (const [table, sql] of Object.entries(tables)) {
      const seen = await ids(ALICE, sql);
      expect(seen.length, table).toBeGreaterThan(0);
      expect(
        seen.every((id) => id.includes('A')),
        `${table}: ${seen.join(', ')}`,
      ).toBe(true);
      expect(
        (await ids(BOB, sql)).every((id) => id.includes('B')),
        table,
      ).toBe(true);
    }
  });

  it('loses access when Whop has not confirmed it for a day', async () => {
    expect(await ids(CAROL, 'select id from stayput.companies')).toEqual([]);
    expect(await ids(CAROL, 'select id from stayput.members')).toEqual([]);
  });

  it('cannot even filter their way into another company', async () => {
    expect(await ids(ALICE, `select id from stayput.members where company_id = 'biz_B'`)).toEqual(
      [],
    );
  });
});

describe('a member', () => {
  it('sees their own member row, membership and goals, nothing of others', async () => {
    expect(await ids(MEMBER_A1, 'select id from stayput.members')).toEqual(['mber_A1']);
    expect(await ids(MEMBER_A1, 'select id from stayput.memberships')).toEqual(['mem_A1']);
    expect(await ids(MEMBER_A1, 'select member_id as id from stayput.goals')).toEqual(['mber_A1']);
  });

  it('never sees a risk score, a payment, the company row or a rescue challenge', async () => {
    for (const sql of [
      'select member_id as id from stayput.risk_scores',
      'select id from stayput.payments',
      'select id from stayput.companies',
      'select target_member_id as id from stayput.rescue_challenges',
    ]) {
      expect(await ids(MEMBER_A1, sql), sql).toEqual([]);
    }
  });
});

describe('anyone else', () => {
  it('sees nothing', async () => {
    for (const table of ['companies', 'members', 'memberships', 'payments', 'goals']) {
      expect(await ids('user_stranger', `select 1 as id from stayput.${table}`), table).toEqual([]);
    }
  });
});

describe('shared data', () => {
  it('shows a benchmark only when at least 5 companies contributed', async () => {
    const rows = await withUser(t.db, ALICE, (tx) =>
      tx.query<{ niche: string }>('select niche from stayput.benchmarks'),
    );
    expect(rows.map((r) => r.niche)).toEqual(['fitness']);
  });

  it('shows the badge catalog to everyone', async () => {
    const rows = await withUser(t.db, 'user_stranger', (tx) =>
      tx.query('select code from stayput.badges'),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('the stayput_user role', () => {
  it('cannot write, even its own rows', async () => {
    await expect(
      withUser(t.db, MEMBER_A1, (tx) =>
        tx.query(`update stayput.goals set title = 'x' where member_id = 'mber_A1'`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withUser(t.db, ALICE, (tx) =>
        tx.query(`insert into stayput.company_admins values ('biz_B', '${ALICE}', now())`),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot read the server-only tables', async () => {
    await expect(
      withUser(t.db, ALICE, (tx) => tx.query('select * from stayput.company_admins')),
    ).rejects.toThrow(/permission denied/);
  });

  it('ends with the transaction: the connection goes back to its own role', async () => {
    await withUser(t.db, ALICE, (tx) => tx.query('select 1'));
    const [row] = await t.db.query<{ user: string; setting: string | null }>(
      `select current_user as user, nullif(current_setting('stayput.user_id', true), '') as setting`,
    );
    expect(row).toEqual({ user: 'postgres', setting: null });
  });
});
