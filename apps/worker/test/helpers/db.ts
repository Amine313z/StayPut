import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildInstallSql, migrationFiles } from '../../../../scripts/install-sql';
import type { Db, TransactionalDb } from '../../src/db';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../../supabase/migrations');

/**
 * What Supabase does to a fresh project before our migrations run: its API roles, and default
 * privileges that hand them everything `postgres` creates in `public`. Mirrored here so that a
 * grant leaking to anon or authenticated would show up in the tests (schema.test.ts).
 */
const SUPABASE_LIKE_SETUP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export interface TestDb {
  db: TransactionalDb;
  /** Runs a whole SQL script (several statements, no parameters). */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * A real Postgres (PGlite, WASM, in-process) with the schema installed, either migration by
 * migration (as `npm run db:migrate`) or through supabase/install.sql (as the SQL Editor).
 */
export async function createTestDb(
  options: { via?: 'migrations' | 'install-sql' } = {},
): Promise<TestDb> {
  const pg = await PGlite.create();
  await pg.exec(SUPABASE_LIKE_SETUP);
  if (options.via === 'install-sql') {
    await pg.exec(buildInstallSql(MIGRATIONS_DIR));
  } else {
    for (const file of migrationFiles(MIGRATIONS_DIR)) {
      await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
  }
  const asDb = (client: Pick<PGlite, 'query'>): Db => ({
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      (await client.query<T>(text, [...params])).rows,
  });
  const db: TransactionalDb = {
    ...asDb(pg),
    transaction: <T>(work: (tx: Db) => Promise<T>) => pg.transaction((tx) => work(asDb(tx))),
  };
  return {
    db,
    exec: async (script) => {
      await pg.exec(script);
    },
    close: () => pg.close(),
  };
}
