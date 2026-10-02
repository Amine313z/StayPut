import {
  BUDDY_FALLBACK,
  DEFAULT_TEMPLATES,
  MESSAGE_KINDS,
  PROMO_VALID_DAYS,
  announcementText,
  checkGuardrails,
  creatorOfferText,
  goldenHour,
  isActionType,
  isCreatorOfferKind,
  isAnnouncePlatform,
  nextLocalHour,
  outOfQuietHours,
  promoCode,
  renderMessage,
  returnOfferText,
  type ActionType,
  type BlockReason,
  type GuardrailSettings,
  type MessageAction,
  type MessageTemplate,
  type OfferType,
  type ReturnOffer,
  type TemplateLocale,
  type TemplateValues,
} from '@stayput/core';
import { WhopApiError, type WhopClient } from '@stayput/whop';
import type { Db } from './db';
import { DiscordApiError, type DiscordClient } from './discord';
import { TelegramApiError, type TelegramClient } from './telegram';

/** The chats StayPut posts in for a creator (announcements): its bots, when set up. */
export interface Platforms {
  discord?: DiscordClient | null;
  telegram?: TelegramClient | null;
}

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
  /** The member space is on: its buddies are paired too (Config.memberSpace). */
  options: { memberSpace: boolean } = { memberSpace: false },
): Promise<{ planned: number; scheduled: number; blocked: number }> {
  const at = now.toISOString();
  const [plan] = await db.query<{ planned: number }>(
    `select stayput.plan_actions($1, $2::timestamptz)
              + stayput.plan_alumni_followups($1, $2::timestamptz)
              + case when $3 then stayput.plan_buddies($1, $2::timestamptz) else 0 end
              as planned`,
    [companyId, at, options.memberSpace],
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
  /** What an earlier attempt kept: an Alumni follow-up's code, already made on Whop. */
  result?: Record<string, unknown> | null;
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
    planId: string | null;
    currency: string | null;
    periodEnd: string | null;
  } | null;
  values: TemplateValues;
  /** An Alumni follow-up: the member's place in the Alumni, its space, the code's discount. */
  alumni?: {
    status: string;
    experienceId: string | null;
    percentOff: number;
    months: number;
  } | null;
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
    case 'alumni_followup':
      // Back in a paid offer, or gone from the Alumni: never called back (SPEC 5.9).
      return action.alumni?.status === 'entered'
        ? null
        : action.alumni?.status === 'returned'
          ? 'member_returned'
          : 'left_alumni';
    default:
      return null;
  }
}

/** The message of an action: the creator's template when they wrote one, else StayPut's. */
export function actionMessage(action: DueAction, type: MessageAction): MessageTemplate {
  return renderActionMessage(
    type,
    action.locale,
    action.templates,
    messageValues(type, action.locale, action.values, action.content),
  );
}

/**
 * The words of a message: the member's, and for a buddies' introduction the other one's first
 * name, as it was when they were paired.
 */
export function messageValues(
  type: MessageAction,
  locale: string,
  values: TemplateValues,
  content: Record<string, unknown> | null,
): TemplateValues {
  if (type === 'creator_offer') {
    // The offer in words: « a 30-day pause… », « 20% off for 3 months ».
    const kind = content?.kind;
    const terms = content?.terms;
    if (!isCreatorOfferKind(kind) || typeof terms !== 'object' || terms === null) return values;
    const t = terms as Record<string, unknown>;
    return {
      ...values,
      offer: creatorOfferText(
        locale === 'fr' ? 'fr' : 'en',
        kind,
        kind === 'pause_offer'
          ? { days: Number(t.days) }
          : { percentOff: Number(t.percentOff), months: Number(t.months) },
      ),
    };
  }
  if (type !== 'buddy_intro' && type !== 'mentor_intro') return values;
  const name = content?.buddy_name;
  return {
    ...values,
    buddy_name:
      typeof name === 'string' && name.trim()
        ? name
        : BUDDY_FALLBACK[locale === 'fr' ? 'fr' : 'en'][type],
  };
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
  | { status: 'failed'; error: string; retry: boolean; result?: Record<string, unknown> };

/**
 * What one action comes to at `now`: the last stops, the quiet hours, then the test mode, then
 * Whop.
 */
export async function runAction(
  action: DueAction,
  whop: WhopClient | null,
  now: number,
  platforms: Platforms = {},
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
  if (type === 'alumni_followup') return runAlumniFollowup(action, whop, now);
  if (type === 'milestone_announcement') return runAnnouncement(action, whop, platforms);
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

/** An announcement's words, from its action: the member's first name, the goal, the milestone. */
export function announcementOf(
  locale: string,
  content: Record<string, unknown>,
  firstName: unknown,
): { text: string; channel: string } | null {
  const goal = content.goal_title;
  const percent = Number(content.percent);
  const channel = content.channel ?? content.channel_id;
  if (typeof goal !== 'string' || !(percent > 0) || typeof channel !== 'string') return null;
  const text = announcementText(locale === 'fr' ? 'fr' : 'en', {
    firstName: typeof firstName === 'string' && firstName ? firstName : null,
    goal,
    percent,
  });
  return { text, channel };
}

/**
 * A milestone the member asked to share (SPEC Phase 5, point 4), posted where the creator chose:
 * a Whop chat channel, a Discord channel (mentioning nobody), a Telegram group.
 */
async function runAnnouncement(
  action: DueAction,
  whop: WhopClient | null,
  platforms: Platforms,
): Promise<Outcome> {
  const platform = action.content.platform;
  const channelId = action.content.channel_id;
  const words = announcementOf(action.locale, action.content, action.values.first_name);
  if (!isAnnouncePlatform(platform) || typeof channelId !== 'string' || !words) {
    return { status: 'failed', error: 'not an announcement', retry: false };
  }
  const result = { text: words.text, platform, channel: words.channel };
  if (action.dryRun) return { status: 'simulated', result };
  let post: (() => Promise<unknown>) | null = null;
  if (platform === 'whop' && whop) {
    post = () =>
      whop.request('POST', '/messages', {
        body: { channel_id: channelId, content: words.text },
        idempotencyKey: `stayput-action-${action.id}`,
      });
  } else if (platform === 'discord' && platforms.discord) {
    const discord = platforms.discord;
    post = () => discord.sendMessage(channelId, words.text, action.id.replace(/-/g, ''));
  } else if (platform === 'telegram' && platforms.telegram) {
    const telegram = platforms.telegram;
    post = () => telegram.sendMessage(channelId, words.text);
  }
  if (!post) return { status: 'failed', error: `${platform} is not set up`, retry: false };
  const outcome = await callWhop(action, post);
  return outcome.status === 'sent' ? { status: 'sent', result } : outcome;
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
    // Whop ties no code to a member: a random one, used once, for the creator's product. Its id
    // is kept for the attribution: a payment with this code is a return (SPEC Phase 6.4).
    calls.push(async () => {
      const created = await whop.request<{ id?: unknown }>('POST', '/promo_codes', {
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
      });
      if (typeof created.id === 'string') result.promo_code_id = created.id;
    });
  }
  for (const call of calls) {
    const outcome = await callWhop(action, call);
    if (outcome.status !== 'sent') return outcome;
  }
  return { status: 'sent', result };
}

/** The return code an Alumni follow-up gives, from the action: the preview shows it too. */
export function followupOffer(
  actionId: string,
  settings: { percentOff: number; months: number },
): ReturnOffer {
  return { code: promoCode(bytesOf(actionId)), ...settings };
}

/** The Alumni follow-up's message, its `{offer}` the return code and what it gives. */
export function followupMessage(
  locale: string,
  templates: DueAction['templates'],
  values: TemplateValues,
  offer: ReturnOffer,
): MessageTemplate {
  const language: TemplateLocale = locale === 'fr' ? 'fr' : 'en';
  return renderActionMessage('alumni_followup', locale, templates, {
    ...values,
    offer: returnOfferText(language, offer),
  });
}

/**
 * An Alumni follow-up (SPEC 5.9): a single-use return code for the product the member left, valid
 * 7 days and not reserved to new customers, then the notification through the Alumni space with
 * the code in it. Each Whop call has its own idempotency key and the code comes from the action:
 * a retry never creates a second code, and the expiry Whop answers is the one kept.
 */
async function runAlumniFollowup(
  action: DueAction,
  whop: WhopClient | null,
  now: number,
): Promise<Outcome> {
  const alumni = action.alumni;
  const experienceId = alumni?.experienceId;
  if (!alumni || !experienceId) {
    return { status: 'failed', error: 'the Alumni space is not ready', retry: false };
  }
  // A code an earlier attempt made on Whop is the one sent: same discount, same expiry.
  const earlier = action.result?.promo_created === true ? action.result : null;
  const offer = earlier
    ? followupOffer(action.id, {
        percentOff: Number(earlier.percent_off),
        months: Number(earlier.months),
      })
    : followupOffer(action.id, { percentOff: alumni.percentOff, months: alumni.months });
  const message = followupMessage(action.locale, action.templates, action.values, offer);
  const result: Record<string, unknown> = {
    message,
    step: Number(action.content.step) || null,
    code: offer.code,
    expires_at:
      typeof earlier?.expires_at === 'string'
        ? earlier.expires_at
        : new Date(now + PROMO_VALID_DAYS * DAY_MS).toISOString(),
    percent_off: offer.percentOff,
    months: offer.months,
  };
  if (action.dryRun) return { status: 'simulated', result };
  if (!whop) return { status: 'failed', error: 'the Whop API key is not set', retry: false };

  if (earlier) {
    result.promo_created = true;
    if (typeof earlier.promo_code_id === 'string') result.promo_code_id = earlier.promo_code_id;
  } else {
    const membership = action.membership;
    const created: { code?: { id?: unknown; expires_at?: unknown } } = {};
    const promo = await callWhop(action, async () => {
      created.code = await whop.request<{ id?: unknown; expires_at?: unknown }>(
        'POST',
        '/promo_codes',
        {
          body: {
            account_id: action.companyId,
            code: offer.code,
            amount_off: offer.percentOff,
            promo_type: 'percentage',
            promo_duration_months: offer.months,
            base_currency: (membership?.currency ?? 'usd').toLowerCase(),
            new_users_only: false,
            one_per_customer: true,
            stock: 1,
            expires_at: result.expires_at,
            ...(membership?.productId ? { product_id: membership.productId } : {}),
          },
          idempotencyKey: `stayput-action-${action.id}-promo`,
        },
      );
    });
    if (promo.status !== 'sent') return promo;
    result.promo_created = true;
    // Kept for the attribution: a payment with this code is a return (SPEC 5.9).
    if (typeof created.code?.id === 'string') result.promo_code_id = created.code.id;
    if (typeof created.code?.expires_at === 'string') result.expires_at = created.code.expires_at;
  }
  const sent = await callWhop(action, () =>
    whop.request('POST', '/notifications', {
      body: {
        experience_id: experienceId,
        user_ids: [action.member.userId],
        title: message.title,
        content: message.body,
      },
      idempotencyKey: `stayput-action-${action.id}-notify`,
    }),
  );
  if (sent.status === 'sent') return { status: 'sent', result };
  // The code exists: kept with the action, so that a retry only sends the notification.
  return sent.status === 'failed' ? { ...sent, result } : sent;
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
    // Discord's and Telegram's errors (an announcement) carry their HTTP status the same way.
    if (error instanceof DiscordApiError || error instanceof TelegramApiError) {
      const transient = error.status === 0 || error.status === 429 || error.status >= 500;
      return {
        status: 'failed',
        error: error.message,
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
  platforms: Platforms = {},
): Promise<string | null> {
  const [row] = await db.query<{ action: DueAction | null }>(
    'select stayput.due_action($1::uuid, $2::timestamptz) as action',
    [actionId, now.toISOString()],
  );
  if (!row?.action) return null;
  return finish(db, row.action, await runAction(row.action, whop, now.getTime(), platforms), now);
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
  platforms: Platforms = {},
): Promise<Record<string, number>> {
  const at = now.toISOString();
  const [row] = await db.query<{ actions: DueAction[] | null }>(
    'select stayput.due_actions($1::timestamptz, $2) as actions',
    [at, limit],
  );
  const counts: Record<string, number> = {};
  for (const action of row?.actions ?? []) {
    const key = await finish(
      db,
      action,
      await runAction(action, whop, now.getTime(), platforms),
      now,
    );
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
