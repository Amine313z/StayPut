/**
 * SPEC Phase 2, 6: 25 fake members with 60 days of history in a sandbox company, or their
 * removal (scripts/seed/sandbox-members.ts says what they are and why they live in StayPut's
 * database rather than in Whop's). SPEC Phase 3: `report` lists them by risk score, with their
 * reasons as the dashboard words them (they are made up: names and all).
 *
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts seed [biz_…]
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts remove [biz_…]
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts report [biz_…]
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts journey [biz_…]
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts scenarios
 *
 * SPEC Phase 5: `journey` walks one fake member from the goal to the testimonial card
 * (scripts/seed/member-journey.ts); its public page is on STAYPUT_URL (the Worker's address).
 *
 * `scenarios` runs the money loop on fake members of a community of its own
 * (scripts/seed/scenarios.ts) through the Worker's hourly jobs, inside one transaction rolled back
 * at the end: nothing stays in the database, and nothing reaches Whop. The other communities are
 * set aside within that transaction only (as demo communities, which every job skips), so that
 * the jobs work on the scenarios' alone.
 *
 * The « Seed sandbox » workflow runs it (GitHub → Actions → Seed sandbox → Run workflow). Refused
 * when WHOP_ENV is production, and for a company StayPut does not know.
 */
import { appendFileSync } from 'node:fs';
import postgres from 'postgres';
import {
  planActionsNow,
  removeSeed,
  rescoreNow,
  riskReport,
  runSeed,
} from './seed/sandbox-members';
import { runJourney } from './seed/member-journey';
import { SCENARIO_COMPANY, runScenarios, verdictTable, type Verdict } from './seed/scenarios';
import type { Db, TransactionalDb } from '../apps/worker/src/db';

/** « StayPut Test », the founder's sandbox account (not a secret). */
const SANDBOX_COMPANY = 'biz_2whAzkbCRpcGqQ';

const [action = 'seed', companyId = SANDBOX_COMPANY] = process.argv.slice(2);
const url = process.env.DATABASE_URL;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!url) fail('Set DATABASE_URL.');
if (!['seed', 'remove', 'report', 'journey', 'scenarios'].includes(action)) {
  fail('Usage: seed-sandbox.ts seed|remove|report|journey|scenarios [biz_…]');
}
if ((process.env.WHOP_ENV || 'sandbox') !== 'sandbox') {
  fail('Refused: WHOP_ENV is not "sandbox". Fake members never go into production.');
}
if (!/^biz_[A-Za-z0-9]+$/.test(companyId)) fail(`Not a Whop company id: ${companyId}`);

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  max: 1,
  ssl: local ? false : 'require',
  prepare: !url.includes(':6543'),
  onnotice: () => {},
});
const db = {
  query: async <T>(text: string, params: readonly unknown[] = []) =>
    Array.from(await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as T[],
};

/** Thrown to roll a transaction (or a savepoint) back once its work is done. */
class RolledBack extends Error {}

/**
 * The scenarios on this database, inside one transaction rolled back: a reading under RLS
 * (withUser) runs in a savepoint undone after it, so that its role and user end with it.
 */
async function scenariosRolledBack(now: Date): Promise<Verdict[]> {
  const run = async <T>(
    client: postgres.TransactionSql,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> =>
    Array.from(await client.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as T[];
  let verdicts: Verdict[] = [];
  try {
    await sql.begin(async (tx) => {
      // Every scheduled job skips a demo community: the others become one, here only.
      await tx.unsafe(
        `update stayput.companies set is_demo = true where id <> $1 and not is_demo`,
        [SCENARIO_COMPANY],
      );
      const inTransaction: TransactionalDb = {
        query: <T>(text: string, params?: readonly unknown[]) => run<T>(tx, text, params),
        transaction: async <T>(work: (reading: Db) => Promise<T>): Promise<T> => {
          let result: T | undefined;
          await tx
            .savepoint(async (sp) => {
              result = await work({
                query: <R>(text: string, params?: readonly unknown[]) => run<R>(sp, text, params),
              });
              throw new RolledBack();
            })
            .catch((error: unknown) => {
              if (!(error instanceof RolledBack)) throw error;
            });
          return result as T;
        },
      };
      verdicts = await runScenarios(inTransaction, now);
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return verdicts;
}

async function main() {
  if (action === 'scenarios') {
    const verdicts = await scenariosRolledBack(new Date());
    const lines = verdictTable(
      'The money loop on fake members (the sandbox’s database, rolled back)',
      verdicts,
    );
    console.info(lines.join('\n'));
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${lines.join('\n')}\n`);
    if (verdicts.some((v) => !v.ok)) process.exitCode = 1;
    return;
  }
  const [company] = await db.query<{ status: string }>(
    'select status from stayput.companies where id = $1',
    [companyId],
  );
  if (!company) {
    fail(`StayPut does not know ${companyId}: open its dashboard once first.`);
  }
  const now = new Date();
  if (action === 'seed') {
    const result = await runSeed(db, companyId, now);
    // Their scores and the weekly analyses at once, with the rules of this code, then the
    // actions their state calls for.
    const scored = await rescoreNow(db, companyId, now);
    const planned = await planActionsNow(db, companyId, now);
    console.info(
      `Seeded ${companyId}: ${result.members} fake members, ${result.items} items (memberships, ` +
        `payments, messages, reactions, lessons, posts); ${scored} risk scores computed, ` +
        `weekly analyses run; ${planned} actions planned.`,
    );
  } else if (action === 'journey') {
    const origin = process.env.STAYPUT_URL || 'https://stayput.chezbenz18.workers.dev';
    const lines = (await runJourney(db, companyId, now, origin)).join('\n');
    console.info(lines);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${lines}\n`);
  } else if (action === 'report') {
    // Printed, and added to the run's summary on GitHub.
    const lines = (await riskReport(db, companyId, now)).join('\n');
    console.info(lines);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${lines}\n`);
  } else {
    const result = await removeSeed(db, companyId, now);
    console.info(
      `Removed from ${companyId}: ${result.members} fake members, ${result.memberships} ` +
        `memberships, ${result.payments} payments.`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
