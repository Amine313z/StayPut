/**
 * After adding a migration:
 *
 *   npm run db:bundle
 *
 * Writes supabase/install.sql (see install-sql.ts) and apps/worker/src/schema-version.ts. A test
 * fails while either is out of date.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildInstallSql, buildSchemaVersion } from './install-sql';

const root = path.resolve(import.meta.dirname, '..');
const migrations = path.join(root, 'supabase/migrations');
for (const [file, content] of [
  ['supabase/install.sql', buildInstallSql(migrations)],
  ['apps/worker/src/schema-version.ts', buildSchemaVersion(migrations)],
] as const) {
  writeFileSync(path.join(root, file), content);
  console.info(`Wrote ${file}.`);
}
