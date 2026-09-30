import type { AccessLevel } from '@stayput/core';
import { USER_TOKEN_ISSUER, WhopApiError, signWebhook, type WhopClient } from '@stayput/whop';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCache } from '../src/access';
import {
  HEALTH_DB_TIMEOUT_MS,
  MAX_WEBHOOK_BYTES,
  companyIdOf,
  createApp,
  type AppDeps,
} from '../src/app';
import { withUser, type ClosableDb, type Db } from '../src/db';
import type { Env } from '../src/env';
import { createTestDb, type TestDb } from './helpers/db';

const NOW = new Date('2026-09-30T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const APP_ID = 'app_stayput';
const SECRET = 'ws_test_secret';
const ENV: Env = {
  WHOP_ENV: 'sandbox',
  WHOP_APP_ID: APP_ID,
  WHOP_API_KEY: 'test_key',
  WHOP_WEBHOOK_SECRET: SECRET,
};

let t: TestDb;
let keys: { privateKey: CryptoKey; publicKey: CryptoKey };

beforeAll(async () => {
  t = await createTestDb({ via: 'install-sql' });
  keys = await generateKeyPair('ES256');
});
afterAll(() => t.close());

/** A fake Whop answering access checks from a table; counts the calls. */
function fakeWhop(access: Record<string, AccessLevel | Error>) {
  const calls: string[] = [];
  const client = {
    env: 'sandbox',
    checkAccess(userId: string, resourceId: string) {
      calls.push(`${userId}:${resourceId}`);
      const answer = access[`${userId}:${resourceId}`] ?? 'no_access';
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ hasAccess: answer !== 'no_access', accessLevel: answer });
    },
  } as unknown as WhopClient;
  return { client, calls };
}

function setup(access: Record<string, AccessLevel | Error> = {}, options: { db?: Db | null } = {}) {
  const db = options.db === undefined ? t.db : options.db;
  const whop = fakeWhop(access);
  const deps: AppDeps = {
    now: () => NOW,
    openDb: (): ClosableDb | null =>
      db && {
        query: <T>(text: string, params?: readonly unknown[]) => db.query<T>(text, params),
        transaction: <T>(work: (tx: Db) => Promise<T>) => t.db.transaction(work),
        close: () => Promise.resolve(),
      },
    whopClient: (config) => (config.apiKey ? whop.client : null),
    userTokenKeys: () => keys.publicKey,
    accessCache: new AccessCache(),
  };
  const app = createApp(deps);
  const request = (path: string, init: RequestInit = {}, env: Env = ENV) =>
    app.request(path, init, env);
  return { request, whop };
}

function userToken(sub: string, { aud = APP_ID, key = keys.privateKey } = {}) {
  return new SignJWT({ sub, aud, iss: USER_TOKEN_ISSUER })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt(NOW_S)
    .setExpirationTime(NOW_S + 300)
    .sign(key);
}

const asUser = async (sub: string) => ({ headers: { 'x-whop-user-token': await userToken(sub) } });

describe('GET /health', () => {
  it('reports a reachable, up-to-date database', async () => {
    const res = await setup().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', whopEnv: 'sandbox', database: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is degraded without a database, with an old schema, or when unreachable', async () => {
    const none = await setup({}, { db: null }).request('/health');
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ database: 'not_configured' });

    const failing = (code?: string): Db => ({
      query: () => Promise.reject(Object.assign(new Error('boom'), { code })),
    });
    const outdated = await setup({}, { db: failing('42P01') }).request('/health');
    expect(await outdated.json()).toMatchObject({ status: 'degraded', database: 'outdated' });
    const down = await setup({}, { db: failing() }).request('/health');
    expect(await down.json()).toMatchObject({ database: 'unreachable' });
  });

  it('answers within the time limit when the database stays silent', async () => {
    vi.useFakeTimers();
    try {
      const silent: Db = { query: () => new Promise(() => {}) };
      const pending = setup({}, { db: silent }).request('/health');
      await vi.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS);
      const res = await pending;
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: 'degraded', database: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/api authentication', () => {
  it('refuses a request without a Whop token', async () => {
    const res = await setup().request('/api/creator/biz_A1/session');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('refuses a token for another app, or signed by someone else', async () => {
    const { request } = setup({ 'user_alice:biz_A1': 'admin' });
    const other = await generateKeyPair('ES256');
    for (const token of [
      await userToken('user_alice', { aud: 'app_other' }),
      await userToken('user_alice', { key: other.privateKey }),
    ]) {
      const res = await request('/api/creator/biz_A1/session', {
        headers: { 'x-whop-user-token': token },
      });
      expect(res.status).toBe(401);
    }
  });
});

describe('GET /api/creator/:companyId/session', () => {
  it('opens to an admin, and records the company and the check for RLS', async () => {
    const { request } = setup({ 'user_alice:biz_A1': 'admin' });
    const res = await request('/api/creator/biz_A1/session', await asUser('user_alice'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      companyId: 'biz_A1',
      userId: 'user_alice',
      accessLevel: 'admin',
    });
    const companies = await withUser(t.db, 'user_alice', (tx) =>
      tx.query<{ id: string; status: string }>('select id, status from stayput.companies'),
    );
    expect(companies).toEqual([{ id: 'biz_A1', status: 'active' }]);
    const [settings] = await t.db.query(
      `select count(*)::int as n from stayput.company_settings where company_id = 'biz_A1'`,
    );
    expect(settings).toEqual({ n: 1 });
  });

  it('reactivates a company that had uninstalled StayPut', async () => {
    await t.db.query(
      `insert into stayput.companies (id, status, uninstalled_at)
       values ('biz_Gone', 'uninstalled', now())`,
    );
    const { request } = setup({ 'user_gone:biz_Gone': 'admin' });
    await request('/api/creator/biz_Gone/session', await asUser('user_gone'));
    const [row] = await t.db.query(
      `select status, uninstalled_at from stayput.companies where id = 'biz_Gone'`,
    );
    expect(row).toEqual({ status: 'active', uninstalled_at: null });
  });

  it('refuses a customer and a stranger', async () => {
    const { request } = setup({ 'user_bob:biz_A1': 'customer' });
    for (const user of ['user_bob', 'user_stranger']) {
      const res = await request('/api/creator/biz_A1/session', await asUser(user));
      expect(res.status, user).toBe(403);
    }
  });

  it('checks the id before asking Whop anything', async () => {
    const { request, whop } = setup();
    const res = await request('/api/creator/not-a-company/session', await asUser('user_alice'));
    expect(res.status).toBe(400);
    expect(whop.calls).toEqual([]);
  });

  it('asks Whop once, then remembers the answer for a while', async () => {
    const { request, whop } = setup({ 'user_alice:biz_A1': 'admin' });
    const init = await asUser('user_alice');
    await request('/api/creator/biz_A1/session', init);
    await request('/api/creator/biz_A1/session', init);
    expect(whop.calls).toEqual(['user_alice:biz_A1']);
  });

  it('treats an id Whop does not know as no access, and an outage as unavailable', async () => {
    const notFound = new WhopApiError(404, 'not_found', 'no such account', {
      method: 'GET',
      path: '/users/x/access/y',
    });
    const outage = new WhopApiError(503, 'unavailable', 'later', { method: 'GET', path: '/x' });
    const { request } = setup({ 'user_alice:biz_Unknown': notFound, 'user_alice:biz_A1': outage });
    const init = await asUser('user_alice');
    expect((await request('/api/creator/biz_Unknown/session', init)).status).toBe(403);
    const res = await request('/api/creator/biz_A1/session', init);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'whop_unavailable' } });
  });

  it('says so when the Whop API key is missing', async () => {
    const { request } = setup();
    const res = await request('/api/creator/biz_A1/session', await asUser('user_alice'), {
      ...ENV,
      WHOP_API_KEY: '',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'not_configured' } });
  });
});

describe('GET /api/member/:experienceId/session', () => {
  it('opens to a member and to the team, not to others', async () => {
    const { request } = setup({
      'user_member:exp_E1': 'customer',
      'user_alice:exp_E1': 'admin',
    });
    for (const [user, status] of [
      ['user_member', 200],
      ['user_alice', 200],
      ['user_stranger', 403],
    ] as const) {
      const res = await request('/api/member/exp_E1/session', await asUser(user));
      expect(res.status, user).toBe(status);
    }
    const res = await request('/api/member/exp_E1/session', await asUser('user_member'));
    expect(await res.json()).toEqual({
      experienceId: 'exp_E1',
      userId: 'user_member',
      accessLevel: 'customer',
    });
  });

  it('refuses a malformed experience id', async () => {
    const res = await setup().request('/api/member/biz_A1/session', await asUser('user_member'));
    expect(res.status).toBe(400);
  });
});

describe('local development', () => {
  const DEV_ENV: Env = {
    ...ENV,
    WHOP_API_KEY: '',
    ENVIRONMENT: 'development',
    DEV_USER_ID: 'user_dev',
    DEV_ACCESS_LEVEL: 'admin',
  };

  it('acts as DEV_USER_ID without a token or Whop when ENVIRONMENT=development', async () => {
    const res = await setup({}, { db: null }).request('/api/creator/biz_Dev/session', {}, DEV_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: 'user_dev', accessLevel: 'admin' });
  });

  it('ignores the DEV_* settings anywhere else', async () => {
    const res = await setup({}, { db: null }).request(
      '/api/creator/biz_Dev/session',
      {},
      { ...DEV_ENV, ENVIRONMENT: 'production' },
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /webhooks/whop', () => {
  async function delivery(body: string, id = 'msg_1', secret = SECRET) {
    return {
      method: 'POST',
      body,
      headers: {
        'webhook-id': id,
        'webhook-timestamp': String(NOW_S),
        'webhook-signature': await signWebhook(body, secret, id, NOW_S),
        'content-type': 'application/json',
      },
    };
  }
  const EVENT = JSON.stringify({
    type: 'membership.activated',
    company_id: 'biz_A1',
    data: { id: 'mem_1' },
  });

  it('stores a signed delivery as a JSON object, once', async () => {
    const { request } = setup();
    const first = await request('/webhooks/whop', await delivery(EVENT, 'msg_store'));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, duplicate: false });
    const again = await request('/webhooks/whop', await delivery(EVENT, 'msg_store'));
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    const rows = await t.db.query(
      `select company_id, type, status, jsonb_typeof(payload) as kind, payload->'data'->>'id' as data_id
         from stayput.webhook_events where id = 'msg_store'`,
    );
    expect(rows).toEqual([
      {
        company_id: 'biz_A1',
        type: 'membership.activated',
        status: 'received',
        kind: 'object',
        data_id: 'mem_1',
      },
    ]);
  });

  it('refuses a bad signature, and a body without JSON or type', async () => {
    const { request } = setup();
    expect(
      (await request('/webhooks/whop', await delivery(EVENT, 'msg_bad', 'ws_other'))).status,
    ).toBe(401);
    expect((await request('/webhooks/whop', await delivery('not json', 'msg_nojson'))).status).toBe(
      400,
    );
    expect(
      (await request('/webhooks/whop', await delivery('{"data":{}}', 'msg_notype'))).status,
    ).toBe(400);
  });

  it('refuses an oversized payload', async () => {
    const big = JSON.stringify({ type: 'x', data: 'a'.repeat(MAX_WEBHOOK_BYTES) });
    const res = await setup().request('/webhooks/whop', await delivery(big, 'msg_big'));
    expect(res.status).toBe(413);
  });

  it('answers 503 until the secret and the database are configured, so Whop retries', async () => {
    const noSecret = await setup().request('/webhooks/whop', await delivery(EVENT, 'msg_ns'), {
      ...ENV,
      WHOP_WEBHOOK_SECRET: '',
    });
    expect(noSecret.status).toBe(503);
    const noDb = await setup({}, { db: null }).request(
      '/webhooks/whop',
      await delivery(EVENT, 'msg_nd'),
    );
    expect(noDb.status).toBe(503);
  });

  it('finds the company wherever the payload names it', () => {
    expect(companyIdOf({ company_id: 'biz_1' })).toBe('biz_1');
    expect(companyIdOf({ data: { account: { id: 'biz_2' } } })).toBe('biz_2');
    expect(companyIdOf({ data: { company_id: 'not-a-company' } })).toBeNull();
    expect(companyIdOf('x')).toBeNull();
  });
});

describe('reserved and unknown routes', () => {
  it('answers the public badge and proof routes with 404 until their phase', async () => {
    const { request } = setup();
    expect((await request('/badge/biz_A1.svg')).status).toBe(404);
    expect((await request('/badge/whatever.png')).status).toBe(400);
    expect((await request('/v/00000000-0000-4000-8000-000000000001')).status).toBe(404);
    expect((await request('/v/1;drop')).status).toBe(400);
  });

  it('answers an unknown route with a JSON 404', async () => {
    const res = await setup().request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
