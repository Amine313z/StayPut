import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The rules every table of the schema must follow. A new table that forgets one fails here, not
 * in production.
 */

// Tables no Whop user may read, even their own rows: the Worker alone uses them.
const SERVER_ONLY = [
  'app_settings',
  'company_admins',
  'company_sync',
  'pending_activity',
  'webhook_events',
];

// Tables with a company_id that is not a foreign key to companies, and why.
const COMPANY_ID_WITHOUT_FK: Record<string, string> = {
  webhook_events: 'a delivery can name a company that has not opened StayPut yet',
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function tables(): Promise<string[]> {
  const rows = await t.db.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'stayput' and c.relkind = 'r' order by 1`,
  );
  return rows.map((r) => r.name);
}

describe('schema stayput', () => {
  it('has the tables of SPEC section 3', async () => {
    expect(await tables()).toEqual(
      expect.arrayContaining([
        'companies',
        'company_settings',
        'members',
        'memberships',
        'payments',
        'activity_events',
        'member_stats_daily',
        'activity_hours',
        'risk_scores',
        'actions',
        'saves',
        'goals',
        'results',
        'proofs',
        'milestones',
        'badges',
        'member_badges',
        'buddy_pairs',
        'rescue_challenges',
        'exit_surveys',
        'alumni_members',
        'cohort_stats',
        'lesson_dropoff_stats',
        'benchmarks',
        'webhook_events',
        'billing',
        'audit_log',
      ]),
    );
  });

  it('enables RLS on every table', async () => {
    const rows = await t.db.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'stayput' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('gives stayput_user a read policy on every table but the server-only ones', async () => {
    const rows = await t.db.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'stayput' and c.relkind = 'r'
          and not exists (select 1 from pg_policies p
                           where p.schemaname = 'stayput' and p.tablename = c.relname
                             and 'stayput_user' = any (p.roles) and p.cmd in ('SELECT', 'ALL'))
        order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(SERVER_ONLY);
  });

  it('lets stayput_user read, and never write', async () => {
    for (const table of await tables()) {
      const [privileges] = await t.db.query<{ read: boolean; write: boolean }>(
        `select has_table_privilege('stayput_user', $1, 'SELECT') as read,
                has_table_privilege('stayput_user', $1, 'INSERT, UPDATE, DELETE, TRUNCATE')
                  as write`,
        [`stayput.${table}`],
      );
      expect(privileges, table).toEqual({ read: !SERVER_ONLY.includes(table), write: false });
    }
  });

  it('grants nothing to Supabase API roles', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [schema] = await t.db.query<{ usage: boolean }>(
        `select has_schema_privilege($1, 'stayput', 'USAGE') as usage`,
        [role],
      );
      expect(schema!.usage, role).toBe(false);
      for (const table of await tables()) {
        const [privilege] = await t.db.query<{ any: boolean }>(
          `select has_table_privilege($1, $2,
                    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as any`,
          [role, `stayput.${table}`],
        );
        expect(privilege!.any, `${role} on ${table}`).toBe(false);
      }
    }
  });

  it('lets no function be executed by PUBLIC', async () => {
    const rows = await t.db.query<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'stayput'
          and (p.proacl is null
               or exists (select 1 from aclexplode(p.proacl) a
                          where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`,
    );
    expect(rows).toEqual([]);
  });

  it('ties every company table to companies, deleted with it', async () => {
    const rows = await t.db.query<{ name: string; cascades: boolean }>(
      `select c.table_name as name,
              exists (
                select 1 from pg_constraint k
                 where k.conrelid = format('stayput.%I', c.table_name)::regclass
                   and k.contype = 'f' and k.confrelid = 'stayput.companies'::regclass
                   and k.confdeltype = 'c') as cascades
         from information_schema.columns c
        where c.table_schema = 'stayput' and c.column_name = 'company_id'
          and c.table_name <> 'companies'
        order by 1`,
    );
    const missing = rows.filter((r) => !r.cascades).map((r) => r.name);
    expect(missing).toEqual(Object.keys(COMPANY_ID_WITHOUT_FK));
  });

  it('refuses ids of the wrong kind', async () => {
    await t.db.query(`insert into stayput.companies (id) values ('biz_schema1')`);
    await expect(
      t.db.query(`insert into stayput.companies (id) values ('user_notacompany')`),
    ).rejects.toThrow(/check/);
    await expect(
      t.db.query(
        `insert into stayput.members (id, company_id, user_id)
         values ('user_wrongprefix', 'biz_schema1', 'user_1')`,
      ),
    ).rejects.toThrow(/check/);
  });

  it('keeps every reference inside one company', async () => {
    await t.db.query(`insert into stayput.companies (id) values ('biz_schemaA'), ('biz_schemaB')`);
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id)
       values ('mber_schemaA1', 'biz_schemaA', 'user_schema1')`,
    );
    // A membership of company B pointing at a member of company A.
    await expect(
      t.db.query(
        `insert into stayput.memberships (id, company_id, member_id, product_id, plan_id, status)
         values ('mem_cross1', 'biz_schemaB', 'mber_schemaA1', 'prod_1', 'plan_1', 'active')`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('seeds the badge catalog', async () => {
    const rows = await t.db.query<{ code: string }>(`select code from stayput.badges order by 1`);
    expect(rows.map((r) => r.code)).toContain('mentor');
  });
});
