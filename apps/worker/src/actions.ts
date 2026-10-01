import {
  DEFAULT_TEMPLATES,
  MESSAGE_KINDS,
  PROMO_VALID_DAYS,
  checkGuardrails,
  goldenHour,
  isActionType,
  nextLocalHour,
  outOfQuietHours,
  promoCode,
  renderMessage,
  type ActionType,
  type BlockReason,
  type GuardrailSettings,
  type MessageAction,
  type MessageTemplate,
  type OfferType,
  type TemplateLocale,
  type TemplateValues,
} from '@stayput/core';
import { WhopApiError, type WhopClient } from '@stayput/whop';
import type { Db } from './db';

/**
 * The actions of SPEC Phase 4, as the Worker runs them: plan them from the company's state
 * (stayput.plan_actions), pass the ready ones through the guardrails (packages/core) and
 * schedule them, then run the ones whose time has come, in test mode (simulated, nothing sent)
 * or for real through Whop. The hourly cron does all three.
 */

/** Actions a company passes through the guardrails per run. */
export const SCHEDULE_BATCH = 50;
/** Actions run per cron run: each is a Whop call, within the run's subrequests. */
export const EXECUTE_BATCH = 20;
/** A Whop outage is tried again an hour later, three attempts in all. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_600_000;

/** What stayput.actions_to_schedule returns. */
export interface ScheduleContext {
  mode: 'auto' | 'manual';
  timezone: string;
  globalKillSwitch: boolean;
  settings: Omit<GuardrailSettings, 'timezone'> & { defaultSendHour: number };
  promosLast30: number;
  actions: {
    id: string;
    type: string;
    memberId: string;
    sendAt: string | null;
    freeDays: number | null;
    doNotContact: boolean;
    messages: { at: string; kind: 'relance' | 'service' }[];
    paymentRetries: number;
    activePromo: boolean;
    freeDaysLast90: number;
    /** 24 counts, for a follow-up whose time is the golden hour. */
    hours: number[] | null;
  }[];
}

export interface ScheduleDecision {
  id: string;
  status: 'scheduled' | 'blocked_by_guardrail';
  send_at: string | null;
  reason: BlockReason | null;
}

/**
 * The guardrails' verdict on each action, in order: a message scheduled for a member counts for
 * the next actions of the same member, so that one run never schedules two follow-ups in a row.
 */
export function scheduleDecisions(context: ScheduleContext, now: number): ScheduleDecision[] {
  const settings: GuardrailSettings = { ...context.settings, timezone: context.timezone };
  const added = new Map<string, { at: number; kind: 'relance' | 'service' }[]>();
  return context.actions.flatMap((action): ScheduleDecision[] => {
    if (!isActionType(action.type)) return [];
    const type: ActionType = action.type;
    const sendAt =
      action.sendAt !== null
        ? Date.parse(action.sendAt)
        : nextLocalHour(
            now,
            goldenHour(action.hours, settings, context.settings.defaultSendHour),
            context.timezone,
          );
    const earlier = added.get(action.memberId) ?? [];
    const verdict = checkGuardrails(
      { type, sendAt, ...(action.freeDays !== null ? { freeDays: action.freeDays } : {}) },
      {
        settings,
        globalKillSwitch: context.globalKillSwitch,
        member: {
          doNotContact: action.doNotContact,
          messages: [
            ...action.messages.map((m) => ({ at: Date.parse(m.at), kind: m.kind })),
            ...earlier,
          ],
          paymentRetries: action.paymentRetries,
          activePromo: action.activePromo,
          freeDaysLast90: action.freeDaysLast90,
        },
        company: { promosLast30: context.promosLast30 },
      },
    );
    if (!verdict.allowed) {
      return [
        { id: action.id, status: 'blocked_by_guardrail', send_at: null, reason: verdict.reason },
      ];
    }
    const kind = MESSAGE_KINDS[type];
    if (kind !== 'none') added.set(action.memberId, [...earlier, { at: verdict.sendAt, kind }]);
    return [
      {
        id: action.id,
        status: 'scheduled',
        send_at: new Date(verdict.sendAt).toISOString(),
        reason: null,
      },
    ];
  });
}

/** Plans a company's actions from its state, then schedules or blocks the ones that are ready. */
export async function prepareActions(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ planned: number; scheduled: number; blocked: number }> {
  const at = now.toISOString();
  const [plan] = await db.query<{ planned: number }>(
    'select stayput.plan_actions($1, $2::timestamptz) as planned',
    [companyId, at],
  );
  const [row] = await db.query<{ context: ScheduleContext | null }>(
    'select stayput.actions_to_schedule($1, $2::timestamptz, $3) as context',
    [companyId, at, SCHEDULE_BATCH],
  );
  const decisions = row?.context ? scheduleDecisions(row.context, now.getTime()) : [];
  if (decisions.length > 0) {
    await db.query('select stayput.apply_schedule($1, $2::text::jsonb, $3::timestamptz)', [
      companyId,
      JSON.stringify(decisions),
      at,
    ]);
  }
  return {
    planned: plan?.planned ?? 0,
    scheduled: decisions.filter((d) => d.status === 'scheduled').length,
    blocked: decisions.filter((d) => d.status === 'blocked_by_guardrail').length,
  };
}

/** What stayput.due_actions returns for each action. */
export interface DueAction {
  id: string;
  companyId: string;
  createdAt: string;
  type: string;
  attempts: number;
  content: Record<string, unknown>;
  globalKillSwitch: boolean;
  killSwitch: boolean;
  dryRun: boolean;
  locale: string;
  /** The company's zone and quiet hours now: they may have changed since the scheduling. */
  timezone: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  experienceId: string | null;
  /** The creator's own templates: `{ fr: { welcome_message: { title, body } } }`. */
  templates: Partial<Record<string, Partial<Record<string, Partial<MessageTemplate>>>>>;
  member: { userId: string; doNotContact: boolean; joined: boolean };
  payment: {
    id: string;
    status: string;
    retryable: boolean | null;
    nextAttemptAt: string | null;
    recoveryUrl: string | null;
  } | null;
  membership: {
    id: string;
    canceling: boolean;
    ended: boolean;
    productId: string | null;
    currency: string | null;
    periodEnd: string | null;
  } | null;
  values: TemplateValues;
}

const FAILED_PAYMENT = new Set(['failed', 'past_due', 'uncollectible', 'unresolved']);
/** A payment waiting for its 3D Secure check (as stayput.risk_features reads it). */
const ACTION_REQUIRED = new Set([
  'open',
  'pending',
  'incomplete',
  'requires_action',
  'requires_capture',
]);

/**
 * Whether what triggered the action still holds when its time comes: a member who paid in the
 * meantime gets no « your payment failed », one who withdrew their cancellation no survey.
 */
function stale(type: ActionType, action: DueAction): string | null {
  const payment = action.payment;
  switch (type) {
    case 'payment_failed_notice':
      return payment && FAILED_PAYMENT.has(payment.status) ? null : 'payment_no_longer_failed';
    case 'payment_action_notice':
      return payment?.recoveryUrl && ACTION_REQUIRED.has(payment.status)
        ? null
        : 'payment_no_longer_waiting';
    case 'exit_survey':
      return action.membership?.canceling ? null : 'cancellation_withdrawn';
    default:
      return null;
  }
}

/** The message of an action: the creator's template when they wrote one, else StayPut's. */
export function actionMessage(action: DueAction, type: MessageAction): MessageTemplate {
  return renderActionMessage(type, action.locale, action.templates, action.values);
}

/**
 * A message in the company's language: the creator's wording where they wrote one (title and
 * text apart), StayPut's otherwise, with the member's values. The preview the creator approves
 * is the message that leaves.
 */
export function renderActionMessage(
  type: MessageAction,
  locale: string,
  templates: Partial<Record<string, Partial<Record<string, Partial<MessageTemplate>>>>>,
  values: TemplateValues,
): MessageTemplate {
  const language: TemplateLocale = locale === 'fr' ? 'fr' : 'en';
  const fallback = DEFAULT_TEMPLATES[language][type];
  const own = templates[language]?.[type];
  const template: MessageTemplate = {
    title: own?.title?.trim() ? own.title : fallback.title,
    body: own?.body?.trim() ? own.body : fallback.body,
  };
  return renderMessage(template, values);
}

type Outcome =
  | { status: 'postponed'; sendAt: number }
  | { status: 'sent' | 'simulated'; result: Record<string, unknown> }
  | { status: 'cancelled'; result: Record<string, unknown> }
  | { status: 'blocked_by_guardrail'; reason: BlockReason }
  | { status: 'failed'; error: string; retry: boolean };

/**
 * What one action comes to at `now`: the last stops, the quiet hours, then the test mode, then
 * Whop.
 */
export async function runAction(
  action: DueAction,
  whop: WhopClient | null,
  now: number,
): Promise<Outcome> {
  if (action.globalKillSwitch)
    return { status: 'blocked_by_guardrail', reason: 'global_kill_switch' };
  if (action.killSwitch) return { status: 'blocked_by_guardrail', reason: 'kill_switch' };
  if (action.member.doNotContact)
    return { status: 'blocked_by_guardrail', reason: 'do_not_contact' };
  if (!action.member.joined) return { status: 'cancelled', result: { reason: 'member_left' } };
  if (!isActionType(action.type)) {
    return { status: 'failed', error: `unknown action type ${action.type}`, retry: false };
  }
  const type: ActionType = action.type;
  const gone = stale(type, action);
  if (gone) return { status: 'cancelled', result: { reason: gone } };
  if (MESSAGE_KINDS[type] !== 'none') {
    // Scheduled before the creator changed their zone or quiet hours, or run late: a message
    // never leaves during the quiet hours, it waits for their end.
    const sendAt = outOfQuietHours(now, action);
    if (sendAt > now) return { status: 'postponed', sendAt };
  }

  if (type === 'payment_retry') {
    const payment = action.payment;
    if (!payment || !FAILED_PAYMENT.has(payment.status)) {
      return { status: 'cancelled', result: { reason: 'payment_no_longer_failed' } };
    }
    if (payment.nextAttemptAt) return { status: 'cancelled', result: { reason: 'whop_retries' } };
    if (!payment.retryable) return { status: 'cancelled', result: { reason: 'not_retryable' } };
    if (action.dryRun) return { status: 'simulated', result: { retry: payment.id } };
    if (!whop) return { status: 'failed', error: 'the Whop API key is not set', retry: false };
    return callWhop(action, () =>
      whop.request('POST', `/payments/${encodeURIComponent(payment.id)}/retry`, {
        idempotencyKey: `stayput-action-${action.id}`,
      }),
    ).then((outcome) =>
      outcome.status === 'sent' ? { status: 'sent', result: { retry: payment.id } } : outcome,
    );
  }

  if (OFFERS.has(type)) return runOffer(action, type as OfferType, whop);
  if (MESSAGE_KINDS[type] === 'none') {
    return { status: 'failed', error: `${type} is not run by StayPut`, retry: false };
  }
  const message = actionMessage(action, type as MessageAction);
  if (action.dryRun) return { status: 'simulated', result: { message } };
  if (!whop) return { status: 'failed', error: 'the Whop API key is not set', retry: false };
  const experienceId = action.experienceId;
  if (!experienceId) {
    // Learned when a member first opens StayPut in the community.
    return {
      status: 'failed',
      error: 'no StayPut experience known for this company yet',
      retry: true,
    };
  }
  return callWhop(action, () =>
    whop.request('POST', '/notifications', {
      body: {
        experience_id: experienceId,
        user_ids: [action.member.userId],
        title: message.title,
        content: message.body,
      },
      idempotencyKey: `stayput-action-${action.id}`,
    }),
  ).then((outcome) =>
    outcome.status === 'sent' ? { status: 'sent', result: { message } } : outcome,
  );
}

const OFFERS: ReadonlySet<ActionType> = new Set([
  'pause_offer',
  'promo_offer',
  'coaching_offer',
  'affiliate_invite',
  'extend_offer',
]);
const DAY_MS = 86_400_000;

/**
 * An offer a member accepted in the departure survey (SPEC Phase 4): their membership kept when
 * they ticked it, then the pause, the free days or the single-use promo code; help and the
 * affiliate invitation are the creator's to follow up, StayPut records them. Every Whop call has
 * its own idempotency key: a retry never pauses, extends or creates twice. The code and the dates
 * come from the action itself, the same on every attempt.
 */
async function runOffer(
  action: DueAction,
  type: OfferType,
  whop: WhopClient | null,
): Promise<Outcome> {
  const membership = action.membership;
  if (!membership || membership.ended) {
    return { status: 'cancelled', result: { reason: 'membership_ended' } };
  }
  const content = action.content;
  const days = Number(content.days) || 0;
  const accepted = Date.parse(action.createdAt);
  const result: Record<string, unknown> = {};
  if (content.keep === true) result.kept = true;
  if (type === 'pause_offer') result.resumes_at = new Date(accepted + days * DAY_MS).toISOString();
  if (type === 'extend_offer') result.days = days;
  if (type === 'promo_offer') {
    result.code = promoCode(bytesOf(action.id));
    result.expires_at = new Date(accepted + PROMO_VALID_DAYS * DAY_MS).toISOString();
    result.percent_off = Number(content.percentOff);
    result.months = Number(content.months);
  }
  if (action.dryRun) return { status: 'simulated', result };
  if (!whop) return { status: 'failed', error: 'the Whop API key is not set', retry: false };

  const id = encodeURIComponent(membership.id);
  const key = (step: string) => `stayput-action-${action.id}-${step}`;
  const calls: (() => Promise<unknown>)[] = [];
  if (content.keep === true) {
    calls.push(() =>
      whop.request('PATCH', `/memberships/${id}`, {
        body: { cancel_at_period_end: false },
        idempotencyKey: key('keep'),
      }),
    );
  }
  if (type === 'pause_offer') {
    calls.push(() =>
      whop.request('POST', `/memberships/${id}/pause`, {
        body: { until: result.resumes_at },
        idempotencyKey: key('pause'),
      }),
    );
  } else if (type === 'extend_offer') {
    calls.push(() =>
      whop.request('POST', `/memberships/${id}/extend`, {
        body: { days },
        idempotencyKey: key('extend'),
      }),
    );
  } else if (type === 'promo_offer') {
    // Whop ties no code to a member: a random one, used once, for the creator's product.
    calls.push(() =>
      whop.request('POST', '/promo_codes', {
        body: {
          account_id: action.companyId,
          code: result.code,
          amount_off: result.percent_off,
          promo_type: 'percentage',
          promo_duration_months: result.months,
          base_currency: (membership.currency ?? 'usd').toLowerCase(),
          new_users_only: false,
          one_per_customer: true,
          stock: 1,
          expires_at: result.expires_at,
          ...(membership.productId ? { product_id: membership.productId } : {}),
        },
        idempotencyKey: key('promo'),
      }),
    );
  }
  for (const call of calls) {
    const outcome = await callWhop(action, call);
    if (outcome.status !== 'sent') return outcome;
  }
  return { status: 'sent', result };
}

/** 8 bytes of an action's id (a random UUID): its promo code, the same on every attempt. */
function bytesOf(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  return Uint8Array.from({ length: 8 }, (_, i) => parseInt(hex.slice(i * 2 + 16, i * 2 + 18), 16));
}

async function callWhop(action: DueAction, call: () => Promise<unknown>): Promise<Outcome> {
  try {
    await call();
    return { status: 'sent', result: {} };
  } catch (error) {
    if (error instanceof WhopApiError) {
      // An outage or a rate limit is tried again later; a refusal (a missing permission, a
      // member who no longer has access) is final.
      const transient = error.status === 0 || error.status === 429 || error.status >= 500;
      return {
        status: 'failed',
        error: `${error.status} ${error.type}: ${error.message}`,
        retry: transient && action.attempts + 1 < MAX_ATTEMPTS,
      };
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'unknown error',
      retry: action.attempts + 1 < MAX_ATTEMPTS,
    };
  }
}

/**
 * Runs one action now when it is scheduled and due (a member's accepted offer, in automatic
 * mode): the member sees what came of it in the same request. Returns its outcome's status.
 */
export async function executeAction(
  db: Db,
  whop: WhopClient | null,
  actionId: string,
  now: Date,
): Promise<string | null> {
  const [row] = await db.query<{ action: DueAction | null }>(
    'select stayput.due_action($1::uuid, $2::timestamptz) as action',
    [actionId, now.toISOString()],
  );
  if (!row?.action) return null;
  return finish(db, row.action, await runAction(row.action, whop, now.getTime()), now);
}

/** Keeps what came of an action: its result, a retry an hour later, or its postponement. */
async function finish(db: Db, action: DueAction, outcome: Outcome, now: Date): Promise<string> {
  const at = now.toISOString();
  if (outcome.status === 'postponed') {
    await db.query('select stayput.postpone_action($1, $2::timestamptz)', [
      action.id,
      new Date(outcome.sendAt).toISOString(),
    ]);
    return 'postponed';
  }
  const retryAt =
    outcome.status === 'failed' && outcome.retry
      ? new Date(now.getTime() + RETRY_DELAY_MS).toISOString()
      : null;
  await db.query(
    'select stayput.finish_action($1, $2, $3::text::jsonb, $4, $5, $6::timestamptz, $7::timestamptz)',
    [
      action.id,
      outcome.status,
      'result' in outcome ? JSON.stringify(outcome.result) : null,
      outcome.status === 'failed' ? outcome.error : null,
      outcome.status === 'blocked_by_guardrail' ? outcome.reason : null,
      retryAt,
      at,
    ],
  );
  return retryAt ? 'retried' : outcome.status;
}

/** Runs the actions whose time has come, across companies, and keeps each result. */
export async function executeDueActions(
  db: Db,
  whop: WhopClient | null,
  now: Date,
  limit = EXECUTE_BATCH,
): Promise<Record<string, number>> {
  const at = now.toISOString();
  const [row] = await db.query<{ actions: DueAction[] | null }>(
    'select stayput.due_actions($1::timestamptz, $2) as actions',
    [at, limit],
  );
  const counts: Record<string, number> = {};
  for (const action of row?.actions ?? []) {
    const key = await finish(db, action, await runAction(action, whop, now.getTime()), now);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
