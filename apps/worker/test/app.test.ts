import type {
  AccessLevel,
  DiscordChannelChoice,
  InsightsReport,
  IntegrationsStatus,
  MemberTelegramStatus,
  MembersPage,
  SyncRun,
  SyncStatus,
} from '@stayput/core';
import { USER_TOKEN_ISSUER, WhopApiError, signWebhook, type WhopClient } from '@stayput/whop';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCache } from '../src/access';
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
  const client = {
    env: 'sandbox',
    request(method: string, path: string) {
      calls.push(`${method} ${path}`);
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
  return { client, calls, listed };
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
    const read = async () =>
      (await (await request('/api/member/exp_Int5/telegram', mo)).json()) as MemberTelegramStatus;
    expect(await read()).toMatchObject({ available: false, linked: false, link: null });

    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      'biz_Int5',
      '-1009000000005',
      'VIP',
      NOW.toISOString(),
    ]);
    const offer = await read();
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
    expect(telegram.sent.at(-1)).toEqual({
      chatId: '5151',
      text: expect.stringContaining('Done') as string,
    });
    expect(await read()).toMatchObject({ linked: true });

    const unlinked = await request('/api/member/exp_Int5/telegram', { method: 'DELETE', ...mo });
    expect(await unlinked.json()).toEqual({ removed: true });
    expect(await read()).toMatchObject({ linked: false });
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
