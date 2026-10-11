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
  /**
   * StayPut's plans (decisions of 2026-10-10 and 2026-10-11), all set on Whop as plans of the
   * app's own product (its App Store listing): Pro's plans and Scale's (`plan_…`, comma-separated:
   * monthly, yearly), the founders' hidden plan, the visible plans' checkout links. Not secrets.
   * Without Pro's and Scale's plans, plans are off and every community has everything.
   */
  WHOP_PLANS_PRO?: string;
  WHOP_PLANS_SCALE?: string;
  WHOP_PLAN_SCALE_FOUNDER?: string;
  CHECKOUT_URL_PRO?: string;
  CHECKOUT_URL_SCALE?: string;
  /** The founder's Whop user (`user_…`): the only one who sees the admin page. */
  ADMIN_USER_ID?: string;
  /**
   * The founders' plan B, if Whop refuses the founders' trial: "on" gives Scale to the registry's
   * communities until BETA_END (an ISO date). Set in Cloudflare's dashboard, it applies without
   * a deployment (wrangler.toml keeps the dashboard's variables).
   */
  FOUNDER_FALLBACK_MODE?: string;
  BETA_END?: string;
  /**
   * The private beta: "true" opens StayPut only to the communities invited (the founders'
   * registry, Settings › Admin), the operator's and the founder's own; any other answers
   * `not_invited`. On in production by default (deploy.yml).
   */
  INVITE_ONLY?: string;
}

/** StayPut's plans as configured; `enabled` once Pro's and Scale's plans are set. */
export interface PlansConfig {
  enabled: boolean;
  /** Whop's plans that give Pro, and Scale (the founders' plan gives Scale too). */
  proPlans: readonly string[];
  scalePlans: readonly string[];
  founderPlan: string | null;
  checkout: { pro: string | null; scale: string | null };
  adminUserId: string | null;
  founderFallback: { on: boolean; betaEnd: Date | null };
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
  /** The private beta (INVITE_ONLY): only invited communities open StayPut. */
  inviteOnly: boolean;
  plans: PlansConfig;
}

const PLAN_ID = /^plan_[A-Za-z0-9]+$/;

/** A checkout link on Whop (https, whop.com), else null: never a link elsewhere. */
function checkoutUrl(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    const host = url.hostname;
    return url.protocol === 'https:' && (host === 'whop.com' || host.endsWith('.whop.com'))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Whop plan ids, comma-separated; anything else left out. */
function planIds(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => PLAN_ID.test(id)),
    ),
  ];
}

export function readPlansConfig(env: Env): PlansConfig {
  const founder = env.WHOP_PLAN_SCALE_FOUNDER?.trim() ?? '';
  const admin = env.ADMIN_USER_ID?.trim();
  const betaEnd = env.BETA_END?.trim() ? new Date(env.BETA_END.trim()) : null;
  const proPlans = planIds(env.WHOP_PLANS_PRO);
  const scalePlans = planIds(env.WHOP_PLANS_SCALE);
  return {
    enabled: proPlans.length > 0 && scalePlans.length > 0,
    proPlans,
    scalePlans,
    founderPlan: PLAN_ID.test(founder) ? founder : null,
    checkout: {
      pro: checkoutUrl(env.CHECKOUT_URL_PRO),
      scale: checkoutUrl(env.CHECKOUT_URL_SCALE),
    },
    adminUserId: isUserId(admin) ? admin : null,
    founderFallback: {
      on: env.FOUNDER_FALLBACK_MODE?.trim().toLowerCase() === 'on',
      betaEnd: betaEnd && !Number.isNaN(betaEnd.getTime()) ? betaEnd : null,
    },
  };
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
    inviteOnly: ['true', 'on'].includes(env.INVITE_ONLY?.trim().toLowerCase() ?? ''),
    plans: readPlansConfig(env),
  };
}
