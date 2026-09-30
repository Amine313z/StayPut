import { isAccessLevel, isUserId, type AccessLevel } from '@stayput/core';
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
}

export interface Config {
  whopEnv: WhopEnv;
  appId: string | null;
  apiKey: string | null;
  webhookSecret: string | null;
  /** Set only in development (ENVIRONMENT=development), never in a deployed Worker. */
  dev: { userId: string; accessLevel: AccessLevel | null } | null;
}

export function readConfig(env: Env): Config {
  const development = env.ENVIRONMENT === 'development';
  const devUser = development && isUserId(env.DEV_USER_ID) ? env.DEV_USER_ID : null;
  const devLevel = isAccessLevel(env.DEV_ACCESS_LEVEL) ? env.DEV_ACCESS_LEVEL : null;
  return {
    whopEnv: parseWhopEnv(env.WHOP_ENV),
    appId: env.WHOP_APP_ID || null,
    apiKey: env.WHOP_API_KEY || null,
    webhookSecret: env.WHOP_WEBHOOK_SECRET || null,
    dev: devUser ? { userId: devUser, accessLevel: devLevel } : null,
  };
}
