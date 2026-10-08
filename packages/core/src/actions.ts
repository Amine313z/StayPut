/**
 * The actions (SPEC Phase 4) and the guardrails every one of them passes through, whatever
 * triggered it (SPEC 5.8). Pure functions: the database gathers the member's history and the
 * company's counters, these decide whether the action may go, and when. Times are milliseconds
 * since the epoch; hours of the day are read in the creator's time zone.
 */

import { DAY_MS } from './risk';

/** What StayPut can do for a member. */
export type ActionType =
  /** Whop charges the failed payment again (POST /payments/{id}/retry). */
  | 'payment_retry'
  /** Asks the member to update their payment method after a failed payment. */
  | 'payment_failed_notice'
  /** The 3D Secure check a payment waits for (its recovery link in the member view). */
  | 'payment_action_notice'
  /** A cancellation at period end: the one-click departure survey in the member view. */
  | 'exit_survey'
  /** Survey answers, applied once the member accepts the offer. */
  | 'pause_offer'
  | 'promo_offer'
  | 'coaching_offer'
  | 'affiliate_invite'
  | 'extend_offer'
  /** The score turned high: a personal message at the member's golden hour. */
  | 'high_risk_message'
  /** The activation radar: a new member who has not started. */
  | 'welcome_message'
  /** A former member in the Alumni offer, 7, 30 and 60 days after leaving. */
  | 'alumni_followup'
  /** A member's milestone, announced in the community's chat at their request (SPEC Phase 5). */
  | 'milestone_announcement'
  /** A newcomer meets the veteran paired with them (SPEC Phase 5, buddies)… */
  | 'buddy_intro'
  /** …and the veteran meets the newcomer. */
  | 'mentor_intro'
  /** A word the creator sent from the dashboard to several members at once, StayPut's wording. */
  | 'creator_message'
  /** « Message » on one member: words the creator wrote themselves, sent word for word. */
  | 'creator_note'
  /** An offer the creator made from the dashboard (« Pause », « Offer »): accept it in the space. */
  | 'creator_offer';

export const ACTION_TYPES: readonly ActionType[] = [
  'payment_retry',
  'payment_failed_notice',
  'payment_action_notice',
  'exit_survey',
  'pause_offer',
  'promo_offer',
  'coaching_offer',
  'affiliate_invite',
  'extend_offer',
  'high_risk_message',
  'welcome_message',
  'alumni_followup',
  'milestone_announcement',
  'buddy_intro',
  'mentor_intro',
  'creator_message',
  'creator_note',
  'creator_offer',
];

export function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * What reaches the member. A follow-up (`relance`) is StayPut reaching out on its own: it is
 * capped (one every 5 days, 4 a month). A service message answers something the member did or
 * must do (a payment to validate, a failed payment, a scheduled cancellation): it is never held
 * back by those caps, since the member's access is at stake, but it counts in their history, so
 * that no follow-up comes on its heels. `none`: no message (a Whop operation, or an offer shown
 * in the member view the member is using).
 */
export type MessageKind = 'relance' | 'service' | 'none';

export const MESSAGE_KINDS: Readonly<Record<ActionType, MessageKind>> = {
  payment_retry: 'none',
  payment_failed_notice: 'service',
  payment_action_notice: 'service',
  exit_survey: 'service',
  pause_offer: 'none',
  promo_offer: 'none',
  coaching_offer: 'none',
  affiliate_invite: 'none',
  extend_offer: 'none',
  high_risk_message: 'relance',
  welcome_message: 'relance',
  alumni_followup: 'relance',
  // A public message the member asked for, in the community's chat: not one to them.
  milestone_announcement: 'none',
  // StayPut reaches out on its own: capped like any follow-up.
  buddy_intro: 'relance',
  mentor_intro: 'relance',
  // The creator's own initiative: capped like StayPut's, the member is the same person.
  creator_message: 'relance',
  // The creator's own words, sent when they choose: no follow-up cap holds them back (the creator
  // writes, StayPut only carries), but they count, so that no follow-up comes on their heels.
  creator_note: 'service',
  creator_offer: 'relance',
};

/** What a creator's own message may hold: Whop's notification, a title and a short text. */
export const CREATOR_NOTE_LIMITS = { title: 80, body: 300 } as const;

/**
 * A creator's own message, trimmed, or null: a title and a text, each within its limit. The
 * text keeps its line breaks.
 */
export function creatorNote(value: unknown): { title: string; body: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { title, body } = value as Record<string, unknown>;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  const t = title.trim();
  const b = body.trim();
  if (!t || !b || t.length > CREATOR_NOTE_LIMITS.title || b.length > CREATOR_NOTE_LIMITS.body) {
    return null;
  }
  return { title: t, body: b };
}

/** The creator's guardrails (company_settings), and the company's time zone. */
export interface GuardrailSettings {
  maxMessagesPer5Days: number;
  maxMessagesPerMonth: number;
  maxPaymentRetries: number;
  monthlyPromoCap: number;
  maxFreeDaysPerQuarter: number;
  /** No message from this hour (inclusive) to `quietHoursEnd` (exclusive), local time. */
  quietHoursStart: number;
  quietHoursEnd: number;
  /** Everything is computed and journaled, nothing is sent. */
  dryRun: boolean;
  /** The creator's own stop. */
  killSwitch: boolean;
  timezone: string;
}

export const DEFAULT_GUARDRAILS: GuardrailSettings = {
  maxMessagesPer5Days: 1,
  maxMessagesPerMonth: 4,
  maxPaymentRetries: 2,
  monthlyPromoCap: 10,
  maxFreeDaysPerQuarter: 14,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  dryRun: false,
  killSwitch: false,
  timezone: 'UTC',
};

/** Spacing of follow-ups, and the windows the monthly and quarterly caps count over. */
export const SPACING_DAYS = 5;
export const MONTH_DAYS = 30;
export const QUARTER_DAYS = 90;

/** What StayPut already did for the member, as the guardrails need it. */
export interface MemberHistory {
  doNotContact: boolean;
  /** Messages sent or scheduled, at the time they went or will go. */
  messages: readonly { at: number; kind: 'relance' | 'service' }[];
  /** Retries StayPut already asked Whop for, on the payment at hand. */
  paymentRetries: number;
  /** One of the member's promo codes is neither used nor expired. */
  activePromo: boolean;
  /** Free days granted over the last 90 days. */
  freeDaysLast90: number;
}

export const EMPTY_HISTORY: MemberHistory = {
  doNotContact: false,
  messages: [],
  paymentRetries: 0,
  activePromo: false,
  freeDaysLast90: 0,
};

export interface CompanyCounters {
  /** Promo codes StayPut created for the company over the last 30 days. */
  promosLast30: number;
}

export type BlockReason =
  | 'global_kill_switch'
  | 'kill_switch'
  | 'do_not_contact'
  | 'message_spacing'
  | 'monthly_message_cap'
  | 'payment_retry_cap'
  | 'promo_already_active'
  | 'monthly_promo_cap'
  | 'free_days_cap';

export const BLOCK_REASONS: readonly BlockReason[] = [
  'global_kill_switch',
  'kill_switch',
  'do_not_contact',
  'message_spacing',
  'monthly_message_cap',
  'payment_retry_cap',
  'promo_already_active',
  'monthly_promo_cap',
  'free_days_cap',
];

export interface ProposedAction {
  type: ActionType;
  /** When the trigger wants it to go. */
  sendAt: number;
  /** Free days an `extend_offer` grants. */
  freeDays?: number;
}

export type GuardrailVerdict =
  | {
      allowed: true;
      /** The time it goes, moved out of the quiet hours when it is a message. */
      sendAt: number;
      /** Computed and journaled only. */
      dryRun: boolean;
    }
  | { allowed: false; reason: BlockReason };

/**
 * The central guardrails: every action of every trigger goes through here before it is
 * scheduled, and an action they stop is kept as `blocked_by_guardrail` with the reason.
 */
export function checkGuardrails(
  action: ProposedAction,
  context: {
    settings: GuardrailSettings;
    /** The stop for the whole app. */
    globalKillSwitch: boolean;
    member: MemberHistory;
    company: CompanyCounters;
  },
): GuardrailVerdict {
  const { settings, member, company } = context;
  if (context.globalKillSwitch) return { allowed: false, reason: 'global_kill_switch' };
  if (settings.killSwitch) return { allowed: false, reason: 'kill_switch' };
  if (member.doNotContact) return { allowed: false, reason: 'do_not_contact' };

  switch (action.type) {
    case 'payment_retry':
      if (member.paymentRetries >= Math.min(settings.maxPaymentRetries, 2)) {
        return { allowed: false, reason: 'payment_retry_cap' };
      }
      break;
    // An Alumni follow-up carries a return code (SPEC 5.9): the same caps as a promo code.
    case 'promo_offer':
    case 'alumni_followup':
      if (member.activePromo) return { allowed: false, reason: 'promo_already_active' };
      if (company.promosLast30 >= settings.monthlyPromoCap) {
        return { allowed: false, reason: 'monthly_promo_cap' };
      }
      break;
    case 'extend_offer':
      if (
        member.freeDaysLast90 + (action.freeDays ?? 0) >
        Math.min(settings.maxFreeDaysPerQuarter, 14)
      ) {
        return { allowed: false, reason: 'free_days_cap' };
      }
      break;
    default:
      break;
  }

  const kind = MESSAGE_KINDS[action.type];
  const sendAt = kind === 'none' ? action.sendAt : outOfQuietHours(action.sendAt, settings);
  if (kind === 'relance') {
    // Any message counts, a service message included: no follow-up on its heels.
    const near = member.messages.filter(
      (m) => Math.abs(m.at - sendAt) < SPACING_DAYS * DAY_MS,
    ).length;
    if (near >= settings.maxMessagesPer5Days) return { allowed: false, reason: 'message_spacing' };
    const month = member.messages.filter(
      (m) => m.at > sendAt - MONTH_DAYS * DAY_MS && m.at <= sendAt,
    ).length;
    if (month >= settings.maxMessagesPerMonth) {
      return { allowed: false, reason: 'monthly_message_cap' };
    }
  }
  return { allowed: true, sendAt, dryRun: settings.dryRun };
}

const HOUR_MS = 3_600_000;
const hourFormats = new Map<string, Intl.DateTimeFormat>();

/** The hour of the day (0-23) at `time` in `timezone`; UTC for a zone the runtime ignores. */
export function localHour(time: number, timezone: string): number {
  let format = hourFormats.get(timezone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        hour: 'numeric',
      });
    } catch {
      return new Date(time).getUTCHours();
    }
    hourFormats.set(timezone, format);
  }
  return Number(format.format(time)) % 24;
}

/**
 * An IANA time zone name the runtime knows (`Europe/Paris`), as given, or null: what a
 * creator's browser reports, or the creator picks, before it becomes the company's zone. Kept as
 * given rather than canonical (America/Montreal stays so): the runtimes do not all agree on the
 * canonical names, and Postgres knows both.
 */
export function timeZoneName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Whether `hour` falls in the quiet hours (which may wrap around midnight). */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * The first full hour at or after `time` that is not a quiet hour in the creator's time zone;
 * `time` itself when it is not one.
 */
export function outOfQuietHours(
  time: number,
  settings: Pick<GuardrailSettings, 'quietHoursStart' | 'quietHoursEnd' | 'timezone'>,
): number {
  const { quietHoursStart: start, quietHoursEnd: end, timezone } = settings;
  if (!isQuietHour(localHour(time, timezone), start, end)) return time;
  let next = Math.ceil(time / HOUR_MS) * HOUR_MS;
  // At most a day of hours: the zone's offset is whole or half hours, so the loop finds it.
  for (let i = 0; i < 26 && isQuietHour(localHour(next, timezone), start, end); i += 1) {
    next += HOUR_MS;
  }
  return next;
}

/**
 * The golden hour (SPEC Phase 4): the hour of the day, in the creator's time zone, the member
 * was most often active over 30 days (`hours`, 24 counts), among the hours that are not quiet;
 * ties go to the hour closest to the creator's default. The default when nothing is known.
 */
export function goldenHour(
  hours: readonly number[] | null,
  settings: Pick<GuardrailSettings, 'quietHoursStart' | 'quietHoursEnd'>,
  defaultHour: number,
): number {
  let best = -1;
  let bestCount = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    if (isQuietHour(hour, settings.quietHoursStart, settings.quietHoursEnd)) continue;
    const count = hours?.[hour] ?? 0;
    const closer =
      count === bestCount &&
      best >= 0 &&
      circularDistance(hour, defaultHour) < circularDistance(best, defaultHour);
    if (count > bestCount || closer) {
      best = hour;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : defaultHour;
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

/** The next time, at or after `after`, that the creator's clock shows `hour` o'clock. */
export function nextLocalHour(after: number, hour: number, timezone: string): number {
  let next = Math.ceil(after / HOUR_MS) * HOUR_MS;
  for (let i = 0; i < 26 && localHour(next, timezone) !== hour; i += 1) next += HOUR_MS;
  return next;
}
