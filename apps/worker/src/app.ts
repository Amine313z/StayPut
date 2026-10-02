import {
  CSRF_HEADER,
  NICHE_PRESETS,
  RISK_FACTORS,
  canOpenCreatorView,
  canOpenMemberView,
  isCompanyId,
  isExperienceId,
  isExitReason,
  isNiche,
  normalizeWeights,
  isProofId,
  parseAnnounceTarget,
  parseCardRequest,
  parseGoalInput,
  parseGoalProposals,
  parseResultEntry,
  timeZoneName,
  type AccessLevel,
  type AffiliateLinkView,
  type CreatorSession,
  type DiscordChannelsUpdate,
  type HealthReport,
  type AlumniView,
  type MemberRetentionView,
  type MemberSession,
  type AnnouncementsView,
  type ResultAnswer,
  type RiskSettingsView,
  type ShareAnswer,
  type SignInMethod,
  type SyncRun,
  type TimezoneAnswer,
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
import { alumniOfMember, createAlumniOffer, readAlumni } from './alumni';
import {
  accountOf,
  accountsView,
  readAccounts,
  readPeople,
  readPlatformActivity,
} from './accounts';
import { isActionView, readActionSettings, readActions, validActionSettings } from './action-views';
import { executeAction, executeDueActions, prepareActions } from './actions';
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
import { answerSurvey, decideOffer, readRetention, retentionView } from './retention';
import { REQUEST_RISK_BATCH, refreshDetection } from './risk';
import { LATEST_MIGRATION } from './schema-version';
import { goneProofPage, proofPage } from './public-proof';
import {
  joinRescue,
  makeCard,
  parseBuddiesUpdate,
  parseBuddyOptOut,
  parseEarnedDays,
  parseRescuesUpdate,
  parseShareRequest,
  planEarnedDays,
  readAnnounceTo,
  readBuddiesView,
  readRescuesView,
  readEarnedDays,
  readGoalProposals,
  readMemberSpace,
  readPublicProof,
  recordOpen,
  recordResult,
  saveAnnounceTo,
  saveBuddies,
  saveRescues,
  saveEarnedDays,
  saveGoalProposals,
  setBuddyOptOut,
  setGoal,
  shareMilestone,
  spaceLocale,
  unpublishCard,
} from './space';
import { memberAffiliateLink } from './affiliate';
import { announceChoices } from './announce';
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
import {
  LIVE_DISCORD_BUDGET,
  SYNC_REQUEST_BUDGET,
  refreshCompanyName,
  refreshDiscordNow,
  summarize,
  syncIfFree,
} from './sync';
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
export const MANUAL_DISCORD_REFRESH_SECONDS = 10 * 60;
/** Actions run right after the creator approves some (the hourly cron runs the rest). */
const REQUEST_ACTION_BATCH = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
      // The community's name, for its messages and pages: with each sync, or as soon as missing.
      const [company] = await db.query<{ name: string | null }>(
        'select name from stayput.companies where id = $1',
        [companyId],
      );
      if (result || !company?.name) await refreshCompanyName(db, whop, companyId);
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
    let company: { timezoneSet: boolean; name: string | null } = {
      timezoneSet: true,
      name: null,
    };
    if (db) {
      company = await recordAdmin(db, companyId, userId, deps.now());
      // The first visit starts the backfill, later ones bring the data up to date (SPEC
      // Phase 2, 2).
      syncInBackground(c, companyId);
    }
    const session: CreatorSession = {
      companyId,
      userId,
      accessLevel: c.get('accessLevel'),
      via: c.get('via'),
      timezoneSet: company.timezoneSet,
      companyName: company.name,
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
      { retryFailed: true, refreshDiscordAfterSeconds: MANUAL_DISCORD_REFRESH_SECONDS },
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

  /** The goals proposed to members (SPEC Phase 5): the creator's own, or their niche's. */
  app.get('/api/creator/:companyId/goals', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const view = await readGoalProposals(
      db,
      c.get('userId'),
      c.get('companyId'),
      spaceLocale(c.req.query('lang')),
    );
    return view ? c.json(view) : apiError('not_found', 'no settings for this company');
  });

  /** The creator writes their own goals for members, or goes back to the niche's (null). */
  app.put('/api/creator/:companyId/goals', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const body = await c.req.json<{ proposals?: unknown }>().catch(() => null);
    const proposals = body?.proposals === null ? null : parseGoalProposals(body?.proposals);
    if (body?.proposals !== null && !proposals) {
      return apiError('invalid_request', 'expected { proposals: up to 6 goals, or null }');
    }
    const companyId = c.get('companyId');
    await saveGoalProposals(db, companyId, proposals);
    const view = await readGoalProposals(
      db,
      c.get('userId'),
      companyId,
      spaceLocale(c.req.query('lang')),
    );
    return view ? c.json(view) : apiError('not_found', 'no settings for this company');
  });

  /** The earned days (SPEC Phase 5, point 5): free days for the milestones members reach. */
  app.get(
    '/api/creator/:companyId/earned-days',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const settings = await readEarnedDays(db, c.get('userId'), c.get('companyId'));
      return settings ? c.json(settings) : apiError('not_found', 'no settings for this company');
    },
  );

  app.put(
    '/api/creator/:companyId/earned-days',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const settings = parseEarnedDays(await c.req.json<unknown>().catch(() => null));
      if (!settings) {
        return apiError('invalid_request', 'expected { enabled, at50, at100 } (0 to 14 days)');
      }
      await saveEarnedDays(db, c.get('companyId'), settings);
      const saved = await readEarnedDays(db, c.get('userId'), c.get('companyId'));
      return saved ? c.json(saved) : apiError('not_found', 'no settings for this company');
    },
  );

  /**
   * The buddies (SPEC Phase 5, point 8): a newcomer paired with a veteran who helps them start.
   * On or off, and where they stand.
   */
  app.get('/api/creator/:companyId/buddies', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const view = await readBuddiesView(db, c.get('userId'), c.get('companyId'), deps.now());
    return view ? c.json(view) : apiError('not_found', 'no settings for this company');
  });

  app.put('/api/creator/:companyId/buddies', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const enabled = parseBuddiesUpdate(await c.req.json<unknown>().catch(() => null));
    if (enabled === null) return apiError('invalid_request', 'expected { enabled: boolean }');
    await saveBuddies(db, c.get('companyId'), enabled);
    const view = await readBuddiesView(db, c.get('userId'), c.get('companyId'), deps.now());
    return view ? c.json(view) : apiError('not_found', 'no settings for this company');
  });

  /**
   * The rescue challenges (SPEC Phase 5, point 9): members inactive for 14 days shown, without
   * their name, to the community's members. On or off, and where they stand.
   */
  app.get('/api/creator/:companyId/rescues', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const view = await readRescuesView(db, c.get('userId'), c.get('companyId'), deps.now());
    return view ? c.json(view) : apiError('not_found', 'no settings for this company');
  });

  app.put('/api/creator/:companyId/rescues', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const enabled = parseRescuesUpdate(await c.req.json<unknown>().catch(() => null));
    if (enabled === null) return apiError('invalid_request', 'expected { enabled: boolean }');
    await saveRescues(db, c.get('companyId'), enabled);
    const view = await readRescuesView(db, c.get('userId'), c.get('companyId'), deps.now());
    return view ? c.json(view) : apiError('not_found', 'no settings for this company');
  });

  /**
   * Where the members' milestones are announced (SPEC Phase 5, point 4), and where they can be:
   * the places StayPut can post in now.
   */
  async function announcements(
    c: Context<AppEnv>,
    db: ClosableDb,
  ): Promise<AnnouncementsView | null> {
    const destination = await readAnnounceTo(db, c.get('userId'), c.get('companyId'));
    if (destination === undefined) return null;
    const config = c.get('config');
    const { choices, whopUnavailable } = await announceChoices(
      db,
      c.get('userId'),
      c.get('companyId'),
      { whop: deps.whopClient(config, { maxRetries: 0 }), discord: deps.discord(config) },
    );
    return { destination, choices, whopUnavailable };
  }

  app.get(
    '/api/creator/:companyId/announcements',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const view = await announcements(c, db);
      return view ? c.json(view) : apiError('not_found', 'no settings for this company');
    },
  );

  /** The creator picks where, among the places StayPut can post in, or turns them off (null). */
  app.put(
    '/api/creator/:companyId/announcements',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<{ destination?: unknown }>().catch(() => null);
      const target = body?.destination === null ? null : parseAnnounceTarget(body?.destination);
      if (body?.destination !== null && !target) {
        return apiError('invalid_request', 'expected { destination: { platform, id } or null }');
      }
      const view = await announcements(c, db);
      if (!view) return apiError('not_found', 'no settings for this company');
      const chosen = target
        ? view.choices.find((d) => d.platform === target.platform && d.id === target.id)
        : null;
      if (target && !chosen) {
        return apiError('invalid_request', 'StayPut cannot post there');
      }
      await saveAnnounceTo(db, c.get('companyId'), chosen ?? null);
      return c.json({ ...view, destination: chosen ?? null } satisfies AnnouncementsView);
    },
  );

  /** SPEC Phase 4: one list of actions (to approve, scheduled, done) and how many each holds. */
  app.get('/api/creator/:companyId/actions', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const view = c.req.query('view') ?? 'queue';
    if (!isActionView(view))
      return apiError('invalid_request', 'view: queue, scheduled or history');
    const page = await readActions(db, c.get('userId'), c.get('companyId'), view, deps.now());
    return page ? c.json(page) : apiError('not_found', 'no settings for this company');
  });

  /**
   * Manual mode: the creator approves actions, the ones named or all of them. They go through
   * the guardrails at once, and what is due runs at once; the rest waits for its time.
   */
  app.post(
    '/api/creator/:companyId/actions/approve',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
      const ids = body?.ids;
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > 500 ||
          !ids.every((id) => typeof id === 'string' && UUID.test(id)))
      ) {
        return apiError('invalid_request', 'expected { ids?: uuid[] }');
      }
      const companyId = c.get('companyId');
      const now = deps.now();
      const [row] = await db.query<{ approved: number }>(
        'select stayput.approve_actions($1, $2, $3, $4::timestamptz) as approved',
        [companyId, ids ? (ids as string[]).join(',') : null, c.get('userId'), now.toISOString()],
      );
      runActionsInBackground(c, companyId, now);
      return c.json({ approved: row?.approved ?? 0 });
    },
  );

  /** The creator cancels an action that has not run yet. */
  app.post(
    '/api/creator/:companyId/actions/:actionId/cancel',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const actionId = c.req.param('actionId');
      if (!UUID.test(actionId)) return apiError('not_found', 'no such action');
      const [row] = await db.query<{ cancelled: boolean }>(
        'select stayput.cancel_action($1, $2::uuid, $3, $4::timestamptz) as cancelled',
        [c.get('companyId'), actionId, c.get('userId'), deps.now().toISOString()],
      );
      return row?.cancelled
        ? c.json({ cancelled: true })
        : apiError('not_found', 'no such action waiting here');
    },
  );

  /** The actions' settings: the mode, the test mode, the stop, the guardrails, the messages. */
  app.get(
    '/api/creator/:companyId/settings/actions',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const settings = await readActionSettings(db, c.get('userId'), c.get('companyId'));
      return settings ? c.json(settings) : apiError('not_found', 'no settings for this company');
    },
  );

  app.put(
    '/api/creator/:companyId/settings/actions',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const settings = validActionSettings(await c.req.json<unknown>().catch(() => null));
      if (!settings) return apiError('invalid_request', 'expected the action settings');
      const companyId = c.get('companyId');
      if (settings.timezone) {
        const zone = await setTimezone(db, companyId, settings.timezone, false);
        if (!zone) return apiError('invalid_request', 'unknown time zone');
      }
      await db.query('select stayput.save_action_settings($1, $2::text::jsonb)', [
        companyId,
        JSON.stringify(settings),
      ]);
      if (settings.offers) {
        await db.query('select stayput.save_offer_settings($1, $2::text::jsonb)', [
          companyId,
          JSON.stringify(settings.offers),
        ]);
      }
      // In automatic mode, what waits for the guardrails goes through them now.
      if (settings.mode === 'auto') runActionsInBackground(c, companyId, deps.now());
      return c.json((await readActionSettings(db, c.get('userId'), companyId)) ?? settings);
    },
  );

  /**
   * The creator's time zone, as their browser reports it: kept while the company has none of its
   * own yet (the quiet hours and the golden hour are the creator's local hours), then changed
   * only in the action settings. Answers the zone in effect.
   */
  app.post('/api/creator/:companyId/timezone', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const body = await c.req.json<{ timezone?: unknown }>().catch(() => null);
    const timezone = timeZoneName(body?.timezone);
    if (!timezone) return apiError('invalid_request', 'expected { timezone: an IANA time zone }');
    const zone = await setTimezone(db, c.get('companyId'), timezone, true);
    return zone
      ? c.json({ timezone: zone } satisfies TimezoneAnswer)
      : apiError('invalid_request', 'unknown time zone');
  });

  async function setTimezone(
    db: Db,
    companyId: string,
    timezone: string,
    onlyIfUnset: boolean,
  ): Promise<string | null> {
    const [row] = await db.query<{ zone: string | null }>(
      'select stayput.set_company_timezone($1, $2, $3, $4::timestamptz) as zone',
      [companyId, timezone, onlyIfUnset, deps.now().toISOString()],
    );
    return row?.zone ?? null;
  }

  /** The « never contact » list: no action of any kind for this member. */
  app.put(
    '/api/creator/:companyId/members/:memberId/contact',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<{ doNotContact?: unknown }>().catch(() => null);
      if (typeof body?.doNotContact !== 'boolean') {
        return apiError('invalid_request', 'expected { doNotContact: boolean }');
      }
      const [row] = await db.query<{ found: boolean }>(
        'select stayput.set_do_not_contact($1, $2, $3) as found',
        [c.get('companyId'), c.req.param('memberId'), body.doNotContact],
      );
      return row?.found
        ? c.json({ doNotContact: body.doNotContact })
        : apiError('not_found', 'no such member here');
    },
  );

  /**
   * After the creator acted: the company's actions go through the guardrails, and what is due
   * runs (a few, within the request's subrequests); the hourly cron does the rest.
   */
  function runActionsInBackground(c: Context<AppEnv>, companyId: string, now: Date): void {
    const whop = deps.whopClient(c.get('config'));
    inBackground(c, 'Actions', async (work) => {
      await prepareActions(work, companyId, now);
      await executeDueActions(work, whop, now, REQUEST_ACTION_BATCH);
    });
  }

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
   * The Discord and Telegram accounts seen writing: the ones no member has (with the members they
   * may be), and the ones tied to a member.
   */
  app.get('/api/creator/:companyId/accounts', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const config = c.get('config');
    const view = await readAccounts(db, c.get('userId'), c.get('companyId'), {
      discord: deps.discord(config),
      telegram: deps.telegram(config),
    });
    return view ? c.json(view) : apiError('forbidden', 'not a team member of this company');
  });

  /** What StayPut saw on Discord and Telegram over 30 days: per day, place, member. */
  app.get(
    '/api/creator/:companyId/platform-activity',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const view = await readPlatformActivity(db, c.get('userId'), c.get('companyId'), deps.now());
      return view ? c.json(view) : apiError('forbidden', 'not a team member of this company');
    },
  );

  /**
   * The same, live: the page asks every half minute while it is open. Telegram's messages are
   * already in (Telegram sends them); Discord's channels are read first when not read for a
   * minute, since Discord sends nothing.
   */
  app.post(
    '/api/creator/:companyId/platform-activity/refresh',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const config = c.get('config');
      const companyId = c.get('companyId');
      const now = deps.now();
      const whop = deps.whopClient(config, { maxRetries: 0 });
      const discord = deps.discord(config);
      if (whop && discord) {
        const read = await refreshDiscordNow(
          { db, whop, discord, now, budget: { left: LIVE_DISCORD_BUDGET } },
          companyId,
        );
        if (read && read.calls > 0) console.info(summarize(read));
      }
      const view = await readPlatformActivity(db, c.get('userId'), companyId, now);
      return view ? c.json(view) : apiError('forbidden', 'not a team member of this company');
    },
  );

  /**
   * Everyone StayPut knows on the company's Discord servers and Telegram groups, beyond who writes
   * there, and how many people each server and group has.
   */
  app.get('/api/creator/:companyId/people', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const config = c.get('config');
    const view = await readPeople(
      db,
      c.get('userId'),
      c.get('companyId'),
      { discord: deps.discord(config), telegram: deps.telegram(config) },
      deps.now(),
    );
    return view ? c.json(view) : apiError('forbidden', 'not a team member of this company');
  });

  /** The Alumni offer (SPEC 5.9): where former members stay in touch, and who is in it. */
  app.get('/api/creator/:companyId/alumni', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const view = await readAlumni(db, c.get('userId'), c.get('companyId'));
    return view ? c.json(view) : apiError('forbidden', 'not a team member of this company');
  });

  /**
   * Creates the Alumni offer on Whop, or finishes creating it: the answer says the step that
   * stopped, and the permission Whop lacked.
   */
  app.post('/api/creator/:companyId/alumni', authenticate, withDb, requireCreator, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const body = await c.req.json<{ name?: unknown }>().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      return apiError('invalid_request', 'expected { name: 1 to 80 characters }');
    }
    const config = c.get('config');
    const whop = deps.whopClient(config);
    if (!whop || !config.appId) {
      return apiError('not_configured', 'the Whop API key or app id is not set');
    }
    const companyId = c.get('companyId');
    const problem = await createAlumniOffer(
      db,
      whop,
      { companyId, userId: c.get('userId'), appId: config.appId, name },
      deps.now(),
    );
    const view = await readAlumni(db, c.get('userId'), companyId);
    return view
      ? c.json({ ...view, problem } satisfies AlumniView)
      : apiError('forbidden', 'not a team member of this company');
  });

  /** The creator ties an account to a member, unties it, or sets it aside (no member). */
  app.post(
    '/api/creator/:companyId/accounts/:change{link|unlink|dismiss|restore}',
    authenticate,
    withDb,
    requireCreator,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<{ memberId?: unknown }>().catch(() => null);
      const account = accountOf(body);
      if (!account) return apiError('invalid_request', 'expected { platform, accountId }');
      const companyId = c.get('companyId');
      const at = deps.now().toISOString();
      const args = [companyId, account.platform, account.accountId];
      const done = async (sql: string, params: unknown[]) =>
        (await db.query<{ done: boolean }>(sql, params))[0]?.done === true;
      let changed: boolean;
      switch (c.req.param('change')) {
        case 'link': {
          const memberId = body?.memberId;
          if (typeof memberId !== 'string' || !/^mber_[A-Za-z0-9]+$/.test(memberId)) {
            return apiError('invalid_request', 'expected { platform, accountId, memberId }');
          }
          changed = await done(
            'select stayput.link_account($1, $2, $3, $4, $5::timestamptz) as done',
            [...args, memberId, at],
          );
          break;
        }
        case 'unlink':
          changed = await done(
            'select stayput.unlink_account($1, $2, $3, $4::timestamptz) as done',
            [...args, at],
          );
          break;
        default: {
          // Set aside as the team's (the creator's own account, a teammate's) or a guest's.
          const as =
            c.req.param('change') === 'restore'
              ? null
              : (body as { as?: unknown } | null)?.as === 'team'
                ? 'team'
                : 'guest';
          changed = await done(
            'select stayput.dismiss_account($1, $2, $3, $4::text, $5::timestamptz) as done',
            [...args, as, at],
          );
        }
      }
      if (!changed) return apiError('not_found', 'no such account or member here');
      const view = await accountsView(db, c.get('userId'), companyId);
      return view ? c.json(view) : apiError('forbidden', 'not a team member of this company');
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
      // Signed in to StayPut outside Whop (sandbox): the page offers the way back to the
      // dashboard. Inside Whop, the creator just closes the tab: there is nothing to go back to.
      const session = config.oauthLogin
        ? await verify(
            readCookie(c.req.header('cookie'), SESSION_COOKIE),
            await signingKey(config.apiKey),
            { purpose: 'session', env: config.whopEnv, nowSeconds: nowSeconds() },
          )
        : null;
      return done({
        status: 'ok',
        name: server.name ?? '',
        channels: String(server.followed),
        ...(session?.userId === install.userId ? { company: install.companyId } : {}),
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
      if (!companyId) return apiError('not_found', 'no community for this experience');
      // Whop notifications to the company's members go through this experience (Phase 4).
      const db = c.get('db');
      if (db) {
        await db.query('select stayput.remember_experience($1, $2)', [
          companyId,
          c.get('experienceId'),
        ]);
      }
      return companyId;
    } catch (error) {
      console.error('Experience not read:', describe(error));
      return apiError('whop_unavailable', 'could not read the experience with Whop');
    }
  }

  /**
   * The member's own subscription (SPEC Phase 4): a payment that needs them, with the link to
   * settle it, and the cancellation they scheduled, with its survey and offer. The team sees a
   * preview of it, with the creator's offers.
   */
  app.get('/api/member/:experienceId/retention', authenticate, withDb, requireMember, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const companyId = await memberCompany(c);
    if (companyId instanceof Response) return companyId;
    return c.json(await retentionFor(c, db, companyId, deps.now()));
  });

  /** The member's answer to the departure survey: their reason, and the offer it brings. */
  app.post(
    '/api/member/:experienceId/retention/survey',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<{ reason?: unknown }>().catch(() => null);
      const reason = body?.reason;
      if (!isExitReason(reason)) return apiError('invalid_request', 'expected { reason }');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const now = deps.now();
      const userId = c.get('userId');
      const row = await readRetention(db, companyId, userId, now);
      if (!(await answerSurvey(db, companyId, row, reason, now))) {
        return apiError('not_found', 'no cancellation to answer for');
      }
      return c.json(await retentionFor(c, db, companyId, now));
    },
  );

  /**
   * The member accepts the offer, or declines it. Accepted, it is an action like the others: in
   * automatic mode it goes through the guardrails and runs now, so the member sees what came of
   * it; in manual mode the creator approves it first.
   */
  app.post(
    '/api/member/:experienceId/retention/offer',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const body = await c.req.json<{ accept?: unknown; keep?: unknown }>().catch(() => null);
      if (typeof body?.accept !== 'boolean') {
        return apiError('invalid_request', 'expected { accept, keep? }');
      }
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const now = deps.now();
      const userId = c.get('userId');
      const row = await readRetention(db, companyId, userId, now);
      const decided = await decideOffer(
        db,
        companyId,
        row,
        { accept: body.accept, keep: body.keep === true },
        now,
      );
      if (decided === 'invalid') {
        return apiError('invalid_request', 'this offer needs the consent to keep the membership');
      }
      if (!decided) return apiError('not_found', 'no offer waiting for an answer');
      if (decided.actionId) {
        await prepareActions(db, companyId, now);
        await executeAction(db, deps.whopClient(c.get('config')), decided.actionId, now);
      }
      return c.json(await retentionFor(c, db, companyId, now));
    },
  );

  /** What the member view shows the user: their payment and departure, or the team's preview. */
  async function retentionFor(
    c: Context<AppEnv>,
    db: Db,
    companyId: string,
    now: Date,
  ): Promise<MemberRetentionView> {
    const row = await readRetention(db, companyId, c.get('userId'), now);
    const alumni = await alumniOfMember(
      db,
      companyId,
      c.get('userId'),
      now,
      c.get('config').whopEnv,
    );
    const view = retentionView(row, {
      preview: c.get('accessLevel') === 'admin',
      whopAppId: c.get('config').appId,
      alumniUrl: alumni.url,
      alumni: alumni.alumni,
    });
    if (view.payment?.kind === 'failed' && !view.payment.url && row.payment?.membershipId) {
      // Where the member updates their payment method: Whop's page for their membership.
      view.payment.url = await manageUrlOf(c, row.payment.membershipId);
    }
    return view;
  }

  /** Whop's page where a member manages their membership (and their payment method). */
  async function manageUrlOf(c: Context<AppEnv>, membershipId: string): Promise<string | null> {
    const whop = deps.whopClient(c.get('config'), { maxRetries: 0 });
    if (!whop) return null;
    try {
      const membership = await whop.request<{ manage_url?: unknown }>(
        'GET',
        `/memberships/${encodeURIComponent(membershipId)}`,
      );
      return typeof membership.manage_url === 'string' ? membership.manage_url : null;
    } catch (error) {
      console.error('Membership not read:', describe(error));
      return null;
    }
  }

  /**
   * The member space (SPEC Phase 5): the member's goal, results, milestones and badges. Opening it
   * is an activity of the member (stayput_open), never of the team, who see a preview.
   */
  app.get('/api/member/:experienceId/space', authenticate, withDb, requireMember, async (c) => {
    const db = c.get('db');
    if (!db) return apiError('not_configured', 'the database is not configured');
    const companyId = await memberCompany(c);
    if (companyId instanceof Response) return companyId;
    const preview = c.get('accessLevel') === 'admin';
    const userId = c.get('userId');
    const fresh = preview ? [] : await recordOpen(db, companyId, userId, deps.now());
    return c.json(
      await readMemberSpace(db, companyId, userId, {
        locale: spaceLocale(c.req.query('lang')),
        preview,
        fresh,
        origin: new URL(c.req.url).origin,
        whopAppId: c.get('config').appId,
      }),
    );
  });

  /** The member sets their goal: the one under way ends. */
  app.post(
    '/api/member/:experienceId/space/goal',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      if (c.get('accessLevel') === 'admin') {
        return apiError('forbidden', 'the team previews the member space, nothing is recorded');
      }
      const now = deps.now();
      const goal = parseGoalInput(await c.req.json<unknown>().catch(() => null), now);
      if (!goal) {
        return apiError(
          'invalid_request',
          'expected { title, unit, category, entry, start, target, targetDate }',
        );
      }
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const userId = c.get('userId');
      if (!(await setGoal(db, companyId, userId, goal, now))) {
        return apiError('not_found', 'StayPut does not know this member yet');
      }
      return c.json(
        await readMemberSpace(db, companyId, userId, {
          locale: spaceLocale(c.req.query('lang')),
          preview: false,
          origin: new URL(c.req.url).origin,
          whopAppId: c.get('config').appId,
        }),
      );
    },
  );

  /** A result on the member's goal: the milestones and badges it brings, to celebrate them. */
  app.post(
    '/api/member/:experienceId/space/result',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      if (c.get('accessLevel') === 'admin') {
        return apiError('forbidden', 'the team previews the member space, nothing is recorded');
      }
      const entry = parseResultEntry(await c.req.json<unknown>().catch(() => null));
      if (!entry) return apiError('invalid_request', 'expected { goalId, value }');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const userId = c.get('userId');
      const now = deps.now();
      const brought = await recordResult(db, companyId, userId, entry, now);
      if (!brought) return apiError('not_found', 'no such goal under way');
      // The milestones' free days (SPEC Phase 5, point 5): through the guardrails like every
      // action; in automatic mode they are added now, and the member sees them at once.
      let earnedDays = 0;
      const earned = await planEarnedDays(
        db,
        companyId,
        userId,
        entry.goalId,
        brought.milestones,
        now,
      );
      if (earned.length > 0) {
        await prepareActions(db, companyId, now);
        const whop = deps.whopClient(c.get('config'));
        for (const action of earned) {
          if ((await executeAction(db, whop, action.id, now)) === 'sent') earnedDays += action.days;
        }
      }
      const answer: ResultAnswer = {
        ...brought,
        earnedDays,
        space: await readMemberSpace(db, companyId, userId, {
          locale: spaceLocale(c.req.query('lang')),
          preview: false,
          origin: new URL(c.req.url).origin,
          whopAppId: c.get('config').appId,
        }),
      };
      return c.json(answer);
    },
  );

  /**
   * The member asks for their milestone to be announced in the community's chat (SPEC Phase 5,
   * point 4): an action through the guardrails; in automatic mode it is posted now.
   */
  app.post(
    '/api/member/:experienceId/space/share',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      if (c.get('accessLevel') === 'admin') {
        return apiError('forbidden', 'the team previews the member space, nothing is recorded');
      }
      const share = parseShareRequest(await c.req.json<unknown>().catch(() => null));
      if (!share) return apiError('invalid_request', 'expected { goalId, percent }');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const now = deps.now();
      const shared = await shareMilestone(db, companyId, c.get('userId'), share, now);
      if (!shared) return apiError('not_found', 'nothing to share there');
      if (shared === 'duplicate') return c.json({ status: 'duplicate' } satisfies ShareAnswer);
      await prepareActions(db, companyId, now);
      const [row] = await db.query<{ status: string }>(
        'select status from stayput.actions where id = $1',
        [shared.id],
      );
      let outcome: string | null = row?.status ?? null;
      if (outcome === 'scheduled') {
        const config = c.get('config');
        outcome = await executeAction(db, deps.whopClient(config), shared.id, now, {
          discord: deps.discord(config),
          telegram: deps.telegram(config),
        });
      }
      const status: ShareAnswer['status'] =
        outcome === 'sent' || outcome === 'simulated'
          ? outcome
          : outcome === 'blocked_by_guardrail' || outcome === 'cancelled'
            ? 'blocked'
            : outcome === 'failed' || outcome === 'retried'
              ? 'failed'
              : 'waiting';
      return c.json({ status } satisfies ShareAnswer);
    },
  );

  /**
   * The member makes the testimonial card of one of their results (SPEC Phase 5, point 6): its
   * public page goes online with only what they agreed to show.
   */
  app.post(
    '/api/member/:experienceId/space/card',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      if (c.get('accessLevel') === 'admin') {
        return apiError('forbidden', 'the team previews the member space, nothing is recorded');
      }
      const request = parseCardRequest(await c.req.json<unknown>().catch(() => null));
      if (!request) {
        return apiError(
          'invalid_request',
          'expected { resultId, showName, affiliateUrl: a whop.com address or null }',
        );
      }
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const card = await makeCard(
        db,
        companyId,
        c.get('userId'),
        request,
        deps.now(),
        new URL(c.req.url).origin,
      );
      return card ? c.json(card) : apiError('not_found', 'no such result of yours');
    },
  );

  /** The member takes a card's page down. */
  app.delete(
    '/api/member/:experienceId/space/card/:proofId',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      const proofId = c.req.param('proofId');
      if (!isProofId(proofId)) return apiError('invalid_request', 'not a proof id');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const removed = await unpublishCard(db, companyId, c.get('userId'), proofId);
      return removed ? c.json({ removed }) : apiError('not_found', 'no such card of yours');
    },
  );

  /** The member takes a rescue challenge up: if its member comes back, they earn the badge. */
  app.post(
    '/api/member/:experienceId/space/rescues/:challengeId',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      if (c.get('accessLevel') === 'admin') {
        return apiError('forbidden', 'the team previews the member space, nothing is recorded');
      }
      const challengeId = c.req.param('challengeId');
      if (!isProofId(challengeId)) return apiError('invalid_request', 'not a challenge id');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const rescues = await joinRescue(db, companyId, c.get('userId'), challengeId, deps.now());
      return rescues ? c.json(rescues) : apiError('not_found', 'no such open challenge');
    },
  );

  /** The member asks not to be paired with a buddy (their pairs end), or may be again. */
  app.post(
    '/api/member/:experienceId/space/buddies',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const db = c.get('db');
      if (!db) return apiError('not_configured', 'the database is not configured');
      if (c.get('accessLevel') === 'admin') {
        return apiError('forbidden', 'the team previews the member space, nothing is recorded');
      }
      const optOut = parseBuddyOptOut(await c.req.json<unknown>().catch(() => null));
      if (optOut === null) return apiError('invalid_request', 'expected { optOut: boolean }');
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const buddies = await setBuddyOptOut(db, companyId, c.get('userId'), optOut, deps.now());
      return buddies
        ? c.json(buddies)
        : apiError('not_found', 'StayPut does not know this member yet');
    },
  );

  /**
   * The member's own affiliate link, read from Whop (SPEC 5.6), to offer on their card. The team,
   * who preview the space, get none.
   */
  app.get(
    '/api/member/:experienceId/space/affiliate',
    authenticate,
    withDb,
    requireMember,
    async (c) => {
      const none: AffiliateLinkView = { url: null };
      if (c.get('accessLevel') === 'admin') return c.json(none);
      const whop = deps.whopClient(c.get('config'), { maxRetries: 0 });
      if (!whop) return c.json(none);
      const companyId = await memberCompany(c);
      if (companyId instanceof Response) return companyId;
      const view: AffiliateLinkView = {
        url: await memberAffiliateLink(whop, companyId, c.get('userId')),
      };
      return c.json(view);
    },
  );

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

  /**
   * The public page of a proof (SPEC Phase 5, point 7): what its member agreed to show, in the
   * community's language; a plain « not here » page otherwise.
   */
  app.get('/v/:proofId', withDb, async (c) => {
    const proofId = c.req.param('proofId');
    if (!isProofId(proofId)) return apiError('invalid_request', 'not a proof id');
    const db = c.get('db');
    const proof = db ? await readPublicProof(db, proofId) : null;
    if (!proof) {
      const language = c.req.header('accept-language') ?? '';
      return goneProofPage(/^fr\b/i.test(language) ? 'fr' : 'en');
    }
    return proofPage(proof);
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
/** Records the company and the admin's check; answers whether the company has its time zone. */
async function recordAdmin(
  db: ClosableDb,
  companyId: string,
  userId: string,
  now: Date,
): Promise<{ timezoneSet: boolean; name: string | null }> {
  const at = now.toISOString();
  return db.transaction(async (tx) => {
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
    const [company] = await tx.query<{ timezone_set: boolean; name: string | null }>(
      `select timezone_set_at is not null as timezone_set, name
         from stayput.companies where id = $1`,
      [companyId],
    );
    return { timezoneSet: company?.timezone_set ?? true, name: company?.name ?? null };
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
