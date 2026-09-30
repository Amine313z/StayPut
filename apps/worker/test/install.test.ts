import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInstallSql, buildSchemaVersion, migrationFiles } from '../../../scripts/install-sql';
import { LATEST_MIGRATION } from '../src/schema-version';
import { MIGRATIONS_DIR, createTestDb, type TestDb } from './helpers/db';

const root = path.resolve(import.meta.dirname, '../../..');

/** Tables, columns, constraints and policies: what must be identical whichever way it installs. */
async function catalog(t: TestDb) {
  const [columns, constraints, policies] = await Promise.all([
    t.db.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns where table_schema = 'stayput'
          and table_name <> 'schema_migrations' order by 1, 2`,
    ),
    t.db.query(
      `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
         from pg_constraint where connamespace = 'stayput'::regnamespace
          and conrelid::regclass::text <> 'stayput.schema_migrations' order by 1, 2`,
    ),
    t.db.query(
      `select tablename, policyname, cmd, roles::text, qual from pg_policies
        where schemaname = 'stayput' order by 1, 2`,
    ),
  ]);
  return { columns, constraints, policies };
}

describe('supabase/install.sql', () => {
  it('is up to date with supabase/migrations (run npm run db:bundle)', () => {
    expect(readFileSync(path.join(root, 'supabase/install.sql'), 'utf8')).toBe(
      buildInstallSql(MIGRATIONS_DIR),
    );
    expect(readFileSync(path.join(root, 'apps/worker/src/schema-version.ts'), 'utf8')).toBe(
      buildSchemaVersion(MIGRATIONS_DIR),
    );
    expect(LATEST_MIGRATION).toBe(migrationFiles(MIGRATIONS_DIR).at(-1));
  });

  it('installs exactly what the migrations install, and records them', async () => {
    const viaInstall = await createTestDb({ via: 'install-sql' });
    const viaMigrations = await createTestDb();
    try {
      expect(await catalog(viaInstall)).toEqual(await catalog(viaMigrations));
      const applied = await viaInstall.db.query<{ name: string }>(
        'select name from stayput.schema_migrations order by 1',
      );
      expect(applied.map((r) => r.name)).toEqual(migrationFiles(MIGRATIONS_DIR));
    } finally {
      await viaInstall.close();
      await viaMigrations.close();
    }
  });

  it('can be pasted again: nothing is applied twice', async () => {
    const t = await createTestDb({ via: 'install-sql' });
    try {
      await t.exec(buildInstallSql(MIGRATIONS_DIR));
      const [count] = await t.db.query<{ n: number }>(
        'select count(*)::int as n from stayput.schema_migrations',
      );
      expect(count!.n).toBe(migrationFiles(MIGRATIONS_DIR).length);
    } finally {
      await t.close();
    }
  });
});
