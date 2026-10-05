import { WhopApiError, type WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAccess, upkeep } from '../src/upkeep';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The hourly upkeep (SPEC Phase 8.2 and 8.3): what Whop answers about a community whose members
 * it refuses, as the Worker reads it, and what the hour then purges and deletes.
 */

const NOW = new Date('2026-10-05T09:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

/** Whop's `GET /permissions`, answering per community as `answers` says. */
function whopAnswering(answers: Record<string, boolean | number>) {
  const asked: string[] = [];
  const whop = {
    request: (method: string, path: string, options?: { query?: Record<string, unknown> }) => {
      const company = String(options?.query?.resource_id);
      asked.push(`${method} ${path} ${company}`);
      const answer = answers[company];
      if (typeof answer === 'number') {
        return Promise.reject(
          new WhopApiError(answer, 'error', 'refused', { method, path: '/permissions' }),
        );
      }
      return Promise.resolve({
        data: [
          { action: 'company:basic:read', granted: answer === true },
          { action: 'member:basic:read', granted: answer === true },
        ],
      });
    },
  } as unknown as WhopClient;
  return { whop, asked };
}

async function refused(id: string) {
  await t.db.query(`insert into stayput.companies (id, name) values ($1, 'Club')`, [id]);
  await t.db.query(
    `insert into stayput.sync_state (company_id, stream, last_error, last_error_at)
     values ($1, 'members', '403 forbidden', now())`,
    [id],
  );
}

const status = async (id: string) =>
  (
    await t.db.query<{ status: string }>('select status from stayput.companies where id = $1', [id])
  )[0]?.status;

describe('the access check', () => {
  it('marks uninstalled what Whop refused everything for a day, and only that', async () => {
    await refused('biz_UpGone');
    await refused('biz_UpBack');
    const { whop, asked } = whopAnswering({ biz_UpGone: 403, biz_UpBack: true });
    expect(await checkAccess(t.db, whop, NOW)).toEqual({ checked: 2, uninstalled: [] });
    expect(asked).toEqual(['GET /permissions biz_UpBack', 'GET /permissions biz_UpGone']);
    // A day later, still refused: uninstalled. The other one was something else.
    expect(await checkAccess(t.db, whop, at(25))).toEqual({
      checked: 2,
      uninstalled: ['biz_UpGone'],
    });
    expect(await status('biz_UpGone')).toBe('uninstalled');
    expect(await status('biz_UpBack')).toBe('active');
  });

  it('marks nobody when Whop refuses the key itself', async () => {
    await refused('biz_UpKey');
    const { whop } = whopAnswering({ biz_UpKey: 401 });
    expect(await checkAccess(t.db, whop, at(100))).toEqual({ checked: 0, uninstalled: [] });
    expect(await checkAccess(t.db, whop, at(200))).toEqual({ checked: 0, uninstalled: [] });
    expect(await status('biz_UpKey')).toBe('active');
  });

  it('deletes 30 days later, in the same hour that purges the old deliveries', async () => {
    const { whop } = whopAnswering({});
    const later = await upkeep(t.db, whop, at(25 + 31 * 24));
    expect(later.deleted).toEqual(['biz_UpGone']);
    expect(await status('biz_UpGone')).toBeUndefined();
  });
});
