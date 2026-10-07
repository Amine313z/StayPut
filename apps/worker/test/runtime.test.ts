import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccessCache } from '../src/access';
import {
  CRON,
  EVERY_MINUTES,
  SCHEDULE,
  groupAt,
  runScheduled,
  type CronJob,
  type JobContext,
  type JobGroup,
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
      // V1: the member space is off unless MEMBER_SPACE_ENABLED says "true".
      memberSpace: false,
      operatorCompanyId: null,
    });
    expect(readConfig({ MEMBER_SPACE_ENABLED: 'true' }).memberSpace).toBe(true);
    expect(readConfig({ MEMBER_SPACE_ENABLED: 'yes' }).memberSpace).toBe(false);
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

  it('reads the operator’s community only when it is a community id', () => {
    expect(readConfig({ OPERATOR_COMPANY_ID: 'biz_Op1' }).operatorCompanyId).toBe('biz_Op1');
    expect(readConfig({ OPERATOR_COMPANY_ID: 'user_Op1' }).operatorCompanyId).toBeNull();
    // The sandbox's, in wrangler.toml: StayPut Test.
    const toml = readFileSync(path.resolve(import.meta.dirname, '../wrangler.toml'), 'utf8');
    const id = /^OPERATOR_COMPANY_ID\s*=\s*"([^"]*)"$/m.exec(toml)?.[1];
    expect(readConfig({ OPERATOR_COMPANY_ID: id }).operatorCompanyId).toBe('biz_2whAzkbCRpcGqQ');
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
  it('declares in wrangler.toml the one trigger src/cron.ts handles', () => {
    const toml = readFileSync(path.resolve(import.meta.dirname, '../wrangler.toml'), 'utf8');
    const crons = /^crons\s*=\s*\[(.*)\]$/m.exec(toml)?.[1];
    expect(crons?.split(',').map((c) => c.trim().replace(/"/g, ''))).toEqual([CRON]);
  });

  it('gives each tick its group: the hourly jobs on the hour, the sync, the weekly ones', () => {
    // Tuesday 6 October 2026, then Monday 5 October (UTC).
    const at = (iso: string) => groupAt(new Date(iso));
    expect(at('2026-10-06T09:00:00Z')).toBe('hourly');
    expect(at('2026-10-06T00:00:00Z')).toBe('hourly');
    for (const minute of ['05', '15', '25', '35', '45', '55']) {
      expect(at(`2026-10-06T09:${minute}:00Z`)).toBe('sync');
    }
    for (const minute of ['10', '20', '30', '40', '50']) {
      expect(at(`2026-10-06T09:${minute}:00Z`)).toBeNull();
    }
    expect(at('2026-10-05T07:30:00Z')).toBe('weekly');
    expect(at('2026-10-05T07:00:00Z')).toBe('hourly');
    expect(at('2026-10-05T08:30:00Z')).toBeNull();
    expect(at('2026-10-06T07:30:00Z')).toBeNull();
  });

  it('runs each group at the pace the status page expects, one group per tick', () => {
    // Two weeks of the trigger's ticks, every 5 minutes from a Monday at midnight UTC.
    const start = Date.parse('2026-10-05T00:00:00Z');
    const ticks = new Map<JobGroup, number[]>();
    for (let t = start; t < start + 14 * 24 * 60 * 60_000; t += 5 * 60_000) {
      const group = groupAt(new Date(t));
      if (group) ticks.set(group, [...(ticks.get(group) ?? []), t]);
    }
    expect([...ticks.keys()].sort()).toEqual(Object.keys(SCHEDULE).sort());
    for (const [group, times] of ticks) {
      const gaps = new Set(times.slice(1).map((t, i) => (t - (times[i] ?? 0)) / 60_000));
      expect({ group, gaps: [...gaps] }).toEqual({ group, gaps: [EVERY_MINUTES[group]] });
    }
  });

  it('runs every job of the group, past a failing one', async () => {
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
      'hourly',
      { hourly: [job('sync'), job('scores', true), job('actions')] },
      { db: null, now: new Date('2026-10-05T09:00:00Z') } as JobContext,
    );
    expect(order).toEqual(['sync', 'scores', 'actions']);
    expect(result).toEqual({ ran: ['sync', 'actions'], failed: ['scores'] });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
    info.mockRestore();
  });

  it('runs nothing for a group it does not know', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runScheduled('* * * * *', {}, {} as JobContext)).toEqual({ ran: [], failed: [] });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
