import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, createTestDb, type TestDb } from './helpers/db';

/**
 * 0053: the message to whoever installs StayPut goes to the communities installed from now on;
 * the ones StayPut already had installed it before there was a message, and never get it.
 */
const MIGRATION = '0053_install_message.sql';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ until: MIGRATION });
  await t.db.query(`insert into stayput.companies (id) values ('biz_Before1')`);
  await t.db.query(`insert into stayput.company_settings (company_id) values ('biz_Before1')`);
  await t.exec(readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8'));
});
afterAll(() => t.close());

describe('0053: the message to whoever installs StayPut', () => {
  it('counts the communities already there as done, sent by no way', async () => {
    const [before] = await t.db.query(
      `select install_message_at is not null as done, install_message_via as via
         from stayput.company_settings where company_id = 'biz_Before1'`,
    );
    expect(before).toEqual({ done: true, via: null });
  });

  it('leaves it to send for a community installed afterwards', async () => {
    await t.db.query(`insert into stayput.companies (id) values ('biz_After1')`);
    await t.db.query(`insert into stayput.company_settings (company_id) values ('biz_After1')`);
    const [after] = await t.db.query(
      `select install_message_at from stayput.company_settings where company_id = 'biz_After1'`,
    );
    expect(after).toEqual({ install_message_at: null });
  });

  it('knows only the two ways it reaches the team', async () => {
    await expect(
      t.db.query(
        `update stayput.company_settings set install_message_via = 'email'
          where company_id = 'biz_After1'`,
      ),
    ).rejects.toThrow();
  });
});
