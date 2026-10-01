import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccessCache } from '../src/access';
import {
  HOURLY_CRON,
  SYNC_CRON,
  WEEKLY_CRON,
  runScheduled,
  type CronJob,
  type JobContext,
} from '../src/cron';
import { readConfig } from '../src/env';

describe('readConfig', () => {
  it('defaults to the sandbox, with nothing configured', () => {
    expect(readConfig({})).toEqual({
      whopEnv: 'sandbox',
      appId: null,
      apiKey: null,
      webhookSecret: null,
      oauthLogin: false,
      discord: null,
      telegram: null,
      dev: null,
    });
  });

  it('turns "Sign in with Whop" on in the sandbox only, once the app id and key exist', () => {
    const app = { WHOP_APP_ID: 'app_1', WHOP_API_KEY: 'apik_1' };
    expect(readConfig(app).oauthLogin).toBe(true);
    expect(readConfig({ ...app, WHOP_ENV: 'production' }).oauthLogin).toBe(false);
    expect(readConfig({ WHOP_APP_ID: 'app_1' }).oauthLogin).toBe(false);
  });

  it('turns the Discord and Telegram modules on with their bots', () => {
    expect(readConfig({ DISCORD_BOT_TOKEN: 'bot' }).discord).toEqual({
      botToken: 'bot',
      clientSecret: null,
    });
    expect(
      readConfig({ DISCORD_BOT_TOKEN: 'bot', DISCORD_CLIENT_SECRET: 'secret' }).discord,
    ).toEqual({ botToken: 'bot', clientSecret: 'secret' });
    expect(readConfig({ DISCORD_CLIENT_SECRET: 'secret' }).discord).toBeNull();
    expect(readConfig({ TELEGRAM_BOT_TOKEN: '1:abc' }).telegram).toEqual({ botToken: '1:abc' });
  });

  it('refuses an unknown WHOP_ENV', () => {
    expect(() => readConfig({ WHOP_ENV: 'staging' })).toThrow(/WHOP_ENV/);
  });

  it('reads the DEV_* settings only in development, and only a real user id', () => {
    const dev = { DEV_USER_ID: 'user_dev', DEV_ACCESS_LEVEL: 'customer' };
    expect(readConfig({ ...dev, ENVIRONMENT: 'development' }).dev).toEqual({
      userId: 'user_dev',
      accessLevel: 'customer',
    });
    expect(readConfig(dev).dev).toBeNull();
    expect(readConfig({ ...dev, ENVIRONMENT: 'development', DEV_USER_ID: 'admin' }).dev).toBeNull();
    expect(
      readConfig({ ENVIRONMENT: 'development', DEV_USER_ID: 'user_dev', DEV_ACCESS_LEVEL: 'root' })
        .dev,
    ).toEqual({ userId: 'user_dev', accessLevel: null });
  });
});

describe('AccessCache', () => {
  it('keeps a grant 5 minutes and a refusal 30 seconds', () => {
    const cache = new AccessCache();
    cache.set('user_a', 'biz_1', 'admin', 0);
    cache.set('user_b', 'biz_1', 'no_access', 0);
    expect(cache.get('user_a', 'biz_1', 299_999)).toBe('admin');
    expect(cache.get('user_a', 'biz_1', 300_000)).toBeNull();
    expect(cache.get('user_b', 'biz_1', 29_999)).toBe('no_access');
    expect(cache.get('user_b', 'biz_1', 30_000)).toBeNull();
  });

  it('forgets the oldest entry when full', () => {
    const cache = new AccessCache(60_000, 60_000, 2);
    cache.set('user_a', 'r', 'admin', 0);
    cache.set('user_b', 'r', 'admin', 0);
    cache.set('user_c', 'r', 'admin', 0);
    expect(cache.get('user_a', 'r', 1)).toBeNull();
    expect(cache.get('user_c', 'r', 1)).toBe('admin');
  });
});

describe('cron', () => {
  it('declares in wrangler.toml exactly the triggers src/cron.ts handles', () => {
    const toml = readFileSync(path.resolve(import.meta.dirname, '../wrangler.toml'), 'utf8');
    const crons = /^crons\s*=\s*\[(.*)\]$/m.exec(toml)?.[1];
    expect(crons?.split(',').map((c) => c.trim().replace(/"/g, ''))).toEqual([
      SYNC_CRON,
      HOURLY_CRON,
      WEEKLY_CRON,
    ]);
  });

  it('runs every job of the trigger, past a failing one', async () => {
    const order: string[] = [];
    const job = (name: string, fail = false): CronJob => ({
      name,
      run: () => {
        order.push(name);
        return fail ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await runScheduled(
      HOURLY_CRON,
      { [HOURLY_CRON]: [job('sync'), job('scores', true), job('actions')] },
      {} as JobContext,
    );
    expect(order).toEqual(['sync', 'scores', 'actions']);
    expect(result).toEqual({ ran: ['sync', 'actions'], failed: ['scores'] });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
    info.mockRestore();
  });

  it('runs nothing for a trigger it does not know', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runScheduled('* * * * *', {}, {} as JobContext)).toEqual({ ran: [], failed: [] });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
