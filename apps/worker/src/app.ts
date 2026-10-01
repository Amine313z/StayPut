import {
  canOpenCreatorView,
  canOpenMemberView,
  isCompanyId,
  isExperienceId,
  type AccessLevel,
  type CreatorSession,
  type HealthReport,
  type MemberSession,
  type SignInMethod,
} from '@stayput/core';
import {
  USER_TOKEN_HEADER,
  WhopApiError,
  base64Url,
  createWhopClient,
  createWhopOAuth,
  pkcePair,
  verifyUserToken,
  verifyWebhook,
  whopUserTokenKeys,
  type WhopClient,
  type WhopOAuth,
} from '@stayput/whop';
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { CryptoKey, JWTVerifyGetKey } from 'jose';
import { AccessCache } from './access';
import { createPostgresDb, type ClosableDb, type Db } from './db';
import { readConfig, type Config, type Env } from './env';
import { API_HEADERS, apiError } from './http';
import { LATEST_MIGRATION } from './schema-version';
import {
  LOGIN_COOKIE,
  LOGIN_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  cookie,
  readCookie,
  safeNext,
  sign,
  signingKey,
  verify,
} from './session';

/** What the routes depend on, injected so that tests run them against fakes. */
export interface AppDeps {
  now(): Date;
  /** A database client for one request, or null when the Worker has no database binding. */
  openDb(env: Env): ClosableDb | null;
  /** The Whop API with the app key, or null when the key is not configured. */
  whopClient(config: Config): WhopClient | null;
  /** Whop's public keys for the iframe token. */
  userTokenKeys(config: Config): JWTVerifyGetKey | CryptoKey;
  /** "Sign in with Whop" outside the iframe (sandbox), or null without an app id. */
  oauth(config: Config): WhopOAuth | null;
  accessCache: AccessCache;
}

export function productionDeps(): AppDeps {
  return {
    now: () => new Date(),
    openDb: (env) => (env.HYPERDRIVE ? createPostgresDb(env.HYPERDRIVE.connectionString) : null),
    whopClient: (config) =>
      config.apiKey ? createWhopClient({ apiKey: config.apiKey, env: config.whopEnv }) : null,
    userTokenKeys: (config) => whopUserTokenKeys(config.whopEnv),
    oauth: (config) =>
      config.appId ? createWhopOAuth({ env: config.whopEnv, clientId: config.appId }) : null,
    accessCache: new AccessCache(),
  };
}

type AppEnv = {
  Bindings: Env;
  Variables: { config: Config; userId: string; via: SignInMethod; db: ClosableDb | null };
};

/** Whop's deliveries are small JSON documents; anything bigger is refused unread. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
const HEALTH_CACHE_MS = 30_000;
/** /health never waits longer than this for the database: a silent database is reported. */
export const HEALTH_DB_TIMEOUT_MS = 5_000;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  let health: { report: HealthReport; at: number } | null = null;

  app.use('*', async (c, next) => {
    c.set('config', readConfig(c.env));
    await next();
    for (const [name, value] of Object.entries(API_HEADERS)) c.res.headers.set(name, value);
  });

  /** Opens the request's database client, closed once the response is sent. */
  const withDb = createMiddleware<AppEnv>(async (c, next) => {
    const db = deps.openDb(c.env);
    c.set('db', db);
    try {
      await next();
    } finally {
      if (db) defer(c, db.close());
    }
  });

  /**
   * Every /api call: the Whop user behind the iframe token, or, in the sandbox, the one who
   * signed in with Whop outside the iframe (session cookie). 401 otherwise, saying where to sign
   * in when that is possible.
   */
  const authenticate = createMiddleware<AppEnv>(async (c, next) => {
    const config = c.get('config');
    const token = c.req.header(USER_TOKEN_HEADER);
    let userId: string | null = null;
    let via: SignInMethod = 'iframe';
    if (token) {
      if (config.appId) {
        const verified = await verifyUserToken(token, {
          appId: config.appId,
          keys: deps.userTokenKeys(config),
          now: deps.now(),
        });
        userId = verified?.userId ?? null;
      }
    } else {
      if (config.oauthLogin && config.apiKey) {
        const session = await verify(
          readCookie(c.req.header('cookie'), SESSION_COOKIE),
          await signingKey(config.apiKey),
          { purpose: 'session', env: config.whopEnv, nowSeconds: nowSeconds() },
        );
        if (session) {
          userId = session.userId;
          via = 'login';
        }
      }
      if (!userId && config.dev) {
        // Local development outside Whop's iframe (ENVIRONMENT=development only).
        userId = config.dev.userId;
      }
    }
    if (!userId) {
      return apiError(
        'unauthenticated',
        'missing or invalid Whop user token',
        config.oauthLogin ? { login: '/auth/login' } : {},
      );
    }
    c.set('userId', userId);
    c.set('via', via);
    await next();
    return undefined;
  });

  const nowSeconds = () => Math.floor(deps.now().getTime() / 1000);

  /** The current user's access to a Whop resource, or the error response to send. */
  async function accessTo(c: Context<AppEnv>, resourceId: string): Promise<AccessLevel | Response> {
    const config = c.get('config');
    const userId = c.get('userId');
    if (config.dev?.accessLevel && userId === config.dev.userId) return config.dev.accessLevel;
    const now = deps.now().getTime();
    const cached = deps.accessCache.get(userId, resourceId, now);
    if (cached) return cached;
    const whop = deps.whopClient(config);
    if (!whop) return apiError('not_configured', 'WHOP_API_KEY is not set');
    let level: AccessLevel;
    try {
      level = (await whop.checkAccess(userId, resourceId)).accessLevel;
    } catch (error) {
      // An id Whop does not know (or refuses to look up) gives no access; anything else is
      // Whop being unavailable, or our key lacking a permission: retry later.
      if (error instanceof WhopApiError && [400, 404, 422].includes(error.status)) {
        level = 'no_access';
      } else {
        console.error('Whop access check failed:', describe(error));
        return apiError('whop_unavailable', 'could not check access with Whop');
      }
    }
    deps.accessCache.set(userId, resourceId, level, now);
    return level;
  }

  // A signed-in browser sends its session cookie on every request to this site, even one a
  // foreign page triggers: changing anything takes a header such a page cannot set (SameSite=Lax
  // already keeps the cookie off cross-site POSTs).
  app.use('/api/*', async (c, next) => {
    const changes = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const hasSession = readCookie(c.req.header('cookie'), SESSION_COOKIE) !== undefined;
    if (changes && hasSession && c.req.header(CSRF_HEADER) === undefined) {
      return apiError('forbidden', `missing ${CSRF_HEADER} header`);
    }
    await next();
    return undefined;
  });

  /** "Sign in with Whop": PKCE pair and state in a signed cookie, then off to Whop. */
  app.get('/auth/login', async (c) => {
    const config = c.get('config');
    const oauth = deps.oauth(config);
    if (!config.oauthLogin || !config.apiKey || !oauth) {
      return apiError('not_found', 'signing in outside Whop is off here');
    }
    const { verifier, challenge } = await pkcePair();
    const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
    const login = await sign(
      {
        purpose: 'login',
        state,
        verifier,
        next: safeNext(c.req.query('next')),
        env: config.whopEnv,
        exp: nowSeconds() + LOGIN_TTL_SECONDS,
      },
      await signingKey(config.apiKey),
    );
    c.header('Set-Cookie', cookie(LOGIN_COOKIE, login, LOGIN_TTL_SECONDS));
    return c.redirect(oauth.authorizeUrl({ redirectUri: callbackUrl(c), state, challenge }), 302);
  });

  /**
   * Back from Whop: the code against tokens, the tokens against the user, then a session cookie.
   * StayPut keeps no Whop token. Any failure returns to the page with `?login=failed`.
   */
  app.get('/auth/callback', async (c) => {
    const config = c.get('config');
    const oauth = deps.oauth(config);
    if (!config.oauthLogin || !config.apiKey || !oauth) {
      return apiError('not_found', 'signing in outside Whop is off here');
    }
    const key = await signingKey(config.apiKey);
    const login = await verify(readCookie(c.req.header('cookie'), LOGIN_COOKIE), key, {
      purpose: 'login',
      env: config.whopEnv,
      nowSeconds: nowSeconds(),
    });
    c.header('Set-Cookie', cookie(LOGIN_COOKIE, '', 0), { append: true });
    const failed = (reason: string) => {
      console.warn(`Sign-in with Whop failed: ${reason}`);
      return c.redirect(withQuery(login?.next ?? '/', 'login', 'failed'), 302);
    };
    const code = c.req.query('code');
    if (!login) return failed('no sign-in under way (cookie missing or expired)');
    if (c.req.query('error')) return failed(`Whop answered ${c.req.query('error')}`);
    if (!code || c.req.query('state') !== login.state) return failed('state mismatch');
    try {
      const tokens = await oauth.exchangeCode({
        code,
        redirectUri: callbackUrl(c),
        verifier: login.verifier,
      });
      const user = await oauth.user(tokens.accessToken);
      if (tokens.refreshToken) {
        const refreshToken = tokens.refreshToken;
        defer(
          c,
          oauth.revoke(refreshToken).catch((error: unknown) => {
            console.warn('Could not revoke the Whop refresh token:', describe(error));
          }),
        );
      }
      const session = await sign(
        {
          purpose: 'session',
          userId: user.userId,
          env: config.whopEnv,
          exp: nowSeconds() + SESSION_TTL_SECONDS,
        },
        key,
      );
      c.header('Set-Cookie', cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS), {
        append: true,
      });
      return c.redirect(login.next, 302);
    } catch (error) {
      return failed(describe(error));
    }
  });

  app.get('/auth/logout', (c) => {
    c.header('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
    return c.redirect('/', 302);
  });

  app.get('/health', withDb, async (c) => {
    const now = deps.now().getTime();
    if (!health || now - health.at >= HEALTH_CACHE_MS) {
      const report: HealthReport = {
        status: 'ok',
        whopEnv: c.get('config').whopEnv,
        database: await databaseState(c.get('db')),
      };
      if (report.database !== 'ok') report.status = 'degraded';
      health = { report, at: now };
    }
    return c.json(health.report, health.report.status === 'ok' ? 200 : 503);
  });

  app.post('/webhooks/whop', withDb, async (c) => {
    const config = c.get('config');
    const db = c.get('db');
    if (!config.webhookSecret || !db) {
      // Whop retries a failed delivery: nothing is lost while the Worker is being set up.
      return apiError('not_configured', 'webhooks are not configured yet');
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_WEBHOOK_BYTES) {
      return apiError('payload_too_large', 'webhook payload too large');
    }
    const raw = await c.req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) {
      return apiError('payload_too_large', 'webhook payload too large');
    }
    const verification = await verifyWebhook(
      raw,
      c.req.raw.headers,
      config.webhookSecret,
      deps.now(),
    );
    if (!verification.ok) {
      return apiError('unauthenticated', `invalid webhook: ${verification.reason}`);
    }
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return apiError('invalid_request', 'the webhook body is not JSON');
    }
    const type = isObject(event) && typeof event.type === 'string' ? event.type : null;
    if (!type) return apiError('invalid_request', 'the webhook has no type');
    // Stored as received; processing (Phase 2) reads the table, so a delivery is never lost
    // and a retry of the same delivery (same webhook-id) is stored once.
    const stored = await db.query(
      `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
       values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)
       on conflict (id) do nothing
       returning id`,
      [verification.id, companyIdOf(event), type, raw, deps.now().toISOString()],
    );
    return c.json({ received: true, duplicate: stored.length === 0 });
  });

  app.get('/api/creator/:companyId/session', authenticate, withDb, async (c) => {
    const companyId = c.req.param('companyId');
    if (!isCompanyId(companyId)) return apiError('invalid_request', 'not a Whop company id');
    const level = await accessTo(c, companyId);
    if (level instanceof Response) return level;
    if (!canOpenCreatorView(level)) {
      return apiError('forbidden', "the creator view is for the account's team");
    }
    const userId = c.get('userId');
    const db = c.get('db');
    if (db) await recordAdmin(db, companyId, userId, deps.now());
    const session: CreatorSession = { companyId, userId, accessLevel: level, via: c.get('via') };
    return c.json(session);
  });

  app.get('/api/member/:experienceId/session', authenticate, async (c) => {
    const experienceId = c.req.param('experienceId');
    if (!isExperienceId(experienceId)) {
      return apiError('invalid_request', 'not a Whop experience id');
    }
    const level = await accessTo(c, experienceId);
    if (level instanceof Response) return level;
    if (!canOpenMemberView(level)) return apiError('forbidden', 'no access to this experience');
    const session: MemberSession = {
      experienceId,
      userId: c.get('userId'),
      accessLevel: level,
      via: c.get('via'),
    };
    return c.json(session);
  });

  // The public "Verified retention" badge (SPEC Phase 6): route reserved, answered once a
  // creator can turn the badge on.
  app.get('/badge/:file', (c) => {
    if (!/^biz_[A-Za-z0-9]+\.svg$/.test(c.req.param('file'))) {
      return apiError('invalid_request', 'expected /badge/<company id>.svg');
    }
    return apiError('not_found', 'no public badge for this company');
  });

  // The public page of a proof (SPEC Phase 5): route reserved until proofs exist.
  app.get('/v/:proofId', (c) => {
    if (!/^[0-9a-f-]{36}$/.test(c.req.param('proofId'))) {
      return apiError('invalid_request', 'not a proof id');
    }
    return apiError('not_found', 'no such proof');
  });

  app.notFound(() => apiError('not_found', 'no such route'));
  app.onError((error) => {
    console.error('Unhandled error:', describe(error));
    return apiError('internal', 'unexpected error');
  });

  return app;
}

async function databaseState(db: Db | null): Promise<HealthReport['database']> {
  if (!db) return 'not_configured';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), HEALTH_DB_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      db.query<{ name: string | null }>('select max(name) as name from stayput.schema_migrations'),
      silence,
    ]);
    if (answer === 'timeout') return 'timeout';
    return answer[0]?.name === LATEST_MIGRATION ? 'ok' : 'outdated';
  } catch (error) {
    // 42P01 / 3F000: the table or the schema is missing, the database is reachable.
    const code = isObject(error) ? error.code : undefined;
    return code === '42P01' || code === '3F000' ? 'outdated' : 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A team member of the company opened the dashboard: the company exists for StayPut (created on
 * the first visit, reactivated after an uninstall), and the Whop check is recorded for RLS.
 */
async function recordAdmin(db: ClosableDb, companyId: string, userId: string, now: Date) {
  const at = now.toISOString();
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into stayput.companies (id, installed_at) values ($1, $2::timestamptz)
       on conflict (id) do update set status = 'active', uninstalled_at = null
         where stayput.companies.status = 'uninstalled'`,
      [companyId, at],
    );
    await tx.query(
      `insert into stayput.company_settings (company_id) values ($1) on conflict do nothing`,
      [companyId],
    );
    await tx.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, $2, $3::timestamptz)
       on conflict (company_id, user_id) do update set verified_at = excluded.verified_at`,
      [companyId, userId, at],
    );
  });
}

/** The company a delivery concerns, when the payload names one. */
export function companyIdOf(event: unknown): string | null {
  if (!isObject(event)) return null;
  const data = isObject(event.data) ? event.data : {};
  const candidates = [
    event.company_id,
    event.account_id,
    data.company_id,
    data.account_id,
    isObject(data.account) ? data.account.id : undefined,
    isObject(data.company) ? data.company.id : undefined,
  ];
  return candidates.find(isCompanyId) ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Changing requests from a signed-in browser carry it (see the /api guard). */
export const CSRF_HEADER = 'x-stayput-csrf';

/** Where Whop sends the browser back; declared on the app (`redirect_uris`). */
function callbackUrl(c: Context<AppEnv>): string {
  return `${new URL(c.req.url).origin}/auth/callback`;
}

function withQuery(path: string, name: string, value: string): string {
  const url = new URL(path, 'https://stayput.invalid');
  url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
}

function defer(c: Context<AppEnv>, promise: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No execution context (tests): let it settle on its own.
    promise.catch(() => {});
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
