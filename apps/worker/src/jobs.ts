import { EXECUTE_BATCH, executeDueActions, prepareActions } from './actions';
import type { CronJob } from './cron';
import { scoreDueCompanies } from './risk';
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
    // Accounts no member has, tied by name where one member surely matches (a member who joined,
    // a Whop username read since): before the stats, which then count their messages.
    await db.query(
      `select stayput.link_accounts_by_name(c.company_id)
         from (select distinct company_id from stayput.platform_accounts
                where decided_at is null and dismissed_at is null) c`,
    );
    await db.query('select stayput.refresh_stats($1::timestamptz)', [now.toISOString()]);
    await db.query('select stayput.purge_pending_activity($1::timestamptz)', [now.toISOString()]);
  },
};

/**
 * SPEC Phase 3: every hour, the risk score of each member (the companies that waited longest
 * first, within the run's CPU), and the weekly analyses of a company when a week has passed.
 * The daily history of scores is kept 400 days.
 */
export const scoreMembers: CronJob = {
  name: 'risk',
  async run({ db, now }) {
    if (!db) return;
    const runs = await scoreDueCompanies(db, now);
    for (const run of runs) {
      console.info(
        `Risk ${run.companyId}: ${run.scored} member(s) scored${run.analyzed ? ', analyses done' : ''}.`,
      );
    }
    await db.query('select stayput.purge_risk_history($1::timestamptz)', [now.toISOString()]);
  },
};

/**
 * SPEC Phase 4: after the scores, each company's actions are planned from its state and passed
 * through the guardrails; then the actions whose time has come are run (simulated in test mode).
 */
export const runActions: CronJob = {
  name: 'actions',
  async run({ db, whop, discord, telegram, now }) {
    if (!db) return;
    const companies = await db.query<{ id: string }>(
      `select id from stayput.companies where status = 'active' and not is_demo order by id`,
    );
    for (const { id } of companies) {
      const prepared = await prepareActions(db, id, now);
      if (prepared.planned + prepared.scheduled + prepared.blocked > 0) {
        console.info(
          `Actions ${id}: ${prepared.planned} planned, ${prepared.scheduled} scheduled, ${prepared.blocked} blocked.`,
        );
      }
    }
    const ran = await executeDueActions(db, whop, now, EXECUTE_BATCH, { discord, telegram });
    if (Object.keys(ran).length > 0) console.info(`Actions run: ${JSON.stringify(ran)}.`);
  },
};
