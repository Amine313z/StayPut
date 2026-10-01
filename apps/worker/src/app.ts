import {
  CSRF_HEADER,
  NICHE_PRESETS,
  RISK_FACTORS,
  canOpenCreatorView,
  canOpenMemberView,
  isCompanyId,
  isExperienceId,
  isNiche,
  normalizeWeights,
  type AccessLevel,
  type CreatorSession,
  type DiscordChannelsUpdate,
  type HealthReport,
  type MemberSession,
  type RiskSettingsView,
  type SignInMethod,
  type SyncRun,
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
import { createDiscordClient, type DiscordClient } from './discord';
import { readConfig, type Config, type Env } from './env';
import { API_HEADERS, apiError } from './http';
import {
  DISCORD_CALLBACK_PATH,
  TELEGRAM_WEBHOOK_PATH,
  chooseDiscordChannels,
  companyOfExperience,
  connectDiscordServer,
  disconnectDiscordServer,
  disconnectTelegramGroup,
  discordAvailable,
  fileTelegramUpdate,
  readDiscordChannels,
  readIntegrations,
  readMemberTelegram,
  type LinkContext,
} from './integrations';
import { readInsights, readMembers, readRiskSettings, readSyncStatus } from './members';
import { REQUEST_RISK_BATCH, refreshDetection } from './risk';
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
import { SYNC_REQUEST_BUDGET, summarize, syncIfFree } from './sync';
import {
  botLanguage,
  createTelegramClient,
  telegramWebhookSecret,
  timingSafeEqual,
  type TelegramClient,
} from './telegram';

/** What the routes depend on, injected so that tests run them against fakes. */
export interface AppDeps {
  now(): Date;
  /** A database client for one request, or null when the Worker has no database binding. */
  openDb(env: Env): ClosableDb | null;
  /**
   * The Whop API with the app key, or null when the key is not configured. The sync asks for
   * `maxRetries: 0`: each call is then one subrequest of its budget.
   */
  whopClient(config: Config, options?: { maxRetries?: number }): WhopClient | null;
  /** Whop's public keys for the iframe token. */
  userTokenKeys(config: Config): JWTVerifyGetKey | CryptoKey;
  /** "Sign in with Whop" outside the iframe (sandbox), or null without an app id. */
  oauth(config: Config): WhopOAuth | null;
  /** Discord's API with StayPut's bot, or null when the Discord module is not set up. */
  discord(config: Config): DiscordClient | null;
  /** Telegram's Bot API with StayPut's bot, or null when the Telegram module is not set up. */
  telegram(config: Config): TelegramClient | null;
  accessCache: AccessCache;
}

export function productionDeps(): AppDeps {
  // One client per token and isolate: they remember the application and the bot they read.
  let discord: { key: string; client: DiscordClient } | null = null;
  let telegram: { key: string; client: TelegramClient } | null = null;
  return {
    now: () => new Date(),
    openDb: (env) => (env.HYPERDRIVE ? createPostgresDb(env.HYPERDRIVE.connectionString) : null),
    whopClient: (config, options = {}) =>
      config.apiKey
        ? createWhopClient({
            apiKey: config.apiKey,
            env: config.whopEnv,
            ...(options.maxRetries === undefined
              ? {}
              : { retry: { maxRetries: options.maxRetries } }),
          })
        : null,
    userTokenKeys: (config) => whopUserTokenKeys(config.whopEnv),
    oauth: (config) =>
      config.appId ? createWhopOAuth({ env: config.whopEnv, clientId: config.appId }) : null,
    discord: (config) => {
      if (!config.discord) return null;
      const key = `${config.discord.botToken}:${config.discord.clientSecret ?? ''}`;
      if (discord?.key !== key) {
        discord = {
          key,
          client: createDiscordClient({
            botToken: config.discord.botToken,
            clientSecret: config.discord.clientSecret,
          }),
        };
      }
      return discord.client;
    },
    telegram: (config) => {
      if (!config.telegram) return null;
      const key = config.telegram.botToken;
      if (telegram?.key !== key) {
        telegram = { key, client: createTelegramClient({ botToken: key }) };
      }
      return telegram.client;
    },
    accessCache: new AccessCache(),
  };
}

type AppEnv = {
  Bindings: Env;
  Variables: {
    config: Config;
    userId: string;
    via: SignInMethod;
    db: ClosableDb | null;
    /** Set by requireCreator: the company of the route, checked with Whop. */
    companyId: string;
    accessLevel: AccessLevel;
    /** Set by requireMember: the experience of the route, checked with Whop. */
    experienceId: string;
  };
};

/** Telegram's updates are small JSON documents; anything bigger is refused unread. */
export const MAX_TELEGRAM_UPDATE_BYTES = 64 * 1024;

/** Whop's deliveries are small JSON documents; anything bigger is refused unread. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
const HEALTH_CACHE_MS = 30_000;
/** /health never waits longer than this for the database: a silent database is reported. */
export const HEALTH_DB_TIMEOUT_MS = 5_000;
/**
 * Opening the dashboard brings the company's data up to date in the background (the backfill,
 * the first time), at most this often. The access check may have used a Whop call: the
 * background reading gets what is left of the budget.
 */
export const OPEN_SYNC_INTERVAL_SECONDS = 10 * 60;
/** "Sync now" in the dashboard: at most once a minute. */
export const MANUAL_SYNC_INTERVAL_SECONDS = 60;
/** « Sync now » also reads the Discord channels not read for this long (their cadence is 3 h). */
export const MANUAL_DISCORD_REFRESH_MINUTES = 10;
const REQUEST_SYNC_BUDGET = SYNC_REQUEST_BUDGET - 2;

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

  /** The routes of the creator view: a company id, and a team member of it (checked with Whop). */
  const requireCreator = createMiddleware<AppEnv>(async (c, next) => {
    const companyId = c.req.param('companyId');
    if (!isCompanyId(companyId)) return apiError('invalid_request', 'not a Whop company id');
    const level = await accessTo(c, companyId);
    if (level instanceof Response) return level;
    if (!canOpenCreatorView(level)) {
      return apiError('forbidden', "the creator view is for the account's team");
    }
    c.set('companyId', companyId);
    c.set('accessLevel', level);
    await next();
    return undefined;
  });

  /**
   * Work after the response (the Worker's waitUntil), on a database client of its own: the
   * request's client closes with the response.
   */
  function inBackground(
    c: Context<AppEnv>,
    label: string,
    work: (db: ClosableDb) => Promise<void>,
  ): void {
    const db = deps.openDb(c.env);
    if (!db) return;
    defer(
      c,
      work(db)
        .catch((error: unknown) => {
          console.error(`${label} failed:`, describe(error));
        })
        .finally(() => db.close()),
    );
  }

  /**
   * Brings the company's data up to date after the response, unless it was done less than
   * `minIntervalSeconds` ago.
   */
  function syncInBackground(
    c: Context<AppEnv>,
    companyId: string,
    minIntervalSeconds = OPEN_SYNC_INTERVAL_SECONDS,
  ): void {
    const config = c.get('config');
    const whop = deps.whopClient(config, { maxRetries: 0 });
    if (!whop) return;
    inBackground(c, 'Background sync', async (db) => {
      const now = deps.now();
      // The creator may have just granted a permission: what Whop refused is tried again.
      const result = await syncIfFree(
        { db, whop, discord: deps.discord(config), now, budget: { left: REQUEST_SYNC_BUDGET } },
        companyId,
        minIntervalSeconds,
        { retryFailed: true },
      );
      if (result) {
        console.info(summarize(result));
        await db.query('select stayput.refresh_stats($1::timestamptz, $2)', [
          now.toISOString(),
          companyId,
        ]);
      }
      // The scores due (on the first visit, every member's) now rather than at the next hour.
      await refreshDetection(db, companyId, now, REQUEST_RISK_BATCH);
    });
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

  app.post('/webhooks/whop', async (c) => {
    const config = c.get('config');
    if (!config.webhookSecret) {
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
    const db = deps.openDb(c.env);
    if (!db) return apiError('not_configured', 'webhooks are not configured yet');
    const now = deps.now();
    // Stored as received, so that a delivery is never lost; a retry of the same delivery (same
    // webhook-id) is stored once.
    let stored: unknown[];
    try {
      stored = await db.query(
        `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
         values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)
         on conflict (id) do nothing
         returning id`,
        [verification.id, companyIdOf(event), type, raw, now.toISOString()],
      );
    } catch (error) {
      defer(c, db.close());
      throw error;
    }
    // Filed after the answer (SPEC Phase 2, 1); the cron retries a delivery that fails.
    defer(
      c,
      fileWebhook(db, verification.id, now).finally(() => db.close()),
    );
    return c.json({ received: true, duplicate: stored.length === 0 });
  });

  app.get('/api/creator/:companyId/session', authenticate, withDb, requireCreator, async (c) => {
    const companyId = c.get('companyId');
    const userId = c.get('userId');
    const db = c.get('db');
    if (db) {
      await recordAdmin(db, companyId, userId, deps.now());
      // The first visit starts the backfill, later ones bring the data up to date (SPEC
      // Phase 2, 2).
      syncInBackground(c, companyId);
    }
    const session: CreatorSession = {
      companyId,
      userId,
      accessLevel: c.get('accessLevel'),
      via: c.get('via'),
    };
    return c.json(session);
  });

  /** Where the reading of the company's Whop data stands. */
  app.get('/api/creator/:companyId/sync', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    return c.json(await readSyncStatus(db, c.get('userId'), c.get('companyId')));
  });

  /**
   * "Sync now": reads what is due from Whop during the request, and the Discord channels not
   * read for a few minutes, then the status.
   */
  app.post('/api/creator/:companyId/sync', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    const config = c.get('config');
    const whop = deps.whopClient(config, { maxRetries: 0 });
    if (!db || !whop) return apiError('not_configured', 'the database or the Whop key is missing');
    const companyId = c.get('companyId');
    const now = deps.now();
    const result = await syncIfFree(
      { db, whop, discord: deps.discord(config), now, budget: { left: REQUEST_SYNC_BUDGET } },
      companyId,
      MANUAL_SYNC_INTERVAL_SECONDS,
      { retryFailed: true, refreshDiscordAfterMinutes: MANUAL_DISCORD_REFRESH_MINUTES },
    );
    if (result) {
      console.info(summarize(result));
      await db.query('select stayput.refresh_stats($1::timestamptz, $2)', [
        now.toISOString(),
        companyId,
      ]);
      await refreshDetection(db, companyId, now, REQUEST_RISK_BATCH);
    }
    const run: SyncRun = {
      ...(await readSyncStatus(db, c.get('userId'), companyId)),
      ran: result !== null,
      calls: result?.calls ?? 0,
    };
    return c.json(run);
  });

  /** The members StayPut collected, with their membership, last payment and recent activity. */
  app.get('/api/creator/:companyId/members', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    return c.json(await readMembers(db, c.get('userId'), c.get('companyId'), deps.now()));
  });

  /** What links to connect Discord and Telegram need to know of this request. */
  async function linkContext(c: Context<AppEnv>): Promise<LinkContext> {
    const config = c.get('config');
    return {
      config,
      origin: new URL(c.req.url).origin,
      now: deps.now(),
      discord: deps.discord(config),
      telegram: deps.telegram(config),
      signingKey: config.apiKey ? await signingKey(config.apiKey) : null,
      language: botLanguage(c.req.query('lang')),
    };
  }

  /** The weekly analyses: cohorts leaving faster than the others, lessons members stall after. */
  app.get('/api/creator/:companyId/insights', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    return c.json(await readInsights(db, c.get('userId'), c.get('companyId')));
  });

  /** How the risk score is computed for this company (SPEC Phase 3: weights, thresholds). */
  app.get(
    '/api/creator/:companyId/settings/risk',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const settings = await readRiskSettings(db, c.get('userId'), c.get('companyId'));
      return settings ? c.json(settings) : apiError('not_found', 'no settings for this company');
    },
  );

  /**
   * New settings: the weights are brought back to a sum of 1, every score is due again and the
   * first ones are computed at once.
   */
  app.put(
    '/api/creator/:companyId/settings/risk',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<Partial<RiskSettingsView>>().catch(() => null);
      const settings = validRiskSettings(body);
      if (!settings) return apiError('invalid_request', 'expected the risk settings');
      const companyId = c.get('companyId');
      const now = deps.now();
      await db.query(
        'select stayput.save_risk_settings($1, $2, $3::text::jsonb, $4, $5, $6, $7::timestamptz)',
        [
          companyId,
          settings.niche,
          JSON.stringify(settings.weights),
          settings.recencyThresholdDays,
          settings.mediumFrom,
          settings.highFrom,
          now.toISOString(),
        ],
      );
      inBackground(c, 'Rescoring', async (work) => {
        await refreshDetection(work, companyId, now, REQUEST_RISK_BATCH);
      });
      return c.json((await readRiskSettings(db, c.get('userId'), companyId)) ?? settings);
    },
  );

  /** Discord and Telegram: what is connected, and the links to connect more. */
  app.get(
    '/api/creator/:companyId/integrations',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      return c.json(
        await readIntegrations(db, c.get('userId'), c.get('companyId'), await linkContext(c)),
      );
    },
  );

  /** The text channels of a connected server: which the bot can read, which are followed. */
  app.get(
    '/api/creator/:companyId/discord/:guildId/channels',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      const discord = deps.discord(c.get('config'));
      if (!db || !discord) return apiError('not_configured', 'Discord is not set up here');
      try {
        const channels = await readDiscordChannels(
          db,
          c.get('userId'),
          c.get('companyId'),
          c.req.param('guildId'),
          discord,
        );
        return channels ? c.json(channels) : apiError('not_found', 'no such server here');
      } catch (error) {
        console.error('Discord channels unavailable:', describe(error));
        return apiError('whop_unavailable', 'Discord did not answer');
      }
    },
  );

  /** The channels the company follows on its server: a stream each, read from the next run. */
  app.put(
    '/api/creator/:companyId/discord/:guildId/channels',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      const discord = deps.discord(c.get('config'));
      if (!db || !discord) return apiError('not_configured', 'Discord is not set up here');
      const body = await c.req.json<Partial<DiscordChannelsUpdate>>().catch(() => null);
      const ids = body?.channelIds;
      if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === 'string')) {
        return apiError('invalid_request', 'expected { channelIds: string[] }');
      }
      let channels;
      try {
        channels = await chooseDiscordChannels(
          db,
          c.get('userId'),
          c.get('companyId'),
          c.req.param('guildId'),
          ids,
          discord,
        );
      } catch (error) {
        console.error('Discord channels not saved:', describe(error));
        return apiError('whop_unavailable', 'Discord did not answer');
      }
      if (!channels) return apiError('not_found', 'no such server here');
      // The new channels start reading now rather than at the next run.
      syncInBackground(c, c.get('companyId'), 0);
      return c.json(channels);
    },
  );

  /** The company stops reading a server, and the bot leaves it. */
  app.delete(
    '/api/creator/:companyId/discord/:guildId',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const removed = await disconnectDiscordServer(
        db,
        deps.discord(c.get('config')),
        c.get('companyId'),
        c.req.param('guildId'),
      );
      return removed ? c.json({ removed }) : apiError('not_found', 'no such server here');
    },
  );

  /** The company stops counting a Telegram group, and the bot leaves it. */
  app.delete(
    '/api/creator/:companyId/telegram/:chatId',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const removed = await disconnectTelegramGroup(
        db,
        deps.telegram(c.get('config')),
        c.get('companyId'),
        c.req.param('chatId'),
      );
      return removed ? c.json({ removed }) : apiError('not_found', 'no such group here');
    },
  );

  /**
   * Back from Discord's page with the bot added: the server joins the company the signed `state`
   * names, then the browser goes to /connected, which says how it went.
   */
  app.get(DISCORD_CALLBACK_PATH, async (c) => {
    const config = c.get('config');
    const discord = deps.discord(config);
    const done = (query: Record<string, string>) =>
      c.redirect(
        `/connected?${new URLSearchParams({ source: 'discord', ...query }).toString()}`,
        302,
      );
    if (!discordAvailable(config) || !discord || !config.apiKey) {
      return done({ status: 'failed', reason: 'unavailable' });
    }
    const install = await verify(c.req.query('state'), await signingKey(config.apiKey), {
      purpose: 'discord-install',
      env: config.whopEnv,
      nowSeconds: nowSeconds(),
    });
    if (!install) return done({ status: 'failed', reason: 'expired' });
    if (c.req.query('error')) return done({ status: 'failed', reason: 'denied' });
    const code = c.req.query('code');
    const db = deps.openDb(c.env);
    if (!code || !db) return done({ status: 'failed', reason: 'error' });
    try {
      const server = await connectDiscordServer(db, discord, {
        companyId: install.companyId,
        userId: install.userId,
        code,
        redirectUri: `${new URL(c.req.url).origin}${DISCORD_CALLBACK_PATH}`,
        now: deps.now(),
      });
      syncInBackground(c, install.companyId, 0);
      return done({
        status: 'ok',
        name: server.name ?? '',
        channels: String(server.followed),
      });
    } catch (error) {
      console.error('Discord server not connected:', describe(error));
      return done({ status: 'failed', reason: 'error' });
    } finally {
      defer(c, db.close());
    }
  });

  /**
   * Telegram's updates for StayPut's bot (a group linked, a message, the bot added or removed,
   * a member linking their account). Telegram repeats the secret StayPut gave it (setWebhook)
   * and retries what is not answered 2xx.
   */
  app.post(TELEGRAM_WEBHOOK_PATH, async (c) => {
    const config = c.get('config');
    const telegram = deps.telegram(config);
    if (!config.telegram || !telegram) return apiError('not_found', 'Telegram is not set up here');
    const secret = await telegramWebhookSecret(config.telegram.botToken);
    if (!timingSafeEqual(c.req.header('x-telegram-bot-api-secret-token') ?? '', secret)) {
      return apiError('unauthenticated', 'invalid Telegram secret');
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_TELEGRAM_UPDATE_BYTES) {
      return c.json({ ok: true, ignored: 'too large' });
    }
    const raw = await c.req.text();
    let update: unknown;
    try {
      update = raw.length > MAX_TELEGRAM_UPDATE_BYTES ? null : JSON.parse(raw);
    } catch {
      update = null;
    }
    // An update StayPut cannot read never becomes readable: answered, so Telegram moves on.
    if (update === null) return c.json({ ok: true, ignored: 'unreadable' });
    const db = deps.openDb(c.env);
    if (!db) return apiError('not_configured', 'the database is not configured');
    try {
      const next = await fileTelegramUpdate(db, config.telegram.botToken, update, deps.now());
      const { reply, leave } = next;
      if (reply || leave) {
        defer(
          c,
          (async () => {
            if (reply) await telegram.sendMessage(reply.chatId, reply.text);
            if (leave) await telegram.leaveChat(leave);
          })().catch((error: unknown) => {
            console.warn('Telegram reply failed:', describe(error));
          }),
        );
      }
      return c.json({ ok: true });
    } finally {
      defer(c, db.close());
    }
  });

  /** The member routes: an experience id, and access to it (checked with Whop). */
  const requireMember = createMiddleware<AppEnv>(async (c, next) => {
    const experienceId = c.req.param('experienceId');
    if (!isExperienceId(experienceId)) {
      return apiError('invalid_request', 'not a Whop experience id');
    }
    const level = await accessTo(c, experienceId);
    if (level instanceof Response) return level;
    if (!canOpenMemberView(level)) return apiError('forbidden', 'no access to this experience');
    c.set('experienceId', experienceId);
    c.set('accessLevel', level);
    await next();
    return undefined;
  });

  app.get('/api/member/:experienceId/session', authenticate, requireMember, (c) => {
    const session: MemberSession = {
      experienceId: c.get('experienceId'),
      userId: c.get('userId'),
      accessLevel: c.get('accessLevel'),
      via: c.get('via'),
    };
    return c.json(session);
  });

  /** The company of the route's experience, or the error response to send. */
  async function memberCompany(c: Context<AppEnv>): Promise<string | Response> {
    const whop = deps.whopClient(c.get('config'));
    if (!whop) return apiError('not_configured', 'WHOP_API_KEY is not set');
    try {
      const companyId = await companyOfExperience(whop, c.get('experienceId'));
      return companyId ?? apiError('not_found', 'no community for this experience');
    } catch (error) {
      console.error('Experience not read:', describe(error));
      return apiError('whop_unavailable', 'could not read the experience with Whop');
    }
  }

  /** Linking one's Telegram account, so that one's messages in the community's groups count. */
  app.get('/api/member/:experienceId/telegram', authenticate, withDb, requireMember, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const companyId = await memberCompany(c);
    if (companyId instanceof Response) return companyId;
    const config = c.get('config');
    return c.json(
      await readMemberTelegram(db, {
        companyId,
        userId: c.get('userId'),
        now: deps.now(),
        config,
        telegram: deps.telegram(config),
        origin: new URL(c.req.url).origin,
        language: botLanguage(c.req.query('lang')),
      }),
    );
  });

  /** The member unlinks their Telegram account. */
  app.delete(
    '/api/member/:experienceId/telegram',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const [row] = await db.query<{ removed: boolean }>(
        'select stayput.unlink_telegram_member($1, $2) as removed',
        [companyId, c.get('userId')],
      );
      return c.json({ removed: row?.removed ?? false });
    },
  );

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

/** A stored delivery into members, memberships, payments and activity_events. */
async function fileWebhook(db: Db, id: string, now: Date): Promise<void> {
  try {
    const [row] = await db.query<{ status: string }>(
      'select stayput.process_webhook_event($1, $2::timestamptz) as status',
      [id, now.toISOString()],
    );
    if (row?.status === 'failed') {
      console.warn(`Webhook ${id} could not be filed: the cron retries it.`);
    }
  } catch (error) {
    console.error(`Webhook ${id} could not be filed:`, describe(error));
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

/**
 * Risk settings a creator sent, made safe: a known niche (else the weights alone), weights
 * brought back to a sum of 1, a recency threshold of 1 to 90 days, levels 0 < medium < high <= 100.
 */
export function validRiskSettings(body: Partial<RiskSettingsView> | null): RiskSettingsView | null {
  if (!body || !isNiche(body.niche)) return null;
  const weights = body.weights ?? NICHE_PRESETS[body.niche].weights;
  if (
    typeof weights !== 'object' ||
    !RISK_FACTORS.every(
      (key) => typeof (weights as unknown as Record<string, unknown>)[key] === 'number',
    )
  ) {
    return null;
  }
  const whole = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  const { recencyThresholdDays, mediumFrom, highFrom } = body;
  if (
    !whole(recencyThresholdDays, 1, 90) ||
    !whole(mediumFrom, 1, 99) ||
    !whole(highFrom, 2, 100)
  ) {
    return null;
  }
  if ((mediumFrom as number) >= (highFrom as number)) return null;
  return {
    niche: body.niche,
    weights: normalizeWeights(weights),
    recencyThresholdDays: recencyThresholdDays as number,
    mediumFrom: mediumFrom as number,
    highFrom: highFrom as number,
  };
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

export { CSRF_HEADER };

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
