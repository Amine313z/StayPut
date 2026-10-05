import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPORTED_TABLES,
  NOT_EXPORTED,
  deleteCompanyData,
  exportCompanyData,
  readTeam,
} from '../src/data';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0038, Settings › General (SPEC Phase 6.12): the team, and the community's data,
 * exported whole under RLS or deleted whole at its team's request.
 */

const NOW = new Date('2026-10-05T09:00:00Z');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function community(id: string, owner: string) {
  const tag = id.slice('biz_'.length);
  await t.db.query(`insert into stayput.companies (id, name) values ($1, 'Club')`, [id]);
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [id]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, $2, now())`,
    [id, owner],
  );
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, username, status,
                                  access_level)
     values ($1, $2, $3, 'Owner', 'owner', 'joined', 'admin'),
            ($4, $2, $5, 'Lea Martin', 'lea', 'joined', 'customer'),
            ($6, $2, $7, 'Moderator', 'mod', 'joined', 'admin')`,
    [`mber_${tag}1`, id, owner, `mber_${tag}2`, `user_${tag}Lea`, `mber_${tag}3`, `user_${tag}Mod`],
  );
  await t.db.query(
    `insert into stayput.webhook_events (id, type, company_id, payload, received_at)
     values ($1, 'membership.activated', $2, '{}', now())`,
    [`msg_${tag}`, id],
  );
}

describe('the community’s data', () => {
  beforeAll(async () => {
    await community('biz_DataA', 'user_OwnerA');
    await community('biz_DataB', 'user_OwnerB');
  });

  it('exports every table with a company id, or says why one is left out', async () => {
    const rows = await t.db.query<{ name: string }>(
      `select distinct c.table_name as name from information_schema.columns c
        where c.table_schema = 'stayput' and c.column_name = 'company_id' order by 1`,
    );
    const tables = rows.map((r) => r.name);
    expect([...EXPORTED_TABLES, ...Object.keys(NOT_EXPORTED)].sort()).toEqual(tables);
  });

  it('exports the community’s rows only, read as its team member', async () => {
    const data = await exportCompanyData(t.db, 'user_OwnerA', 'biz_DataA', NOW);
    expect(data).not.toBeNull();
    expect(data!.exportedAt).toBe(NOW.toISOString());
    expect(data!.company).toMatchObject({ id: 'biz_DataA', name: 'Club' });
    expect(Object.keys(data!.tables)).toEqual([...EXPORTED_TABLES]);
    const members = data!.tables.members!;
    expect(members.truncated).toBe(false);
    expect(members.rows.map((m) => m.company_id)).toEqual(['biz_DataA', 'biz_DataA', 'biz_DataA']);
    expect(data!.team.map((m) => m.name)).toEqual(['Owner', 'Moderator']);
    // Another team's member reads nothing of it.
    expect(await exportCompanyData(t.db, 'user_OwnerB', 'biz_DataA', NOW)).toBeNull();
  });

  it('lists the Whop team and who opened StayPut', async () => {
    const team = await readTeam(t.db, 'user_OwnerA', 'biz_DataA');
    expect(team.members).toEqual([
      {
        userId: 'user_OwnerA',
        name: 'Owner',
        username: 'owner',
        openedAt: expect.any(String) as string,
      },
      { userId: 'user_DataAMod', name: 'Moderator', username: 'mod', openedAt: null },
    ]);
    expect((await readTeam(t.db, 'user_OwnerB', 'biz_DataA')).members).toEqual([]);
  });

  it('deletes everything about one community, and nothing of another', async () => {
    expect(await deleteCompanyData(t.db, 'biz_DataA')).toBe(true);
    for (const table of [...EXPORTED_TABLES, ...Object.keys(NOT_EXPORTED)]) {
      const [row] = await t.db.query<{ n: number }>(
        `select count(*)::int as n from stayput.${table} where company_id = 'biz_DataA'`,
      );
      expect(row!.n, table).toBe(0);
    }
    const [left] = await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.members where company_id = 'biz_DataB'`,
    );
    expect(left!.n).toBe(3);
    expect(await deleteCompanyData(t.db, 'biz_DataA')).toBe(false);
  });
});
