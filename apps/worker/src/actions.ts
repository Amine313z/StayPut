import {
  DEFAULT_TEMPLATES,
  MESSAGE_KINDS,
  checkGuardrails,
  goldenHour,
  isActionType,
  nextLocalHour,
  renderMessage,
  type ActionType,
  type BlockReason,
  type GuardrailSettings,
  type MessageAction,
  type MessageTemplate,
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
  type: string;
  attempts: number;
  content: Record<string, unknown>;
  globalKillSwitch: boolean;
  killSwitch: boolean;
  dryRun: boolean;
  locale: string;
  experienceId: string | null;
  /** The creator's own templates: `{ fr: { welcome_message: { title, body } } }`. */
  templates: Record<string, Record<string, Partial<MessageTemplate>> | undefined>;
  member: { userId: string; doNotContact: boolean; joined: boolean };
  payment: {
    id: string;
    status: string;
    retryable: boolean | null;
    nextAttemptAt: string | null;
    recoveryUrl: string | null;
  } | null;
  membership: { id: string; canceling: boolean } | null;
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
  const locale: TemplateLocale = action.locale === 'fr' ? 'fr' : 'en';
  const fallback = DEFAULT_TEMPLATES[locale][type];
  const own = action.templates[locale]?.[type];
  const template: MessageTemplate = {
    title: own?.title?.trim() ? own.title : fallback.title,
    body: own?.body?.trim() ? own.body : fallback.body,
  };
  return renderMessage(template, action.values);
}

type Outcome =
  | { status: 'sent' | 'simulated'; result: Record<string, unknown> }
  | { status: 'cancelled'; result: Record<string, unknown> }
  | { status: 'blocked_by_guardrail'; reason: BlockReason }
  | { status: 'failed'; error: string; retry: boolean };

/** What one action comes to: the last stops, then the test mode, then Whop. */
export async function runAction(action: DueAction, whop: WhopClient | null): Promise<Outcome> {
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

  if (MESSAGE_KINDS[type] === 'none') {
    return {
      status: 'failed',
      error: `${type} is applied when the member accepts it`,
      retry: false,
    };
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
    const outcome = await runAction(action, whop);
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
    const key = retryAt ? 'retried' : outcome.status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
