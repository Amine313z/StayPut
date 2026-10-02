import { attributeSaves, type AttributionFacts } from '@stayput/core';
import type { Db } from './db';

/**
 * SPEC Phase 6.4, every hour after the actions: the money each company's actions saved. The
 * database gathers the facts (attribution_facts), packages/core decides (attributeSaves), the
 * database keeps it (record_saves), a payment counted once.
 */
export async function recordSaves(db: Db, companyId: string, now: Date): Promise<number> {
  const [row] = await db.query<{ facts: Omit<AttributionFacts, 'counted'> }>(
    'select stayput.attribution_facts($1, $2::timestamptz) as facts',
    [companyId, now.toISOString()],
  );
  if (!row || row.facts.actions.length === 0 || row.facts.payments.length === 0) return 0;
  // The payments already counted are left out by the database.
  const saves = attributeSaves({ ...row.facts, counted: new Set() });
  if (saves.length === 0) return 0;
  const [kept] = await db.query<{ count: number }>(
    'select stayput.record_saves($1, $2::text::jsonb) as count',
    [companyId, JSON.stringify(saves)],
  );
  return kept?.count ?? 0;
}
