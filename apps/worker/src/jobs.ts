import type { CronJob } from './cron';
import { SYNC_REQUEST_BUDGET, summarize, syncDueCompanies } from './sync';

/** Deliveries replayed per run at most: failed ones, or ones the background never finished. */
export const WEBHOOK_REPLAY_LIMIT = 100;

/** SPEC Phase 2, 1: a delivery that failed is retried at the next run (5 attempts at most). */
export const replayWebhooks: CronJob = {
  name: 'replay-webhooks',
  async run({ db, now }) {
    if (!db) return;
    const [row] = await db.query<{ counts: Record<string, number> | null }>(
      'select stayput.process_pending_webhooks($1, $2::timestamptz) as counts',
      [WEBHOOK_REPLAY_LIMIT, now.toISOString()],
    );
    const counts = row?.counts ?? {};
    if (Object.keys(counts).length > 0) {
      console.info(`Webhooks replayed: ${JSON.stringify(counts)}.`);
    }
  },
};

/** SPEC Phase 2, 2 and 3: the companies that waited longest, within the run's Whop calls. */
export const syncWithWhop: CronJob = {
  name: 'sync',
  async run({ db, syncWhop, discord, now }) {
    if (!db || !syncWhop) return;
    const results = await syncDueCompanies({
      db,
      whop: syncWhop,
      discord: discord ?? null,
      now,
      budget: { left: SYNC_REQUEST_BUDGET },
    });
    for (const result of results) console.info(summarize(result));
  },
};

/** SPEC Phase 2, 4: member_stats_daily and activity_hours, where activity changed. */
export const refreshStats: CronJob = {
  name: 'stats',
  async run({ db, now }) {
    if (!db) return;
    await db.query('select stayput.refresh_stats($1::timestamptz)', [now.toISOString()]);
    await db.query('select stayput.purge_pending_activity($1::timestamptz)', [now.toISOString()]);
  },
};
