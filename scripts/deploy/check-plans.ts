/**
 * Deployment step (.github/workflows/deploy.yml): the plans StayPut sells, as Whop holds them.
 * StayPut gives a community the level of its owner's plan (decision of 2026-10-11), read in
 * WHOP_PLANS_PRO and WHOP_PLANS_SCALE; since 2026-10-24 those plans are Whop products the
 * founder makes by hand. A plan id typed wrong, or a checkout link (CHECKOUT_URL_*) to a plan
 * outside its level's list, would take a buyer's money and open nothing: production stops here,
 * before anything changes; the sandbox only reports. Each plan's level, period, price and trial
 * are printed (what its public checkout page shows); never the key.
 *
 *   tsx scripts/deploy/check-plans.ts
 */
import { WhopApiError, createWhopClient, parseWhopEnv } from '@stayput/whop';
import { secretValue } from './prepare';

const PLAN_ID = /^plan_[A-Za-z0-9]+$/;

export interface PlanSettings {
  pro: string | undefined;
  scale: string | undefined;
  checkoutPro: string | undefined;
  checkoutScale: string | undefined;
}

/** What Whop answered about one plan: its fields, or why there are none. */
export type PlanRead =
  { found: true; plan: Record<string, unknown> } | { found: false; status: number; detail: string };

export interface PlansReview {
  /** Mistakes a buyer would pay for: production stops on them. */
  problems: string[];
  /** Worth a look, never a stop. */
  warnings: string[];
  /** One line per plan read. */
  lines: string[];
}

/** The ids of a comma-separated setting, as the Worker reads them (env.ts planIds). */
export function planIdList(raw: string | undefined): { ids: string[]; invalid: string[] } {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    ids: [...new Set(items.filter((item) => PLAN_ID.test(item)))],
    invalid: items.filter((item) => !PLAN_ID.test(item)),
  };
}

/** The plan a checkout link leads to (`https://whop.com/checkout/plan_…`), else null. */
export function checkoutPlan(url: string | undefined): string | null {
  return /\/checkout\/(plan_[A-Za-z0-9]+)/.exec(url ?? '')?.[1] ?? null;
}

/** A plan as one line: « 79 USD / month, 30-day trial, visible ». */
export function describePlan(plan: Record<string, unknown>): string {
  const days = Number(plan.billing_period);
  const period =
    days >= 28 && days <= 31
      ? 'month'
      : days >= 360 && days <= 366
        ? 'year'
        : Number.isFinite(days) && days > 0
          ? `${days} days`
          : 'one payment';
  const price = Number(plan.renewal_price ?? plan.initial_price);
  const currency = typeof plan.currency === 'string' ? plan.currency.toUpperCase() : '';
  const trial = Number(plan.trial_period_days);
  return [
    `${Number.isFinite(price) ? price : '?'} ${currency} / ${period}`.trim(),
    Number.isInteger(trial) && trial > 0 ? `${trial}-day trial` : 'no trial',
    typeof plan.visibility === 'string' ? plan.visibility : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The plans as set, checked against what Whop holds (`read`: GET /plans/{id}). */
export async function reviewPlans(
  settings: PlanSettings,
  read: (id: string) => Promise<PlanRead>,
): Promise<PlansReview> {
  const review: PlansReview = { problems: [], warnings: [], lines: [] };
  const pro = planIdList(settings.pro);
  const scale = planIdList(settings.scale);
  for (const [name, list] of [
    ['WHOP_PLANS_PRO', pro],
    ['WHOP_PLANS_SCALE', scale],
  ] as const) {
    if (list.invalid.length > 0) {
      review.problems.push(
        `${name} holds ${list.invalid.length} value(s) that are not plan ids (plan_…): StayPut ` +
          'leaves them out, so whoever pays for them gets nothing.',
      );
    }
  }
  if (pro.ids.length === 0 && scale.ids.length === 0) {
    review.warnings.push('No plan is set: plans are off, every community has everything.');
    return review;
  }
  if (pro.ids.length === 0 || scale.ids.length === 0) {
    review.problems.push(
      `${pro.ids.length === 0 ? 'WHOP_PLANS_PRO' : 'WHOP_PLANS_SCALE'} is empty: StayPut turns ` +
        'plans off without both, and every community gets everything for free.',
    );
  }
  for (const id of pro.ids.filter((id) => scale.ids.includes(id))) {
    review.problems.push(`${id} is in both WHOP_PLANS_PRO and WHOP_PLANS_SCALE.`);
  }
  for (const [tier, list] of [
    ['Pro', pro.ids],
    ['Scale', scale.ids],
  ] as const) {
    // The monthly plans in the list's order: the plan page shows the first (readOffers).
    const monthly: { id: string; trial: number }[] = [];
    for (const id of list) {
      const answer = await read(id);
      if (!answer.found) {
        if (answer.status === 404) {
          review.problems.push(
            `${tier}: Whop knows no plan ${id}. Copy its id again from the plan in Whop.`,
          );
        } else {
          review.warnings.push(
            `${tier}: Whop did not show plan ${id} (${answer.detail}): the plan page will ` +
              'show no price for it. Check that the plan belongs to StayPut’s own community.',
          );
        }
        continue;
      }
      review.lines.push(`${tier} · ${id}: ${describePlan(answer.plan)}`);
      const days = Number(answer.plan.billing_period);
      if (days >= 28 && days <= 31) {
        monthly.push({ id, trial: Number(answer.plan.trial_period_days) || 0 });
      }
    }
    const shown = monthly[0];
    if (shown && monthly.length > 1) {
      review.lines.push(`${tier}: the plan page shows ${shown.id}, the first monthly plan.`);
      // An offer like the MVP (a longer trial) shown to everyone instead of the ordinary plan.
      if (monthly.some((plan) => plan.trial < shown.trial)) {
        review.warnings.push(
          `${tier}: the plan page shows ${shown.id} and its ${shown.trial}-day trial, not the ` +
            'ordinary plan: put the ordinary monthly plan first in the list.',
        );
      }
    }
  }
  for (const [name, url, list] of [
    ['CHECKOUT_URL_PRO', settings.checkoutPro, pro.ids],
    ['CHECKOUT_URL_SCALE', settings.checkoutScale, scale.ids],
  ] as const) {
    if (!url?.trim()) continue;
    const plan = checkoutPlan(url);
    if (!plan) {
      review.warnings.push(`${name} names no plan (whop.com/checkout/plan_…): not checked.`);
    } else if (!list.includes(plan)) {
      review.problems.push(
        `${name} leads to ${plan}, which is not in its level's list: a buyer would pay for ` +
          'nothing. Put that plan in the list, or the link of one of its plans in ' +
          `${name}.`,
      );
    }
  }
  return review;
}

async function main() {
  const apiKey = secretValue('WHOP_API_KEY', process.env.WHOP_API_KEY);
  const production = process.env.STAYPUT_TARGET?.trim() === 'production';
  const whop = apiKey
    ? createWhopClient({ apiKey, env: parseWhopEnv(process.env.WHOP_ENV) })
    : null;
  const review = await reviewPlans(
    {
      pro: process.env.WHOP_PLANS_PRO,
      scale: process.env.WHOP_PLANS_SCALE,
      checkoutPro: process.env.CHECKOUT_URL_PRO,
      checkoutScale: process.env.CHECKOUT_URL_SCALE,
    },
    async (id) => {
      if (!whop) return { found: false, status: 0, detail: 'WHOP_API_KEY is not set' };
      try {
        const plan = await whop.request<Record<string, unknown>>(
          'GET',
          `/plans/${encodeURIComponent(id)}`,
        );
        return { found: true, plan };
      } catch (error) {
        if (error instanceof WhopApiError) {
          return { found: false, status: error.status, detail: `${error.status} ${error.type}` };
        }
        return { found: false, status: 0, detail: error instanceof Error ? error.message : '?' };
      }
    },
  );
  for (const line of review.lines) console.info(line);
  for (const warning of review.warnings) console.warn(`::warning::${warning}`);
  for (const problem of review.problems) {
    console.error(production ? `::error::${problem}` : `::warning::${problem}`);
  }
  if (production && review.problems.length > 0) {
    throw new Error('The plans StayPut sells are not set right: nothing was deployed.');
  }
  if (review.problems.length === 0) console.info('Every plan set is one Whop sells.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
