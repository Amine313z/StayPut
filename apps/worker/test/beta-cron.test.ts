import type { WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, type Env } from '../src/env';
import { runActions, syncWithWhop, weeklyReports } from '../src/jobs';
import { member, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The private beta in the cron (decision of 2026-10-11): for a community it keeps out (one
 * StayPut recorded before the door was there, or one the founder took out of the registry),
 * nothing reaches anyone: no action sent, no Monday report, nothing more read from Whop. The
 * invited communities and the operator's go on as before.
 */

// A Monday, 10:00 in New York (the communities' zone by default, 0044): the Monday reports are
// due.
const MONDAY = new Date('2026-10-12T14:00:00Z');
const MONTH_AGO = new Date(MONDAY.getTime() - 30 * 86_400_000);
const ADMIN = 'user_Founder';
const ENV: Env = {
  WHOP_ENV: 'sandbox',
  WHOP_APP_ID: 'app_stayput',
  WHOP_API_KEY: 'test_key',
  ADMIN_USER_ID: ADMIN,
  OPERATOR_COMPANY_ID: 'biz_Operator',
  INVITE_ONLY: 'true',
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ via: 'install-sql' });
});
afterAll(() => t.close());

const db = () => ({ ...t.db, close: () => Promise.resolve() });

/** Whop, faked: every call recorded; notifications taken, lists empty. */
function fakeWhop() {
  const calls: { method: string; path: string; body?: unknown; params?: unknown }[] = [];
  const client = {
    env: 'sandbox',
    request(method: string, path: string, options?: { body?: unknown }) {
      calls.push({ method, path, body: options?.body });
      return Promise.resolve({ success: true });
    },
    listPage(path: string, params?: unknown) {
      calls.push({ method: 'GET', path, params });
      return Promise.resolve({ items: [], nextCursor: null });
    },
    getRaw(path: string, params?: unknown) {
      calls.push({ method: 'GET', path, params });
      return Promise.resolve('{"data":[],"page_info":{"end_cursor":null,"has_next_page":false}}');
    },
    checkAccess() {
      return Promise.resolve({ hasAccess: true, accessLevel: 'admin' as const });
    },
  } as unknown as WhopClient;
  return { client, calls };
}

/** A community StayPut has, with its first member and an action of theirs due now. */
async function community(id: string, openedBy: string | null) {
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [
    id,
    MONTH_AGO.toISOString(),
  ]);
  if (openedBy) {
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, $2, $3::timestamptz)`,
      [id, openedBy, MONTH_AGO.toISOString()],
    );
  }
  const tag = id.slice(4);
  await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
    id,
    'members',
    JSON.stringify(page([member(`mber_${tag}`, `user_${tag}`)])),
  ]);
  await t.db.query(
    `insert into stayput.actions (company_id, member_id, type, status, trigger, send_at,
                                  approved_by, message_kind)
     values ($1, $2, 'golden_hour_message', 'scheduled', 'score_high', $3::timestamptz,
             'user_Creator', 'relance')`,
    [id, `mber_${tag}`, new Date(MONDAY.getTime() - 60_000).toISOString()],
  );
}

const action = async (id: string) =>
  (
    await t.db.query<{ status: string; send_at: Date | string }>(
      'select status, send_at from stayput.actions where company_id = $1',
      [id],
    )
  )[0]!;

describe('the private beta in the cron', () => {
  it('sends nothing and reads nothing for a community it keeps out', async () => {
    // Invited by the founder, opened by its tester: StayPut works.
    await community('biz_Invited', 'user_Tester');
    await t.db.query(
      `insert into stayput.founders (company_id, invited_at) values ('biz_Invited', $1)`,
      [MONTH_AGO.toISOString()],
    );
    // The operator's own: StayPut works without an invitation.
    await community('biz_Operator', 'user_Operator');
    // Recorded by its webhooks before the door was there, never opened.
    await community('biz_Legacy', null);
    // Opened by a tester the founder took out of the registry since.
    await community('biz_Removed', 'user_Removed');
    const config = readConfig(ENV);

    // The Monday report: to the invited community and the operator's only.
    const reports = fakeWhop();
    await weeklyReports.run({
      config,
      db: db(),
      whop: reports.client,
      syncWhop: null,
      now: MONDAY,
    });
    const notified = reports.calls
      .filter((call) => call.path === '/notifications')
      .map((call) => (call.body as { account_id: string }).account_id)
      .sort();
    expect(notified).toEqual(['biz_Invited', 'biz_Operator']);

    // The actions: those of the communities kept out wait an hour, unsent; the others run.
    const actions = fakeWhop();
    await runActions.run({
      config,
      db: db(),
      whop: actions.client,
      syncWhop: null,
      now: MONDAY,
    });
    const anHourOn = new Date(MONDAY.getTime() + 3_600_000).toISOString();
    for (const shut of ['biz_Legacy', 'biz_Removed']) {
      const kept = await action(shut);
      expect(kept.status).toBe('scheduled');
      expect(new Date(kept.send_at).toISOString()).toBe(anHourOn);
    }
    for (const open of ['biz_Invited', 'biz_Operator']) {
      expect((await action(open)).status).not.toBe('scheduled');
    }
    expect(JSON.stringify(actions.calls)).not.toMatch(/Legacy|Removed/);

    // The synchronization: nothing more read for the community taken out; the others' passes go
    // on (each pass is kept in company_sync).
    const sync = fakeWhop();
    await syncWithWhop.run({ config, db: db(), whop: null, syncWhop: sync.client, now: MONDAY });
    const synced = await t.db.query<{ company_id: string }>(
      'select company_id from stayput.company_sync order by company_id',
    );
    expect(synced.map((row) => row.company_id)).toEqual(['biz_Invited', 'biz_Operator']);

    // Without INVITE_ONLY (the public launch), every community is served again.
    const open = readConfig({ ...ENV, INVITE_ONLY: 'false' });
    const later = new Date(MONDAY.getTime() + 2 * 3_600_000);
    const all = fakeWhop();
    await runActions.run({ config: open, db: db(), whop: all.client, syncWhop: null, now: later });
    for (const back of ['biz_Legacy', 'biz_Removed']) {
      expect((await action(back)).status).not.toBe('scheduled');
    }
  });
});
