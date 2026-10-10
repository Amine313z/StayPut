import { isAccessLevel, isCompanyId, isUserId, type AccessLevel } from '@stayput/core';
import { parseWhopEnv, type WhopEnv } from '@stayput/whop';

/**
 * The Worker's bindings: `vars` of wrangler.jsonc, secrets (`wrangler secret put`), and in
 * local development `.dev.vars` (never committed, see .dev.vars.example).
 */
export interface Env {
  /** "sandbox" (default) or "production". */
  WHOP_ENV?: string;
  /** The app's id (`app_…`), audience of the iframe token. */
  WHOP_APP_ID?: string;
  /** Secret: the app API key. */
  WHOP_API_KEY?: string;
  /** Secret: the webhook's `ws_…` signing secret. */
  WHOP_WEBHOOK_SECRET?: string;
  /** "development" only in .dev.vars: turns on the DEV_* settings below. */
  ENVIRONMENT?: string;
  /** Local development without Whop's iframe: the user every request acts as. */
  DEV_USER_ID?: string;
  /** Local development without a Whop API key: the access level that user has. */
  DEV_ACCESS_LEVEL?: string;
  HYPERDRIVE?: { connectionString: string };
  /** Secret, optional: the token of StayPut's Discord bot (Discord module). */
  DISCORD_BOT_TOKEN?: string;
  /** Secret, optional: the client secret of StayPut's Discord application (adding the bot). */
  DISCORD_CLIENT_SECRET?: string;
  /** Secret, optional: the token of StayPut's Telegram bot (Telegram module). */
  TELEGRAM_BOT_TOKEN?: string;
  /**
   * "true" turns the member space on (goals, results, testimonial cards and their pages,
   * buddies, rescue challenges): off in V1, kept for a later version (decision of 2026-10-02).
   * The departure survey is not part of it: it always runs.
   */
  MEMBER_SPACE_ENABLED?: string;
  /**
   * "true" serves the legal pages (/privacy, /terms, /dpa): off since 2026-10-10 (no Whop app
   * shows any, Whop asks for none); their texts stay in legal.ts, ready to come back.
   */
  LEGAL_PAGES_ENABLED?: string;
  /**
   * The operator's own community (`biz_…`): its team sees StayPut's internal status page
   * (SPEC Phase 8.5). Not a secret: a community's id.
   */
  OPERATOR_COMPANY_ID?: string;
}

export interface Config {
  whopEnv: WhopEnv;
  appId: string | null;
  apiKey: string | null;
  webhookSecret: string | null;
  /**
   * "Sign in with Whop" outside the iframe (/auth/*): sandbox only, where Whop cannot display
   * the app's views (DECISIONS.md). Needs the app id (OAuth client) and the API key (signs the
   * session cookie).
   */
  oauthLogin: boolean;
  /**
   * The Discord module (SPEC Phase 2, 5): reading needs the bot's token, adding the bot to a
   * server needs the application's client secret too.
   */
  discord: { botToken: string; clientSecret: string | null } | null;
  /** The Telegram module (decision of 2026-10-01). */
  telegram: { botToken: string } | null;
  /** Set only in development (ENVIRONMENT=development), never in a deployed Worker. */
  dev: { userId: string; accessLevel: AccessLevel | null } | null;
  /** The member space is on (MEMBER_SPACE_ENABLED=true); off, its routes and its work stop. */
  memberSpace: boolean;
  /** The legal pages are served (LEGAL_PAGES_ENABLED=true); off, they answer 404. */
  legalPages: boolean;
  /** The community whose team sees the internal status page; null: nobody's. */
  operatorCompanyId: string | null;
}

export function readConfig(env: Env): Config {
  const development = env.ENVIRONMENT === 'development';
  const devUser = development && isUserId(env.DEV_USER_ID) ? env.DEV_USER_ID : null;
  const devLevel = isAccessLevel(env.DEV_ACCESS_LEVEL) ? env.DEV_ACCESS_LEVEL : null;
  const whopEnv = parseWhopEnv(env.WHOP_ENV);
  const appId = env.WHOP_APP_ID || null;
  const apiKey = env.WHOP_API_KEY || null;
  return {
    whopEnv,
    appId,
    apiKey,
    webhookSecret: env.WHOP_WEBHOOK_SECRET || null,
    oauthLogin: whopEnv === 'sandbox' && appId !== null && apiKey !== null,
    discord: env.DISCORD_BOT_TOKEN
      ? { botToken: env.DISCORD_BOT_TOKEN, clientSecret: env.DISCORD_CLIENT_SECRET || null }
      : null,
    telegram: env.TELEGRAM_BOT_TOKEN ? { botToken: env.TELEGRAM_BOT_TOKEN } : null,
    dev: devUser ? { userId: devUser, accessLevel: devLevel } : null,
    memberSpace: env.MEMBER_SPACE_ENABLED === 'true',
    legalPages: env.LEGAL_PAGES_ENABLED === 'true',
    operatorCompanyId: isCompanyId(env.OPERATOR_COMPANY_ID) ? env.OPERATOR_COMPANY_ID : null,
  };
}
