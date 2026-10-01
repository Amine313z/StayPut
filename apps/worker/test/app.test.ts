import type {
  AccountsView,
  MemberRetentionView,
  PlatformActivityView,
  ActionsPage,
  AccessLevel,
  DiscordChannelChoice,
  InsightsReport,
  IntegrationsStatus,
  MemberTelegramStatus,
  PeopleView,
  MembersPage,
  SyncRun,
  SyncStatus,
} from '@stayput/core';
import { USER_TOKEN_ISSUER, WhopApiError, signWebhook, type WhopClient } from '@stayput/whop';
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
  const writes: { method: string; path: string; body: unknown }[] = [];
  const client = {
    env: 'sandbox',
    request(method: string, path: string, options?: { body?: unknown }) {
      calls.push(`${method} ${path}`);
      if (method !== 'GET') writes.push({ method, path, body: options?.body });
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
  } as unknown as WhopClient;
  return { client, calls, listed, writes };
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
    await request(
      '/api/creator/biz_ActQ2/settings/actions',
      json(init, 'PUT', { ...DEFAULTS, locale: 'fr', dryRun: true }),
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

  it('asks why, makes the offer for the reason, and keeps the membership only with consent', async () => {
    const { read, answer, decide, whop, company, request, boss } = await departing(1);
    expect(await read()).toMatchObject({
      preview: null,
      creatorName: 'Le Club',
      whopAppId: APP_ID,
      payment: null,
      departure: { reason: null, offer: null, outcome: 'pending', result: null },
    });

    // Too expensive: a single-use code. Then the member changes their mind: no time, a pause.
    const expensive = (await (await answer('too_expensive')).json()) as MemberRetentionView;
    expect(expensive.departure?.offer).toEqual({
      type: 'promo_offer',
      percentOff: 20,
      months: 3,
      validDays: 7,
      keep: 'never',
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
    expect(history.actions.find((a) => a.type === 'pause_offer')).toMatchObject({
      status: 'sent',
      message: null,
      offer: { reason: 'no_time', days: 30, keep: true, resumesAt: expect.any(String) as string },
    });
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
    });
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
