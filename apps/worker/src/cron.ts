import type { WhopClient } from '@stayput/whop';
import type { ClosableDb } from './db';
import type { DiscordClient } from './discord';
import type { Config } from './env';
import { refreshStats, replayWebhooks, scoreMembers, syncWithWhop } from './jobs';

/** Must match `triggers.crons` in wrangler.toml (runtime.test.ts checks it). */
export const SYNC_CRON = '*/10 * * * *';
export const HOURLY_CRON = '0 * * * *';
export const WEEKLY_CRON = '30 7 * * 1';

export interface JobContext {
  config: Config;
  db: ClosableDb | null;
  whop: WhopClient | null;
  /** The same API without retries, for the sync: one call is one subrequest of its budget. */
  syncWhop: WhopClient | null;
  /** Discord's API with StayPut's bot, when the Discord module is set up. */
  discord?: DiscordClient | null;
  /** The time the run was scheduled for: jobs never read the clock themselves. */
  now: Date;
}

export interface CronJob {
  name: string;
  run(ctx: JobContext): Promise<void>;
}

/**
 * What each trigger runs. Every 10 minutes, a slice of the synchronization with Whop (Phase 2):
 * each run reads the companies that waited longest, so that the free plan's 50 subrequests per
 * run still cover every company each hour (DECISIONS.md). Every hour, scores (3) and due actions
 * (4); every week, cohorts and blocking lessons (3).
 */
export const SCHEDULE: Readonly<Record<string, readonly CronJob[]>> = {
  [SYNC_CRON]: [replayWebhooks, syncWithWhop, refreshStats],
  [HOURLY_CRON]: [scoreMembers],
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
