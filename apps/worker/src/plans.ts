import {
  FOUNDER_PLACES,
  LIMITS,
  allows,
  forecastRevenue,
  higherTier,
  isTier,
  type AdminCompaniesView,
  type AdminCompanyRow,
  type DashboardView,
  type FounderStatus,
  type InsightsOverview,
  type InsightsReport,
  type PlanView,
  type PlatformDashboard,
  type Tier,
  type TierSource,
} from '@stayput/core';
import { WhopApiError, type WhopClient } from '@stayput/whop';
import type { Db } from './db';
import type { PlansConfig } from './env';

/**
 * A community's plan (decision of 2026-10-10; packages/core/src/plans.ts says what each level
 * opens). The level is the company's, from its OWNER's access to StayPut's products on Whop:
 * Scale, else Pro, else Free, a trial running counting as access (Whop charges at its end, never
 * StayPut). The whole team has it. Kept in stayput.company_plans and read again from Whop after
 * PLAN_FRESH_MS, or at once after a membership webhook; when Whop does not answer, the last
 * known level stays, never less.
 */

/** How long a level read from Whop holds before it is read again. */
export const PLAN_FRESH_MS = 5 * 60_000;
/** After Whop did not answer: when to ask again. */
export const PLAN_RETRY_MS = 60_000;

/** Whop's statuses of a membership that opens access. */
const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceling']);

export interface CompanyPlan {
  tier: Tier;
  source: TierSource;
  ownerUserId: string | null;
  planId: string | null;
  trialEndsAt: Date | null;
  /** The owner holds the founders' plan. */
  founderPlan: boolean;
  /** Whop did not answer the last reading: this is the last level known. */
  stale: boolean;
}

/** Plans not set up (no products configured): everything is open, as before plans. */
export const OPEN_PLAN: CompanyPlan = {
  tier: 'scale',
  source: 'off',
  ownerUserId: null,
  planId: null,
  trialEndsAt: null,
  founderPlan: false,
  stale: false,
};

interface PlanRow {
  tier: string;
  source: string;
  owner_user_id: string | null;
  company_owner: string | null;
  plan_id: string | null;
  trial_ends_at: Date | string | null;
  fresh_until: Date | string | null;
  failed_at: Date | string | null;
}

const asDate = (value: Date | string | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value);

function fromRow(row: PlanRow, config: PlansConfig, stale: boolean): CompanyPlan {
  const tier = isTier(row.tier) ? row.tier : 'free';
  return {
    tier,
    source: (['whop', 'founder_fallback', 'none'] as const).find((s) => s === row.source) ?? 'none',
    ownerUserId: row.owner_user_id ?? row.company_owner,
    planId: row.plan_id,
    trialEndsAt: asDate(row.trial_ends_at),
    founderPlan: config.founderPlan !== null && row.plan_id === config.founderPlan,
    stale,
  };
}

/** Readings under way in this Worker instance: the calls of one screen share one. */
const reading = new Map<string, Promise<CompanyPlan>>();

/**
 * The community's plan: the stored one while fresh, else read again from Whop (`force`: read
 * again whatever its age). Never throws on Whop's account: the last level known stays.
 */
export async function companyPlan(
  db: Db,
  whop: WhopClient | null,
  config: PlansConfig,
  companyId: string,
  now: Date,
  options: { force?: boolean } = {},
): Promise<CompanyPlan> {
  if (!config.enabled) return OPEN_PLAN;
  const [row] = await db.query<PlanRow>(
    `select p.tier, p.source, p.owner_user_id, c.owner_user_id as company_owner, p.plan_id,
            p.trial_ends_at, p.fresh_until, p.failed_at
       from stayput.companies c
       left join stayput.company_plans p on p.company_id = c.id
      where c.id = $1`,
    [companyId],
  );
  if (!row) return { ...OPEN_PLAN, tier: 'free', source: 'none' };
  const freshUntil = asDate(row.fresh_until);
  if (!options.force && row.tier && freshUntil && freshUntil > now) {
    return fromRow(row, config, row.failed_at !== null);
  }
  const key = companyId;
  let asked = reading.get(key);
  if (!asked) {
    asked = readFromWhop(db, whop, config, companyId, row, now).finally(() => reading.delete(key));
    reading.set(key, asked);
  }
  return asked;
}

/** What Whop says of the owner's access, stored; the last level known when it does not answer. */
async function readFromWhop(
  db: Db,
  whop: WhopClient | null,
  config: PlansConfig,
  companyId: string,
  row: PlanRow,
  now: Date,
): Promise<CompanyPlan> {
  const known = row.tier ? fromRow(row, config, true) : null;
  try {
    if (!whop) throw new Error('WHOP_API_KEY is not set');
    const owner = row.company_owner ?? (await readOwner(db, whop, companyId));
    if (!owner) throw new Error('Whop named no owner for this company');
    let tier: Tier = 'free';
    let product: string | null = null;
    if (await hasAccess(whop, owner, config.scaleProduct!)) {
      tier = 'scale';
      product = config.scaleProduct;
    } else if (await hasAccess(whop, owner, config.proProduct!)) {
      tier = 'pro';
      product = config.proProduct;
    }
    // Pro covers one whop: the owner's first installed community. Scale covers them all.
    if (tier === 'pro' && !(await firstOfOwner(db, owner, companyId))) tier = 'free';
    const membership = product ? await ownerMembership(db, whop, owner, product, now) : null;
    let source: TierSource = tier === 'free' ? 'none' : 'whop';
    // Plan B for the founders (FOUNDER_FALLBACK_MODE): Scale until BETA_END for the registry.
    if (tier !== 'scale' && (await fallbackScale(db, config, companyId, now))) {
      source = 'founder_fallback';
      tier = higherTier(tier, 'scale');
    }
    const founderPlan = config.founderPlan !== null && membership?.planId === config.founderPlan;
    if (founderPlan) {
      await db.query('select stayput.note_founder_plan($1, $2::timestamptz)', [
        companyId,
        now.toISOString(),
      ]);
    }
    await store(db, companyId, now, {
      tier,
      source,
      owner,
      membershipId: membership?.id ?? null,
      planId: membership?.planId ?? null,
      trialEndsAt: membership?.trialEndsAt ?? null,
    });
    return {
      tier,
      source,
      ownerUserId: owner,
      planId: membership?.planId ?? null,
      trialEndsAt: membership?.trialEndsAt ?? null,
      founderPlan,
      stale: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Plan of ${companyId} not read from Whop:`, message);
    // The last level known stays, never less; Free only for a community never read.
    await db.query(
      `insert into stayput.company_plans (company_id, tier, source, fresh_until, failed_at,
                                          last_error)
       values ($1, 'free', 'none', $2::timestamptz, $3::timestamptz, left($4, 300))
       on conflict (company_id) do update
         set fresh_until = excluded.fresh_until, failed_at = excluded.failed_at,
             last_error = excluded.last_error`,
      [
        companyId,
        new Date(now.getTime() + PLAN_RETRY_MS).toISOString(),
        now.toISOString(),
        message,
      ],
    );
    return known ?? { ...OPEN_PLAN, tier: 'free', source: 'none', stale: true };
  }
}

/** Whether the user has access to the product; an id Whop does not know is no access. */
async function hasAccess(whop: WhopClient, userId: string, productId: string): Promise<boolean> {
  try {
    return (await whop.checkAccess(userId, productId)).hasAccess;
  } catch (error) {
    if (error instanceof WhopApiError && [400, 404, 422].includes(error.status)) return false;
    throw error;
  }
}

/** The company's owner as Whop's company says it (`owner_user`), kept on the company. */
async function readOwner(db: Db, whop: WhopClient, companyId: string): Promise<string | null> {
  const company = await whop.request<{ owner_user?: { id?: unknown } | null }>(
    'GET',
    `/companies/${encodeURIComponent(companyId)}`,
  );
  const owner = company.owner_user?.id;
  if (typeof owner !== 'string' || !/^user_[A-Za-z0-9]+$/.test(owner)) return null;
  await db.query('update stayput.companies set owner_user_id = $2 where id = $1', [
    companyId,
    owner,
  ]);
  return owner;
}

/** Whether this is the owner's first installed community (the one Pro covers). */
async function firstOfOwner(db: Db, owner: string, companyId: string): Promise<boolean> {
  const [first] = await db.query<{ id: string }>(
    `select id from stayput.companies
      where owner_user_id = $1 and status = 'active' and not is_demo
      order by installed_at, id limit 1`,
    [owner],
  );
  return !first || first.id === companyId;
}

/** The registry gives Scale until BETA_END, while plan B is on. */
async function fallbackScale(
  db: Db,
  config: PlansConfig,
  companyId: string,
  now: Date,
): Promise<boolean> {
  const { on, betaEnd } = config.founderFallback;
  if (!on || !betaEnd || now >= betaEnd) return false;
  const [row] = await db.query<{ invited: boolean }>(
    `select exists (select 1 from stayput.founders
                     where company_id = $1 and status in ('invited', 'subscribed')) as invited`,
    [companyId],
  );
  return row?.invited === true;
}

interface OwnerMembership {
  id: string;
  planId: string | null;
  trialEndsAt: Date | null;
}

/**
 * The owner's live StayPut membership for the product: which plan, and when a trial running
 * ends. From the memberships Whop's webhooks told, else asked to Whop (best effort: without it,
 * the level holds, only the banners lack their date).
 */
async function ownerMembership(
  db: Db,
  whop: WhopClient,
  owner: string,
  product: string,
  now: Date,
): Promise<OwnerMembership | null> {
  try {
    const page = await whop.listPage<Record<string, unknown>>('/memberships', {
      user_id: owner,
      product_id: product,
    });
    for (const membership of page.items) await noteAppMembership(db, membership, now);
  } catch (error) {
    console.info(
      'StayPut memberships not listed:',
      error instanceof Error ? error.message : String(error),
    );
  }
  const [row] = await db.query<{
    id: string;
    plan_id: string | null;
    status: string;
    renewal_period_end: Date | string | null;
  }>(
    `select id, plan_id, status, renewal_period_end from stayput.app_memberships
      where user_id = $1 and product_id = $2
        and status = any(string_to_array($3, ','))
      order by updated_at desc limit 1`,
    [owner, product, [...LIVE_STATUSES].join(',')],
  );
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    trialEndsAt: row.status === 'trialing' ? asDate(row.renewal_period_end) : null,
  };
}

/** A membership of StayPut's products as Whop gives it (a webhook's data, a listing's item). */
export async function noteAppMembership(
  db: Db,
  membership: Record<string, unknown>,
  now: Date,
): Promise<string | null> {
  const id = membership.id;
  const user = (membership.user as { id?: unknown } | undefined)?.id ?? membership.user_id;
  const product = (membership.product as { id?: unknown } | undefined)?.id ?? membership.product_id;
  const plan = (membership.plan as { id?: unknown } | undefined)?.id ?? membership.plan_id;
  const status = membership.status;
  if (
    typeof id !== 'string' ||
    !/^mem_[A-Za-z0-9]+$/.test(id) ||
    typeof user !== 'string' ||
    !/^user_[A-Za-z0-9]+$/.test(user) ||
    typeof status !== 'string' ||
    !/^[a-z_]{1,40}$/.test(status)
  ) {
    return null;
  }
  const end = membership.renewal_period_end;
  const ends = typeof end === 'string' && !Number.isNaN(Date.parse(end)) ? end : null;
  await db.query(
    `insert into stayput.app_memberships (id, user_id, product_id, plan_id, status,
                                          renewal_period_end, cancel_at_period_end, updated_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz)
     on conflict (id) do update
       set product_id = coalesce(excluded.product_id, stayput.app_memberships.product_id),
           plan_id = coalesce(excluded.plan_id, stayput.app_memberships.plan_id),
           status = excluded.status, renewal_period_end = excluded.renewal_period_end,
           cancel_at_period_end = excluded.cancel_at_period_end,
           updated_at = excluded.updated_at`,
    [
      id,
      user,
      typeof product === 'string' && /^prod_[A-Za-z0-9]+$/.test(product) ? product : null,
      typeof plan === 'string' && /^plan_[A-Za-z0-9]+$/.test(plan) ? plan : null,
      status,
      ends,
      membership.cancel_at_period_end === true,
      now.toISOString(),
    ],
  );
  return user;
}

async function store(
  db: Db,
  companyId: string,
  now: Date,
  plan: {
    tier: Tier;
    source: TierSource;
    owner: string;
    membershipId: string | null;
    planId: string | null;
    trialEndsAt: Date | null;
  },
): Promise<void> {
  await db.query(
    `insert into stayput.company_plans as p
            (company_id, tier, source, owner_user_id, membership_id, plan_id, trial_ends_at,
             checked_at, fresh_until, failed_at, last_error, changed_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, null,
             null, $8::timestamptz)
     on conflict (company_id) do update
       set tier = excluded.tier, source = excluded.source,
           owner_user_id = excluded.owner_user_id, membership_id = excluded.membership_id,
           plan_id = excluded.plan_id, trial_ends_at = excluded.trial_ends_at,
           checked_at = excluded.checked_at, fresh_until = excluded.fresh_until,
           failed_at = null, last_error = null,
           changed_at = case when p.tier = excluded.tier then p.changed_at
                             else excluded.changed_at end`,
    [
      companyId,
      plan.tier,
      plan.source,
      plan.owner,
      plan.membershipId,
      plan.planId,
      plan.trialEndsAt?.toISOString() ?? null,
      now.toISOString(),
      new Date(now.getTime() + PLAN_FRESH_MS).toISOString(),
    ],
  );
  await db.query(
    'update stayput.companies set plan = $2 where id = $1 and plan is distinct from $2',
    [companyId, plan.tier],
  );
  await autopilotFor(db, companyId, plan.tier);
}

/**
 * The autopilot is Scale's: below it, a community in automatic mode goes to manual (its actions
 * wait for approval), and back to automatic once on Scale again. Nothing else changes.
 */
async function autopilotFor(db: Db, companyId: string, tier: Tier): Promise<void> {
  if (tier === 'scale') {
    await db.query(
      `with resumed as (
         update stayput.company_plans set autopilot_paused = false
          where company_id = $1 and autopilot_paused returning company_id)
       update stayput.companies set mode = 'auto'
        where id in (select company_id from resumed)`,
      [companyId],
    );
  } else {
    await db.query(
      `with paused as (
         update stayput.companies set mode = 'manual'
          where id = $1 and mode = 'auto' returning id)
       update stayput.company_plans set autopilot_paused = true
        where company_id in (select id from paused)`,
      [companyId],
    );
  }
}

/**
 * Read again at the next request: the communities this user owns (a membership webhook names a
 * person; their communities have their level). Returns how many.
 */
export async function invalidatePlansOf(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ company_id: string }>(
    `update stayput.company_plans p set fresh_until = null
       from stayput.companies c
      where c.id = p.company_id and (c.owner_user_id = $1 or p.owner_user_id = $1)
      returning p.company_id`,
    [userId],
  );
  return rows.length;
}

/** Free's manual actions this month; null at a level without a limit. */
export async function manualActions(
  db: Db,
  companyId: string,
  tier: Tier,
  now: Date,
): Promise<{ used: number; limit: number } | null> {
  const limit = LIMITS[tier].manualActionsPerMonth;
  if (limit === null) return null;
  const [row] = await db.query<{ used: number }>(
    'select stayput.manual_actions_used($1, $2::timestamptz) as used',
    [companyId, now.toISOString()],
  );
  return { used: Number(row?.used ?? 0), limit };
}

/**
 * Takes `count` of Free's manual actions this month, all or none: `ok` false past the limit.
 * Levels without a limit take nothing.
 */
export async function takeManualActions(
  db: Db,
  companyId: string,
  tier: Tier,
  count: number,
  now: Date,
): Promise<{ ok: boolean; used: number; limit: number } | null> {
  const limit = LIMITS[tier].manualActionsPerMonth;
  if (limit === null || count < 1) return null;
  const [row] = await db.query<{ taken: { ok: boolean; used: number; limit: number } }>(
    'select stayput.take_manual_actions($1, $2, $3, $4::timestamptz) as taken',
    [companyId, count, limit, now.toISOString()],
  );
  return row?.taken ?? { ok: false, used: limit, limit };
}

/** Gives back actions taken for nothing (a member gone, an offer already open). */
export async function giveBackManualActions(
  db: Db,
  companyId: string,
  count: number,
  now: Date,
): Promise<void> {
  if (count < 1) return;
  await db.query('select stayput.give_back_manual_actions($1, $2, $3::timestamptz)', [
    companyId,
    count,
    now.toISOString(),
  ]);
}

/** The founders' plan's price as Whop gives it, read once an hour per Worker instance. */
let founderPrice: { at: number; price: { amount: number; currency: string } | null } | null = null;

async function readFounderPrice(
  whop: WhopClient | null,
  planId: string | null,
  now: Date,
): Promise<{ amount: number; currency: string } | null> {
  if (!whop || !planId) return null;
  if (founderPrice && now.getTime() - founderPrice.at < 3_600_000) return founderPrice.price;
  let price: { amount: number; currency: string } | null = null;
  try {
    const plan = await whop.request<{ renewal_price?: unknown; currency?: unknown }>(
      'GET',
      `/plans/${encodeURIComponent(planId)}`,
    );
    const amount = Number(plan.renewal_price);
    if (Number.isFinite(amount) && amount > 0 && typeof plan.currency === 'string') {
      price = { amount, currency: plan.currency };
    }
  } catch (error) {
    console.info('Founders’ plan not read:', error instanceof Error ? error.message : error);
  }
  founderPrice = { at: now.getTime(), price };
  return price;
}

/** The plan as the dashboard shows it. */
export async function planView(
  db: Db,
  config: PlansConfig,
  companyId: string,
  plan: CompanyPlan,
  now: Date,
  options: { whop?: WhopClient | null; whopAppId?: string | null } = {},
): Promise<PlanView> {
  return {
    tier: plan.tier,
    source: plan.source,
    trialEndsAt: plan.trialEndsAt?.toISOString() ?? null,
    founder: plan.founderPlan
      ? {
          trialEndsAt: plan.trialEndsAt?.toISOString() ?? null,
          price: await readFounderPrice(options.whop ?? null, config.founderPlan, now),
        }
      : null,
    manualActions:
      plan.source === 'off' ? null : await manualActions(db, companyId, plan.tier, now),
    checkout: config.checkout,
    whopAppId: options.whopAppId ?? null,
    stale: plan.stale,
  };
}

/**
 * The level stored for a community, without asking Whop (the cron's and the members' requests:
 * the dashboard and the hourly pass keep it fresh). Everything when plans are off.
 */
export async function storedTier(db: Db, config: PlansConfig, companyId: string): Promise<Tier> {
  if (!config.enabled) return 'scale';
  const [row] = await db.query<{ tier: string }>('select stayput.company_tier($1) as tier', [
    companyId,
  ]);
  return isTier(row?.tier) ? row.tier : 'free';
}

/** What StayPut may plan by itself at this level (prepareActions' options). */
export function planningAt(tier: Tier): { automations: boolean; winback: boolean } {
  return { automations: allows(tier, 'automations'), winback: allows(tier, 'winback') };
}

/**
 * A membership webhook (`membership.activated`, `.updated`, `.deactivated`, Whop's app events
 * alike): the person it names, and the membership when it is one of StayPut's own products (or
 * the founders' plan). Null for anything else.
 */
export function membershipEvent(
  event: unknown,
  config: PlansConfig,
): { userId: string; stayput: Record<string, unknown> | null } | null {
  if (!event || typeof event !== 'object') return null;
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !/^(app_)?membership[._]/.test(type)) return null;
  if (!data || typeof data !== 'object') return null;
  const membership = data as Record<string, unknown>;
  const user = (membership.user as { id?: unknown } | undefined)?.id ?? membership.user_id;
  if (typeof user !== 'string' || !/^user_[A-Za-z0-9]+$/.test(user)) return null;
  const product = (membership.product as { id?: unknown } | undefined)?.id ?? membership.product_id;
  const plan = (membership.plan as { id?: unknown } | undefined)?.id ?? membership.plan_id;
  const ours =
    (typeof product === 'string' &&
      (product === config.proProduct || product === config.scaleProduct)) ||
    (typeof plan === 'string' && plan === config.founderPlan);
  return { userId: user, stayput: ours ? membership : null };
}

/**
 * What a membership webhook changes: StayPut's own membership kept, the level of the communities
 * the person owns read again at their next request, and the founders' plan noted for them
 * (`subscribed` when invited, else `flagged`).
 */
export async function onMembershipEvent(
  db: Db,
  config: PlansConfig,
  event: unknown,
  now: Date,
): Promise<{ invalidated: number } | null> {
  if (!config.enabled) return null;
  const found = membershipEvent(event, config);
  if (!found) return null;
  if (found.stayput) {
    await noteAppMembership(db, found.stayput, now);
    const plan = (found.stayput.plan as { id?: unknown } | undefined)?.id ?? found.stayput.plan_id;
    if (config.founderPlan && plan === config.founderPlan) {
      await db.query(
        `select stayput.note_founder_plan(c.id, $2::timestamptz)
           from stayput.companies c where c.owner_user_id = $1`,
        [found.userId, now.toISOString()],
      );
    }
  }
  return { invalidated: await invalidatePlansOf(db, found.userId) };
}

/** The dashboard's history at this level: Free's last LIMITS.free.historyDays days. */
export function dashboardAt(view: DashboardView, tier: Tier): DashboardView {
  const days = LIMITS[tier].historyDays;
  if (days >= view.revenueHistory.length && days >= view.riskHistory.length) return view;
  return {
    ...view,
    riskHistory: view.riskHistory.slice(-days),
    revenueHistory: view.revenueHistory.slice(-days),
  };
}

/** A platform's dashboard at this level: Free's days only, no 14- or 30-day lists. */
export function platformAt(view: PlatformDashboard, tier: Tier): PlatformDashboard {
  const days = LIMITS[tier].historyDays;
  if (days >= view.daily.length) return view;
  const daily = view.daily.slice(-days);
  return {
    ...view,
    from: daily[0]?.day ?? view.from,
    daily,
    active: { ...view.active, d14: [], d30: [] },
    silent: {
      ...view.silent,
      d14: { total: 0, members: [] },
      d30: { total: 0, members: [] },
    },
  };
}

/** Whether a day (yyyy-mm-dd) is within this level's history, counted back from `today`. */
export function dayWithin(day: string, today: string, tier: Tier): boolean {
  const back = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
  return back < LIMITS[tier].historyDays;
}

/** Analytics at this level: cohorts are Pro's, lessons Scale's. */
export function insightsAt(report: InsightsReport, tier: Tier): InsightsReport {
  return {
    ...report,
    cohorts: allows(tier, 'cohorts') ? report.cohorts : [],
    averages: allows(tier, 'cohorts') ? report.averages : { 30: null, 60: null, 90: null },
    lessons: allows(tier, 'lessons') ? report.lessons : [],
  };
}

/**
 * Analytics › Overview at this level: Free sees the forecast's one figure (what acting adds over
 * 90 days) and its last days of activity, Pro the whole forecast, Scale its scenarios too.
 */
export function overviewAt(view: InsightsOverview, tier: Tier): InsightsOverview {
  if (allows(tier, 'forecast_scenarios')) {
    return { ...view, forecastAccess: 'scenarios', forecastPreview: null };
  }
  if (allows(tier, 'forecast')) return { ...view, forecastAccess: 'full', forecastPreview: null };
  const preview = forecastRevenue({
    revenue: view.revenue,
    stay: view.stay,
    saveRate: view.saveRate,
    reached: 1,
  }).gain;
  const none = Object.fromEntries(Object.keys(view.revenue).map((level) => [level, 0]));
  return {
    ...view,
    revenue: none as InsightsOverview['revenue'],
    stay: none as InsightsOverview['stay'],
    calibrated: [],
    saveRate: 0,
    saveRateObserved: false,
    activity: view.activity.slice(-LIMITS[tier].historyDays),
    forecastAccess: 'preview',
    forecastPreview: Math.round(preview * 100) / 100,
  };
}

/** The admin page (ADMIN_USER_ID): the communities, their level and plan, the founders. */
export async function readAdmin(db: Db, config: PlansConfig): Promise<AdminCompaniesView> {
  const rows = await db.query<{
    company_id: string;
    name: string | null;
    tier: string | null;
    source: string | null;
    plan_id: string | null;
    trial_ends_at: Date | string | null;
    checked_at: Date | string | null;
    failed_at: Date | string | null;
    founder_status: string | null;
    invited_at: Date | string | null;
    note: string | null;
  }>(
    `select coalesce(c.id, f.company_id) as company_id, c.name, p.tier, p.source, p.plan_id,
            p.trial_ends_at, p.checked_at, p.failed_at, f.status as founder_status,
            f.invited_at, f.note
       from (select id, name from stayput.companies where not is_demo) c
       full join stayput.founders f on f.company_id = c.id
       left join stayput.company_plans p on p.company_id = c.id
      order by (f.status = 'flagged') desc nulls last, p.tier desc nulls last,
               coalesce(c.id, f.company_id)`,
  );
  const iso = (value: Date | string | null) => asDate(value)?.toISOString() ?? null;
  const companies: AdminCompanyRow[] = rows.map((row) => ({
    companyId: row.company_id,
    name: row.name,
    tier: isTier(row.tier) ? row.tier : 'free',
    source: (['whop', 'founder_fallback', 'none'] as const).find((s) => s === row.source) ?? 'none',
    planId: row.plan_id,
    trialEndsAt: iso(row.trial_ends_at),
    founder:
      row.founder_status && row.invited_at
        ? {
            status: row.founder_status as FounderStatus,
            invitedAt: iso(row.invited_at)!,
            note: row.note,
          }
        : null,
    checkedAt: iso(row.checked_at),
    stale: row.failed_at !== null,
  }));
  const taken = companies.filter((c) => c.founder && c.founder.status !== 'flagged').length;
  return {
    companies,
    founders: { places: FOUNDER_PLACES, taken, left: Math.max(0, FOUNDER_PLACES - taken) },
    fallback: {
      on: config.founderFallback.on,
      betaEnd: config.founderFallback.betaEnd?.toISOString() ?? null,
    },
  };
}
