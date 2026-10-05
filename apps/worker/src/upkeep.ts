import { WhopApiError, type WhopClient } from '@stayput/whop';
import type { Db } from './db';

/**
 * The data's upkeep (SPEC Phase 8.2 and 8.3), every hour: Whop's deliveries go once done with,
 * and a community whose access Whop withdrew is marked uninstalled, then deleted 30 days later.
 */

/** Communities asked about per run at most: one call to Whop each. */
export const ACCESS_CHECK_LIMIT = 10;

/** What the question to Whop asks: the community's basic reading, and its members'. */
const ACCESS_ACTIONS = 'company:basic:read,member:basic:read';

/**
 * Asks Whop what it still grants the app on the communities whose members it refused to give
 * (`GET /permissions`). Nothing granted for a day: uninstalled. Whop refusing the key itself
 * (401) concerns every community, so nobody is marked; Whop unavailable, the next run asks again.
 */
export async function checkAccess(
  db: Db,
  whop: WhopClient,
  now: Date,
  limit = ACCESS_CHECK_LIMIT,
): Promise<{ checked: number; uninstalled: string[] }> {
  const at = now.toISOString();
  const suspects = await db.query<{ id: string }>(
    'select id from stayput.access_suspects($1::timestamptz, $2) as id',
    [at, limit],
  );
  let checked = 0;
  const uninstalled: string[] = [];
  for (const { id } of suspects) {
    let granted: boolean;
    try {
      const answer = await whop.request<{ data?: { action?: unknown; granted?: unknown }[] }>(
        'GET',
        '/permissions',
        { query: { resource_id: id, actions: ACCESS_ACTIONS } },
      );
      granted = (answer.data ?? []).some((permission) => permission.granted === true);
    } catch (error) {
      const status = error instanceof WhopApiError ? error.status : 0;
      if (status === 401) break;
      if (status !== 403 && status !== 404) continue;
      granted = false;
    }
    checked += 1;
    const [row] = await db.query<{ status: string }>(
      'select stayput.record_access($1, $2, $3::timestamptz) as status',
      [id, granted, at],
    );
    if (row?.status === 'uninstalled') uninstalled.push(id);
  }
  return { checked, uninstalled };
}

/** One hour's upkeep: the deliveries purged, access checked, the uninstalled deleted. */
export async function upkeep(
  db: Db,
  whop: WhopClient | null,
  now: Date,
): Promise<{ purged: number; checked: number; uninstalled: string[]; deleted: string[] }> {
  const at = now.toISOString();
  const [purge] = await db.query<{ count: number }>(
    'select stayput.purge_webhook_events($1::timestamptz) as count',
    [at],
  );
  const access = whop ? await checkAccess(db, whop, now) : { checked: 0, uninstalled: [] };
  const deleted = await db.query<{ id: string }>(
    'select id from stayput.delete_uninstalled_companies($1::timestamptz) as id',
    [at],
  );
  return {
    purged: Number(purge?.count ?? 0),
    ...access,
    deleted: deleted.map((row) => row.id),
  };
}
