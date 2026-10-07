import { createApp, productionDeps } from './app';
import { SCHEDULE, groupAt, runScheduled } from './cron';
import { readConfig, type Env } from './env';

const deps = productionDeps();
const app = createApp(deps);

/**
 * The Worker: `fetch` answers /api, /webhooks, /health, /badge and /v (wrangler.toml,
 * `run_worker_first`); every other path is the React app, served as static assets.
 */
export default {
  fetch: app.fetch,

  async scheduled(
    controller: { cron: string; scheduledTime: number },
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    // One trigger every 5 minutes (cron.ts): its time names the jobs, and the ticks with none end
    // here, before the database is opened.
    const now = new Date(controller.scheduledTime);
    const group = groupAt(now);
    if (!group) return;
    const config = readConfig(env);
    const db = deps.openDb(env);
    try {
      await runScheduled(group, SCHEDULE, {
        config,
        db,
        whop: deps.whopClient(config),
        syncWhop: deps.whopClient(config, { maxRetries: 0 }),
        discord: deps.discord(config),
        telegram: deps.telegram(config),
        now,
      });
    } finally {
      if (db) ctx.waitUntil(db.close());
    }
  },
};
