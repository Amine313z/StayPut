import {
  jobState,
  scrubErrorMessage,
  type HealthReport,
  type OperatorStatus,
  type WebhookReplay,
} from '@stayput/core';
import type { WhopEnv } from '@stayput/whop';
import type { Db } from './db';
import { LATEST_MIGRATION } from './schema-version';

/**
 * StayPut's own running (SPEC Phase 8.5): the errors and the scheduled jobs recorded, the
 * internal status page read, Whop's failed deliveries replayed. What is recorded is scrubbed
 * first (scrubErrorMessage): no secret, no person.
 */

/** Failed deliveries replayed per click at most. */
export const REPLAY_LIMIT = 100;

/**
 * Records an error: once per place, community and message, counted. Never throws: an error that
 * cannot be recorded is only written to the Worker's log.
 */
export async function logError(
  db: Db | null,
  source: string,
  companyId: string | null,
  error: unknown,
  now: Date,
): Promise<void> {
  if (!db) return;
  try {
    await db.query('select stayput.log_error($1, $2, $3, $4::timestamptz)', [
      source
        .toLowerCase()
        .replace(/[^a-z0-9:_ -]+/g, '-')
        .slice(0, 80),
      companyId,
      scrubErrorMessage(error),
      now.toISOString(),
    ]);
  } catch (failure) {
    console.error('Could not record an error:', scrubErrorMessage(failure));
  }
}

/**
 * A line of the community's journal (`audit_log`): who on its team did what, when, and to what.
 * The target names ids, counts and settings, never a person's name or a text; a member's id in
 * it is erased with the member (forget_member). Never throws: the change is already made, so a
 * line that cannot be written is an error recorded, not a failed request.
 */
export async function recordAudit(
  db: Db | null,
  entry: { companyId: string; actor: string; action: string; target?: Record<string, unknown> },
  now: Date,
): Promise<void> {
  if (!db) return;
  try {
    await db.query(
      `insert into stayput.audit_log (company_id, actor, action, target, created_at)
       values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)`,
      [
        entry.companyId,
        entry.actor,
        entry.action,
        JSON.stringify(entry.target ?? {}),
        now.toISOString(),
      ],
    );
  } catch (error) {
    console.error(`Could not record ${entry.action} in the journal:`, scrubErrorMessage(error));
    await logError(db, `audit:${entry.action}`, entry.companyId, error, now);
  }
}

/** Records a scheduled job's run, failed (`error`) or not. Never throws. */
export async function recordJobRun(
  db: Db | null,
  job: string,
  startedAt: Date,
  finishedAt: Date,
  error: unknown,
): Promise<void> {
  if (!db) return;
  try {
    await db.query('select stayput.record_job_run($1, $2::timestamptz, $3::timestamptz, $4)', [
      job,
      startedAt.toISOString(),
      finishedAt.toISOString(),
      error === undefined ? null : scrubErrorMessage(error),
    ]);
  } catch (failure) {
    console.error(`Could not record the run of ${job}:`, scrubErrorMessage(failure));
  }
}

interface StatusRow {
  jobs: {
    job: string;
    lastStartedAt: string;
    lastFinishedAt: string;
    lastOkAt: string | null;
    lastFailedAt: string | null;
    lastError: string | null;
    runs: number;
    failures: number;
    lastDurationMs: number;
  }[];
  webhooks: {
    lastDay: OperatorStatus['webhooks']['lastDay'];
    lastReceivedAt: string | null;
    failedCount: number;
    failed: {
      id: string;
      type: string;
      companyId: string | null;
      companyName: string | null;
      attempts: number;
      lastError: string | null;
      receivedAt: string;
    }[];
  };
  companies: OperatorStatus['companies'];
  syncErrors: OperatorStatus['syncErrors'];
  failedActions: OperatorStatus['failedActions'];
  errors: OperatorStatus['errors'];
}

/** Attempts after which the replays of every ten minutes give up (0005). */
const AUTOMATIC_ATTEMPTS = 5;

const scrub = (text: string | null) => (text === null ? null : scrubErrorMessage(text));

/**
 * The internal status page: every job of the schedule (those never run too), Whop's deliveries,
 * the communities, the refused readings, the failed actions and the errors.
 */
export async function readOperatorStatus(
  db: Db,
  now: Date,
  context: {
    whopEnv: WhopEnv;
    database: HealthReport['database'];
    /** Each scheduled job, and how often its trigger runs it. */
    jobs: readonly { job: string; everyMinutes: number }[];
  },
): Promise<OperatorStatus> {
  const [row] = await db.query<{ status: StatusRow }>(
    'select stayput.operator_status($1::timestamptz) as status',
    [now.toISOString()],
  );
  const status = row!.status;
  const runs = new Map(status.jobs.map((run) => [run.job, run]));
  const scheduled = new Set(context.jobs.map((job) => job.job));
  return {
    checkedAt: now.toISOString(),
    whopEnv: context.whopEnv,
    database: context.database,
    migration: LATEST_MIGRATION,
    jobs: [
      ...context.jobs.map(({ job, everyMinutes }) => {
        const run = runs.get(job) ?? null;
        return {
          job,
          everyMinutes,
          state: jobState(run, everyMinutes, now),
          lastFinishedAt: run?.lastFinishedAt ?? null,
          lastOkAt: run?.lastOkAt ?? null,
          lastFailedAt: run?.lastFailedAt ?? null,
          lastError: scrub(run?.lastError ?? null),
          lastDurationMs: run?.lastDurationMs ?? null,
          runs: run?.runs ?? 0,
          failures: run?.failures ?? 0,
        };
      }),
      // A job no longer in the schedule still shows its last run, as stopped.
      ...status.jobs
        .filter((run) => !scheduled.has(run.job))
        .map((run) => ({
          job: run.job,
          everyMinutes: 0,
          state: 'late' as const,
          lastFinishedAt: run.lastFinishedAt,
          lastOkAt: run.lastOkAt,
          lastFailedAt: run.lastFailedAt,
          lastError: scrub(run.lastError),
          lastDurationMs: run.lastDurationMs,
          runs: run.runs,
          failures: run.failures,
        })),
    ],
    webhooks: {
      lastDay: status.webhooks.lastDay,
      lastReceivedAt: status.webhooks.lastReceivedAt,
      failedCount: Number(status.webhooks.failedCount),
      failed: status.webhooks.failed.map((delivery) => ({
        ...delivery,
        retrying: delivery.attempts < AUTOMATIC_ATTEMPTS,
        lastError: scrub(delivery.lastError),
      })),
    },
    companies: status.companies,
    syncErrors: status.syncErrors.map((error) => ({
      ...error,
      error: scrubErrorMessage(error.error),
    })),
    failedActions: status.failedActions.map((action) => ({
      ...action,
      lastError: scrub(action.lastError),
    })),
    errors: status.errors.map((error) => ({ ...error, message: scrubErrorMessage(error.message) })),
  };
}

/** One failed delivery processed again now: its new status (`missing` if there is none). */
export async function replayWebhook(db: Db, id: string, now: Date): Promise<string> {
  const [row] = await db.query<{ status: string }>(
    `select case when exists (select 1 from stayput.webhook_events
                               where id = $1 and status in ('failed', 'received'))
                 then stayput.process_webhook_event($1, $2::timestamptz)
                 else 'missing' end as status`,
    [id, now.toISOString()],
  );
  return row?.status ?? 'missing';
}

/** Every failed delivery (REPLAY_LIMIT at most), the oldest first, processed again now. */
export async function replayFailedWebhooks(db: Db, now: Date): Promise<WebhookReplay> {
  const [row] = await db.query<{ counts: WebhookReplay['counts'] | null }>(
    'select stayput.replay_failed_webhooks($1, $2::timestamptz) as counts',
    [REPLAY_LIMIT, now.toISOString()],
  );
  return { counts: row?.counts ?? {} };
}
