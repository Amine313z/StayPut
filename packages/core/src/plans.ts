import type { ActionSettingsUpdate, ActionSettingsView, RuleId } from './api';

/**
 * StayPut's plans (decision of 2026-10-10): what each level opens, in ONE place. The Worker
 * refuses what a community's level does not open (HTTP 402, `PaymentRequiredBody`), whatever the
 * page shows; the page reads the same table to put a lock where the Worker would refuse.
 *
 * The level belongs to the community (Whop's company), never to a person: it comes from the
 * Whop access of the company's owner to StayPut's products (Scale, else Pro, else Free), and the
 * whole team has it. Prices, trials and discounts are Whop's: no price and no length of time is
 * written here, only what each level opens and its limits.
 */

export const TIERS = ['free', 'pro', 'scale'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** Whether `tier` is `min` or above. */
export function tierAtLeast(tier: Tier, min: Tier): boolean {
  return TIERS.indexOf(tier) >= TIERS.indexOf(min);
}

/** The higher of two levels. */
export function higherTier(a: Tier, b: Tier): Tier {
  return tierAtLeast(a, b) ? a : b;
}

/**
 * Every feature a level opens, and the lowest level that opens it. Free's are listed too, so
 * that the table reads as the offer does; a feature missing here opens for everyone.
 */
export const FEATURES = {
  // Free: the dashboard, money at risk, the risk score, « Needs attention ».
  dashboard: 'free',
  risk_score: 'free',
  needs_attention: 'free',
  // Free: Whop's activity and one platform (Discord or Telegram), read only.
  whop_activity: 'free',
  one_platform: 'free',
  // Free: the verified retention badge, the comparison with the niche.
  badge: 'free',
  benchmarks: 'free',
  // Free: the 90-day forecast as a preview (its one figure); 7 days of history.
  forecast_preview: 'free',
  // Free: a few manual actions a month (Message, Pause, Offer), counted (LIMITS).
  manual_actions: 'free',
  // Free: the data export, the team.
  export: 'free',
  team: 'free',

  // Pro: unlimited manual actions; the actions StayPut prepares, and « Approve all ».
  unlimited_actions: 'pro',
  prepared_actions: 'pro',
  // Pro: failed payments recovered, pause offers.
  payment_recovery: 'pro',
  pause_offers: 'pro',
  // Pro: the follow-up automation and its settings (limits, quiet hours, best hour).
  automations: 'pro',
  // Pro: the departure survey, cohorts, the Monday report, 90 days of history.
  exit_survey: 'pro',
  cohorts: 'pro',
  weekly_report: 'pro',
  // Pro: Discord and Telegram together, with direct messages.
  both_platforms: 'pro',
  platform_dms: 'pro',
  // Pro: the whole 90-day forecast.
  forecast: 'pro',

  // Scale: the autopilot (actions run without approval).
  autopilot: 'scale',
  // Scale: win back former members, and the Alumni product.
  winback: 'scale',
  // Scale: lessons and recommendations, forecast scenarios.
  lessons: 'scale',
  forecast_scenarios: 'scale',
  // Scale: several Discord servers or Telegram groups, several whops.
  several_servers: 'scale',
  several_whops: 'scale',
  // Scale: priority support.
  priority_support: 'scale',
} as const satisfies Record<string, Tier>;

export type Feature = keyof typeof FEATURES;

export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && Object.hasOwn(FEATURES, value);
}

/** The lowest level that opens `feature`. */
export function requiredTier(feature: Feature): Tier {
  return FEATURES[feature];
}

/** Whether a community at `tier` may use `feature`. */
export function allows(tier: Tier, feature: Feature): boolean {
  return tierAtLeast(tier, FEATURES[feature]);
}

export interface TierLimits {
  /** Manual actions (Message, Pause, Offer) a month; null: no limit. */
  manualActionsPerMonth: number | null;
  /** Days of history the dashboard's figures and charts go back. */
  historyDays: number;
  /** Discord servers plus Telegram groups connected at once; null: no limit. */
  servers: number | null;
}

/** Each level's limits. */
export const LIMITS: Readonly<Record<Tier, TierLimits>> = {
  free: { manualActionsPerMonth: 5, historyDays: 7, servers: 1 },
  pro: { manualActionsPerMonth: null, historyDays: 90, servers: 2 },
  scale: { manualActionsPerMonth: null, historyDays: 90, servers: null },
};

/**
 * Where a community's level comes from: Whop (the owner's access to StayPut's products), the
 * founders' plan B (FOUNDER_FALLBACK_MODE: the registry gives Scale until BETA_END), nothing
 * (Free), or `off`: plans are not set up yet (no products configured), everything is open.
 */
export type TierSource = 'whop' | 'founder_fallback' | 'none' | 'off';

/** The platforms a community connects servers of. */
export type ServerPlatform = 'discord' | 'telegram';

/**
 * Whether a community at `tier`, with these servers connected, may connect one more on
 * `platform` (one already connected counts once): null when it may, else the level that
 * would let it. Free: one server, Discord or Telegram. Pro: one Discord server and one Telegram
 * group. Scale: as many as it likes.
 */
export function serverAllowed(
  tier: Tier,
  connected: Readonly<Record<ServerPlatform, number>>,
  platform: ServerPlatform,
): Tier | null {
  if (tier === 'scale') return null;
  if (tier === 'pro') return connected[platform] === 0 ? null : 'scale';
  const total = connected.discord + connected.telegram;
  if (total === 0) return null;
  return connected[platform] === 0 && total === 1 ? 'pro' : 'scale';
}

/** A founder's place in the registry (the registry never opens anything: the Whop plan does). */
export type FounderStatus = 'invited' | 'subscribed' | 'flagged';

export const FOUNDER_STATUSES: readonly FounderStatus[] = ['invited', 'subscribed', 'flagged'];

/** Places in the founders' registry. */
export const FOUNDER_PLACES = 20;

/** The community's plan as the dashboard shows it (GET /api/creator/:companyId/session). */
export interface PlanView {
  tier: Tier;
  source: TierSource;
  /** The Whop trial under way, and when Whop ends it (the first charge), else null. */
  trialEndsAt: string | null;
  /**
   * The plan bought is the founders' one: the banner and its reminders, with its price as Whop
   * gives it (null when Whop did not say).
   */
  founder: {
    trialEndsAt: string | null;
    price: { amount: number; currency: string } | null;
  } | null;
  /** Free's manual actions this month (null: no limit at this level). */
  manualActions: { used: number; limit: number } | null;
  /** Where to subscribe: the visible plans only, never the founders' one. */
  checkout: { pro: string | null; scale: string | null };
  /** To open the checkout through Whop inside its frame. */
  whopAppId: string | null;
  /** Whop did not answer the last check: the level shown is the last one known. */
  stale: boolean;
}

/**
 * One of Pro's or Scale's Whop plans, as Settings › Plan shows it: its price, its trial, its
 * checkout. Read from Whop (`GET /plans/{id}`), never typed in StayPut: what Whop charges is
 * what the page says.
 */
export interface PlanOffer {
  /** How often Whop charges: every month, or every year. */
  period: 'month' | 'year';
  /** What Whop charges each period, in the currency's units (29 is $29). */
  amount: number;
  currency: string;
  /** The free days before the first charge, when the plan has a trial. */
  trialDays: number | null;
  /** Whop's checkout of this plan (https, whop.com), when Whop gave it. */
  checkout: string | null;
}

/** GET /api/creator/:companyId/offers: Pro's and Scale's plans, null when Whop did not answer. */
export interface PlanOffersView {
  offers: { pro: PlanOffer[]; scale: PlanOffer[] } | null;
}

/** The body of a 402: the level that opens what was asked, and where to get it. */
export interface PaymentRequiredBody {
  error: { code: 'payment_required'; message: string };
  requiredTier: Tier;
  checkoutUrl: string | null;
}

/** The founders' registry and the communities on a plan (GET /api/admin/companies). */
export interface AdminCompaniesView {
  companies: AdminCompanyRow[];
  /** The private beta's requests: communities not invited whose team opened StayPut. */
  requests: AccessRequestRow[];
  /** Help & support › Support: what teams wrote to the founder, the latest first. */
  support: SupportMessageRow[];
  founders: { places: number; taken: number; left: number };
  fallback: { on: boolean; betaEnd: string | null };
}

export interface AccessRequestRow {
  companyId: string;
  /** Its name as Whop gives it, once read. */
  name: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Its team's visits (calls less than a minute apart count once). */
  visits: number;
}

/** A message a team wrote to the founder from Help & support. */
export interface SupportMessageRow {
  id: string;
  companyId: string;
  /** The community's name as Whop gives it, once read. */
  name: string | null;
  /** Who on the team wrote it. */
  userId: string;
  body: string;
  createdAt: string;
  /** Whop's notification reached the founder's team. */
  notified: boolean;
  /** The copy is in the support chat with the writer: the founder answers there. */
  inChat: boolean;
}

export interface AdminCompanyRow {
  companyId: string;
  name: string | null;
  tier: Tier;
  source: TierSource;
  /** The Whop plan the owner holds (its id), when known. */
  planId: string | null;
  trialEndsAt: string | null;
  founder: { status: FounderStatus; invitedAt: string; note: string | null } | null;
  checkedAt: string | null;
  stale: boolean;
}

/** The feature each rule of Automations › Rules is (turning one on is its plan's). */
export const RULE_FEATURES: Readonly<Record<RuleId, Feature>> = {
  payment_retry: 'payment_recovery',
  payment_notice: 'payment_recovery',
  exit_survey: 'exit_survey',
  check_in: 'automations',
  welcome: 'automations',
};

/** The settings of the follow-up automation (Pro's): limits, quiet hours, best hour, wording. */
const AUTOMATION_FIELDS = [
  'quietHoursStart',
  'quietHoursEnd',
  'defaultSendHour',
  'maxMessagesPer5Days',
  'maxMessagesPerMonth',
  'maxPaymentRetries',
  'monthlyPromoCap',
  'maxFreeDaysPerQuarter',
] as const satisfies readonly (keyof ActionSettingsView)[];

/**
 * Whether saving `next` over `current` changes the follow-up automation (its limits, hours,
 * messages or departure offers): Pro's. The language, the time zone, test mode and the stop are
 * everyone's.
 */
export function automationChanged(
  current: ActionSettingsView,
  next: ActionSettingsUpdate,
): boolean {
  if (AUTOMATION_FIELDS.some((field) => current[field] !== next[field])) return true;
  if (stable(current.templates) !== stable(next.templates)) return true;
  return next.offers !== undefined && stable(current.offers) !== stable(next.offers);
}

/** JSON with the keys sorted: the same settings read the same, whatever their order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
