import type { WhopClient } from '@stayput/whop';
import type { ClosableDb } from './db';
import type { DiscordClient } from './discord';
import type { TelegramClient } from './telegram';
import type { Config } from './env';
import { logError, recordJobRun } from './operations';
import {
  activityRetention,
  benchmarks,
  countSaves,
  dataUpkeep,
  refreshStats,
  replayWebhooks,
  runActions,
  scoreMembers,
  syncWithWhop,
  weeklyReports,
} from './jobs';

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
  /** Telegram's Bot API with StayPut's bot, when the Telegram module is set up. */
  telegram?: TelegramClient | null;
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
 * run still cover every company each hour (DECISIONS.md). Every hour, scores (3), due actions
 * (4), the money they saved (6) and, on Mondays from 8:00 where each community is, its Monday
 * report (6.9), then the data's upkeep (8.2, 8.3); every Monday, the niches' anonymous
 * benchmarks (6.10) and the activity older than 12 months (8.4).
 */
export const SCHEDULE: Readonly<Record<string, readonly CronJob[]>> = {
  [SYNC_CRON]: [replayWebhooks, syncWithWhop, refreshStats],
  [HOURLY_CRON]: [scoreMembers, runActions, countSaves, weeklyReports, dataUpkeep],
  [WEEKLY_CRON]: [benchmarks, activityRetention],
};

/** How often each trigger runs, in minutes: the status page says a job is late after two. */
export const EVERY_MINUTES: Readonly<Record<string, number>> = {
  [SYNC_CRON]: 10,
  [HOURLY_CRON]: 60,
  [WEEKLY_CRON]: 7 * 24 * 60,
};

/** Every scheduled job, and how often it runs (the status page, SPEC Phase 8.5). */
export function scheduledJobs(
  schedule: Readonly<Record<string, readonly CronJob[]>> = SCHEDULE,
): { job: string; everyMinutes: number }[] {
  return Object.entries(schedule).flatMap(([cron, jobs]) =>
    jobs.map((job) => ({ job: job.name, everyMinutes: EVERY_MINUTES[cron] ?? 0 })),
  );
}

/**
 * Runs every job of a trigger, one after the other. A failing job is logged and does not stop
 * the next ones: they are independent, and the next run retries. Each run is recorded, and each
 * failure in the error log (SPEC Phase 8.5).
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
  // The jobs' clock: the time the run was scheduled for, plus the time spent since.
  const runStarted = Date.now();
  const clock = () => new Date(ctx.now.getTime() + Math.max(0, Date.now() - runStarted));
  for (const job of jobs) {
    const startedAt = clock();
    let failure: unknown = undefined;
    try {
      await job.run(ctx);
      ran.push(job.name);
    } catch (error) {
      failure = error ?? 'unknown error';
      failed.push(job.name);
      console.error(`Job ${job.name} failed:`, error instanceof Error ? error.message : error);
    }
    const finishedAt = clock();
    await recordJobRun(ctx.db, job.name, startedAt, finishedAt, failure);
    if (failure !== undefined) await logError(ctx.db, `job:${job.name}`, null, failure, finishedAt);
  }
  console.info(`Cron "${cron}": ${ran.length} ran, ${failed.length} failed.`);
  return { ran, failed };
}
