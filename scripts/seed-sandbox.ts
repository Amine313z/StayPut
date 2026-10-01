/**
 * SPEC Phase 2, 6: 25 fake members with 60 days of history in a sandbox company, or their
 * removal (scripts/seed/sandbox-members.ts says what they are and why they live in StayPut's
 * database rather than in Whop's). SPEC Phase 3: `report` lists them by risk score, with their
 * reasons as the dashboard words them (they are made up: names and all).
 *
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts seed [biz_…]
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts remove [biz_…]
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts report [biz_…]
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

/** « StayPut Test », the founder's sandbox account (not a secret). */
const SANDBOX_COMPANY = 'biz_2whAzkbCRpcGqQ';

const [action = 'seed', companyId = SANDBOX_COMPANY] = process.argv.slice(2);
const url = process.env.DATABASE_URL;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!url) fail('Set DATABASE_URL.');
if (!['seed', 'remove', 'report'].includes(action)) {
  fail('Usage: seed-sandbox.ts seed|remove|report [biz_…]');
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

async function main() {
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
