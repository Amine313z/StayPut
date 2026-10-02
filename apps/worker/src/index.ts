import { createApp, productionDeps } from './app';
import { SCHEDULE, runScheduled } from './cron';
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
    const config = readConfig(env);
    const db = deps.openDb(env);
    try {
      await runScheduled(controller.cron, SCHEDULE, {
        config,
        db,
        whop: deps.whopClient(config),
        syncWhop: deps.whopClient(config, { maxRetries: 0 }),
        discord: deps.discord(config),
        telegram: deps.telegram(config),
        now: new Date(controller.scheduledTime),
      });
    } finally {
      if (db) ctx.waitUntil(db.close());
    }
  },
};
