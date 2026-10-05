import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBenchmarks, refreshBenchmarks, saveBenchmarksSetting } from '../src/benchmarks';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0036, anonymous benchmarks (SPEC Phase 6.10): a niche's retention from the communities
 * that share theirs, each once, shown only from 5 of them, and only to a community that shares.
 */

// Monday 5 October 2026: the figures of October, from the arrivals of April to October.
const NOW = new Date('2026-10-05T07:30:00Z');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

/**
 * A community of `niche` whose arrivals of August left at `rates` (30, 60, 90 days), 20 of them
 * old enough at each horizon; sharing its figures or not.
 */
async function community(
  niche: string,
  rates: [number, number, number],
  over: { shares?: boolean; demo?: boolean; eligible?: number; month?: string } = {},
) {
  n += 1;
  const c = `biz_Bench${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, niche, is_demo) values ($1, 'Club', $2, $3)`,
    [c, niche, over.demo ?? false],
  );
  await t.db.query(
    `insert into stayput.company_settings (company_id, options)
     values ($1, jsonb_build_object('benchmarks_opt_in', $2::boolean))`,
    [c, over.shares ?? true],
  );
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', now())`,
    [c],
  );
  const eligible = over.eligible ?? 20;
  const left = rates.map((rate) => Math.round(eligible * rate));
  await t.db.query(
    `insert into stayput.cohort_stats (company_id, cohort_month, members, left_by_30, left_by_60,
                                       left_by_90, eligible_30, eligible_60, eligible_90,
                                       computed_at)
     values ($1, $2::date, $3, $4, $5, $6, $3, $3, $3, $7::timestamptz)`,
    [c, over.month ?? '2026-08-01', eligible, ...left, NOW.toISOString()],
  );
  return c;
}

const read = (c: string) => readBenchmarks(t.db, 'user_Owner', c, NOW);
const niche = async (c: string) => (await read(c))!.horizons.map((h) => h.niche);

describe('anonymous benchmarks', () => {
  it('shows a niche’s retention once 5 communities share theirs, each counted once', async () => {
    // Four fitness communities share: not enough.
    const first = await community('fitness', [0.1, 0.2, 0.3]);
    for (let i = 0; i < 3; i++) await community('fitness', [0.1, 0.2, 0.3]);
    // Neither one that keeps its figures, nor the demo, nor one with 8 members old enough, nor
    // arrivals more than 6 months ago count.
    await community('fitness', [0.9, 0.9, 0.9], { shares: false });
    await community('fitness', [0.9, 0.9, 0.9], { demo: true });
    await community('fitness', [0.9, 0.9, 0.9], { eligible: 8 });
    await community('fitness', [0.9, 0.9, 0.9], { month: '2026-03-01' });
    expect(await refreshBenchmarks(t.db, NOW)).toBe(3);
    expect(await niche(first)).toEqual([null, null, null]);
    // The fifth: each community's rate weighs the same, its size never.
    await community('fitness', [0.35, 0.45, 0.55], { eligible: 40 });
    await refreshBenchmarks(t.db, NOW);
    const view = await read(first);
    expect(view).toMatchObject({ optedIn: true, niche: 'fitness', minimum: 5 });
    expect(view!.horizons).toEqual([
      { days: 30, mine: 0.9, niche: 0.85 },
      { days: 60, mine: 0.8, niche: 0.75 },
      { days: 90, mine: 0.7, niche: 0.65 },
    ]);
    expect(view!.computedAt).toBe(NOW.toISOString());
    // What is kept names no community: a niche, a month, a figure, how many made it.
    const [row] = await t.db.query<Record<string, unknown>>(
      `select * from stayput.benchmarks where niche = 'fitness' and metric = 'retention_30'`,
    );
    expect(Object.keys(row!).sort()).toEqual(
      ['computed_at', 'contributors', 'metric', 'niche', 'period_month', 'value'].sort(),
    );
    expect(row!.contributors).toBe(5);
  });

  it('shows nothing of its niche to a community that does not share, and its own anyway', async () => {
    const shy = await community('fitness', [0.2, 0.3, 0.4], { shares: false });
    const view = await read(shy);
    expect(view!.optedIn).toBe(false);
    expect(view!.horizons.map((h) => h.niche)).toEqual([null, null, null]);
    expect(view!.horizons.map((h) => h.mine)).toEqual([0.8, 0.7, 0.6]);
    // Sharing shows them at once; the next refresh counts it.
    await saveBenchmarksSetting(t.db, shy, true);
    expect((await read(shy))!.horizons.map((h) => h.niche)).toEqual([0.85, 0.75, 0.65]);
  });

  it('leaves a community that stops sharing out of the next figures', async () => {
    const trading = [] as string[];
    for (let i = 0; i < 5; i++) trading.push(await community('trading', [0.2, 0.3, 0.4]));
    await refreshBenchmarks(t.db, NOW);
    expect(await niche(trading[1]!)).toEqual([0.8, 0.7, 0.6]);
    await saveBenchmarksSetting(t.db, trading[0]!, false);
    await refreshBenchmarks(t.db, NOW);
    expect(await niche(trading[1]!)).toEqual([null, null, null]);
  });

  it('says « too few yet » for its own figures with fewer than 10 members old enough', async () => {
    const small = await community('coaching', [0.5, 0.5, 0.5], { eligible: 6 });
    expect((await read(small))!.horizons.map((h) => h.mine)).toEqual([null, null, null]);
    expect(await readBenchmarks(t.db, 'user_Stranger', small, NOW)).toBeNull();
  });
});
