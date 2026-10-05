/**
 * Applies supabase/migrations/*.sql in order, once each (tracked in stayput.schema_migrations).
 *
 *   DATABASE_URL="postgresql://postgres:…@…:5432/postgres" npm run db:migrate
 *
 * Use Supabase's direct or session connection (port 5432): migrations need the `postgres` role
 * and create a role. Each file runs in one transaction; a failure leaves the database unchanged.
 * The alternative without a terminal is supabase/install.sql in the SQL Editor.
 *
 * With STAYPUT_TARGET (the Deploy workflow: sandbox or production), the database is that
 * deployment's: claimed by the first, refused to the other (scripts/deploy/claim.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { claimDatabase, claimedBy, claimProblem, type Queryable } from './deploy/claim';
import { migrationFiles } from './install-sql';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (Supabase -> Connect -> Session pooler or Direct connection).');
  process.exit(1);
}

const dir = path.resolve(import.meta.dirname, '../supabase/migrations');
const target = process.env.STAYPUT_TARGET?.trim() || null;
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  max: 1,
  ssl: local ? false : 'require',
  prepare: !url.includes(':6543'),
  onnotice: () => {},
});

async function main() {
  await sql`create schema if not exists stayput`;
  await sql`create table if not exists stayput.schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`;
  await sql`alter table stayput.schema_migrations enable row level security`;
  const db: Queryable = {
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      Array.from(await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as T[],
  };
  if (target) {
    // A database the other deployment claimed is left as it is, not even migrated.
    const problem = claimProblem(await claimedBy(db), target);
    if (problem) throw new Error(problem);
  }
  const done = new Set(
    (await sql<{ name: string }[]>`select name from stayput.schema_migrations`).map((r) => r.name),
  );
  for (const file of migrationFiles(dir)) {
    if (done.has(file)) {
      console.info(`  skip  ${file}`);
      continue;
    }
    const body = readFileSync(path.join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into stayput.schema_migrations (name) values (${file})`;
    });
    console.info(`  apply ${file}`);
  }
  console.info('Migrations up to date.');
  if (target) {
    const problem = await claimDatabase(db, target);
    if (problem) throw new Error(problem);
    console.info(`This database serves the ${target} deployment.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
