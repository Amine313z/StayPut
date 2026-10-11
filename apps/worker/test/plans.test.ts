import type {
  AccessLevel,
  AdminCompaniesView,
  CreatorSession,
  MembersPage,
  PaymentRequiredBody,
} from '@stayput/core';
import { USER_TOKEN_ISSUER, WhopApiError, signWebhook, type WhopClient } from '@stayput/whop';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessCache } from '../src/access';
import { createApp, type AppDeps } from '../src/app';
import type { ClosableDb } from '../src/db';
import { readConfig, type Env } from '../src/env';
import { runActions } from '../src/jobs';
import { member, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * The plans' acceptance (decision of 2026-10-10, section 10 of the founder's brief): the seven
 * cases, each through the Worker's real routes, the real database and its cron job, Whop faked
 * (its access checks, its companies, its memberships, its signed webhooks).
 *
 * 1. No subscription: Free, and the sixth manual action of the month is refused (402).
 * 2. A Pro trial: Pro at once, through the membership webhook (no 5-minute wait).
 * 3. The founders' plan: Scale, and the founders' banner with its date and price.
 * 4. The founders' plan bought by a community outside the registry: flagged.
 * 5. A cancellation: Free, the automations stop, the data stays.
 * 6. A moderator of a Scale community: Scale (the owner pays, the team has it).
 * 7. Whop unreachable: the last level known stays.
 */

// The real time (to the second): RLS checks a creator's access against the database's clock.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400_000;
const APP_ID = 'app_stayput';
const SECRET = 'ws_test_secret';
// StayPut's App Store product and its plans (decision of 2026-10-11: the level is the plan's).
const APP_PRODUCT = 'prod_StayPutApp';
const FREE_PLAN = 'plan_StayPutFree';
const PRO_MONTHLY = 'plan_ProMonthly';
const PRO_YEARLY = 'plan_ProYearly';
const SCALE_MONTHLY = 'plan_ScaleMonthly';
const SCALE_YEARLY = 'plan_ScaleYearly';
const FOUNDER = 'plan_StayPutFounder';
const ADMIN = 'user_Founder';
const CHECKOUT_PRO = 'https://whop.com/checkout/plan_ProMonthly';
const CHECKOUT_SCALE = 'https://whop.com/checkout/plan_ScaleMonthly';
const ENV: Env = {
  WHOP_ENV: 'sandbox',
  WHOP_APP_ID: APP_ID,
  WHOP_API_KEY: 'test_key',
  WHOP_WEBHOOK_SECRET: SECRET,
  WHOP_PLANS_PRO: `${PRO_MONTHLY},${PRO_YEARLY}`,
  WHOP_PLANS_SCALE: `${SCALE_MONTHLY},${SCALE_YEARLY}`,
  WHOP_PLAN_SCALE_FOUNDER: FOUNDER,
  CHECKOUT_URL_PRO: CHECKOUT_PRO,
  CHECKOUT_URL_SCALE: CHECKOUT_SCALE,
  ADMIN_USER_ID: ADMIN,
};
const EMPTY_PAGE = '{"data":[],"page_info":{"end_cursor":null,"has_next_page":false}}';

let t: TestDb;
let keys: { privateKey: CryptoKey; publicKey: CryptoKey };
beforeAll(async () => {
  t = await createTestDb({ via: 'install-sql' });
  keys = await generateKeyPair('ES256');
});
afterAll(() => t.close());

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

/** Memberships as Whop lists a person's (GET /memberships?user_id): StayPut's and others'. */
interface AppMembership {
  id: string;
  user: { id: string };
  product: { id: string };
  plan: { id: string };
  status: string;
  renewal_period_end: string | null;
  cancel_at_period_end: boolean;
}

/**
 * Whop, faked: who has access to what (communities and StayPut's products), each company's
 * owner, StayPut's memberships, the founders' plan's price. `down` makes every access check fail
 * as an unreachable Whop does.
 */
function fakeWhop() {
  const access: Record<string, AccessLevel> = {};
  const owners: Record<string, string> = {};
  const memberships: AppMembership[] = [];
  /** The community of each experience (StayPut's place in it), as GET /experiences/{id}. */
  const experiences: Record<string, string> = {};
  const state = { down: false };
  const client = {
    env: 'sandbox',
    request(method: string, path: string) {
      if (state.down) {
        return Promise.reject(
          new WhopApiError(503, 'unavailable', 'Whop is down', { method, path }),
        );
      }
      const experience = /^\/experiences\/(exp_[A-Za-z0-9]+)$/.exec(path)?.[1];
      if (method === 'GET' && experience && experiences[experience]) {
        return Promise.resolve({ id: experience, company: { id: experiences[experience] } });
      }
      const company = /^\/companies\/(biz_[A-Za-z0-9]+)$/.exec(path)?.[1];
      if (method === 'GET' && company) {
        const owner = owners[company];
        return Promise.resolve({
          id: company,
          title: `Club ${company.slice(4)}`,
          owner_user: owner ? { id: owner } : null,
        });
      }
      if (method === 'GET' && path === `/plans/${FOUNDER}`) {
        return Promise.resolve({ id: FOUNDER, renewal_price: 39.5, currency: 'usd' });
      }
      if (method === 'POST' && path === '/notifications') return Promise.resolve({ success: true });
      return Promise.reject(new WhopApiError(404, 'not_found', 'no such thing', { method, path }));
    },
    getRaw(path: string) {
      return Promise.reject(new WhopApiError(404, 'not_found', 'none', { method: 'GET', path }));
    },
    checkAccess(userId: string, resourceId: string) {
      if (state.down) {
        return Promise.reject(
          new WhopApiError(503, 'unavailable', 'Whop is down', {
            method: 'GET',
            path: `/users/${userId}/access/${resourceId}`,
          }),
        );
      }
      const level = access[`${userId}:${resourceId}`] ?? 'no_access';
      return Promise.resolve({ hasAccess: level !== 'no_access', accessLevel: level });
    },
    listPageRaw() {
      return Promise.resolve(EMPTY_PAGE);
    },
    listPage(path: string, query: Record<string, string> = {}) {
      if (state.down) {
        return Promise.reject(
          new WhopApiError(503, 'unavailable', 'Whop is down', { method: 'GET', path }),
        );
      }
      const items =
        path === '/memberships' && query.user_id
          ? memberships.filter((m) => m.user.id === query.user_id)
          : [];
      return Promise.resolve({ items, nextCursor: null });
    },
  } as unknown as WhopClient;
  return { client, access, owners, memberships, experiences, state };
}

function setup(env: Env = ENV) {
  const whop = fakeWhop();
  const deps: AppDeps = {
    now: () => NOW,
    openDb: (): ClosableDb => ({ ...t.db, close: () => Promise.resolve() }),
    whopClient: (config) => (config.apiKey ? whop.client : null),
    userTokenKeys: () => keys.publicKey,
    oauth: () => null,
    discord: () => null,
    telegram: () => null,
    accessCache: new AccessCache(),
  };
  const app = createApp(deps);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, init, env, executionCtx);
  return { request, whop };
}

async function as(user: string, init: RequestInit = {}): Promise<RequestInit> {
  const token = await new SignJWT({ sub: user, aud: APP_ID, iss: USER_TOKEN_ISSUER })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt(NOW_S)
    .setExpirationTime(NOW_S + 300)
    .sign(keys.privateKey);
  return {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      'x-whop-user-token': token,
    },
  };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** A community whose owner (and, given, others) are admins on Whop, opened once by its owner. */
async function community(
  env: ReturnType<typeof setup>,
  company: string,
  owner: string,
  team: string[] = [],
) {
  env.whop.owners[company] = owner;
  for (const user of [owner, ...team]) env.whop.access[`${user}:${company}`] = 'admin';
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [
    company,
    new Date(NOW.getTime() - 30 * DAY).toISOString(),
  ]);
}

async function session(env: ReturnType<typeof setup>, company: string, user: string) {
  const res = await env.request(`/api/creator/${company}/session`, await as(user));
  expect(res.status).toBe(200);
  const body = (await res.json()) as CreatorSession;
  await settle();
  return body;
}

/** A membership webhook from Whop, signed as Whop signs it. */
async function membershipWebhook(
  env: ReturnType<typeof setup>,
  type: string,
  membership: AppMembership,
) {
  const id = `msg_${membership.id.slice(4)}${type.replace(/\W/g, '')}`;
  const body = JSON.stringify({
    type,
    company_id: 'biz_StayPut',
    data: { ...membership, company: { id: 'biz_StayPut' } },
  });
  const res = await env.request('/webhooks/whop', {
    method: 'POST',
    body,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(NOW_S),
      'webhook-signature': await signWebhook(body, SECRET, id, NOW_S),
      'content-type': 'application/json',
    },
  });
  expect(res.status).toBe(200);
  await settle();
}

const appMembership = (
  id: string,
  user: string,
  product: string,
  plan: string,
  status: string,
  ends: Date | null,
): AppMembership => ({
  id,
  user: { id: user },
  product: { id: product },
  plan: { id: plan },
  status,
  renewal_period_end: ends?.toISOString() ?? null,
  cancel_at_period_end: false,
});

async function joinMembers(company: string, count: number) {
  const tag = company.slice(4);
  await t.db.query('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
    company,
    'members',
    JSON.stringify(
      page(
        Array.from({ length: count }, (_, i) =>
          member(`mber_${tag}${i + 1}`, `user_${tag}${i + 1}`),
        ),
      ),
    ),
  ]);
  return Array.from({ length: count }, (_, i) => `mber_${tag}${i + 1}`);
}

describe('the plans’ acceptance', () => {
  it('1. no subscription: Free, five manual actions a month, the sixth refused with 402', async () => {
    const env = setup();
    await community(env, 'biz_NoSub', 'user_NoSubOwner');
    const ids = await joinMembers('biz_NoSub', 6);
    // StayPut installed on its free plan, and the owner a paying member of another community:
    // neither gives a level, and the other community's membership is never kept.
    env.whop.memberships.push(
      appMembership('mem_NoSubFree', 'user_NoSubOwner', APP_PRODUCT, FREE_PLAN, 'active', null),
      appMembership(
        'mem_NoSubElsewhere',
        'user_NoSubOwner',
        'prod_SomeoneElse',
        'plan_SomeoneElse',
        'active',
        null,
      ),
    );
    // Test mode: the messages are simulated, nothing leaves.
    await t.db.query('update stayput.company_settings set dry_run = true where company_id = $1', [
      'biz_NoSub',
    ]);

    const opened = await session(env, 'biz_NoSub', 'user_NoSubOwner');
    expect(
      await t.db.query(`select id from stayput.app_memberships where user_id = 'user_NoSubOwner'`),
    ).toEqual([]);
    expect(opened.plan).toMatchObject({
      tier: 'free',
      source: 'none',
      manualActions: { used: 0, limit: 5 },
      checkout: { pro: CHECKOUT_PRO, scale: CHECKOUT_SCALE },
      founder: null,
      stale: false,
    });

    const message = async (id: string) =>
      env.request(
        '/api/creator/biz_NoSub/members/message',
        await as('user_NoSubOwner', post({ memberIds: [id] })),
      );
    for (const id of ids.slice(0, 5)) {
      const res = await message(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ queued: 1 });
    }
    const sixth = await message(ids[5]!);
    expect(sixth.status).toBe(402);
    expect((await sixth.json()) as PaymentRequiredBody).toMatchObject({
      error: { code: 'payment_required' },
      requiredTier: 'pro',
      checkoutUrl: CHECKOUT_PRO,
    });
    // Nothing was queued for the sixth, and the count says 5 / 5.
    const [queued] = await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.actions
        where company_id = 'biz_NoSub' and type = 'creator_message'`,
    );
    expect(queued?.n).toBe(5);
    expect((await session(env, 'biz_NoSub', 'user_NoSubOwner')).plan.manualActions).toEqual({
      used: 5,
      limit: 5,
    });
    // What Pro opens is refused too, with Pro's checkout.
    const approve = await env.request(
      '/api/creator/biz_NoSub/actions/approve',
      await as('user_NoSubOwner', post({})),
    );
    expect(approve.status).toBe(402);
    expect(await approve.json()).toMatchObject({ requiredTier: 'pro', checkoutUrl: CHECKOUT_PRO });
  });

  it('2. a Pro trial: Pro at once, through the membership webhook', async () => {
    const env = setup();
    await community(env, 'biz_Trial', 'user_TrialOwner');
    expect((await session(env, 'biz_Trial', 'user_TrialOwner')).plan.tier).toBe('free');
    const [before] = await t.db.query<{ fresh_until: Date }>(
      `select fresh_until from stayput.company_plans where company_id = 'biz_Trial'`,
    );
    // The level just read holds 5 minutes…
    expect(before?.fresh_until.getTime()).toBe(NOW.getTime() + 5 * 60_000);

    // …but the owner starts Pro's trial on Whop: Whop gives access, and tells StayPut.
    const trialEnds = new Date(NOW.getTime() + 14 * DAY);
    const trial = appMembership(
      'mem_Trial1',
      'user_TrialOwner',
      APP_PRODUCT,
      PRO_MONTHLY,
      'trialing',
      trialEnds,
    );
    env.whop.memberships.push(trial);
    await membershipWebhook(env, 'membership.activated', trial);

    // The same instant: no wait.
    const opened = await session(env, 'biz_Trial', 'user_TrialOwner');
    expect(opened.plan).toMatchObject({
      tier: 'pro',
      source: 'whop',
      trialEndsAt: trialEnds.toISOString(),
      manualActions: null,
      founder: null,
    });
    const approve = await env.request(
      '/api/creator/biz_Trial/actions/approve',
      await as('user_TrialOwner', post({})),
    );
    expect(approve.status).toBe(200);
  });

  it('3. the founders’ plan: Scale, and the founders’ banner with its date and price', async () => {
    const env = setup();
    // The founder invites the community (a place of 20).
    const invited = await env.request(
      '/api/admin/founders',
      await as(ADMIN, post({ companyId: 'biz_Founding', note: 'beta' })),
    );
    expect(invited.status).toBe(200);

    // Its owner buys the founders' plan on Whop: Scale, free until its first charge.
    const firstCharge = new Date(NOW.getTime() + 60 * DAY);
    const founding = appMembership(
      'mem_Founding1',
      'user_FoundingOwner',
      APP_PRODUCT,
      FOUNDER,
      'trialing',
      firstCharge,
    );
    env.whop.memberships.push(founding);
    await membershipWebhook(env, 'membership.activated', founding);

    // Then installs StayPut and opens it.
    await community(env, 'biz_Founding', 'user_FoundingOwner');
    const opened = await session(env, 'biz_Founding', 'user_FoundingOwner');
    expect(opened.plan).toMatchObject({
      tier: 'scale',
      source: 'whop',
      trialEndsAt: firstCharge.toISOString(),
      founder: {
        trialEndsAt: firstCharge.toISOString(),
        price: { amount: 39.5, currency: 'usd' },
      },
    });
    // The registry says subscribed; one place of 20 taken.
    const admin = (await (
      await env.request('/api/admin/companies', await as(ADMIN))
    ).json()) as AdminCompaniesView;
    expect(admin.companies.find((c) => c.companyId === 'biz_Founding')?.founder).toMatchObject({
      status: 'subscribed',
      note: 'beta',
    });
    expect(admin.founders).toMatchObject({ places: 20, left: 19 });
    // Nobody else reads the admin page.
    expect((await env.request('/api/admin/companies', await as('user_FoundingOwner'))).status).toBe(
      404,
    );
  });

  it('4. the founders’ plan bought by a community outside the registry: flagged', async () => {
    const env = setup();
    await community(env, 'biz_Leak', 'user_LeakOwner');
    expect((await session(env, 'biz_Leak', 'user_LeakOwner')).plan.tier).toBe('free');

    // A leaked link: the owner buys the founders' plan without an invitation.
    const leaked = appMembership(
      'mem_Leak1',
      'user_LeakOwner',
      APP_PRODUCT,
      FOUNDER,
      'trialing',
      new Date(NOW.getTime() + 30 * DAY),
    );
    env.whop.memberships.push(leaked);
    await membershipWebhook(env, 'membership.activated', leaked);

    const admin = (await (
      await env.request('/api/admin/companies', await as(ADMIN))
    ).json()) as AdminCompaniesView;
    expect(admin.companies.find((c) => c.companyId === 'biz_Leak')?.founder).toMatchObject({
      status: 'flagged',
    });
    // Flagged takes no place; Whop gave access, so the level is Scale until the founder decides.
    expect(admin.founders.left).toBe(19);
    expect((await session(env, 'biz_Leak', 'user_LeakOwner')).plan.tier).toBe('scale');
  });

  it('5. a cancellation: Free, the automations stop, the data stays', async () => {
    const env = setup();
    await community(env, 'biz_Cancel', 'user_CancelOwner');
    const ids = await joinMembers('biz_Cancel', 3);
    const subscription = appMembership(
      'mem_Cancel1',
      'user_CancelOwner',
      APP_PRODUCT,
      SCALE_MONTHLY,
      'active',
      new Date(NOW.getTime() + 20 * DAY),
    );
    env.whop.memberships.push(subscription);
    expect((await session(env, 'biz_Cancel', 'user_CancelOwner')).plan.tier).toBe('scale');
    // Automatic mode (Scale's), and a follow-up of StayPut's own due now.
    const auto = await env.request(
      '/api/creator/biz_Cancel/mode',
      await as('user_CancelOwner', post({ mode: 'auto' })),
    );
    expect(auto.status).toBe(200);
    // What the switch ran in the background (the actions due then) ends first.
    await settle();
    await t.db.query(
      `insert into stayput.actions (company_id, member_id, type, status, trigger, send_at,
                                    approved_by, message_kind)
       values ('biz_Cancel', $1, 'golden_hour_message', 'scheduled', 'score_high',
               $2::timestamptz, 'auto', 'relance')`,
      [ids[0], new Date(NOW.getTime() - 60_000).toISOString()],
    );
    const due = async () =>
      (
        await t.db.query<{ due: { companyId: string }[] }>(
          'select stayput.due_actions($1::timestamptz, 500) as due',
          [NOW.toISOString()],
        )
      )[0]!.due.filter((a) => a.companyId === 'biz_Cancel').length;
    expect(await due()).toBe(1);

    // The owner cancels: Whop takes the access away, and tells StayPut.
    subscription.status = 'canceled';
    await membershipWebhook(env, 'membership.deactivated', subscription);

    // The hourly job reads the level again first.
    await runActions.run({
      config: readConfig(ENV),
      db: { ...t.db, close: () => Promise.resolve() },
      whop: env.whop.client,
      syncWhop: null,
      now: NOW,
    });
    const [plan] = await t.db.query<{ tier: string; autopilot_paused: boolean; mode: string }>(
      `select p.tier, p.autopilot_paused, c.mode from stayput.company_plans p
         join stayput.companies c on c.id = p.company_id where p.company_id = 'biz_Cancel'`,
    );
    expect(plan).toEqual({ tier: 'free', autopilot_paused: true, mode: 'manual' });
    // StayPut's follow-up waits (not run, not deleted); nothing new of its own is planned.
    expect(await due()).toBe(0);
    const actions = await t.db.query<{ status: string; approved_by: string | null }>(
      `select status, approved_by from stayput.actions where company_id = 'biz_Cancel'`,
    );
    expect(actions).toEqual([{ status: 'scheduled', approved_by: 'auto' }]);
    // The data stays: the members, read as before.
    const opened = await session(env, 'biz_Cancel', 'user_CancelOwner');
    expect(opened.plan.tier).toBe('free');
    const members = (await (
      await env.request('/api/creator/biz_Cancel/members', await as('user_CancelOwner'))
    ).json()) as MembersPage;
    expect(members.members.map((m) => m.id).sort()).toEqual([...ids].sort());
  });

  it('6. a moderator of a Scale community has Scale: the owner pays, the team has it', async () => {
    const env = setup();
    await community(env, 'biz_Team', 'user_TeamOwner', ['user_TeamMod']);
    // The owner holds Scale, its yearly plan.
    env.whop.memberships.push(
      appMembership(
        'mem_Team1',
        'user_TeamOwner',
        APP_PRODUCT,
        SCALE_YEARLY,
        'active',
        new Date(NOW.getTime() + 300 * DAY),
      ),
    );
    // The moderator has no StayPut subscription of their own, and opens StayPut first.
    const opened = await session(env, 'biz_Team', 'user_TeamMod');
    expect(opened.plan).toMatchObject({ tier: 'scale', source: 'whop' });
    const auto = await env.request(
      '/api/creator/biz_Team/mode',
      await as('user_TeamMod', post({ mode: 'auto' })),
    );
    expect(auto.status).toBe(200);
  });

  it('7. Whop unreachable: the last level known stays', async () => {
    const env = setup();
    await community(env, 'biz_Down', 'user_DownOwner');
    env.whop.memberships.push(
      appMembership(
        'mem_Down1',
        'user_DownOwner',
        APP_PRODUCT,
        PRO_MONTHLY,
        'active',
        new Date(NOW.getTime() + 20 * DAY),
      ),
    );
    expect((await session(env, 'biz_Down', 'user_DownOwner')).plan.tier).toBe('pro');

    // Five minutes later Whop does not answer.
    await t.db.query(
      `update stayput.company_plans set fresh_until = $2::timestamptz where company_id = $1`,
      ['biz_Down', new Date(NOW.getTime() - 1000).toISOString()],
    );
    env.whop.state.down = true;
    const opened = await session(env, 'biz_Down', 'user_DownOwner');
    expect(opened.plan).toMatchObject({ tier: 'pro', stale: true });
    // Still Pro for what Pro opens.
    const approve = await env.request(
      '/api/creator/biz_Down/actions/approve',
      await as('user_DownOwner', post({})),
    );
    expect(approve.status).toBe(200);
    const [row] = await t.db.query<{ tier: string; failed_at: Date | null; last_error: string }>(
      `select tier, failed_at, last_error from stayput.company_plans where company_id = 'biz_Down'`,
    );
    expect(row).toMatchObject({ tier: 'pro', failed_at: NOW });
    expect(row?.last_error).toMatch(/down/i);
  });
});

describe('the private beta (INVITE_ONLY)', () => {
  /** A delivery from Whop about `company`, signed as Whop signs it. */
  async function companyWebhook(env: ReturnType<typeof setup>, id: string, company: string) {
    const body = JSON.stringify({
      type: 'member.created',
      company_id: company,
      data: { id: `mber_${id}`, company: { id: company }, user: { id: `user_${id}` } },
    });
    const res = await env.request('/webhooks/whop', {
      method: 'POST',
      body,
      headers: {
        'webhook-id': `msg_${id}`,
        'webhook-timestamp': String(NOW_S),
        'webhook-signature': await signWebhook(body, SECRET, `msg_${id}`, NOW_S),
        'content-type': 'application/json',
      },
    });
    expect(res.status).toBe(200);
    await settle();
    return (await res.json()) as { received: boolean; ignored?: boolean };
  }
  const kept = async (company: string) =>
    (
      await t.db.query<{ n: number }>(
        'select count(*)::int as n from stayput.webhook_events where company_id = $1',
        [company],
      )
    )[0]?.n;
  const requests = async (env: ReturnType<typeof setup>) => {
    const res = await env.request('/api/admin/companies', await as(ADMIN));
    expect(res.status).toBe(200);
    return ((await res.json()) as AdminCompaniesView).requests;
  };

  it('opens StayPut to the invited, the operator’s community and the founder; shuts the rest', async () => {
    const env = setup({ ...ENV, INVITE_ONLY: 'true', OPERATOR_COMPANY_ID: 'biz_Operator' });
    const closed = async (res: Response) => {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_invited');
    };

    // A community that installed StayPut through a link passed on: the door shut, and nothing of
    // it kept (the session that records a community is never reached) but its request, for the
    // founder: its name, read from Whop, and when. Its creator is asked for nothing.
    env.whop.access['user_StrangerOwner:biz_Stranger'] = 'admin';
    await closed(
      await env.request('/api/creator/biz_Stranger/session', await as('user_StrangerOwner')),
    );
    await settle();
    expect(await t.db.query(`select id from stayput.companies where id = 'biz_Stranger'`)).toEqual(
      [],
    );
    expect(await requests(env)).toEqual([
      {
        companyId: 'biz_Stranger',
        name: 'Club Stranger',
        firstSeenAt: NOW.toISOString(),
        lastSeenAt: NOW.toISOString(),
        visits: 1,
      },
    ]);
    // The dashboard's other calls of the same visit count once.
    await closed(
      await env.request('/api/creator/biz_Stranger/dashboard', await as('user_StrangerOwner')),
    );
    await settle();
    expect((await requests(env))[0]?.visits).toBe(1);
    // Its members, opening StayPut in the community, find the same, and ask for nothing.
    env.whop.experiences.exp_Stranger = 'biz_Stranger';
    env.whop.access['user_StrangerMember:exp_Stranger'] = 'customer';
    await closed(
      await env.request('/api/member/exp_Stranger/home', await as('user_StrangerMember')),
    );
    await settle();
    expect(
      await t.db.query(`select user_id from stayput.access_requests where company_id = $1`, [
        'biz_Stranger',
      ]),
    ).toEqual([{ user_id: 'user_StrangerOwner' }]);
    // Its webhooks are acknowledged, never kept: no member, no automation.
    expect(await companyWebhook(env, 'Stranger1', 'biz_Stranger')).toEqual({
      received: true,
      ignored: true,
    });
    expect(await kept('biz_Stranger')).toBe(0);
    expect(await t.db.query(`select id from stayput.companies where id = 'biz_Stranger'`)).toEqual(
      [],
    );
    // A request the founder does not answer can be ignored.
    expect(
      (await env.request('/api/admin/requests/biz_Stranger', await as(ADMIN, { method: 'DELETE' })))
        .status,
    ).toBe(200);
    expect(await requests(env)).toEqual([]);
    // Nobody but the founder reads or answers the requests.
    expect((await env.request('/api/admin/companies', await as('user_StrangerOwner'))).status).toBe(
      404,
    );

    // The operator's own community opens without an invitation.
    await community(env, 'biz_Operator', 'user_OperatorOwner');
    expect(
      (await env.request('/api/creator/biz_Operator/session', await as('user_OperatorOwner')))
        .status,
    ).toBe(200);
    await settle();
    expect(await requests(env)).toEqual([]);

    // A tester installs StayPut from the founder's link: the founder sees the request and invites
    // it in one click; it opens, and the request is gone.
    await community(env, 'biz_Tester', 'user_TesterOwner');
    await closed(
      await env.request('/api/creator/biz_Tester/session', await as('user_TesterOwner')),
    );
    await settle();
    expect((await requests(env)).map((r) => [r.companyId, r.name])).toEqual([
      ['biz_Tester', 'Club Tester'],
    ]);
    const invite = await env.request(
      '/api/admin/founders',
      await as(ADMIN, post({ companyId: 'biz_Tester' })),
    );
    expect(invite.status).toBe(200);
    expect(((await invite.json()) as AdminCompaniesView).requests).toEqual([]);
    expect(await t.db.query('select company_id from stayput.access_requests')).toEqual([]);
    expect(
      (await env.request('/api/creator/biz_Tester/session', await as('user_TesterOwner'))).status,
    ).toBe(200);
    await settle();
    expect(await companyWebhook(env, 'Tester1', 'biz_Tester')).toEqual({
      received: true,
      duplicate: false,
    });
    expect(await kept('biz_Tester')).toBe(1);
    // Removed from the registry: shut again.
    expect(
      (await env.request('/api/admin/founders/biz_Tester', await as(ADMIN, { method: 'DELETE' })))
        .status,
    ).toBe(200);
    await closed(
      await env.request('/api/creator/biz_Tester/session', await as('user_TesterOwner')),
    );
    await settle();

    // The founder opens any community they are on the team of; its webhooks are then kept, and
    // its team stays shut out.
    env.whop.access[`${ADMIN}:biz_Stranger`] = 'admin';
    expect((await env.request('/api/creator/biz_Stranger/session', await as(ADMIN))).status).toBe(
      200,
    );
    await settle();
    expect((await companyWebhook(env, 'Stranger2', 'biz_Stranger')).ignored).toBeUndefined();
    expect(await kept('biz_Stranger')).toBe(1);
    await closed(
      await env.request('/api/creator/biz_Stranger/session', await as('user_StrangerOwner')),
    );
  });
});
