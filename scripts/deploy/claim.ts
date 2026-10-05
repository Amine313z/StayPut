/**
 * One database, one deployment (SPEC Phase 9, docs/production.md). The deployment that first
 * migrates a database claims it, in stayput.app_settings (migration 0043); from then on the other
 * deployment is refused before any migration runs. Production never writes into the sandbox's
 * database, nor the reverse, whatever address was pasted where. Used by scripts/migrate.ts when
 * STAYPUT_TARGET is set (the Deploy workflow).
 */

/** The little scripts/migrate.ts and the tests share: a parameterised query. */
export interface Queryable {
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * The deployment the database serves: `undefined` before migration 0043 (nothing to claim yet),
 * `null` while no deployment has claimed it.
 */
export async function claimedBy(db: Queryable): Promise<string | null | undefined> {
  const [column] = await db.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'stayput' and table_name = 'app_settings'
          and column_name = 'deployment_target') as present`,
  );
  if (!column?.present) return undefined;
  const [row] = await db.query<{ target: string | null }>(
    'select deployment_target as target from stayput.app_settings',
  );
  return row?.target ?? null;
}

/** Why `target` must not use a database `claimed` by another deployment; null when it may. */
export function claimProblem(claimed: string | null | undefined, target: string): string | null {
  if (!claimed || claimed === target) return null;
  return (
    `this database belongs to the ${claimed} deployment: the ${target} deployment needs its own` +
    ` (${target === 'production' ? 'PRODUCTION_SUPABASE_DB_URL' : 'SUPABASE_DB_URL'},` +
    ' docs/production.md). Nothing was changed.'
  );
}

/** Claims an unclaimed database for `target`; then why it must not be used, or null. */
export async function claimDatabase(db: Queryable, target: string): Promise<string | null> {
  await db.query(
    `update stayput.app_settings set deployment_target = $1 where deployment_target is null`,
    [target],
  );
  return claimProblem(await claimedBy(db), target);
}
