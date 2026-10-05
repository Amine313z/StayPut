import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBadge, readPublicBadge, saveBadgeSetting, verifiedRetention } from '../src/badge';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0037, the « Verified retention » badge (SPEC Phase 6.11): the members who joined in
 * the last 12 months still there after 90 days, public only once the team turns it on, and only
 * with enough members to mean something.
 */

const NOW = new Date('2026-10-05T09:00:00Z');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

async function community(over: { demo?: boolean; status?: 'active' | 'uninstalled' } = {}) {
  n += 1;
  const c = `biz_Badge${n}`;
  const uninstalled = over.status === 'uninstalled';
  await t.db.query(
    `insert into stayput.companies (id, name, locale, is_demo, status, uninstalled_at)
     values ($1, 'Le Club', 'fr', $2, $3, $4::timestamptz)`,
    [c, over.demo ?? false, over.status ?? 'active', uninstalled ? NOW.toISOString() : null],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', now())`,
    [c],
  );
  return c;
}

async function cohort(c: string, month: string, eligible: number, left: number) {
  await t.db.query(
    `insert into stayput.cohort_stats (company_id, cohort_month, members, left_by_90,
                                       eligible_90, computed_at)
     values ($1, $2::date, $3, $4, $3, $5::timestamptz)`,
    [c, month, eligible, left, NOW.toISOString()],
  );
}

describe('the verified retention badge', () => {
  it('counts the arrivals of the last 12 months old enough for 90 days, from 10 of them', async () => {
    const c = await community();
    await cohort(c, '2026-03-01', 6, 1);
    // Too few yet: no figure.
    expect(await verifiedRetention(t.db, c, NOW)).toMatchObject({ retention: null, members: 6 });
    await cohort(c, '2026-06-01', 14, 2);
    // More than 12 months ago: not counted.
    await cohort(c, '2025-08-01', 50, 40);
    expect(await verifiedRetention(t.db, c, NOW)).toEqual({
      retention: 0.85,
      members: 20,
      computedAt: NOW.toISOString(),
    });
  });

  it('is public only once turned on, for a community still using StayPut', async () => {
    const c = await community();
    await cohort(c, '2026-05-01', 20, 2);
    expect(await readPublicBadge(t.db, c, NOW)).toBeNull();
    await saveBadgeSetting(t.db, c, true);
    expect(await readPublicBadge(t.db, c, NOW)).toMatchObject({
      name: 'Le Club',
      locale: 'fr',
      retention: 0.9,
      members: 20,
    });
    const view = await readBadge(t.db, 'user_Owner', c, NOW, 'https://stayput.example');
    expect(view).toEqual({
      enabled: true,
      retention: 0.9,
      members: 20,
      locale: 'fr',
      badgeUrl: `https://stayput.example/badge/${c}.svg`,
      verifyUrl: `https://stayput.example/verify/${c}`,
    });
    expect(await readBadge(t.db, 'user_Stranger', c, NOW, 'https://stayput.example')).toBeNull();

    for (const over of [{ demo: true }, { status: 'uninstalled' as const }]) {
      const other = await community(over);
      await cohort(other, '2026-05-01', 20, 2);
      await saveBadgeSetting(t.db, other, true);
      expect(await readPublicBadge(t.db, other, NOW), JSON.stringify(over)).toBeNull();
    }
  });
});
