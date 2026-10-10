import { NICHES } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The niches the schema keeps (0001, 0002, then 0050 for sports betting) are exactly the ones
 * packages/core knows: a community saves any of them, its benchmarks are kept under it, and a
 * niche nobody knows is refused.
 */

const NOW = '2026-10-10T12:00:00.000Z';
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', ['biz_Niche1', NOW]);
});
afterAll(() => t.close());

const save = (niche: string) =>
  t.db.query(
    'select stayput.save_risk_settings($1, $2, $3::text::jsonb, $4, $5, $6, $7::timestamptz)',
    [
      'biz_Niche1',
      niche,
      JSON.stringify({
        recency: 0.35,
        frequency: 0.3,
        progress: 0.05,
        payment: 0.2,
        friction: 0.1,
      }),
      7,
      40,
      70,
      NOW,
    ],
  );

describe('the niches of the schema', () => {
  it('takes every niche StayPut knows, sports betting included', async () => {
    expect(NICHES).toContain('sports_betting');
    for (const niche of NICHES) await save(niche);
    await save('sports_betting');
    const [row] = await t.db.query<{ niche: string }>(
      `select niche from stayput.companies where id = 'biz_Niche1'`,
    );
    expect(row?.niche).toBe('sports_betting');
    for (const niche of NICHES) {
      await t.db.query(
        `insert into stayput.benchmarks (niche, period_month, metric, value, contributors, computed_at)
         values ($1, '2026-09-01', 'retention_30', 0.8, 5, $2::timestamptz)`,
        [niche, NOW],
      );
    }
  });

  it('refuses a niche it does not know', async () => {
    await expect(save('poker')).rejects.toThrow(/companies_niche_check/);
    await expect(
      t.db.query(
        `insert into stayput.benchmarks (niche, period_month, metric, value, contributors, computed_at)
         values ('poker', '2026-09-01', 'retention_30', 0.8, 5, $1::timestamptz)`,
        [NOW],
      ),
    ).rejects.toThrow(/benchmarks_niche_check/);
  });
});
