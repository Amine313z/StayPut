import type {
  AccountsView,
  AlumniView,
  DashboardView,
  FeedView,
  AnnouncementsView,
  GoalProposalsView,
  MemberDetail,
  MemberRetentionView,
  MemberSpaceView,
  ResultAnswer,
  ShareAnswer,
  SpaceOverview,
  TestimonialCard,
  PlatformActivityView,
  ActionsPage,
  AccessLevel,
  DiscordChannelChoice,
  InsightsOverview,
  InsightsReport,
  IntegrationsStatus,
  MemberTelegramStatus,
  PeopleView,
  MembersPage,
  PlatformDashboard,
  SyncRun,
  SyncStatus,
  WeeklyReportsView,
  BenchmarksView,
} from '@stayput/core';
import { DEFAULT_PLATFORM_SIGNALS } from '@stayput/core';
import { USER_TOKEN_ISSUER, WhopApiError, signWebhook, type WhopClient } from '@stayput/whop';
import { createHash } from 'node:crypto';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCache } from '../src/access';
import { prepareActions } from '../src/actions';
import {
  HEALTH_DB_TIMEOUT_MS,
  MAX_WEBHOOK_BYTES,
  companyIdOf,
  createApp,
  type AppDeps,
} from '../src/app';
import { withUser, type ClosableDb, type Db } from '../src/db';
import { SESSION_COOKIE, sign, signingKey } from '../src/session';
import type { DiscordClient } from '../src/discord';
import type { Env } from '../src/env';
import { telegramWebhookSecret, type TelegramClient } from '../src/telegram';
import { member, membership, message, page, payment, variant } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

// The real time (to the second): RLS checks a creator's access against the database's own
// clock (is_company_admin), so a fixed date would make these tests expire.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const NOW_S = Math.floor(NOW.getTime() / 1000);
const APP_ID = 'app_stayput';
const SECRET = 'ws_test_secret';
const ENV: Env = {
  WHOP_ENV: 'sandbox',
  WHOP_APP_ID: APP_ID,
  WHOP_API_KEY: 'test_key',
  WHOP_WEBHOOK_SECRET: SECRET,
  // The member space's own tests run with it on; « the member space is off » turns it off.
  MEMBER_SPACE_ENABLED: 'true',
};

let t: TestDb;
let keys: { privateKey: CryptoKey; publicKey: CryptoKey };

beforeAll(async () => {
  t = await createTestDb({ via: 'install-sql' });
  keys = await generateKeyPair('ES256');
});
afterAll(() => t.close());

/** What the Worker left running after its answers (waitUntil): every test waits for it. */
const pending: Promise<unknown>[] = [];
const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
  passThroughOnException: () => {},
  props: {},
};
async function settle() {
  while (pending.length > 0) await Promise.all(pending.splice(0));
}
afterEach(settle);

const EMPTY_PAGE = '{"data":[],"page_info":{"end_cursor":null,"has_next_page":false}}';

/**
 * A fake Whop answering access checks from a table, and every list with an empty page (or the
 * pages given); counts the calls.
 */
function fakeWhop(
  access: Record<string, AccessLevel | Error>,
  lists: Record<string, string> = {},
  experiences: Record<string, string> = {},
) {
  const calls: string[] = [];
  const listed: string[] = [];
  const writes: { method: string; path: string; body: unknown; key?: string }[] = [];
  /** Whop refuses these (`POST /experiences`…) with this error, once each. */
  const refusals: Record<string, WhopApiError> = {};
  const client = {
    env: 'sandbox',
    request(method: string, path: string, options?: { body?: unknown; idempotencyKey?: string }) {
      calls.push(`${method} ${path}`);
      const refused = refusals[`${method} ${path}`];
      if (refused) {
        delete refusals[`${method} ${path}`];
        return Promise.reject(refused);
      }
      if (method !== 'GET') {
        writes.push({ method, path, body: options?.body, key: options?.idempotencyKey });
      }
      // What creating the Alumni offer asks of Whop.
      if (method === 'POST' && path === '/products') return Promise.resolve({ id: 'prod_Alu1' });
      if (method === 'POST' && path === '/variants') {
        return Promise.resolve({
          id: 'plan_Alu1',
          purchase_url: 'https://sandbox.whop.com/checkout/plan_Alu1',
        });
      }
      if (method === 'POST' && path === '/experiences') return Promise.resolve({ id: 'exp_Alu1' });
      if (method === 'POST' && /^\/experiences\/exp_[A-Za-z0-9]+\/attach$/.test(path)) {
        return Promise.resolve({ id: 'exp_Alu1' });
      }
      // A member's membership, and what an accepted offer asks of Whop.
      const membership = /^\/memberships\/(mem_[A-Za-z0-9]+)/.exec(path)?.[1];
      if (method === 'GET' && membership) {
        return Promise.resolve({
          id: membership,
          manage_url: `https://whop.com/manage/${membership}`,
        });
      }
      if (method !== 'GET' && (membership || path === '/promo_codes')) {
        return Promise.resolve({ id: 'promo_1' });
      }
      // A company: its name. Its account (/accounts/…) answers 403 to an app key, as live.
      const named = /^\/companies\/(biz_[A-Za-z0-9]+)$/.exec(path)?.[1];
      if (method === 'GET' && named) {
        return Promise.resolve({
          id: named,
          title: `Le Club ${named.slice(4)}`,
          // Whop's logo: an attachment, on its images' address.
          logo: named === 'biz_Logo' ? { url: 'https://assets.whop.com/logos/biz_Logo.png' } : null,
        });
      }
      if (/^\/accounts\//.test(path)) {
        return Promise.reject(new WhopApiError(403, 'forbidden', 'not allowed', { method, path }));
      }
      // A user's public profile: the username Whop searches affiliates by.
      const user = /^\/users\/(user_[A-Za-z0-9]+)$/.exec(path)?.[1];
      if (method === 'GET' && user) {
        return Promise.resolve({ id: user, username: user.replace('user_', '') });
      }
      const experience = /^\/experiences\/(exp_[A-Za-z0-9]+)$/.exec(path)?.[1];
      const company = experience ? experiences[experience] : undefined;
      if (!company)
        return Promise.reject(
          new WhopApiError(404, 'not_found', 'no such thing', { method, path }),
        );
      return Promise.resolve({ id: experience, company: { id: company } });
    },
    getRaw(path: string) {
      calls.push(`GET ${path}`);
      return Promise.reject(
        new WhopApiError(404, 'not_found', 'no such user', { method: 'GET', path }),
      );
    },
    checkAccess(userId: string, resourceId: string) {
      calls.push(`${userId}:${resourceId}`);
      const answer = access[`${userId}:${resourceId}`] ?? 'no_access';
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ hasAccess: answer !== 'no_access', accessLevel: answer });
    },
    listPageRaw(path: string) {
      listed.push(path);
      return Promise.resolve(lists[path] ?? EMPTY_PAGE);
    },
    listPage(path: string) {
      listed.push(path);
      const page = JSON.parse(lists[path] ?? EMPTY_PAGE) as { data: unknown[] };
      return Promise.resolve({ items: page.data, nextCursor: null });
    },
  } as unknown as WhopClient;
  return { client, calls, listed, writes, refusals };
}

function setup(
  access: Record<string, AccessLevel | Error> = {},
  options: {
    db?: Db | null;
    lists?: Record<string, string>;
    discord?: DiscordClient;
    telegram?: TelegramClient;
    /** The company of each experience, as Whop answers GET /experiences/{id}. */
    experiences?: Record<string, string>;
    /** What the address of an image answers (the community's logo). */
    fetchImage?: (url: string) => Promise<Response>;
    /** How long a reading waits for Discord or Telegram. */
    outsideWaitMs?: number;
  } = {},
) {
  const db = options.db === undefined ? t.db : options.db;
  const whop = fakeWhop(access, options.lists, options.experiences);
  const clock = { now: NOW };
  const deps: AppDeps = {
    now: () => clock.now,
    openDb: (): ClosableDb | null =>
      db && {
        query: <T>(text: string, params?: readonly unknown[]) => db.query<T>(text, params),
        transaction: <T>(work: (tx: Db) => Promise<T>) => t.db.transaction(work),
        close: () => Promise.resolve(),
      },
    whopClient: (config) => (config.apiKey ? whop.client : null),
    userTokenKeys: () => keys.publicKey,
    oauth: () => null,
    discord: (config) => (config.discord ? (options.discord ?? null) : null),
    telegram: (config) => (config.telegram ? (options.telegram ?? null) : null),
    accessCache: new AccessCache(),
    ...(options.fetchImage ? { fetchImage: options.fetchImage } : {}),
    ...(options.outsideWaitMs === undefined ? {} : { outsideWaitMs: options.outsideWaitMs }),
  };
  const app = createApp(deps);
  const request = (path: string, init: RequestInit = {}, env: Env = ENV) =>
    app.request(path, init, env, executionCtx);
  return { request, whop, clock };
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

describe('the member space, off in V1 (MEMBER_SPACE_ENABLED)', () => {
  it('answers none of its routes, while the departure survey goes on', async () => {
    const { request } = setup(
      {
        'user_boss:biz_Off1': 'admin',
        'user_ana:exp_Off1': 'customer',
      },
      { experiences: { exp_Off1: 'biz_Off1' } },
    );
    const off: Env = { ...ENV, MEMBER_SPACE_ENABLED: undefined };
    const boss = await asUser('user_boss');
    await request('/api/creator/biz_Off1/session', boss, off);
    await settle();
    for (const path of [
      '/api/creator/biz_Off1/space',
      '/api/creator/biz_Off1/preview/space',
      '/api/creator/biz_Off1/goals',
      '/api/creator/biz_Off1/earned-days',
      '/api/creator/biz_Off1/buddies',
      '/api/creator/biz_Off1/rescues',
      '/api/creator/biz_Off1/announcements',
    ]) {
      expect((await request(path, boss, off)).status, path).toBe(404);
    }
    const ana = await asUser('user_ana');
    expect((await request('/api/member/exp_Off1/space', ana, off)).status).toBe(404);
    expect(
      (await request('/api/member/exp_Off1/space/goal', { ...ana, method: 'POST' }, off)).status,
    ).toBe(404);
    expect((await request('/api/member/exp_Off1/space/affiliate', ana, off)).status).toBe(404);
    // The departure survey and the payment links are not the member space; nor the survey's
    // invitation to recommend the community (its affiliate link).
    expect((await request('/api/member/exp_Off1/retention', ana, off)).status).toBe(200);
    expect(
      await (await request('/api/member/exp_Off1/retention/affiliate', ana, off)).json(),
    ).toEqual({ url: null });
    // A card page once online says it is gone.
    const page = await request('/v/00000000-0000-4000-8000-000000000001', {}, off);
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
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
      via: 'iframe',
      timezoneSet: false,
      // Not read from Whop yet.
      companyName: null,
      companyLogo: false,
      testMode: false,
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
    // Its access checks (the other calls are the background sync's).
    expect(whop.calls.filter((call) => !/^[A-Z]+ \//.test(call))).toEqual(['user_alice:biz_A1']);
  });

  it('learns the community’s name from Whop, for its messages and pages', async () => {
    const { request, whop } = setup({ 'user_alice:biz_Named': 'admin' });
    const init = await asUser('user_alice');
    const first = (await (await request('/api/creator/biz_Named/session', init)).json()) as {
      companyName: string | null;
    };
    expect(first.companyName).toBeNull();
    await settle();
    expect(whop.calls).toContain('GET /companies/biz_Named');
    const again = (await (await request('/api/creator/biz_Named/session', init)).json()) as {
      companyName: string | null;
    };
    expect(again.companyName).toBe('Le Club Named');
  });

  it('learns the community’s logo from Whop, and serves it from its own address', async () => {
    const fetched: string[] = [];
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const answers: Response[] = [
      new Response(png, { headers: { 'content-type': 'image/png' } }),
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    ];
    const { request } = setup(
      { 'user_alice:biz_Logo': 'admin', 'user_alice:biz_Named': 'admin' },
      {
        fetchImage: (url) => {
          fetched.push(url);
          return Promise.resolve(answers.shift()!);
        },
      },
    );
    const init = await asUser('user_alice');
    const session = async (company: string) =>
      (await (await request(`/api/creator/${company}/session`, init)).json()) as {
        companyLogo: boolean;
      };
    expect((await session('biz_Logo')).companyLogo).toBe(false);
    await settle();
    expect((await session('biz_Logo')).companyLogo).toBe(true);
    const logo = await request('/api/creator/biz_Logo/logo', init);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(png);
    expect(fetched).toEqual(['https://assets.whop.com/logos/biz_Logo.png']);
    // Not an image: nothing is passed on.
    expect((await request('/api/creator/biz_Logo/logo', init)).status).toBe(404);
    // A community without a logo: none, and nothing is fetched.
    await session('biz_Named');
    await settle();
    expect((await session('biz_Named')).companyLogo).toBe(false);
    expect((await request('/api/creator/biz_Named/logo', init)).status).toBe(404);
    expect(fetched).toHaveLength(2);
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
      via: 'iframe',
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

  it('stores a signed delivery once, answers, then files it', async () => {
    const event = JSON.stringify({
      type: 'membership.activated',
      company_id: 'biz_Hook',
      data: membership('mem_Hook1', 'user_Hook1', { account: { id: 'biz_Hook' } }),
    });
    const { request } = setup();
    const first = await request('/webhooks/whop', await delivery(event, 'msg_store'));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, duplicate: false });
    await settle();
    const again = await request('/webhooks/whop', await delivery(event, 'msg_store'));
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    await settle();
    const rows = await t.db.query(
      `select company_id, type, status, attempts, jsonb_typeof(payload) as kind
         from stayput.webhook_events where id = 'msg_store'`,
    );
    expect(rows).toEqual([
      {
        company_id: 'biz_Hook',
        type: 'membership.activated',
        status: 'processed',
        attempts: 1,
        kind: 'object',
      },
    ]);
    expect(
      await t.db.query(`select company_id, status from stayput.memberships where id = 'mem_Hook1'`),
    ).toEqual([{ company_id: 'biz_Hook', status: 'active' }]);
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

describe('the synchronization from the creator view', () => {
  const ACCOUNT_LISTS = [
    '/variants',
    '/members',
    '/memberships',
    '/payments',
    '/support_channels',
    '/chat_channels',
    '/forums',
    '/courses',
  ];

  it('starts reading the company on the first visit, after answering', async () => {
    const { request, whop } = setup({ 'user_carla:biz_Sync1': 'admin' });
    const init = await asUser('user_carla');
    expect((await request('/api/creator/biz_Sync1/session', init)).status).toBe(200);
    await settle();
    expect(whop.listed).toEqual(ACCOUNT_LISTS);

    // Another visit soon after reads nothing again.
    whop.listed.length = 0;
    await request('/api/creator/biz_Sync1/session', init);
    await settle();
    expect(whop.listed).toEqual([]);

    const res = await request('/api/creator/biz_Sync1/sync', init);
    expect(res.status).toBe(200);
    const status = (await res.json()) as SyncStatus;
    expect(status.backfillDone).toBe(true);
    expect(status.lastSyncAt).toBe(NOW.toISOString());
    expect(status.streams.map((s) => s.stream)).toEqual(
      ACCOUNT_LISTS.map((p) => (p === '/variants' ? 'plans' : p.slice(1))).sort(),
    );
  });

  it('reads now on demand, at most once a minute', async () => {
    const { request, clock } = setup({ 'user_erin:biz_Sync2': 'admin' });
    const init = await asUser('user_erin');
    await request('/api/creator/biz_Sync2/session', init);
    await settle();
    const syncNow = async () =>
      (await (
        await request('/api/creator/biz_Sync2/sync', { method: 'POST', ...init })
      ).json()) as SyncRun;

    expect(await syncNow()).toMatchObject({ ran: false, calls: 0, backfillDone: true });
    clock.now = new Date(NOW.getTime() + 61_000);
    expect(await syncNow()).toMatchObject({ ran: true, calls: 0 });
    expect(await syncNow()).toMatchObject({ ran: false });
  });

  it('keeps the synchronization to the team', async () => {
    const { request } = setup({ 'user_dan:biz_Sync3': 'customer' });
    const init = await asUser('user_dan');
    for (const [path, method] of [
      ['/api/creator/biz_Sync3/sync', 'GET'],
      ['/api/creator/biz_Sync3/sync', 'POST'],
      ['/api/creator/biz_Sync3/members', 'GET'],
    ] as const) {
      expect((await request(path, { method, ...init })).status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('GET /api/creator/:companyId/members', () => {
  const ingest = (companyId: string, kind: string, body: unknown, scope: string | null = null) =>
    t.db.query('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
      companyId,
      kind,
      scope,
      JSON.stringify(body),
    ]);
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  it("lists the company's members with what StayPut collected about them", async () => {
    const { request } = setup({ 'user_mia:biz_Mem1': 'admin', 'user_mia:biz_Mem2': 'admin' });
    const init = await asUser('user_mia');
    await request('/api/creator/biz_Mem1/session', init);
    await request('/api/creator/biz_Mem2/session', init);
    await settle();

    const c = 'biz_Mem1';
    await ingest(c, 'plans', page([variant('plan_VM1')]));
    await ingest(
      c,
      'members',
      page([
        member('mber_MA', 'user_UA'),
        member('mber_MB', 'user_UB'),
        member('mber_MC', 'user_UC', { status: 'left' }),
      ]),
    );
    await ingest(
      c,
      'memberships',
      page([
        membership('mem_MA', 'user_UA', { plan_id: 'plan_VM1' }),
        membership('mem_MB', 'user_UB', { plan_id: 'plan_VM1', cancel_at_period_end: true }),
        membership('mem_MC', 'user_UC', { plan_id: 'plan_VM1', status: 'canceled' }),
      ]),
    );
    await ingest(
      c,
      'payments',
      page([
        payment('pay_MA1', { membership_id: 'mem_MA', member_id: 'mber_MA' }),
        payment('pay_MB1', {
          membership_id: 'mem_MB',
          member_id: 'mber_MB',
          substatus: 'failed',
          failure_message: 'Card declined',
          created_at: daysAgo(1),
        }),
      ]),
    );
    await ingest(
      c,
      'messages',
      page([message('msg_MA1', 'user_UA', daysAgo(1)), message('msg_MA2', 'user_UA', daysAgo(2))]),
      'chat_M1',
    );
    await ingest('biz_Mem2', 'members', page([member('mber_Other', 'user_Other')]));
    await t.db.query('select stayput.refresh_stats($1::timestamptz)', [NOW.toISOString()]);

    const res = await request('/api/creator/biz_Mem1/members', init);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MembersPage;
    expect(body.summary).toEqual({
      members: 2,
      liveMemberships: 2,
      scheduledCancellations: 1,
      failedPayments: 1,
      activity30d: 2,
      // Two memberships at 49 $ a month; none at risk before the first scores.
      revenue: { currency: 'USD', monthly: 98, atRisk: 0, otherCurrencies: false },
      // No score computed yet: the members arrived after the visit.
      risk: {
        high: 0,
        medium: 0,
        low: 0,
        scheduledDeparture: 0,
        inactiveNewcomers: 0,
        computedAt: null,
      },
    });
    expect(body.truncated).toBe(false);
    expect(body.members.map((m) => [m.id, m.status])).toEqual([
      ['mber_MA', 'joined'],
      ['mber_MB', 'joined'],
      ['mber_MC', 'left'],
    ]);
    expect(body.members[0]).toMatchObject({
      name: 'Name user_UA',
      accessLevel: 'customer',
      lastActivityAt: daysAgo(1),
      activity: { messages: 2, reactions: 0, posts: 0, lessons: 0 },
      membership: { status: 'active', price: 49, currency: 'usd', cancelAtPeriodEnd: false },
      lastPayment: { status: 'succeeded', amount: 49, currency: 'usd' },
    });
    expect(body.members[1]).toMatchObject({
      membership: { cancelAtPeriodEnd: true },
      lastPayment: { status: 'failed', failureReason: 'Card declined' },
    });
    // Nothing personal leaves the database: no e-mail, no phone.
    expect(JSON.stringify(body)).not.toMatch(/@mail\.test|\+33/);
  });

  it('brings the revenue back to a month, the team and other currencies aside', async () => {
    const { request } = setup({ 'user_mia:biz_Rev1': 'admin' });
    const init = await asUser('user_mia');
    await request('/api/creator/biz_Rev1/session', init);
    await settle();

    const c = 'biz_Rev1';
    await ingest(
      c,
      'plans',
      page([
        variant('plan_Year', { billing_period: 365, renewal_price: 120 }),
        variant('plan_Week', { billing_period: 7, renewal_price: 12 }),
        variant('plan_Month', { renewal_price: 49 }),
        variant('plan_Eur', { currency: 'eur', renewal_price: 30 }),
      ]),
    );
    await ingest(
      c,
      'members',
      page([
        member('mber_RY', 'user_RY'),
        member('mber_RW', 'user_RW'),
        member('mber_RT', 'user_RT'),
        member('mber_RE', 'user_RE'),
        member('mber_RF', 'user_RF'),
        member('mber_RS', 'user_RS', { access_level: 'admin' }),
      ]),
    );
    await ingest(
      c,
      'memberships',
      page([
        membership('mem_RY', 'user_RY', { plan_id: 'plan_Year', billing_period_days: 365 }),
        membership('mem_RW', 'user_RW', { plan_id: 'plan_Week', billing_period_days: 7 }),
        membership('mem_RT', 'user_RT', { plan_id: 'plan_Month', status: 'trialing' }),
        membership('mem_RE', 'user_RE', { plan_id: 'plan_Eur' }),
        membership('mem_RF', 'user_RF', { plan_id: 'plan_Month', status: 'past_due' }),
        membership('mem_RS', 'user_RS', { plan_id: 'plan_Month' }),
      ]),
    );

    const res = await request('/api/creator/biz_Rev1/members', init);
    const body = (await res.json()) as MembersPage;
    // 120 a year is 10 a month, 12 a week is 52, 49 overdue still counts; not the trial, the
    // team, nor the euros (flagged instead).
    expect(body.summary.revenue).toEqual({
      currency: 'USD',
      monthly: 111,
      atRisk: 0,
      otherCurrencies: true,
    });
    // The team is not counted among the members.
    expect(body.summary.members).toBe(5);
  });
});

describe('Discord and Telegram', () => {
  const MODULES: Env = {
    ...ENV,
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    TELEGRAM_BOT_TOKEN: '123456:telegram-token',
  };
  const ORIGIN = 'http://localhost';
  const GUILD = '910000000000000001';
  const OTHER_GUILD = '910000000000000002';

  /** StayPut's Discord bot: one server with two readable channels and a hidden one. */
  function fakeDiscord() {
    const left: string[] = [];
    const exchanged: { code: string; redirectUri: string }[] = [];
    const client: DiscordClient = {
      messagesRaw: () => Promise.resolve('[]'),
      membersRaw: () => Promise.resolve('[]'),
      memberCount: (guildId) => Promise.resolve(guildId === GUILD ? 42 : null),
      application: () => Promise.resolve({ id: '700000000000000001', botId: '700000000000000001' }),
      guildChannels: (guildId) =>
        Promise.resolve(
          guildId === GUILD
            ? [
                { id: '920000000000000001', name: 'general', category: null, readable: true },
                { id: '920000000000000002', name: 'wins', category: 'Club', readable: true },
                { id: '920000000000000003', name: 'staff', category: 'Club', readable: false },
              ]
            : [{ id: '930000000000000001', name: 'elsewhere', category: null, readable: true }],
        ),
      leaveGuild: (guildId) => {
        left.push(guildId);
        return Promise.resolve();
      },
      sendMessage: () => Promise.resolve(),
      user: (userId) =>
        Promise.resolve(
          userId === '940000000000000001'
            ? { name: 'Alice Martin', username: 'alice.m' }
            : { name: null, username: null },
        ),
      exchangeCode: (code, redirectUri) => {
        exchanged.push({ code, redirectUri });
        return code === 'bad'
          ? Promise.reject(new Error('invalid_grant'))
          : Promise.resolve({ guildId: GUILD, guildName: 'Le Club' });
      },
    };
    return { client, left, exchanged };
  }

  function fakeTelegram() {
    const sent: { chatId: string; text: string }[] = [];
    const webhooks: { url: string; secret: string }[] = [];
    const left: string[] = [];
    const client: TelegramClient = {
      bot: () => Promise.resolve({ username: 'StayPutBot', readsAllMessages: true }),
      setWebhook: (url, secret) => {
        webhooks.push({ url, secret });
        return Promise.resolve();
      },
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
      leaveChat: (chatId) => {
        left.push(chatId);
        return Promise.resolve();
      },
      chatMember: (_chatId, userId) =>
        Promise.resolve(
          userId === '5550001'
            ? { name: 'Bruno', username: 'bruno_p' }
            : { name: null, username: null },
        ),
      memberCount: () => Promise.resolve(34),
      administrators: () =>
        Promise.resolve([{ id: '5550009', name: 'Chef Telegram', username: 'chef_tg' }]),
    };
    return { client, sent, webhooks, left };
  }

  function modules(access: Record<string, AccessLevel>, experiences: Record<string, string> = {}) {
    const discord = fakeDiscord();
    const telegram = fakeTelegram();
    const app = setup(access, {
      discord: discord.client,
      telegram: telegram.client,
      experiences,
    });
    const request = (path: string, init: RequestInit = {}) => app.request(path, init, MODULES);
    return { ...app, request, discord, telegram };
  }

  const integrations = async (
    request: (path: string, init?: RequestInit) => Response | Promise<Response>,
    companyId: string,
    init: RequestInit,
  ) =>
    (await (
      await request(`/api/creator/${companyId}/integrations`, init)
    ).json()) as IntegrationsStatus;

  /** The Telegram update, sent as Telegram does (with the secret StayPut gave it). */
  async function telegramUpdate(
    request: (path: string, init?: RequestInit) => Response | Promise<Response>,
    update: unknown,
    secret?: string,
  ) {
    return request('/webhooks/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token':
          secret ?? (await telegramWebhookSecret('123456:telegram-token')),
      },
      body: JSON.stringify(update),
    });
  }

  it('offers nothing to connect while the modules are not set up', async () => {
    const { request } = setup({ 'user_ivy:biz_Int0': 'admin' });
    const init = await asUser('user_ivy');
    await request('/api/creator/biz_Int0/session', init);
    const status = (await (
      await request('/api/creator/biz_Int0/integrations', init)
    ).json()) as IntegrationsStatus;
    expect(status.discord).toMatchObject({ available: false, install: null, servers: [] });
    expect(status.telegram).toMatchObject({ available: false, addToGroup: null, groups: [] });
    expect((await request('/webhooks/telegram', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('connects a Discord server through Discord, following what the bot can read', async () => {
    const { request, discord } = modules({ 'user_ivy:biz_Int1': 'admin' });
    const init = await asUser('user_ivy');
    await request('/api/creator/biz_Int1/session', init);
    await settle();
    const before = await integrations(request, 'biz_Int1', init);
    expect(before.whopAppId).toBe(APP_ID);
    const install = new URL(before.discord.install!.url);
    expect(install.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/discord/callback`);
    const state = install.searchParams.get('state')!;

    // Discord sends the creator back with a code; the state says which company asked.
    const back = await request(
      `/auth/discord/callback?${new URLSearchParams({ code: 'good', state, guild_id: GUILD }).toString()}`,
    );
    expect(back.status).toBe(302);
    const done = new URL(back.headers.get('location')!, ORIGIN);
    expect(done.pathname).toBe('/connected');
    expect(Object.fromEntries(done.searchParams)).toEqual({
      source: 'discord',
      status: 'ok',
      name: 'Le Club',
      channels: '2',
    });
    expect(discord.exchanged).toEqual([
      { code: 'good', redirectUri: `${ORIGIN}/auth/discord/callback` },
    ]);
    await settle();

    // Signed in to StayPut outside Whop (sandbox) as the creator who asked: the page offers the
    // way back to their dashboard. Someone else's session: no.
    const signedIn = async (userId: string) => {
      const session = await sign(
        { purpose: 'session', userId, env: 'sandbox', exp: Math.floor(NOW.getTime() / 1000) + 600 },
        await signingKey('test_key'),
      );
      const again = await request(
        `/auth/discord/callback?${new URLSearchParams({ code: 'good', state, guild_id: GUILD }).toString()}`,
        { headers: { cookie: `${SESSION_COOKIE}=${session}` } },
      );
      await settle();
      return new URL(again.headers.get('location')!, ORIGIN).searchParams.get('company');
    };
    expect(await signedIn('user_ivy')).toBe('biz_Int1');
    expect(await signedIn('user_mallory')).toBeNull();

    const after = await integrations(request, 'biz_Int1', init);
    expect(after.discord.servers).toEqual([
      {
        guildId: GUILD,
        name: 'Le Club',
        connectedAt: NOW.toISOString(),
        channels: [
          expect.objectContaining({ id: '920000000000000001' }),
          expect.objectContaining({ id: '920000000000000002' }),
        ],
      },
    ]);
  });

  it('refuses a forged or expired state, and says when the creator declined', async () => {
    const { request, discord, clock } = modules({ 'user_ivy:biz_Int6': 'admin' });
    const init = await asUser('user_ivy');
    await request('/api/creator/biz_Int6/session', init);
    await settle();
    const status = await integrations(request, 'biz_Int6', init);
    const state = new URL(status.discord.install!.url).searchParams.get('state')!;
    const failed = async (query: Record<string, string>) => {
      const res = await request(`/auth/discord/callback?${new URLSearchParams(query).toString()}`);
      return new URL(res.headers.get('location') ?? '/', ORIGIN).searchParams.get('reason');
    };
    expect(await failed({ code: 'good', state: 'forged.state' })).toBe('expired');
    expect(await failed({ code: 'good' })).toBe('expired');
    expect(await failed({ error: 'access_denied', state })).toBe('denied');
    expect(await failed({ code: 'bad', state })).toBe('error');
    clock.now = new Date(NOW.getTime() + 31 * 60_000);
    expect(await failed({ code: 'good', state })).toBe('expired');
    expect(discord.exchanged.map((e) => e.code)).toEqual(['bad']);
  });

  it('lets the team choose the channels, among the readable ones of its own server', async () => {
    const { request, discord } = modules({
      'user_jon:biz_Int2': 'admin',
      'user_kim:biz_Int3': 'admin',
    });
    const jon = await asUser('user_jon');
    await request('/api/creator/biz_Int2/session', jon);
    await t.db.query('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
      'biz_Int2',
      OTHER_GUILD,
      'Second',
      'user_jon',
      NOW.toISOString(),
    ]);
    const channels = `/api/creator/biz_Int2/discord/${OTHER_GUILD}/channels`;
    expect(await (await request(channels, jon)).json()).toEqual([
      {
        id: '930000000000000001',
        name: 'elsewhere',
        category: null,
        readable: true,
        followed: false,
      },
    ]);
    const choose = (ids: unknown, init: RequestInit) =>
      request(channels, {
        ...init,
        method: 'PUT',
        headers: { ...init.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ channelIds: ids }),
      });
    // A channel of another server, and an unreadable one, are ignored.
    const saved = (await (
      await choose(['930000000000000001', '920000000000000001'], jon)
    ).json()) as DiscordChannelChoice[];
    expect(saved.filter((c) => c.followed).map((c) => c.id)).toEqual(['930000000000000001']);
    // Read back as the choice dialog opens: the chosen channel shows as followed.
    const reopened = (await (await request(channels, jon)).json()) as DiscordChannelChoice[];
    expect(reopened.filter((c) => c.followed).map((c) => c.id)).toEqual(['930000000000000001']);
    expect((await choose('nope', jon)).status).toBe(400);

    // Another company's team sees nothing of this server.
    const kim = await asUser('user_kim');
    await request('/api/creator/biz_Int3/session', kim);
    expect(
      (await request(`/api/creator/biz_Int3/discord/${OTHER_GUILD}/channels`, kim)).status,
    ).toBe(404);
    expect(
      (await request(`/api/creator/biz_Int3/discord/${OTHER_GUILD}`, { method: 'DELETE', ...kim }))
        .status,
    ).toBe(404);

    const removed = await request(`/api/creator/biz_Int2/discord/${OTHER_GUILD}`, {
      method: 'DELETE',
      ...jon,
    });
    expect(await removed.json()).toEqual({ removed: true });
    expect(discord.left).toEqual([OTHER_GUILD]);
  });

  it('links a Telegram group with the signed link, then counts its messages', async () => {
    const { request, telegram } = modules({ 'user_lea:biz_Int4': 'admin' });
    const init = await asUser('user_lea');
    await request('/api/creator/biz_Int4/session', init);
    await settle();
    const status = await integrations(request, 'biz_Int4', init);
    expect(telegram.webhooks).toEqual([
      {
        url: `${ORIGIN}/webhooks/telegram`,
        secret: await telegramWebhookSecret('123456:telegram-token'),
      },
    ]);
    const start = new URL(status.telegram.addToGroup!.url).searchParams.get('startgroup')!;
    const group = { id: -1009000000001, type: 'supergroup', title: 'VIP' };
    const from = { id: 4242, is_bot: false, language_code: 'fr' };

    expect((await telegramUpdate(request, {}, 'wrong')).status).toBe(401);
    const linked = await telegramUpdate(request, {
      update_id: 1,
      message: {
        message_id: 1,
        date: NOW_S,
        chat: group,
        from,
        text: `/start@StayPutBot ${start}`,
      },
    });
    expect(linked.status).toBe(200);
    await settle();
    expect(telegram.sent).toEqual([
      { chatId: '-1009000000001', text: expect.stringContaining('relié à StayPut') as string },
    ]);
    await telegramUpdate(request, {
      update_id: 2,
      message: { message_id: 2, date: NOW_S, chat: group, from, text: 'salut' },
    });
    const after = await integrations(request, 'biz_Int4', init);
    expect(after.telegram.groups).toEqual([
      {
        chatId: '-1009000000001',
        title: 'VIP',
        connectedAt: NOW.toISOString(),
        active: true,
        lastMessageAt: NOW.toISOString(),
      },
    ]);
    expect(after.telegram.unlinkedAuthors).toBe(1);

    // A stale link: the bot says so and leaves.
    await telegramUpdate(request, {
      update_id: 3,
      message: {
        message_id: 1,
        date: NOW_S,
        chat: { id: -1009000000002, type: 'group', title: 'Other' },
        from,
        text: '/start abc_1_aaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    await settle();
    expect(telegram.left).toEqual(['-1009000000002']);

    const removed = await request('/api/creator/biz_Int4/telegram/-1009000000001', {
      method: 'DELETE',
      ...init,
    });
    expect(await removed.json()).toEqual({ removed: true });
    expect(telegram.left).toEqual(['-1009000000002', '-1009000000001']);
  });

  it("answers in the creator's StayPut language, and skips the channel posts Telegram copies", async () => {
    const { request, telegram } = modules({ 'user_noe:biz_Int6': 'admin' });
    const init = await asUser('user_noe');
    await request('/api/creator/biz_Int6/session', init);
    await settle();
    const status = (await (
      await request('/api/creator/biz_Int6/integrations?lang=fr', init)
    ).json()) as IntegrationsStatus;
    const start = new URL(status.telegram.addToGroup!.url).searchParams.get('startgroup')!;
    expect(start).toMatch(/_fr_/);
    // A channel's discussion group; Telegram says nothing of the creator's language.
    const group = { id: -1009000000006, type: 'supergroup', title: 'Mon canal Chat' };
    const update = (id: number, message: Record<string, unknown>) =>
      telegramUpdate(request, {
        update_id: id,
        message: { message_id: id, date: NOW_S, chat: group, ...message },
      });
    await update(20, { from: { id: 4343, is_bot: false }, text: `/start@StayPutBot ${start}` });
    await settle();
    expect(telegram.sent.at(-1)).toEqual({
      chatId: '-1009000000006',
      text: expect.stringContaining('relié à StayPut') as string,
    });
    // A channel post, copied by Telegram into the group, is nobody's activity…
    await update(21, {
      from: { id: 777000, is_bot: false, first_name: 'Telegram' },
      sender_chat: { id: -1009000000099, type: 'channel', title: 'Mon canal' },
      is_automatic_forward: true,
      text: 'Nouvelle vidéo',
    });
    // …a member's comment under it is theirs.
    await update(22, {
      from: { id: 5555, is_bot: false },
      reply_to_message: { message_id: 21 },
      text: 'Top !',
    });
    const after = await integrations(request, 'biz_Int6', init);
    expect(after.telegram.unlinkedAuthors).toBe(1);
  });

  it('lets the creator tie an account to a member, StayPut asking Telegram its names', async () => {
    const { request } = modules({
      'user_ola:biz_Int9': 'admin',
      'user_eve:biz_Int9': 'customer',
    });
    const init = await asUser('user_ola');
    await request('/api/creator/biz_Int9/session', init);
    await settle();
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name)
       values ('mber_Int9A', 'biz_Int9', 'user_Int9A', 'Bruno Petit'),
              ('mber_Int9B', 'biz_Int9', 'user_Int9B', 'Bruno Lefèvre')`,
    );
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      'biz_Int9',
      '-1009000000009',
      'VIP',
      NOW.toISOString(),
    ]);
    // A message of before 0012, without the author's names.
    await t.db.query('select stayput.record_telegram_message($1, $2, $3, $4::timestamptz)', [
      '-1009000000009',
      '5550001',
      '1',
      NOW.toISOString(),
    ]);
    const accounts = async () =>
      (await (await request('/api/creator/biz_Int9/accounts', init)).json()) as AccountsView;
    // StayPut asked Telegram the names (getChatMember): Bruno, @bruno_p; two members may be him.
    expect(await accounts()).toEqual({
      unlinked: [
        {
          platform: 'telegram',
          accountId: '5550001',
          name: 'Bruno',
          username: 'bruno_p',
          messages: 1,
          lastAt: expect.any(String) as string,
          suggestions: [
            { memberId: 'mber_Int9B', name: 'Bruno Lefèvre', strong: false },
            { memberId: 'mber_Int9A', name: 'Bruno Petit', strong: false },
          ],
        },
      ],
      linked: [],
      dismissed: [],
    });

    const change = (what: string, body: unknown) =>
      request(`/api/creator/biz_Int9/accounts/${what}`, {
        ...init,
        method: 'POST',
        headers: { ...init.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const account = { platform: 'telegram', accountId: '5550001' };
    const linked = (await (
      await change('link', { ...account, memberId: 'mber_Int9A' })
    ).json()) as AccountsView;
    expect(linked).toEqual({
      unlinked: [],
      linked: [
        {
          ...account,
          name: 'Bruno',
          username: 'bruno_p',
          member: { id: 'mber_Int9A', name: 'Bruno Petit' },
          via: 'creator',
        },
      ],
      dismissed: [],
    });
    expect((await integrations(request, 'biz_Int9', init)).telegram).toMatchObject({
      linkedMembers: 1,
      unlinkedAuthors: 0,
    });
    const unlinked = async (what: string) =>
      ((await (await change(what, account)).json()) as AccountsView).unlinked.length;
    expect(await unlinked('unlink')).toBe(1);
    // The creator's own account: set aside as the team's.
    const team = (await (
      await change('dismiss', { ...account, as: 'team' })
    ).json()) as AccountsView;
    expect(team.unlinked).toEqual([]);
    expect(team.dismissed).toEqual([
      {
        ...account,
        name: 'Bruno',
        username: 'bruno_p',
        as: 'team',
        at: expect.any(String) as string,
      },
    ]);
    expect(await unlinked('restore')).toBe(1);
    expect(await unlinked('dismiss')).toBe(0);
    expect(await unlinked('restore')).toBe(1);

    expect((await change('link', { ...account, memberId: 'nope' })).status).toBe(400);
    expect((await change('link', { platform: 'irc', accountId: '1' })).status).toBe(400);
    expect(
      (await change('unlink', { platform: 'discord', accountId: '940000000000000009' })).status,
    ).toBe(404);
    expect((await request('/api/creator/biz_Int9/accounts', await asUser('user_eve'))).status).toBe(
      403,
    );

    // What StayPut saw: the group's message, the member's again.
    await change('link', { ...account, memberId: 'mber_Int9A' });
    const activity = (await (
      await request('/api/creator/biz_Int9/platform-activity', init)
    ).json()) as PlatformActivityView;
    expect(activity.platforms.find((p) => p.platform === 'telegram')).toMatchObject({
      messages: 1,
      authors: 1,
      members: 1,
    });
    expect(activity.places).toEqual([
      expect.objectContaining({ platform: 'telegram', name: 'VIP', messages: 1 }),
    ]);
    expect(activity.topMembers).toEqual([
      expect.objectContaining({ id: 'mber_Int9A', name: 'Bruno Petit', telegram: 1 }),
    ]);
    expect(
      (await request('/api/creator/biz_Int9/platform-activity', await asUser('user_eve'))).status,
    ).toBe(403);
    // Live, as the page asks every half minute: the same view.
    const live = await request('/api/creator/biz_Int9/platform-activity/refresh', {
      ...init,
      method: 'POST',
    });
    expect(((await live.json()) as PlatformActivityView).places).toEqual(activity.places);
  });

  it('lets a member link their Telegram account, once the community has a group', async () => {
    const { request, telegram } = modules(
      { 'user_mo:exp_Int5': 'customer', 'user_owner5:biz_Int5': 'admin' },
      { exp_Int5: 'biz_Int5' },
    );
    const owner = await asUser('user_owner5');
    await request('/api/creator/biz_Int5/session', owner);
    await settle();
    await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      'biz_Int5',
      'members',
      JSON.stringify(page([member('mber_Int5', 'user_mo')])),
    ]);
    const mo = await asUser('user_mo');
    const read = async (query = '') =>
      (await (
        await request(`/api/member/exp_Int5/telegram${query}`, mo)
      ).json()) as MemberTelegramStatus;
    expect(await read()).toMatchObject({ available: false, linked: false, link: null });

    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      'biz_Int5',
      '-1009000000005',
      'VIP',
      NOW.toISOString(),
    ]);
    const offer = await read('?lang=fr');
    expect(offer).toMatchObject({ available: true, linked: false, whopAppId: APP_ID });
    const token = new URL(offer.link!.url).searchParams.get('start')!;

    // The member opens the bot with it: Telegram says which account they are.
    await telegramUpdate(request, {
      update_id: 10,
      message: {
        message_id: 1,
        date: NOW_S,
        chat: { id: 5151, type: 'private' },
        from: { id: 5151, is_bot: false, language_code: 'en' },
        text: `/start ${token}`,
      },
    });
    await settle();
    // In the language of the member's StayPut, whatever Telegram says.
    expect(telegram.sent.at(-1)).toEqual({
      chatId: '5151',
      text: expect.stringContaining('vos messages dans les groupes Telegram') as string,
    });
    expect(await read()).toMatchObject({ linked: true });

    const unlinked = await request('/api/member/exp_Int5/telegram', { method: 'DELETE', ...mo });
    expect(await unlinked.json()).toEqual({ removed: true });
    expect(await read()).toMatchObject({ linked: false });
  });
});

describe('the Alumni offer (SPEC 5.9)', () => {
  const json = (init: RequestInit, method: string, body: unknown) => ({
    ...init,
    method,
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('creates it on Whop step by step, and finishes it once a refused permission is granted', async () => {
    const { request, whop } = setup({
      'user_owner71:biz_Alu1': 'admin',
      'user_eve:biz_Alu1': 'customer',
    });
    const owner = await asUser('user_owner71');
    await request('/api/creator/biz_Alu1/session', owner);
    await settle();
    const path = '/api/creator/biz_Alu1/alumni';
    expect(await (await request(path, owner)).json()).toEqual({
      offer: null,
      entered: 0,
      left: 0,
      returned: 0,
    });
    expect((await request(path, json(owner, 'POST', { name: ' ' }))).status).toBe(400);

    // The app may not create experiences yet: the first two steps hold, the answer says why.
    whop.refusals['POST /experiences'] = new WhopApiError(403, 'forbidden', 'missing permission', {
      method: 'POST',
      path: '/experiences',
    });
    const stopped = (await (
      await request(path, json(owner, 'POST', { name: 'Alumni du Club' }))
    ).json()) as AlumniView;
    expect(stopped).toMatchObject({
      offer: {
        name: 'Alumni du Club',
        url: 'https://sandbox.whop.com/checkout/plan_Alu1',
        completedAt: null,
      },
      problem: { step: 'experience', permission: 'experience:create' },
    });
    // Granted: trying again finishes the rest, without a second product or variant.
    const ready = (await (
      await request(path, json(owner, 'POST', { name: 'Alumni du Club' }))
    ).json()) as AlumniView;
    expect(ready).toMatchObject({
      offer: { completedAt: expect.any(String) as string },
      problem: null,
    });
    expect(whop.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /products',
      'POST /variants',
      'POST /experiences',
      'POST /experiences/exp_Alu1/attach',
    ]);
    expect(whop.writes[0]).toMatchObject({
      body: { account_id: 'biz_Alu1', title: 'Alumni du Club', visibility: 'hidden' },
      key: 'stayput-alumni-biz_Alu1-product',
    });
    expect(whop.writes[1]?.body).toMatchObject({
      product_id: 'prod_Alu1',
      plan_type: 'one_time',
      initial_price: 0,
      visibility: 'hidden',
    });
    expect(whop.writes[2]?.body).toEqual({
      account_id: 'biz_Alu1',
      app_id: APP_ID,
      name: 'Alumni du Club',
    });
    expect(whop.writes[3]?.body).toEqual({ product_id: 'prod_Alu1' });
    // Ready: nothing more to ask of Whop.
    await request(path, json(owner, 'POST', { name: 'Alumni du Club' }));
    expect(whop.writes).toHaveLength(4);
    // A member of the community sees nothing of it.
    expect((await request(path, await asUser('user_eve'))).status).toBe(403);
  });
});

describe('everyone on Discord and Telegram (the people)', () => {
  const MODULES: Env = {
    ...ENV,
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    TELEGRAM_BOT_TOKEN: '123456:telegram-token',
  };
  const GUILD = '910000000000000061';
  const CHAT = '-1009000000061';

  it('lists who is on the server and in the group, with how many people each has', async () => {
    const counted: string[] = [];
    const discord = {
      memberCount: (guildId: string) => {
        counted.push(guildId);
        return Promise.resolve(42);
      },
    } as unknown as DiscordClient;
    const telegram = {
      memberCount: (chatId: string) => {
        counted.push(chatId);
        return Promise.resolve(34);
      },
      administrators: () =>
        Promise.resolve([{ id: '5550009', name: 'Chef Telegram', username: 'chef_tg' }]),
    } as unknown as TelegramClient;
    const app = setup(
      { 'user_owner61:biz_Ppl1': 'admin', 'user_eve:biz_Ppl1': 'customer' },
      { discord, telegram },
    );
    const request = (path: string, init: RequestInit = {}) => app.request(path, init, MODULES);
    const owner = await asUser('user_owner61');
    await request('/api/creator/biz_Ppl1/session', owner);
    await settle();
    await t.db.query('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
      'biz_Ppl1',
      GUILD,
      'Le Club',
      'user_owner61',
      NOW.toISOString(),
    ]);
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      'biz_Ppl1',
      CHAT,
      'VIP',
      NOW.toISOString(),
    ]);
    // Nina joins the group: Telegram's service message is the only news of her.
    const joined = await request('/webhooks/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': await telegramWebhookSecret('123456:telegram-token'),
      },
      body: JSON.stringify({
        update_id: 61,
        message: {
          message_id: 7,
          date: Math.floor(NOW.getTime() / 1000),
          chat: { id: Number(CHAT), type: 'supergroup', title: 'VIP' },
          from: { id: 5552, is_bot: false, first_name: 'Nina' },
          new_chat_members: [{ id: 5552, is_bot: false, first_name: 'Nina' }],
        },
      }),
    });
    expect(joined.status).toBe(200);
    await settle();

    const read = async () =>
      (await (await request('/api/creator/biz_Ppl1/people', owner)).json()) as PeopleView;
    const people = await read();
    expect(people.places).toEqual([
      { platform: 'discord', id: GUILD, name: 'Le Club', total: 42, known: 0, list: 'pending' },
      { platform: 'telegram', id: CHAT, name: 'VIP', total: 34, known: 2, list: 'joins' },
    ]);
    expect(people.people.map((p) => [p.name, p.status, p.here])).toEqual([
      ['Nina', 'unlinked', true],
      ['Chef Telegram', 'unlinked', true],
    ]);
    // The head counts are read again after 10 minutes, not at each reading.
    expect(counted).toEqual([GUILD, CHAT]);
    await read();
    expect(counted).toEqual([GUILD, CHAT]);
    // A member of the community sees nothing of it.
    expect((await request('/api/creator/biz_Ppl1/people', await asUser('user_eve'))).status).toBe(
      403,
    );

    // A topic of the forum group is created, then written in: Integrations › Telegram names it
    // (fix prompt v4.1, block 7), never what was written.
    const update = async (updateId: number, message: Record<string, unknown>) =>
      request('/webhooks/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': await telegramWebhookSecret('123456:telegram-token'),
        },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            date: Math.floor(NOW.getTime() / 1000),
            chat: { id: Number(CHAT), type: 'supergroup', title: 'VIP', is_forum: true },
            from: { id: 5552, is_bot: false, first_name: 'Nina' },
            ...message,
          },
        }),
      });
    expect(
      (
        await update(62, {
          message_id: 8,
          message_thread_id: 8,
          forum_topic_created: { name: 'Signals', icon_color: 7322096 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await update(63, {
          message_id: 9,
          message_thread_id: 8,
          is_topic_message: true,
          text: 'never kept',
        })
      ).status,
    ).toBe(200);
    await settle();
    const telegramView = (await (
      await request('/api/creator/biz_Ppl1/platforms/telegram', owner)
    ).json()) as PlatformDashboard;
    expect(telegramView.places.map((p) => [p.kind, p.name, p.parent, p.messages])).toEqual([
      ['topic', 'Signals', 'VIP', 1],
      ['general', 'VIP', null, 0],
    ]);
  });

  it('never keeps the screen waiting on Telegram: what comes late shows at the next reading', async () => {
    // Telegram takes its time to count the group (brief v4 §9.6: an answer within 5 seconds).
    let count: (value: number) => void = () => {};
    const telegram = {
      memberCount: () =>
        new Promise<number>((resolve) => {
          count = resolve;
        }),
      administrators: () => Promise.resolve([]),
    } as unknown as TelegramClient;
    const app = setup({ 'user_owner62:biz_Ppl2': 'admin' }, { telegram, outsideWaitMs: 20 });
    const request = (path: string, init: RequestInit = {}) => app.request(path, init, MODULES);
    const owner = await asUser('user_owner62');
    await request('/api/creator/biz_Ppl2/session', owner);
    await settle();
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      'biz_Ppl2',
      '-1009000000062',
      'VIP',
      NOW.toISOString(),
    ]);
    const read = async () =>
      (await (await request('/api/creator/biz_Ppl2/people', owner)).json()) as PeopleView;
    // The answer does not wait for the count...
    expect((await read()).places).toEqual([
      expect.objectContaining({ platform: 'telegram', name: 'VIP', total: null }),
    ]);
    // ...which arrives after it, and shows at the next reading.
    count(34);
    await settle();
    expect((await read()).places).toEqual([
      expect.objectContaining({ platform: 'telegram', name: 'VIP', total: 34 }),
    ]);
  });
});

describe('detection settings and analyses (SPEC Phase 3)', () => {
  const settingsPath = '/api/creator/biz_Risk1/settings/risk';
  const put = (init: RequestInit, body: unknown) => ({
    ...init,
    method: 'PUT',
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('reads the settings, saves new ones brought back to a sum of 1, refuses nonsense', async () => {
    const { request } = setup({ 'user_rita:biz_Risk1': 'admin', 'user_sam:biz_Risk1': 'customer' });
    const init = await asUser('user_rita');
    await request('/api/creator/biz_Risk1/session', init);
    await settle();
    expect(await (await request(settingsPath, init)).json()).toEqual({
      niche: 'other',
      weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
      recencyThresholdDays: 14,
      mediumFrom: 40,
      highFrom: 70,
    });

    const saved = await request(
      settingsPath,
      put(init, {
        niche: 'fitness',
        weights: { recency: 1, frequency: 1, progress: 1, payment: 1, friction: 1 },
        recencyThresholdDays: 10,
        mediumFrom: 35,
        highFrom: 65,
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      niche: 'fitness',
      weights: { recency: 0.2, frequency: 0.2, progress: 0.2, payment: 0.2, friction: 0.2 },
      recencyThresholdDays: 10,
      mediumFrom: 35,
      highFrom: 65,
    });
    await settle();

    for (const body of [
      { niche: 'poker', recencyThresholdDays: 10, mediumFrom: 40, highFrom: 70 },
      { niche: 'fitness', recencyThresholdDays: 0, mediumFrom: 40, highFrom: 70 },
      { niche: 'fitness', recencyThresholdDays: 10, mediumFrom: 70, highFrom: 40 },
      {
        niche: 'fitness',
        weights: { recency: 'a' },
        recencyThresholdDays: 10,
        mediumFrom: 4,
        highFrom: 7,
      },
    ]) {
      expect((await request(settingsPath, put(init, body))).status, JSON.stringify(body)).toBe(400);
    }
    // Without weights, the niche's preset.
    const preset = await request(
      settingsPath,
      put(init, { niche: 'trading', recencyThresholdDays: 7, mediumFrom: 40, highFrom: 70 }),
    );
    expect(((await preset.json()) as { weights: unknown }).weights).toEqual({
      recency: 0.35,
      frequency: 0.3,
      progress: 0.1,
      payment: 0.15,
      friction: 0.1,
    });
    await settle();

    const customer = await asUser('user_sam');
    expect((await request(settingsPath, customer)).status).toBe(403);
    expect((await request('/api/creator/biz_Risk1/insights', customer)).status).toBe(403);
    expect((await request('/api/creator/biz_Risk1/insights/overview', customer)).status).toBe(403);
  });

  it('reads Analytics › Overview at once, StayPut’s figures for a new community', async () => {
    const { request } = setup({ 'user_rita:biz_Risk3': 'admin' });
    const init = await asUser('user_rita');
    await request('/api/creator/biz_Risk3/session', init);
    await settle();
    const response = await request('/api/creator/biz_Risk3/insights/overview', init);
    expect(response.status).toBe(200);
    const overview = (await response.json()) as InsightsOverview;
    expect(overview).toMatchObject({
      currency: null,
      revenue: { low: 0, medium: 0, high: 0, scheduled_departure: 0 },
      stay: { low: 0.95, medium: 0.8, high: 0.5, scheduled_departure: 0.5 },
      calibrated: [],
      saveRate: 0.3,
      saveRateObserved: false,
      reasons: [],
    });
    expect(overview.activity).toHaveLength(30);
  });

  it('reads the benchmarks and shares the community’s figures on demand', async () => {
    const { request } = setup({
      'user_rita:biz_Bench1': 'admin',
      'user_sam:biz_Bench1': 'customer',
    });
    const init = await asUser('user_rita');
    await request('/api/creator/biz_Bench1/session', init);
    await settle();
    const path = '/api/creator/biz_Bench1/benchmarks';
    const response = await request(path, init);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      optedIn: false,
      minimum: 5,
      horizons: [
        { days: 30, mine: null, niche: null },
        { days: 60, mine: null, niche: null },
        { days: 90, mine: null, niche: null },
      ],
      computedAt: null,
    });
    const on = await request(path, put(init, { optedIn: true }));
    expect(((await on.json()) as BenchmarksView).optedIn).toBe(true);
    expect((await request(path, put(init, { optedIn: 1 }))).status).toBe(400);
    await settle();
    const customer = await asUser('user_sam');
    expect((await request(path, customer)).status).toBe(403);
    expect((await request(path, put(customer, { optedIn: false }))).status).toBe(403);
  });

  it('reads the Monday reports and turns them off and on (Analytics › Reports)', async () => {
    const { request } = setup({ 'user_rita:biz_Week1': 'admin', 'user_sam:biz_Week1': 'customer' });
    const init = await asUser('user_rita');
    await request('/api/creator/biz_Week1/session', init);
    await settle();
    const path = '/api/creator/biz_Week1/reports';
    const response = await request(path, init);
    expect(response.status).toBe(200);
    const view = (await response.json()) as WeeklyReportsView;
    expect(view).toMatchObject({ enabled: true, reports: [] });
    expect(Date.parse(view.nextAt)).toBeGreaterThan(Date.now() - 60_000);
    const off = await request(path, put(init, { enabled: false }));
    expect(((await off.json()) as WeeklyReportsView).enabled).toBe(false);
    expect((await request(path, put(init, { enabled: 'no' }))).status).toBe(400);
    const on = await request(path, put(init, { enabled: true }));
    expect(((await on.json()) as WeeklyReportsView).enabled).toBe(true);
    await settle();
    const customer = await asUser('user_sam');
    expect((await request(path, customer)).status).toBe(403);
    expect((await request(path, put(customer, { enabled: false }))).status).toBe(403);
  });

  it('reads Integrations › Discord and › Telegram, and saves a platform’s signals', async () => {
    const { request } = setup({ 'user_rita:biz_Plat1': 'admin', 'user_sam:biz_Plat1': 'customer' });
    const init = await asUser('user_rita');
    await request('/api/creator/biz_Plat1/session', init);
    await settle();
    const path = '/api/creator/biz_Plat1/platforms';
    const response = await request(`${path}/discord`, init);
    expect(response.status).toBe(200);
    const view = (await response.json()) as PlatformDashboard;
    expect(view).toMatchObject({
      platform: 'discord',
      hero: { activeMembers7d: 0, silentMembers7d: 0, messages30d: 0, memberMessages30d: 0 },
      heatmap: [],
      places: [],
      active: { d7: [], d14: [], d30: [] },
      silent: { d7: { total: 0, members: [] } },
    });
    expect(view.daily).toHaveLength(30);
    // The signals: StayPut's defaults until the creator saves theirs.
    expect(view.signals.settings).toEqual({
      discord: DEFAULT_PLATFORM_SIGNALS,
      telegram: DEFAULT_PLATFORM_SIGNALS,
    });
    expect((await request(`${path}/irc`, init)).status).toBe(404);
    // A day of the chart, an hour of the heatmap.
    expect((await request(`${path}/telegram/days/2026-10-01`, init)).status).toBe(200);
    expect((await request(`${path}/telegram/days/2026-02-30`, init)).status).toBe(400);
    expect(await (await request(`${path}/discord/slots/7/21`, init)).json()).toEqual({
      dow: 7,
      hour: 21,
      messages: 0,
      others: 0,
      members: [],
    });
    for (const wrong of ['8/21', '0/21', '1/24', '1/x']) {
      expect((await request(`${path}/discord/slots/${wrong}`, init)).status, wrong).toBe(400);
    }
    const signals = { ...DEFAULT_PLATFORM_SIGNALS, silent: { on: true, points: 15 } };
    const saved = await request(`${path}/discord/signals`, put(init, signals));
    expect(await saved.json()).toEqual({
      settings: { discord: signals, telegram: DEFAULT_PLATFORM_SIGNALS },
    });
    await settle();
    for (const wrong of [{ ...signals, drop: { on: true, points: 50 } }, { silent: true }, null]) {
      expect(
        (await request(`${path}/discord/signals`, put(init, wrong))).status,
        JSON.stringify(wrong),
      ).toBe(400);
    }
    expect((await request(`${path}/irc/signals`, put(init, signals))).status).toBe(404);
    const customer = await asUser('user_sam');
    expect((await request(`${path}/discord`, customer)).status).toBe(403);
    expect((await request(`${path}/discord/signals`, put(customer, signals))).status).toBe(403);
  });

  it('reads the weekly analyses once they ran', async () => {
    const { request } = setup({ 'user_rita:biz_Risk2': 'admin' });
    const init = await asUser('user_rita');
    await request('/api/creator/biz_Risk2/session', init);
    await settle();
    await t.db.query(
      'select stayput.save_analyses($1, $2::text::jsonb, $3::text::jsonb, $4::timestamptz)',
      [
        'biz_Risk2',
        JSON.stringify([
          {
            month: '2026-06-01',
            members: 12,
            eligible: { 30: 12, 60: 12, 90: 12 },
            left: { 30: 6, 60: 6, 90: 6 },
            alertHorizon: 30,
          },
        ]),
        JSON.stringify([
          {
            lessonId: 'lesn_1',
            courseId: 'cors_1',
            title: 'Lesson 1',
            reached: 12,
            stalled: 6,
            rate: 0.5,
            courseAverage: 0.2,
            flagged: true,
          },
        ]),
        NOW.toISOString(),
      ],
    );
    const insights = (await (
      await request('/api/creator/biz_Risk2/insights', init)
    ).json()) as InsightsReport;
    expect(insights).toEqual({
      computedAt: NOW.toISOString(),
      averages: { 30: 0.5, 60: 0.5, 90: 0.5 },
      cohorts: [
        {
          month: '2026-06-01',
          members: 12,
          rates: { 30: 0.5, 60: 0.5, 90: 0.5 },
          alertHorizon: 30,
        },
      ],
      lessons: [
        {
          lessonId: 'lesn_1',
          courseId: 'cors_1',
          title: 'Lesson 1',
          reached: 12,
          stalled: 6,
          rate: 0.5,
          courseAverage: 0.2,
          flagged: true,
        },
      ],
    });
  });
});

describe('the actions (SPEC Phase 4)', () => {
  const json = (init: RequestInit, method: string, body: unknown) => ({
    ...init,
    method,
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const DEFAULTS = {
    mode: 'manual',
    rulesOff: [],
    locale: 'en',
    dryRun: false,
    killSwitch: false,
    timezone: 'UTC',
    quietHoursStart: 22,
    quietHoursEnd: 8,
    defaultSendHour: 19,
    maxMessagesPer5Days: 1,
    maxMessagesPerMonth: 4,
    maxPaymentRetries: 2,
    monthlyPromoCap: 10,
    maxFreeDaysPerQuarter: 14,
    templates: {},
    offers: {
      pauseDays: 30,
      promoPercent: 20,
      promoMonths: 3,
      extendDays: 7,
      coachingMessage: null,
    },
  };

  /** A company with one new member who has not started: StayPut proposes to welcome them. */
  async function withProposal(companyId: string, admin: string) {
    const env = setup({
      [`${admin}:${companyId}`]: 'admin',
      [`user_eve:${companyId}`]: 'customer',
    });
    const init = await asUser(admin);
    await env.request(`/api/creator/${companyId}/session`, init);
    await settle();
    const memberId = `mber_${companyId.slice(4)}A`;
    await t.db.query(`update stayput.companies set name = 'Le Club', locale = 'fr' where id = $1`, [
      companyId,
    ]);
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at)
       values ($1, $2, 'user_newcomer1', 'Ana Lopez', $3::timestamptz - interval '4 days')`,
      [memberId, companyId, NOW.toISOString()],
    );
    await t.db.query(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                        level_since, computed_at, inactive_newcomer)
       values ($1, $2, 20, 'low', '{}', $3::timestamptz, $3::timestamptz, true)`,
      [companyId, memberId, NOW.toISOString()],
    );
    await prepareActions(t.db, companyId, NOW);
    return { ...env, init, memberId };
  }

  it('lists what waits for approval with each message as it will read, to the creator only', async () => {
    const { request, init, memberId } = await withProposal('biz_ActQ1', 'user_ava');
    const page = (await (
      await request('/api/creator/biz_ActQ1/actions?view=queue', init)
    ).json()) as ActionsPage;
    expect(page).toMatchObject({
      view: 'queue',
      counts: { queue: 1, scheduled: 0, history: 0 },
      mode: 'manual',
      dryRun: false,
      killSwitch: false,
    });
    expect(page.actions).toEqual([
      expect.objectContaining({
        type: 'welcome_message',
        status: 'proposed',
        trigger: 'activation_radar',
        member: { id: memberId, name: 'Ana Lopez' },
        message: {
          title: 'Bienvenue, Ana',
          body: 'Content de t’avoir dans Le Club. Le meilleur premier pas : présente-toi à la communauté, puis lance la première leçon.',
        },
      }),
    ]);
    expect((await request('/api/creator/biz_ActQ1/actions?view=nope', init)).status).toBe(400);
    // A member of the community sees nothing of it.
    const eve = await asUser('user_eve');
    expect((await request('/api/creator/biz_ActQ1/actions', eve)).status).toBe(403);
  });

  it('runs what the creator approves, in test mode a simulation, and cancels what they drop', async () => {
    const { request, init } = await withProposal('biz_ActQ2', 'user_bob');
    // NOW is the real time: quiet hours away from it, or the message would wait for the morning
    // whenever the tests run at night.
    const hour = NOW.getUTCHours();
    await request(
      '/api/creator/biz_ActQ2/settings/actions',
      json(init, 'PUT', {
        ...DEFAULTS,
        locale: 'fr',
        dryRun: true,
        quietHoursStart: (hour + 2) % 24,
        quietHoursEnd: (hour + 3) % 24,
      }),
    );
    await settle();
    const [proposal] = (
      (await (await request('/api/creator/biz_ActQ2/actions', init)).json()) as ActionsPage
    ).actions;
    const approved = await request(
      '/api/creator/biz_ActQ2/actions/approve',
      json(init, 'POST', { ids: [proposal!.id] }),
    );
    expect(await approved.json()).toEqual({ approved: 1 });
    await settle();
    const history = (await (
      await request('/api/creator/biz_ActQ2/actions?view=history', init)
    ).json()) as ActionsPage;
    expect(history.counts).toEqual({ queue: 0, scheduled: 0, history: 1 });
    expect(history.actions[0]).toMatchObject({
      status: 'simulated',
      message: { title: 'Bienvenue, Ana' },
    });

    expect(
      (await request('/api/creator/biz_ActQ2/actions/approve', json(init, 'POST', { ids: ['x'] })))
        .status,
    ).toBe(400);
    const cancel = (id: string) =>
      request(`/api/creator/biz_ActQ2/actions/${id}/cancel`, { ...init, method: 'POST' });
    // Already run: nothing to cancel.
    expect((await cancel(proposal!.id)).status).toBe(404);
    expect((await cancel('not-an-id')).status).toBe(404);
  });

  it('cancels an action that has not run, and keeps a member off every action', async () => {
    const { request, init, memberId } = await withProposal('biz_ActQ3', 'user_cid');
    const [proposal] = (
      (await (await request('/api/creator/biz_ActQ3/actions', init)).json()) as ActionsPage
    ).actions;
    const cancelled = await request(`/api/creator/biz_ActQ3/actions/${proposal!.id}/cancel`, {
      ...init,
      method: 'POST',
    });
    expect(await cancelled.json()).toEqual({ cancelled: true });
    const history = (await (
      await request('/api/creator/biz_ActQ3/actions?view=history', init)
    ).json()) as ActionsPage;
    expect(history.actions[0]).toMatchObject({ status: 'cancelled', note: 'cancelled_by_creator' });

    const contact = (id: string, body: unknown) =>
      request(`/api/creator/biz_ActQ3/members/${id}/contact`, json(init, 'PUT', body));
    expect(await (await contact(memberId, { doNotContact: true })).json()).toEqual({
      doNotContact: true,
    });
    const members = (await (
      await request('/api/creator/biz_ActQ3/members', init)
    ).json()) as MembersPage;
    expect(members.members.find((m) => m.id === memberId)).toMatchObject({ doNotContact: true });
    expect((await contact('mber_Elsewhere1', { doNotContact: true })).status).toBe(404);
    expect((await contact(memberId, { doNotContact: 'yes' })).status).toBe(400);
  });

  it('reads and saves the settings, stricter than the SPEC never looser', async () => {
    const { request, init } = await withProposal('biz_ActQ4', 'user_dan');
    const path = '/api/creator/biz_ActQ4/settings/actions';
    expect(await (await request(path, init)).json()).toEqual({ ...DEFAULTS, locale: 'fr' });
    const welcome = { title: 'Bienvenue {first_name}', body: 'On est ravis[[, {first_name}]].' };
    const offers = {
      pauseDays: 45,
      promoPercent: 30,
      promoMonths: 2,
      extendDays: 5,
      coachingMessage: '  Écris-moi où tu bloques, je te réponds en personne.  ',
    };
    const saved = await request(
      path,
      json(init, 'PUT', {
        ...DEFAULTS,
        mode: 'auto',
        maxMessagesPerMonth: 2,
        templates: { fr: { welcome_message: welcome, exit_survey: { title: ' ', body: '' } } },
        offers,
      }),
    );
    expect(await saved.json()).toEqual({
      ...DEFAULTS,
      mode: 'auto',
      maxMessagesPerMonth: 2,
      templates: { fr: { welcome_message: welcome } },
      offers: { ...offers, coachingMessage: 'Écris-moi où tu bloques, je te réponds en personne.' },
    });
    // Sent without the offers (a page from before them), the offers stay; an empty message is
    // StayPut's own.
    const { offers: _kept, ...withoutOffers } = DEFAULTS;
    expect(await (await request(path, json(init, 'PUT', withoutOffers))).json()).toMatchObject({
      offers: { pauseDays: 45 },
    });
    expect(
      await (
        await request(
          path,
          json(init, 'PUT', { ...DEFAULTS, offers: { ...offers, coachingMessage: ' ' } }),
        )
      ).json(),
    ).toMatchObject({ offers: { pauseDays: 45, coachingMessage: null } });
    for (const wrong of [
      { ...DEFAULTS, maxMessagesPerMonth: 5 },
      { ...DEFAULTS, maxFreeDaysPerQuarter: 30 },
      { ...DEFAULTS, quietHoursStart: 24 },
      { ...DEFAULTS, mode: 'yolo' },
      {
        ...DEFAULTS,
        templates: { fr: { welcome_message: { title: 'Hi {firstname}', body: '' } } },
      },
      { ...DEFAULTS, templates: { fr: { welcome_message: { title: 'x'.repeat(81), body: '' } } } },
      { ...DEFAULTS, timezone: 'Mars/Olympus' },
      { ...DEFAULTS, offers: { ...DEFAULTS.offers, pauseDays: 120 } },
      { ...DEFAULTS, offers: { ...DEFAULTS.offers, promoPercent: 80 } },
      { ...DEFAULTS, offers: { ...DEFAULTS.offers, extendDays: 0 } },
      { ...DEFAULTS, offers: { ...DEFAULTS.offers, promoMonths: 1.5 } },
      { ...DEFAULTS, offers: { ...DEFAULTS.offers, coachingMessage: 'x'.repeat(401) } },
      { ...DEFAULTS, offers: { ...DEFAULTS.offers, coachingMessage: 42 } },
      { ...DEFAULTS, offers: 'generous' },
    ]) {
      expect((await request(path, json(init, 'PUT', wrong))).status, JSON.stringify(wrong)).toBe(
        400,
      );
    }
  });

  it('turns a rule off and on, for the team only (fix prompt v4.1, block 7)', async () => {
    const { request, init } = await withProposal('biz_ActQ8', 'user_hal');
    const rule = async (id: string, body: unknown, as = init) =>
      request(`/api/creator/biz_ActQ8/rules/${id}`, json(as, 'PUT', body));
    expect(await (await rule('check_in', { on: false })).json()).toMatchObject({
      rulesOff: ['check_in'],
    });
    expect(await (await rule('welcome', { on: false })).json()).toMatchObject({
      rulesOff: ['check_in', 'welcome'],
    });
    expect(await (await rule('check_in', { on: true })).json()).toMatchObject({
      rulesOff: ['welcome'],
    });
    // The settings say it, and saving them leaves the rules as they are.
    const path = '/api/creator/biz_ActQ8/settings/actions';
    expect(await (await request(path, init)).json()).toMatchObject({ rulesOff: ['welcome'] });
    expect(
      await (await request(path, json(init, 'PUT', { ...DEFAULTS, rulesOff: [] }))).json(),
    ).toMatchObject({ rulesOff: ['welcome'] });
    expect((await rule('everything', { on: false })).status).toBe(400);
    expect((await rule('welcome', { on: 'yes' })).status).toBe(400);
    // A member of the community is not the team.
    expect((await rule('welcome', { on: true }, await asUser('user_eve'))).status).toBe(403);
  });

  it('ticks « Set guardrails » and « Review your at-risk members » once, for the team only', async () => {
    const { request, init } = await withProposal('biz_ActQ7', 'user_gus');
    const ticks = async () =>
      (
        await t.db.query<{ guardrails: string | null; reviewed: string | null }>(
          `select guardrails_saved_at::text as guardrails, at_risk_reviewed_at::text as reviewed
             from stayput.company_settings where company_id = $1`,
          ['biz_ActQ7'],
        )
      )[0];
    expect(await ticks()).toEqual({ guardrails: null, reviewed: null });

    // A refused save ticks nothing; a saved one does.
    const path = '/api/creator/biz_ActQ7/settings/actions';
    expect((await request(path, json(init, 'PUT', { ...DEFAULTS, mode: 'yolo' }))).status).toBe(
      400,
    );
    expect((await ticks())?.guardrails).toBeNull();
    expect((await request(path, json(init, 'PUT', DEFAULTS))).status).toBe(200);
    const first = await ticks();
    expect(first?.guardrails).not.toBeNull();

    const reviewed = '/api/creator/biz_ActQ7/getting-started/reviewed';
    expect((await request(reviewed, { ...init, method: 'POST' })).status).toBe(200);
    expect(await (await request(reviewed, { ...init, method: 'POST' })).json()).toEqual({
      done: true,
    });
    // The first time is kept.
    const second = await ticks();
    expect(second?.reviewed).not.toBeNull();
    expect((await request(path, json(init, 'PUT', DEFAULTS))).status).toBe(200);
    expect(await ticks()).toEqual(second);
    expect(second?.guardrails).toBe(first?.guardrails);

    // A member of the community is not the team.
    const eve = await asUser('user_eve');
    expect((await request(reviewed, { ...eve, method: 'POST' })).status).toBe(403);
  });

  it('takes the zone from the creator’s browser once, then only from the settings', async () => {
    const { request, init } = await withProposal('biz_ActQ5', 'user_eli');
    const detected = (timezone: unknown, as = init) =>
      request('/api/creator/biz_ActQ5/timezone', json(as, 'POST', { timezone }));
    expect(await (await detected('Europe/Paris')).json()).toEqual({ timezone: 'Europe/Paris' });
    // Another browser, elsewhere: the first one's zone stays.
    expect(await (await detected('Asia/Tokyo')).json()).toEqual({ timezone: 'Europe/Paris' });
    expect((await detected('Mars/Olympus')).status).toBe(400);
    expect((await detected(42)).status).toBe(400);
    expect((await detected('Asia/Tokyo', await asUser('user_eve'))).status).toBe(403);

    const path = '/api/creator/biz_ActQ5/settings/actions';
    expect(await (await request(path, init)).json()).toMatchObject({ timezone: 'Europe/Paris' });
    // Saved without a zone (the creator did not touch it), the zone stays; with one, it changes.
    const { timezone: _unchanged, ...withoutZone } = DEFAULTS;
    expect(await (await request(path, json(init, 'PUT', withoutZone))).json()).toMatchObject({
      timezone: 'Europe/Paris',
    });
    const moved = await request(
      path,
      json(init, 'PUT', { ...DEFAULTS, timezone: 'America/Montreal' }),
    );
    expect(await moved.json()).toMatchObject({ timezone: 'America/Montreal' });
  });
});

describe("the member's departure survey and payments (SPEC Phase 4)", () => {
  const json = (init: RequestInit, method: string, body: unknown) => ({
    ...init,
    method,
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** A community whose member Ana scheduled her cancellation; `boss` is of the team. */
  async function departing(n: number, over: { mode?: 'auto' | 'manual'; dryRun?: boolean } = {}) {
    const [company, experience] = [`biz_Ret${n}`, `exp_Ret${n}`];
    const env = setup(
      {
        [`user_ana${n}:${experience}`]: 'customer',
        [`user_boss${n}:${experience}`]: 'admin',
        [`user_boss${n}:${company}`]: 'admin',
      },
      { experiences: { [experience]: company } },
    );
    await env.request(`/api/creator/${company}/session`, await asUser(`user_boss${n}`));
    await settle();
    await t.db.query(`update stayput.companies set name = 'Le Club', mode = $2 where id = $1`, [
      company,
      over.mode ?? 'auto',
    ]);
    await t.db.query(`update stayput.company_settings set dry_run = $2 where company_id = $1`, [
      company,
      over.dryRun ?? false,
    ]);
    await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      company,
      'members',
      JSON.stringify(page([member(`mber_Ret${n}`, `user_ana${n}`)])),
    ]);
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status,
                                        cancel_at_period_end, current_period_end, canceled_at)
       values ($1, $2, $3, $4, 'prod_Ret1', 'plan_Ret1', 49, 'eur', 30, 'active', true,
               $5::timestamptz + interval '10 days', $5::timestamptz - interval '1 day')`,
      [`mem_Ret${n}`, company, `mber_Ret${n}`, `user_ana${n}`, NOW.toISOString()],
    );
    const ana = await asUser(`user_ana${n}`);
    const base = `/api/member/${experience}/retention`;
    const read = async (as = ana) =>
      (await (await env.request(base, as)).json()) as MemberRetentionView;
    const answer = (reason: unknown) =>
      env.request(`${base}/survey`, json(ana, 'POST', { reason }));
    const decide = (body: unknown) => env.request(`${base}/offer`, json(ana, 'POST', body));
    return { ...env, company, ana, read, answer, decide, boss: () => asUser(`user_boss${n}`) };
  }

  it('lets the creator offer a pause from the dashboard, which the member accepts in their space', async () => {
    const env = await departing(9);
    const boss = await env.boss();
    const offerOf = (body: unknown) =>
      env.request(`/api/creator/${env.company}/members/mber_Ret9/offer`, json(boss, 'POST', body));
    expect((await offerOf({ kind: 'free_lunch' })).status).toBe(400);
    const made = await offerOf({ kind: 'pause_offer' });
    expect(made.status).toBe(200);
    const offer = (await made.json()) as { offerId: string; kind: string; terms: unknown };
    expect(offer).toMatchObject({ kind: 'pause_offer', terms: { days: 30 } });
    // One open offer at a time.
    expect((await offerOf({ kind: 'promo_offer' })).status).toBe(409);
    // Ana, a member, makes no offers.
    const asAna = await env.request(
      `/api/creator/${env.company}/members/mber_Ret9/offer`,
      json(env.ana, 'POST', { kind: 'pause_offer' }),
    );
    expect(asAna.status).toBe(403);

    expect((await env.read()).creatorOffer).toMatchObject({
      id: offer.offerId,
      kind: 'pause_offer',
      terms: { days: 30 },
      outcome: 'open',
      result: null,
    });
    const decideCreator = (body: unknown) =>
      env.request(`/api/member/exp_Ret9/retention/creator-offer`, json(env.ana, 'POST', body));
    expect((await decideCreator({ offerId: offer.offerId })).status).toBe(400);
    const accepted = (await (
      await decideCreator({ offerId: offer.offerId, accept: true })
    ).json()) as MemberRetentionView;
    // Applied at once: the cancellation withdrawn, then the pause.
    expect(accepted.creatorOffer).toMatchObject({
      outcome: 'accepted',
      result: { status: 'applied', kept: true },
    });
    expect((await decideCreator({ offerId: offer.offerId, accept: false })).status).toBe(404);
  });

  it('sends the creator’s word from the dashboard, and shows the home’s figures', async () => {
    const env = await departing(10);
    const boss = await env.boss();
    const send = (body: unknown) =>
      env.request(`/api/creator/${env.company}/members/message`, json(boss, 'POST', body));
    expect((await send({ memberIds: [] })).status).toBe(400);
    expect((await send({ memberIds: ['not-a-member'] })).status).toBe(400);
    expect(await (await send({ memberIds: ['mber_Ret10'] })).json()).toEqual({ queued: 1 });
    await settle();
    const home = (await (
      await env.request(`/api/creator/${env.company}/dashboard`, boss)
    ).json()) as DashboardView;
    expect(home).toMatchObject({
      currency: 'EUR',
      monthlyRevenue: 49,
      members: { total: 1 },
      mode: 'auto',
      testMode: false,
    });
    const feed = (await (
      await env.request(`/api/creator/${env.company}/feed`, boss)
    ).json()) as FeedView;
    expect(feed.items.some((i) => i.event === 'cancellation_scheduled')).toBe(true);
    expect((await env.request(`/api/creator/${env.company}/dashboard`, env.ana)).status).toBe(403);
  });

  it('offers a pause to the members leaving, and retries the failed payments now', async () => {
    const env = await departing(11);
    const boss = await env.boss();
    const home = async () =>
      (
        (await (
          await env.request(`/api/creator/${env.company}/dashboard`, boss)
        ).json()) as DashboardView
      ).priority;
    const offers = (body: unknown) =>
      env.request(`/api/creator/${env.company}/members/offers`, json(boss, 'POST', body));
    expect((await offers({ memberIds: ['mber_Ret11'] })).status).toBe(400);
    expect((await offers({ memberIds: [], kind: 'pause_offer' })).status).toBe(400);
    // Ana leaves at the end of her period: a pause is the day's action.
    expect(await home()).toEqual({ kind: 'pause', memberIds: ['mber_Ret11'], revenue: 49 });
    expect(
      await (await offers({ memberIds: ['mber_Ret11', 'mber_Ret11'], kind: 'pause_offer' })).json(),
    ).toEqual({ made: 1, refused: 0 });
    // Offered already: refused, never an error.
    expect(await (await offers({ memberIds: ['mber_Ret11'], kind: 'pause_offer' })).json()).toEqual(
      { made: 0, refused: 1 },
    );
    await settle();
    // Nothing more to offer, she still leaves: hers to look at, never « nothing urgent ».
    expect(await home()).toEqual({ kind: 'review', filter: 'cancelling', members: 1, revenue: 49 });

    // Her payment failed two hours ago: retried now, approved by the click.
    await t.db.query(
      `insert into stayput.payments (id, company_id, member_id, amount, currency, status,
                                     retryable, whop_created_at)
       values ('pay_Ret11', $1, 'mber_Ret11', 49, 'eur', 'failed', true,
               $2::timestamptz - interval '2 hours')`,
      [env.company, NOW.toISOString()],
    );
    expect(await home()).toEqual({ kind: 'retry', payments: 1, revenue: 49 });
    const retry = (as: RequestInit) =>
      env.request(`/api/creator/${env.company}/payments/retry`, json(as, 'POST', {}));
    expect((await retry(env.ana)).status).toBe(403);
    expect(await (await retry(boss)).json()).toEqual({ queued: 1 });
    await settle();
    const [action] = await t.db.query<{ approved_by: string; trigger: string }>(
      `select approved_by, trigger from stayput.actions
        where company_id = $1 and type = 'payment_retry' and subject_id = 'pay_Ret11'`,
      [env.company],
    );
    expect(action).toEqual({ approved_by: 'user_boss11', trigger: 'creator' });
  });

  it('turns the test mode off from its banner, nothing else changed', async () => {
    const env = await departing(12, { dryRun: true, mode: 'manual' });
    const boss = await env.boss();
    const off = (as: RequestInit) =>
      env.request(`/api/creator/${env.company}/test-mode/off`, json(as, 'POST', {}));
    expect((await off(env.ana)).status).toBe(403);
    expect(await (await off(boss)).json()).toMatchObject({ dryRun: false, mode: 'manual' });
    const [row] = await t.db.query<{ dry_run: boolean; guardrails: string | null }>(
      `select dry_run, guardrails_saved_at as guardrails from stayput.company_settings
        where company_id = $1`,
      [env.company],
    );
    // The limits were not looked at: « Getting started » still asks for them.
    expect(row).toEqual({ dry_run: false, guardrails: null });
  });

  it('opens a member’s drawer for the team only: their membership and their payments', async () => {
    const env = await departing(14);
    const boss = await env.boss();
    const read = (memberId: string, as: RequestInit = boss) =>
      env.request(`/api/creator/${env.company}/members/${memberId}`, as);
    const detail = (await (await read('mber_Ret14')).json()) as MemberDetail;
    expect(detail).toMatchObject({ memberId: 'mber_Ret14', scores: [], payments: [] });
    expect(detail.memberships).toEqual([
      expect.objectContaining({ id: 'mem_Ret14', price: 49, cancelAtPeriodEnd: true }),
    ]);
    // Whop only: the community connected neither Discord nor Telegram.
    expect(detail.platforms.map((p) => p.platform)).toEqual(['whop']);
    expect((await read('mber_Ret14', env.ana)).status).toBe(403);
    expect((await read('mber_Nobody')).status).toBe(404);
    expect((await read('not-a-member')).status).toBe(400);
  });

  it('keeps the welcome seen once, and changes only the mode from it, for the team only', async () => {
    const env = await departing(13, { dryRun: true, mode: 'manual' });
    const boss = await env.boss();
    const post = (path: string, as: RequestInit, body: unknown = {}) =>
      env.request(`/api/creator/${env.company}/${path}`, json(as, 'POST', body));
    const welcomed = async () =>
      (
        await t.db.query<{ at: string | null }>(
          `select welcomed_at::text as at from stayput.company_settings where company_id = $1`,
          [env.company],
        )
      )[0]?.at ?? null;
    // A member of the community is not the team.
    expect((await post('getting-started/welcomed', env.ana)).status).toBe(403);
    expect((await post('mode', env.ana, { mode: 'auto' })).status).toBe(403);
    expect(await welcomed()).toBeNull();

    expect(await (await post('getting-started/welcomed', boss)).json()).toEqual({ done: true });
    const first = await welcomed();
    expect(first).not.toBeNull();
    // The first time is kept.
    expect((await post('getting-started/welcomed', boss)).status).toBe(200);
    expect(await welcomed()).toBe(first);

    expect((await post('mode', boss, { mode: 'yolo' })).status).toBe(400);
    expect((await post('mode', boss, null)).status).toBe(400);
    expect(await (await post('mode', boss, { mode: 'auto' })).json()).toMatchObject({
      mode: 'auto',
      dryRun: true,
    });
    await settle();
    const [row] = await t.db.query<{ mode: string; dry_run: boolean; guardrails: string | null }>(
      `select c.mode, s.dry_run, s.guardrails_saved_at as guardrails
         from stayput.companies c join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [env.company],
    );
    // The mode only: the test mode stays on, and the limits were not looked at.
    expect(row).toEqual({ mode: 'auto', dry_run: true, guardrails: null });
    expect(await (await post('mode', boss, { mode: 'manual' })).json()).toMatchObject({
      mode: 'manual',
    });
  });

  it('asks why, makes the offer for the reason, and keeps the membership only with consent', async () => {
    const { read, answer, decide, whop, company, request, boss } = await departing(1);
    expect(await read()).toMatchObject({
      preview: null,
      creatorName: 'Le Club',
      whopAppId: APP_ID,
      payment: null,
      departure: { reason: null, offer: null, outcome: 'pending', result: null },
    });

    // Too expensive: a discount on the membership, which then has to continue. Then the member
    // changes their mind: no time, a pause.
    const expensive = (await (await answer('too_expensive')).json()) as MemberRetentionView;
    expect(expensive.departure?.offer).toEqual({
      type: 'promo_offer',
      percentOff: 20,
      months: 3,
      keep: 'required',
    });
    const busy = (await (await answer('no_time')).json()) as MemberRetentionView;
    expect(busy.departure?.offer).toEqual({ type: 'pause_offer', days: 30, keep: 'required' });
    expect((await answer('bored')).status).toBe(400);

    // A pause needs the member's consent to keep their membership.
    expect((await decide({ accept: true })).status).toBe(400);
    const accepted = (await (
      await decide({ accept: true, keep: true })
    ).json()) as MemberRetentionView;
    expect(accepted.departure).toMatchObject({
      outcome: 'accepted',
      result: { status: 'applied', resumesAt: expect.any(String) as string },
    });
    // Automatic mode: through the guardrails, then Whop at once.
    expect(whop.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'PATCH /memberships/mem_Ret1',
      'POST /memberships/mem_Ret1/pause',
    ]);
    expect(whop.writes[0]?.body).toEqual({ cancel_at_period_end: false });
    expect((await decide({ accept: true, keep: true })).status).toBe(404);
    // The offer ran; the notification asking for the survey, answered, no longer goes.
    expect(
      await t.db.query(
        `select type, status, trigger from stayput.actions where company_id = $1 order by type`,
        [company],
      ),
    ).toEqual([
      { type: 'exit_survey', status: 'cancelled', trigger: 'cancel_at_period_end' },
      { type: 'pause_offer', status: 'sent', trigger: 'exit_survey' },
    ]);
    // The creator finds it in the history: why, what, and the member's consent.
    const history = (await (
      await request(`/api/creator/${company}/actions?view=history`, await boss())
    ).json()) as ActionsPage;
    const pause = history.actions.find((a) => a.type === 'pause_offer');
    expect(pause).toMatchObject({
      status: 'sent',
      message: null,
      offer: { reason: 'no_time', days: 30, keep: true, resumesAt: expect.any(String) as string },
    });
    // What came of it (fix prompt v4.1, block 4): paused, until the day the pause ends…
    expect(pause?.outcome).toEqual({ kind: 'paused', until: pause?.offer?.resumesAt });
    // …which the member's row says too: « Paused · resumes Nov 2 » on Members and in the drawer.
    const members = (await (
      await request(`/api/creator/${company}/members`, await boss())
    ).json()) as MembersPage;
    expect(members.members.find((m) => m.id === 'mber_Ret1')?.membership?.pausedUntil).toBe(
      pause?.offer?.resumesAt,
    );
  });

  it('waits for the creator in manual mode, and the team sees a preview', async () => {
    const { read, answer, decide, boss, company } = await departing(2, { mode: 'manual' });
    await answer('other');
    const waiting = (await (await decide({ accept: true })).json()) as MemberRetentionView;
    // Free days: the cancellation stands, nothing asked; the creator approves the action first.
    expect(waiting.departure).toMatchObject({
      offer: { type: 'extend_offer', days: 7, keep: 'optional' },
      outcome: 'accepted',
      result: { status: 'waiting' },
    });
    const [action] = await t.db.query<{ status: string; content: Record<string, unknown> }>(
      `select status, content from stayput.actions where company_id = $1 and type = 'extend_offer'`,
      [company],
    );
    expect(action).toMatchObject({ status: 'proposed', content: { days: 7, keep: false } });

    // The team previews it, with the creator's offers; nothing of theirs is recorded.
    const preview = await read(await boss());
    expect(preview).toEqual({
      creatorName: 'Le Club',
      whopAppId: APP_ID,
      alumniUrl: null,
      preview: {
        offers: {
          pauseDays: 30,
          promoPercent: 20,
          promoMonths: 3,
          extendDays: 7,
          coachingMessage: null,
        },
        testMode: false,
      },
      payment: null,
      departure: null,
      alumni: null,
      creatorOffer: null,
      locale: 'en',
    });
    // The member reads the survey in the language of the community's messages, never their
    // browser's.
    await t.db.query(`update stayput.companies set locale = 'fr' where id = $1`, [company]);
    expect((await read()).locale).toBe('fr');
  });

  it('shows the payment to settle, and no survey in test mode or for « never contact »', async () => {
    const { read, answer, company } = await departing(3, { dryRun: true });
    await t.db.query(
      `insert into stayput.payments (id, company_id, member_id, amount, currency, status,
                                     whop_created_at, whop_membership_id)
       values ('pay_Ret3', $1, 'mber_Ret3', 49, 'eur', 'failed', $2::timestamptz, 'mem_Ret3')`,
      [company, NOW.toISOString()],
    );
    // Test mode: nothing reaches members, the survey neither; the payment is theirs to see.
    expect(await read()).toMatchObject({
      payment: {
        kind: 'failed',
        amount: 49,
        currency: 'eur',
        url: 'https://whop.com/manage/mem_Ret3',
      },
      departure: null,
    });
    expect((await answer('no_time')).status).toBe(404);

    // Out of test mode, the survey opens; its answer still carries the page to pay from.
    await t.db.query(`update stayput.company_settings set dry_run = false where company_id = $1`, [
      company,
    ]);
    const answered = (await (await answer('no_time')).json()) as MemberRetentionView;
    expect(answered).toMatchObject({
      payment: { kind: 'failed', url: 'https://whop.com/manage/mem_Ret3' },
      departure: { reason: 'no_time', offer: { type: 'pause_offer' } },
    });

    // A 3D Secure check: the link Whop gave.
    await t.db.query(
      `update stayput.payments set status = 'requires_action',
                                   recovery_url = 'https://whop.com/checkout/3ds'
        where id = 'pay_Ret3'`,
    );
    expect(await read()).toMatchObject({
      payment: { kind: 'action_required', url: 'https://whop.com/checkout/3ds' },
      departure: { outcome: 'pending' },
    });
    await t.db.query(`update stayput.members set do_not_contact = true where id = 'mber_Ret3'`);
    expect((await read()).departure).toBeNull();
  });
});

describe('the member space (SPEC Phase 5)', () => {
  const json = (init: RequestInit, method: string, body: unknown) => ({
    ...init,
    method,
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** A fitness community with its member Lina; `boss` is of the team. */
  async function community(n: number, lists: Record<string, string> = {}) {
    const [company, experience] = [`biz_Spc${n}`, `exp_Spc${n}`];
    const env = setup(
      {
        [`user_lina${n}:${experience}`]: 'customer',
        [`user_boss${n}:${experience}`]: 'admin',
        [`user_boss${n}:${company}`]: 'admin',
      },
      { experiences: { [experience]: company }, lists },
    );
    await env.request(`/api/creator/${company}/session`, await asUser(`user_boss${n}`));
    await settle();
    await t.db.query(`update stayput.companies set niche = 'fitness' where id = $1`, [company]);
    await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      company,
      'members',
      JSON.stringify(page([member(`mber_Spc${n}`, `user_lina${n}`)])),
    ]);
    const lina = await asUser(`user_lina${n}`);
    const boss = await asUser(`user_boss${n}`);
    const base = `/api/member/${experience}/space`;
    return { ...env, company, experience, lina, boss, base };
  }

  const opensOf = async (company: string) =>
    (
      await t.db.query<{ n: number }>(
        `select count(*)::int as n from stayput.activity_events
          where company_id = $1 and type = 'stayput_open'`,
        [company],
      )
    )[0]?.n;

  it('records the member’s opening, their goal and their results', async () => {
    const { request, company, lina, base } = await community(1);
    const first = (await (await request(`${base}?lang=fr`, lina)).json()) as MemberSpaceView;
    expect(first).toMatchObject({ preview: false, known: true, goal: null, fresh: [] });
    expect(first.proposals[0]).toEqual({
      title: 'Atteindre mon poids cible',
      unit: 'kg',
      category: 'body',
      entry: 'total',
    });
    expect(await opensOf(company)).toBe(1);

    const goal = {
      title: 'Atteindre mon poids cible',
      unit: 'kg',
      category: 'body',
      entry: 'total',
      start: 92,
      target: 85,
      targetDate: new Date(NOW.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    expect(
      (await request(`${base}/goal`, json(lina, 'POST', { ...goal, target: 92 }))).status,
    ).toBe(400);
    const set = (await (
      await request(`${base}/goal?lang=fr`, json(lina, 'POST', goal))
    ).json()) as MemberSpaceView;
    expect(set.goal).toMatchObject({ title: goal.title, start: 92, target: 85, progress: 0 });

    const goalId = set.goal!.id;
    const recorded = (await (
      await request(`${base}/result?lang=fr`, json(lina, 'POST', { goalId, value: 88.5 }))
    ).json()) as ResultAnswer;
    expect(recorded).toMatchObject({
      milestones: [25, 50],
      badges: ['first_result', 'milestone_25', 'milestone_50'],
      achieved: false,
      space: { goal: { current: 88.5, progress: 50 } },
    });
    expect(
      (
        await request(
          `${base}/result`,
          json(lina, 'POST', { goalId: '00000000-0000-4000-8000-000000000000', value: 1 }),
        )
      ).status,
    ).toBe(404);
    expect((await request(`${base}/result`, json(lina, 'POST', { goalId }))).status).toBe(400);
  });

  it('takes a screenshot’s fingerprint and numbers, and justifies only what is on it', async () => {
    const { request, lina, base } = await community(4);
    const goal = {
      title: 'Atteindre mon chiffre d’affaires mensuel',
      unit: '€',
      category: 'income',
      entry: 'total',
      start: 0,
      target: 5000,
      targetDate: new Date(NOW.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    const set = (await (
      await request(`${base}/goal`, json(lina, 'POST', goal))
    ).json()) as MemberSpaceView;
    const goalId = set.goal!.id;
    const proof = { sha256: 'f'.repeat(64), numbers: [3250, 270.83] };
    const justified = (await (
      await request(`${base}/result`, json(lina, 'POST', { goalId, value: 3250, proof }))
    ).json()) as ResultAnswer;
    expect(justified).toMatchObject({
      proof: 'justified',
      badges: expect.arrayContaining(['first_proof']) as unknown,
    });
    expect(justified.space.results[0]).toMatchObject({ value: 3250, proof: 'justified' });
    const declared = (await (
      await request(
        `${base}/result`,
        json(lina, 'POST', { goalId, value: 3300, proof: { ...proof, sha256: 'e'.repeat(64) } }),
      )
    ).json()) as ResultAnswer;
    expect(declared.proof).toBe('declared');
    // A fingerprint that is none, or numbers that are no numbers: refused.
    for (const bad of [
      { sha256: 'image.png', numbers: [1] },
      { sha256: 'd'.repeat(64), numbers: ['1'] },
    ]) {
      expect(
        (await request(`${base}/result`, json(lina, 'POST', { goalId, value: 1, proof: bad })))
          .status,
      ).toBe(400);
    }
  });

  it('adds the earned days at a milestone, through the guardrails, in automatic mode', async () => {
    const { request, whop, company, lina, boss, base } = await community(5);
    await t.db.query(`update stayput.companies set mode = 'auto' where id = $1`, [company]);
    await t.db.query(
      `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, status, current_period_end)
       values ('mem_Spc5', $1, 'mber_Spc5', 'user_lina5', 'prod_Club', 'plan_Club', 49, 'eur',
               'active', $2::timestamptz + interval '20 days')`,
      [company, NOW.toISOString()],
    );
    const url = `/api/creator/${company}/earned-days`;
    expect(await (await request(url, boss)).json()).toEqual({ enabled: false, at50: 3, at100: 7 });
    expect(
      (await request(url, json(boss, 'PUT', { enabled: true, at50: 15, at100: 7 }))).status,
    ).toBe(400);
    expect(
      await (await request(url, json(boss, 'PUT', { enabled: true, at50: 3, at100: 7 }))).json(),
    ).toEqual({ enabled: true, at50: 3, at100: 7 });
    // A member is no creator.
    expect((await request(url, lina)).status).toBe(403);

    const goal = {
      title: 'Signer de nouveaux clients',
      unit: 'clients',
      category: 'clients',
      entry: 'add',
      start: 0,
      target: 10,
      targetDate: new Date(NOW.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    const set = (await (
      await request(`${base}/goal`, json(lina, 'POST', goal))
    ).json()) as MemberSpaceView;
    expect(set.rewards.offered).toEqual({ at50: 3, at100: 7 });
    const answer = (await (
      await request(`${base}/result`, json(lina, 'POST', { goalId: set.goal!.id, value: 5 }))
    ).json()) as ResultAnswer;
    expect(answer).toMatchObject({ milestones: [25, 50], earnedDays: 3 });
    expect(answer.space.rewards.received).toEqual([
      { percent: 50, days: 3, at: expect.any(String) as unknown },
    ]);
    expect(whop.writes).toContainEqual({
      method: 'POST',
      path: '/memberships/mem_Spc5/extend',
      body: { days: 3 },
      key: expect.stringMatching(/^stayput-action-.+-extend$/) as unknown,
    });
    const history = (await (
      await request(`/api/creator/${company}/actions?view=history`, boss)
    ).json()) as ActionsPage;
    expect(history.actions.find((a) => a.trigger === 'milestone')).toMatchObject({
      type: 'extend_offer',
      status: 'sent',
      milestone: 50,
      offer: { reason: null, keep: false, days: 3 },
    });
  });

  it('shows the team a preview where nothing is recorded', async () => {
    const { request, company, boss, base } = await community(2);
    const preview = (await (await request(`${base}?lang=en`, boss)).json()) as MemberSpaceView;
    expect(preview).toMatchObject({ preview: true, known: false, goal: null });
    expect(preview.proposals.map((p) => p.title)).toEqual([
      'Reach my target weight',
      'Train regularly',
      'Run further',
    ]);
    expect(await opensOf(company)).toBe(0);
    const goal = {
      title: 'Run',
      unit: 'km',
      category: 'performance',
      entry: 'total',
      start: 1,
      target: 10,
      targetDate: NOW.toISOString().slice(0, 10),
    };
    expect((await request(`${base}/goal`, json(boss, 'POST', goal))).status).toBe(403);
  });

  it('brings the member space into the dashboard: its figures, cards online, previews', async () => {
    const { request, company, lina, boss, base } = await community(12);
    const overview = `/api/creator/${company}/space`;
    expect(await (await request(overview, boss)).json()).toEqual({
      goals: { active: 0, achieved: 0 },
      results: { last30: 0, justified30: 0, members30: 0 },
      opens30: 0,
      badges30: 0,
      cards: { online: 0, latest: [] },
      buddies: { enabled: false, activePairs: 0 },
      rescues: { enabled: false, open: 0, rescuedLast30: 0 },
      whopAppId: APP_ID,
    });

    // A member opens their space, sets a goal, notes two results (one backed) and makes a card.
    await request(`${base}?lang=fr`, lina);
    const goal = {
      title: 'Atteindre mon chiffre d’affaires mensuel',
      unit: '€',
      category: 'income',
      entry: 'total',
      start: 0,
      target: 5000,
      targetDate: new Date(NOW.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    const set = (await (
      await request(`${base}/goal`, json(lina, 'POST', goal))
    ).json()) as MemberSpaceView;
    const goalId = set.goal!.id;
    await request(`${base}/result`, json(lina, 'POST', { goalId, value: 1500 }));
    const proof = { sha256: 'd'.repeat(64), numbers: [3250] };
    const backed = (await (
      await request(`${base}/result`, json(lina, 'POST', { goalId, value: 3250, proof }))
    ).json()) as ResultAnswer;
    const resultId = backed.space.results.find((r) => r.proof === 'justified')!.id;
    const card = (await (
      await request(
        `${base}/card`,
        json(lina, 'POST', { resultId, showName: false, affiliateUrl: null }),
      )
    ).json()) as TestimonialCard;

    const seen = (await (await request(overview, boss)).json()) as SpaceOverview;
    expect(seen).toMatchObject({
      goals: { active: 1, achieved: 0 },
      results: { last30: 2, justified30: 1, members30: 1 },
      opens30: 1,
      cards: { online: 1, latest: [card] },
    });
    expect(seen.badges30).toBeGreaterThan(0);

    // What members see, without an experience: the same previews as in the member view.
    const retention = (await (
      await request(`/api/creator/${company}/preview/retention`, boss)
    ).json()) as MemberRetentionView;
    expect(retention.preview).not.toBeNull();
    const space = (await (
      await request(`/api/creator/${company}/preview/space?lang=en`, boss)
    ).json()) as MemberSpaceView;
    expect(space).toMatchObject({ preview: true, known: false, goal: null, cards: [] });
    expect(space.proposals.map((p) => p.title)).toContain('Train regularly');
    // The team's previews record nothing: the member's opening is the only one.
    expect(await opensOf(company)).toBe(1);
    // The team only.
    for (const path of [
      overview,
      `/api/creator/${company}/preview/retention`,
      `/api/creator/${company}/preview/space`,
    ]) {
      expect((await request(path, lina)).status).toBe(403);
    }
  });

  it('publishes the card of a member’s result, and its page until they take it down', async () => {
    const { request, company, lina, boss, base } = await community(6);
    const goal = {
      title: 'Atteindre mon chiffre d’affaires <mensuel>',
      unit: '€',
      category: 'income',
      entry: 'total',
      start: 0,
      target: 5000,
      targetDate: new Date(NOW.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    const set = (await (
      await request(`${base}/goal`, json(lina, 'POST', goal))
    ).json()) as MemberSpaceView;
    const proof = { sha256: 'c'.repeat(64), numbers: [3250] };
    const recorded = (await (
      await request(
        `${base}/result?lang=fr`,
        json(lina, 'POST', { goalId: set.goal!.id, value: 3250, proof }),
      )
    ).json()) as ResultAnswer;
    expect(recorded.space).toMatchObject({ cards: [], whopAppId: APP_ID });
    const resultId = recorded.space.results[0]!.id;
    const ask = (init: RequestInit, body: unknown) =>
      request(`${base}/card`, json(init, 'POST', body));

    // The team previews the space: nothing goes online.
    expect((await ask(boss, { resultId, showName: true, affiliateUrl: null })).status).toBe(403);
    // A link elsewhere than Whop, or no result of the member's: refused.
    for (const affiliateUrl of ['https://evil.example/?whop.com', 'javascript:alert(1)']) {
      expect((await ask(lina, { resultId, showName: true, affiliateUrl })).status).toBe(400);
    }
    expect(
      (
        await ask(lina, {
          resultId: '00000000-0000-4000-8000-000000000000',
          showName: false,
          affiliateUrl: null,
        })
      ).status,
    ).toBe(404);

    const made = await ask(lina, {
      resultId,
      showName: true,
      affiliateUrl: 'https://whop.com/le-club/?a=lina6',
    });
    expect(made.status).toBe(200);
    const card = (await made.json()) as TestimonialCard;
    expect(card).toMatchObject({
      resultId,
      level: 'justified',
      url: `http://localhost/v/${card.proofId}`,
      display: {
        goal: goal.title,
        value: 3250,
        progress: 65,
        name: 'Name user_lina6',
        affiliateUrl: 'https://whop.com/le-club/?a=lina6',
        day: NOW.toISOString().slice(0, 10),
      },
    });
    const seen = (await (await request(`${base}?lang=fr`, lina)).json()) as MemberSpaceView;
    expect(seen.cards).toEqual([card]);

    // The public page: anyone opens it, without signing in.
    const pageOf = (headers: Record<string, string> = {}) =>
      request(`/v/${card.proofId}`, { headers });
    const open = await pageOf();
    expect(open.status).toBe(200);
    expect(open.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await open.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Atteindre mon chiffre d’affaires &lt;mensuel&gt;');
    expect(html).toContain('By Name user_lina6');
    expect(html).toContain('✓ Backed by a screenshot');
    expect(html).toContain(
      '<a class="join" href="https://whop.com/le-club/?a=lina6" target="_blank" rel="noopener nofollow">',
    );
    expect(html).toContain('<span class="w65"></span>');
    expect(html).not.toContain('<script');
    // Its policy allows its own style, and nothing else.
    const style = /<style>([\s\S]*)<\/style>/.exec(html)![1]!;
    const digest = createHash('sha256').update(style).digest('base64');
    expect(open.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src 'sha256-${digest}'; base-uri 'none'; form-action 'none'`,
    );
    // In the community's language.
    await t.db.query(`update stayput.companies set locale = 'fr' where id = $1`, [company]);
    await request(
      `${base}/card`,
      json(lina, 'POST', { resultId, showName: false, affiliateUrl: null }),
    );
    const french = await (await pageOf()).text();
    expect(french).toContain('<html lang="fr">');
    expect(french).toContain('Par un membre de la communauté');
    expect(french).not.toContain('Name user_lina6');
    expect(french).not.toContain('class="join"');

    // Only the member takes it down.
    const remove = (init: RequestInit, id: string) =>
      request(`${base}/card/${id}`, { ...init, method: 'DELETE' });
    expect((await remove(lina, 'not-a-proof')).status).toBe(400);
    expect((await remove(lina, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await remove(boss, card.proofId)).status).toBe(404);
    const removed = await remove(lina, card.proofId);
    expect(await removed.json()).toEqual({ removed: true });
    expect(((await (await request(base, lina)).json()) as MemberSpaceView).cards).toEqual([]);
    const gone = await pageOf({ 'accept-language': 'fr-FR,fr;q=0.9' });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('Cette page n’existe pas');
    expect(await (await pageOf()).text()).toContain('This page does not exist');
    expect((await request('/v/not-a-proof')).status).toBe(400);
  });

  it('offers the member’s affiliate link when Whop has one, never the team’s', async () => {
    const affiliates = JSON.stringify({
      data: [
        { id: 'aff_Other', user: { id: 'user_lina70' } },
        { id: 'aff_Lina', user: { id: 'user_lina7' } },
      ],
    });
    const overrides = JSON.stringify({
      data: [
        { product_direct_link: null, checkout_direct_link: null },
        {
          product_direct_link: 'https://whop.com/le-club/?a=lina7',
          checkout_direct_link: 'https://whop.com/checkout/plan_Club/?a=lina7',
        },
      ],
    });
    const { request, whop, lina, boss, base } = await community(7, {
      '/affiliates': affiliates,
      '/affiliates/aff_Lina/overrides': overrides,
    });
    expect(await (await request(`${base}/affiliate`, lina)).json()).toEqual({
      url: 'https://whop.com/le-club/?a=lina7',
    });
    expect(whop.calls).toContain('GET /users/user_lina7');
    const affiliateCalls = () => whop.listed.filter((path) => path.startsWith('/affiliates'));
    expect(affiliateCalls()).toEqual(['/affiliates', '/affiliates/aff_Lina/overrides']);
    // The team previews: no Whop call for them.
    expect(await (await request(`${base}/affiliate`, boss)).json()).toEqual({ url: null });
    expect(affiliateCalls()).toHaveLength(2);
    // StayPut may not read affiliates: the member pastes their link.
    whop.refusals['GET /users/user_lina7'] = new WhopApiError(403, 'forbidden', 'missing scope', {
      method: 'GET',
      path: '/users/user_lina7',
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await (await request(`${base}/affiliate`, lina)).json()).toEqual({ url: null });
    expect(errors).toHaveBeenCalledWith('Affiliate link not read:', expect.any(String));
    errors.mockRestore();
  });

  it('gives no link for a member who is no affiliate, or whose commission has none', async () => {
    const { request, lina, base } = await community(8, {
      '/affiliates': JSON.stringify({ data: [{ id: 'aff_Lina8', user: { id: 'user_lina8' } }] }),
      // A revenue share: Whop gives it no link.
      '/affiliates/aff_Lina8/overrides': JSON.stringify({
        data: [{ product_direct_link: null, checkout_direct_link: null }],
      }),
    });
    expect(await (await request(`${base}/affiliate`, lina)).json()).toEqual({ url: null });
    const other = await community(9);
    expect(await (await other.request(`${other.base}/affiliate`, other.lina)).json()).toEqual({
      url: null,
    });
  });

  it('pairs a newcomer with a veteran: the creator turns it on, the member can opt out', async () => {
    const { request, company, lina, boss, base } = await community(10);
    // Lina joined two days ago; Sam is a member for months, engaged.
    await t.db.query(`update stayput.members set joined_at = $2::timestamptz where id = $1`, [
      'mber_Spc10',
      new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
    ]);
    await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      company,
      'members',
      JSON.stringify(page([member('mber_Sam10', 'user_sam10')])),
    ]);
    await t.db.query(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                        level_since, computed_at)
       values ($1, 'mber_Sam10', 8, 'low', '{}', $2::timestamptz, $2::timestamptz)`,
      [company, NOW.toISOString()],
    );
    const url = `/api/creator/${company}/buddies`;
    expect(await (await request(url, boss)).json()).toEqual({
      enabled: false,
      activePairs: 0,
      waitingNewcomers: 1,
      veterans: 1,
      mentors: 0,
    });
    // A member is no creator.
    expect((await request(url, lina)).status).toBe(403);
    expect((await request(url, json(boss, 'PUT', { enabled: 'yes' }))).status).toBe(400);
    expect(await (await request(url, json(boss, 'PUT', { enabled: true }))).json()).toMatchObject({
      enabled: true,
    });
    await t.db.query('select stayput.plan_buddies($1, $2::timestamptz)', [
      company,
      NOW.toISOString(),
    ]);

    const seen = (await (await request(`${base}?lang=fr`, lina)).json()) as MemberSpaceView;
    expect(seen.buddies).toEqual({
      optedOut: false,
      partners: [
        {
          pairId: expect.any(String) as string,
          role: 'veteran',
          name: 'Name user_sam10',
          joinedAt: '2026-06-01T10:00:00.000Z',
          pairedAt: NOW.toISOString(),
          sameCategory: null,
        },
      ],
    });
    // The team previews the space: nobody's buddy.
    const preview = (await (await request(`${base}?lang=fr`, boss)).json()) as MemberSpaceView;
    expect(preview.buddies).toBeNull();
    expect((await request(`${base}/buddies`, json(boss, 'POST', { optOut: true }))).status).toBe(
      403,
    );
    expect((await request(`${base}/buddies`, json(lina, 'POST', { optOut: 1 }))).status).toBe(400);
    expect(
      await (await request(`${base}/buddies`, json(lina, 'POST', { optOut: true }))).json(),
    ).toEqual({ optedOut: true, partners: [] });
    expect(await (await request(url, boss)).json()).toMatchObject({ activePairs: 0 });
  });

  it('shows members the rescue challenges, never who, and lets them take one up', async () => {
    const { request, company, lina, boss, base } = await community(11);
    // Sam, a member for months, silent on the community's Discord for 20 days.
    await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      company,
      'members',
      JSON.stringify(page([member('mber_Sam11', 'user_sam11')])),
    ]);
    await t.db.query(
      `insert into stayput.discord_guilds (guild_id, company_id, name, channel_ids, connected_at)
       values ('950000000000000011', $1, 'Le Club', array['950000000000000012'],
               $2::timestamptz)`,
      [company, NOW.toISOString()],
    );
    await t.db.query(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at,
                                            external_id, metadata)
       values ($1, 'mber_Sam11', 'discord_message', $2::timestamptz, '950000000000000013',
               '{"channel_id": "950000000000000012"}')`,
      [company, new Date(NOW.getTime() - 20 * 86_400_000).toISOString()],
    );
    const url = `/api/creator/${company}/rescues`;
    expect(await (await request(url, boss)).json()).toEqual({
      enabled: false,
      open: 0,
      rescuedLast30: 0,
      rescuers: 0,
    });
    expect((await request(url, lina)).status).toBe(403);
    expect((await request(url, json(boss, 'PUT', {}))).status).toBe(400);
    expect(await (await request(url, json(boss, 'PUT', { enabled: true }))).json()).toMatchObject({
      enabled: true,
    });
    await t.db.query('select stayput.plan_rescues($1, $2::timestamptz)', [
      company,
      NOW.toISOString(),
    ]);
    expect(await (await request(url, boss)).json()).toMatchObject({ open: 1 });

    const seen = (await (await request(`${base}?lang=fr`, lina)).json()) as MemberSpaceView;
    expect(seen.rescues).toEqual({
      challenges: [
        {
          id: expect.any(String) as string,
          platform: 'discord',
          place: 'Le Club',
          url: 'https://discord.com/channels/950000000000000011/950000000000000012/950000000000000013',
          lastMessageAt: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(),
          createdAt: NOW.toISOString(),
          helpers: 0,
          joined: false,
        },
      ],
      rescued: 0,
    });
    expect(JSON.stringify(seen.rescues)).not.toMatch(/sam|Sam/);
    // The team previews the space: no challenge there.
    const preview = (await (await request(`${base}?lang=fr`, boss)).json()) as MemberSpaceView;
    expect(preview.rescues).toBeNull();
    const id = seen.rescues!.challenges[0]!.id;
    const take = (init: RequestInit, challenge: string) =>
      request(`${base}/rescues/${challenge}`, { ...init, method: 'POST' });
    expect((await take(boss, id)).status).toBe(403);
    expect((await take(lina, 'not-a-challenge')).status).toBe(400);
    expect((await take(lina, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(await (await take(lina, id)).json()).toMatchObject({
      challenges: [{ id, joined: true, helpers: 1 }],
    });
  });

  it('lets the creator write the goals proposed to members', async () => {
    const { request, company, boss, lina, base } = await community(3);
    const url = `/api/creator/${company}/goals`;
    const read = (await (await request(`${url}?lang=fr`, boss)).json()) as GoalProposalsView;
    expect(read).toMatchObject({ niche: 'fitness', custom: null });
    expect(read.defaults).toHaveLength(3);

    expect((await request(url, json(boss, 'PUT', { proposals: 'none' }))).status).toBe(400);
    expect((await request(url, json(boss, 'PUT', {}))).status).toBe(400);
    const own = [{ title: 'Courir 5 km', unit: 'km', category: 'performance', entry: 'total' }];
    const saved = (await (
      await request(`${url}?lang=fr`, json(boss, 'PUT', { proposals: own }))
    ).json()) as GoalProposalsView;
    expect(saved.custom).toEqual(own);
    // The members choose among the creator's own.
    const seen = (await (await request(`${base}?lang=en`, lina)).json()) as MemberSpaceView;
    expect(seen.proposals).toEqual(own);

    const back = (await (
      await request(url, json(boss, 'PUT', { proposals: null }))
    ).json()) as GoalProposalsView;
    expect(back.custom).toBeNull();
    // A member is no creator.
    expect((await request(url, lina)).status).toBe(403);
  });
});

describe('announcing the milestones (SPEC Phase 5, point 4)', () => {
  const json = (init: RequestInit, method: string, body: unknown) => ({
    ...init,
    method,
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const MODULES: Env = {
    ...ENV,
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    TELEGRAM_BOT_TOKEN: '123456:telegram-token',
  };

  it('lets the creator pick where, and the member share their milestone there', async () => {
    const [company, experience] = ['biz_Ann1', 'exp_Ann1'];
    const posted: { channel: string; text: string }[] = [];
    const discord = {
      guildChannels: () =>
        Promise.resolve([
          {
            id: '920000000000000101',
            name: 'general',
            category: null,
            readable: true,
            writable: true,
          },
          {
            id: '920000000000000102',
            name: 'staff',
            category: null,
            readable: true,
            writable: false,
          },
        ]),
      sendMessage: (channel: string, text: string) => {
        posted.push({ channel, text });
        return Promise.resolve();
      },
    } as unknown as DiscordClient;
    const env = setup(
      {
        [`user_lina9:${experience}`]: 'customer',
        [`user_boss9:${experience}`]: 'admin',
        [`user_boss9:${company}`]: 'admin',
      },
      {
        experiences: { [experience]: company },
        discord,
        lists: {
          '/chat_channels': JSON.stringify({
            data: [{ id: 'chat_Wins1', experience: { id: 'exp_Chat1', name: 'Victoires' } }],
            page_info: { end_cursor: null, has_next_page: false },
          }),
        },
      },
    );
    const request = (path: string, init: RequestInit = {}) => env.request(path, init, MODULES);
    const boss = await asUser('user_boss9');
    const lina = await asUser('user_lina9');
    await request(`/api/creator/${company}/session`, boss);
    await settle();
    await t.db.query(`update stayput.companies set mode = 'auto', locale = 'fr' where id = $1`, [
      company,
    ]);
    await t.db.query(
      `insert into stayput.discord_guilds (guild_id, company_id, name, connected_at)
       values ('910000000000000901', $1, 'Le Club', now())`,
      [company],
    );
    await t.db.query(
      `insert into stayput.telegram_chats (chat_id, company_id, title, connected_at)
       values ('-100900', $1, 'Le Club (groupe)', now())`,
      [company],
    );
    await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      company,
      'members',
      JSON.stringify(
        page([
          member('mber_Ann1', 'user_lina9', { user: { id: 'user_lina9', name: 'Lina Martin' } }),
        ]),
      ),
    ]);

    const url = `/api/creator/${company}/announcements`;
    const view = (await (await request(url, boss)).json()) as AnnouncementsView;
    expect(view).toEqual({
      destination: null,
      choices: [
        { platform: 'whop', id: 'chat_Wins1', name: 'Victoires', place: 'Whop' },
        { platform: 'discord', id: '920000000000000101', name: '#general', place: 'Le Club' },
        { platform: 'telegram', id: '-100900', name: 'Le Club (groupe)', place: 'Telegram' },
      ],
      whopUnavailable: false,
    });
    // Never a place StayPut cannot post in.
    expect(
      (
        await request(
          url,
          json(boss, 'PUT', { destination: { platform: 'discord', id: '920000000000000102' } }),
        )
      ).status,
    ).toBe(400);
    const saved = (await (
      await request(
        url,
        json(boss, 'PUT', { destination: { platform: 'discord', id: '920000000000000101' } }),
      )
    ).json()) as AnnouncementsView;
    expect(saved.destination).toEqual({
      platform: 'discord',
      id: '920000000000000101',
      name: '#general',
      place: 'Le Club',
    });

    // The member reaches 50 %, sees where and in which words, and shares it.
    const base = `/api/member/${experience}/space`;
    const goal = {
      title: 'Signer de nouveaux clients',
      unit: 'clients',
      category: 'clients',
      entry: 'add',
      start: 0,
      target: 10,
      targetDate: new Date(NOW.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    const set = (await (
      await request(`${base}/goal`, json(lina, 'POST', goal))
    ).json()) as MemberSpaceView;
    expect(set.announce).toEqual({ locale: 'fr', firstName: 'Lina', place: '#general' });
    const goalId = set.goal!.id;
    await request(`${base}/result`, json(lina, 'POST', { goalId, value: 5 }));
    const shared = (await (
      await request(`${base}/share`, json(lina, 'POST', { goalId, percent: 50 }))
    ).json()) as ShareAnswer;
    expect(shared).toEqual({ status: 'sent' });
    expect(posted).toEqual([
      {
        channel: '920000000000000101',
        text: '🎉 Lina a atteint 50\u00a0% de son objectif : « Signer de nouveaux clients » !',
      },
    ]);
    expect(
      await (await request(`${base}/share`, json(lina, 'POST', { goalId, percent: 50 }))).json(),
    ).toEqual({ status: 'duplicate' });
    // A milestone not reached, or the team: nothing.
    expect(
      (await request(`${base}/share`, json(lina, 'POST', { goalId, percent: 75 }))).status,
    ).toBe(404);
    expect(
      (await request(`${base}/share`, json(boss, 'POST', { goalId, percent: 50 }))).status,
    ).toBe(403);
    // The creator sees it in the history, with its words.
    const history = (await (
      await request(`/api/creator/${company}/actions?view=history`, boss)
    ).json()) as ActionsPage;
    expect(history.actions.find((a) => a.type === 'milestone_announcement')).toMatchObject({
      status: 'sent',
      trigger: 'member_request',
      message: {
        title: '#general',
        body: '🎉 Lina a atteint 50\u00a0% de son objectif : « Signer de nouveaux clients » !',
      },
    });
    // Turned off.
    expect(
      (
        (await (
          await request(url, json(boss, 'PUT', { destination: null }))
        ).json()) as AnnouncementsView
      ).destination,
    ).toBeNull();
  });
});
