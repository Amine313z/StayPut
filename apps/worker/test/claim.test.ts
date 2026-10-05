import { describe, expect, it } from 'vitest';
import { claimDatabase, claimedBy, claimProblem } from '../../../scripts/deploy/claim';
import { createTestDb } from './helpers/db';

/** One database, one deployment (SPEC Phase 9, scripts/deploy/claim.ts, migration 0043). */
describe('the deployment a database serves', () => {
  it('is the first one to migrate it; the other one is refused from then on', async () => {
    const t = await createTestDb();
    try {
      expect(await claimedBy(t.db)).toBeNull();
      expect(await claimDatabase(t.db, 'sandbox')).toBeNull();
      expect(await claimedBy(t.db)).toBe('sandbox');
      // The sandbox again, at each of its deployments: fine.
      expect(await claimDatabase(t.db, 'sandbox')).toBeNull();
      // Production given the sandbox's database: refused, and the database stays the sandbox's.
      expect(await claimDatabase(t.db, 'production')).toMatch(
        /belongs to the sandbox deployment: .*PRODUCTION_SUPABASE_DB_URL/,
      );
      expect(await claimedBy(t.db)).toBe('sandbox');
    } finally {
      await t.close();
    }
  });

  it('has nothing to claim before migration 0043: the first migration runs', async () => {
    const t = await createTestDb({ until: '0043_deployment_target.sql' });
    try {
      expect(await claimedBy(t.db)).toBeUndefined();
      expect(claimProblem(undefined, 'production')).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('knows only the sandbox and production', async () => {
    const t = await createTestDb();
    try {
      await expect(claimDatabase(t.db, 'staging')).rejects.toThrow(/check/);
      expect(claimProblem('production', 'sandbox')).toMatch(/needs its own \(SUPABASE_DB_URL/);
    } finally {
      await t.close();
    }
  });
});
