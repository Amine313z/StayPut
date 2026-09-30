import type { WhopClient } from '@stayput/whop';
import type { ClosableDb } from './db';
import type { Config } from './env';

/** Must match `triggers.crons` in wrangler.toml (cron.test.ts checks it). */
export const HOURLY_CRON = '0 * * * *';
export const WEEKLY_CRON = '30 7 * * 1';

export interface JobContext {
  config: Config;
  db: ClosableDb | null;
  whop: WhopClient | null;
  /** The time the run was scheduled for: jobs never read the clock themselves. */
  now: Date;
}

export interface CronJob {
  name: string;
  run(ctx: JobContext): Promise<void>;
}

/**
 * What each trigger runs. The phases fill these lists: sync and webhook replay (Phase 2),
 * scores (3), due actions (4) every hour; cohorts and blocking lessons (3) every week.
 */
export const SCHEDULE: Readonly<Record<string, readonly CronJob[]>> = {
  [HOURLY_CRON]: [],
  [WEEKLY_CRON]: [],
};

/**
 * Runs every job of a trigger, one after the other. A failing job is logged and does not stop
 * the next ones: they are independent, and the next run retries.
 */
export async function runScheduled(
  cron: string,
  schedule: Readonly<Record<string, readonly CronJob[]>>,
  ctx: JobContext,
): Promise<{ ran: string[]; failed: string[] }> {
  const jobs = schedule[cron];
  const ran: string[] = [];
  const failed: string[] = [];
  if (!jobs) {
    console.warn(`No job list for cron "${cron}".`);
    return { ran, failed };
  }
  for (const job of jobs) {
    try {
      await job.run(ctx);
      ran.push(job.name);
    } catch (error) {
      failed.push(job.name);
      console.error(`Job ${job.name} failed:`, error instanceof Error ? error.message : error);
    }
  }
  console.info(`Cron "${cron}": ${ran.length} ran, ${failed.length} failed.`);
  return { ran, failed };
}
