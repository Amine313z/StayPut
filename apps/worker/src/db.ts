import postgres from 'postgres';

/**
 * What data-access code depends on: parameterised SQL in, rows out. Production implements it
 * with postgres.js through Hyperdrive; tests with PGlite running the real migrations.
 *
 * Portability rules: `$1, $2` parameters only; cast what you read when the type matters
 * (`::int`, `::float8`); numeric and bigint come back as strings from postgres.js. Read an
 * array column as jsonb (`to_jsonb(channel_ids) as channel_ids`): without `fetch_types`
 * (below), postgres.js hands a Postgres array over as text (`{1,2}`). The test database does
 * the same (test/helpers/db.ts).
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** A Db that can run several statements in one transaction. */
export interface TransactionalDb extends Db {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}

export interface ClosableDb extends TransactionalDb {
  close(): Promise<void>;
}

/**
 * Runs `work` for one Whop user, under RLS: in one transaction, as role `stayput_user`, with
 * `stayput.user_id` set, so the policies of supabase/migrations decide which rows exist. Both
 * settings end with the transaction: a pooled connection never keeps them.
 */
export function withUser<T>(
  db: TransactionalDb,
  userId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(
      `select set_config('role', 'stayput_user', true),
              set_config('stayput.user_id', $1, true)`,
      [userId],
    );
    return work(tx);
  });
}

/**
 * The database through Hyperdrive (`env.HYPERDRIVE.connectionString`). One client per request:
 * Hyperdrive keeps the real connections to Supabase open between requests.
 */
export function createPostgresDb(connectionString: string): ClosableDb {
  const sql = postgres(connectionString, {
    max: 5,
    // Skips the extra round trip postgres.js makes to read array types on connect.
    fetch_types: false,
    onnotice: () => {},
  });
  const run = async <T>(
    client: postgres.Sql | postgres.TransactionSql,
    text: string,
    params: readonly unknown[],
  ): Promise<T[]> => {
    const rows = await client.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
    return Array.from(rows) as T[];
  };
  return {
    query: <T>(text: string, params: readonly unknown[] = []) => run<T>(sql, text, params),
    transaction: <T>(work: (tx: Db) => Promise<T>) =>
      sql.begin((tx) =>
        work({
          query: <R>(text: string, params: readonly unknown[] = []) => run<R>(tx, text, params),
        }),
      ) as Promise<T>,
    close: () => sql.end({ timeout: 5 }),
  };
}
