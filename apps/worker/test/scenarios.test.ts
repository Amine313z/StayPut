import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runScenarios, verdictTable } from '../../../scripts/seed/scenarios';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * scripts/seed/scenarios.ts on an in-memory database: the money loop on fake members, through the
 * Worker's own hourly jobs. The same scenarios run on the sandbox's database (`seed-sandbox.ts
 * scenarios`), inside a transaction rolled back.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ via: 'install-sql' });
});
afterAll(() => t.close());

describe('the money loop on fake members', () => {
  it('scores, acts through Whop, and counts the money saved once', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const verdicts = await runScenarios(t.db, new Date());
    info.mockRestore();
    const failed = verdicts.filter((v) => !v.ok);
    expect(failed, verdictTable('The money loop', verdicts).join('\n')).toEqual([]);
    expect(verdicts.length).toBeGreaterThan(15);
  }, 120_000);
});
