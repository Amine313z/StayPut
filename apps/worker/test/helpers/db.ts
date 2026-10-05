import { PGlite, type Results } from '@electric-sql/pglite';
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
  options: {
    via?: 'migrations' | 'install-sql';
    /** Stops before this migration (its file name), to test what it does to older rows. */
    until?: string;
  } = {},
): Promise<TestDb> {
  const pg = await PGlite.create();
  await pg.exec(SUPABASE_LIKE_SETUP);
  if (options.via === 'install-sql') {
    await pg.exec(buildInstallSql(MIGRATIONS_DIR));
  } else {
    for (const file of migrationFiles(MIGRATIONS_DIR)) {
      if (options.until !== undefined && file >= options.until) break;
      await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
  }
  const asDb = (client: Pick<PGlite, 'query'>): Db => ({
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      asPostgresJs(await client.query<T>(text, [...params])),
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

/** json and jsonb: postgres.js parses them, arrays included. */
const JSON_TYPES = new Set([114, 3802]);

/**
 * The rows as production reads them. The Worker's postgres.js skips fetching the array types
 * (`fetch_types: false`, src/db.ts), so a Postgres array reaches it as text (`{1,2}`), where
 * PGlite hands a JavaScript array: without this, code that reads an array column passes here
 * and breaks in production (it did, on `discord_guilds.channel_ids`).
 */
function asPostgresJs<T>(result: Results<T>): T[] {
  const notJson = result.fields
    .filter((field) => !JSON_TYPES.has(field.dataTypeID))
    .map((field) => field.name);
  if (notJson.length === 0) return result.rows;
  return result.rows.map((row) => {
    const copy = { ...row } as Record<string, unknown>;
    for (const name of notJson) {
      const value = copy[name];
      if (Array.isArray(value)) copy[name] = arrayText(value);
    }
    return copy as T;
  });
}

/** Postgres's text form of an array: `{a,"b c",NULL}`. */
function arrayText(values: readonly unknown[]): string {
  const element = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (Array.isArray(value)) return arrayText(value);
    const text =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
            ? String(value)
            : JSON.stringify(value);
    return /^[^\s{}",\\]+$/.test(text) && text.toUpperCase() !== 'NULL'
      ? text
      : `"${text.replace(/["\\]/g, '\\$&')}"`;
  };
  return `{${values.map(element).join(',')}}`;
}
