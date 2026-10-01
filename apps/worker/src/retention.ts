import {
  DEFAULT_GUARDRAILS,
  DEFAULT_OFFERS,
  checkGuardrails,
  exitOffer,
  type AlumniReturn,
  type ExitOffer,
  type ExitReason,
  type MemberRetentionView,
  type OfferResult,
  type OfferSettings,
} from '@stayput/core';
import type { Db } from './db';

/**
 * The member's side of the actions (SPEC Phase 4): the departure survey and its offer, and the
 * payment that needs them, as the member view shows them. The member's own subscription only,
 * never a score (SPEC 5.3).
 */

/** A payment waiting for its 3D Secure check, and a failed one (as stayput.risk_features). */
const ACTION_REQUIRED = new Set([
  'open',
  'pending',
  'incomplete',
  'requires_action',
  'requires_capture',
]);
const FAILED_PAYMENT = new Set(['failed', 'past_due', 'uncollectible', 'unresolved']);

/** What stayput.member_retention returns. */
export interface RetentionRow {
  member: { id: string; doNotContact: boolean; joined: boolean } | null;
  company: {
    name: string | null;
    mode: string;
    timezone: string;
    dryRun: boolean;
    killSwitch: boolean;
    globalKillSwitch: boolean | null;
    offers: OfferSettings;
    guardrails: {
      maxMessagesPer5Days: number;
      maxMessagesPerMonth: number;
      maxPaymentRetries: number;
      monthlyPromoCap: number;
      maxFreeDaysPerQuarter: number;
      quietHoursStart: number;
      quietHoursEnd: number;
    };
    promosLast30: number;
  } | null;
  history: { activePromo: boolean; freeDaysLast90: number } | null;
  payment: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    recoveryUrl: string | null;
    membershipId: string | null;
  } | null;
  departure: { membershipId: string; endsAt: string | null } | null;
  survey: {
    id: string;
    reason: ExitReason | null;
    offerType: string | null;
    offer: ExitOffer | null;
    outcome: 'pending' | 'accepted' | 'declined' | 'expired';
    keep: boolean | null;
    action: {
      status: string;
      result: Record<string, unknown> | null;
      error: string | null;
    } | null;
  } | null;
}

export async function readRetention(
  db: Db,
  companyId: string,
  userId: string,
  now: Date,
): Promise<RetentionRow> {
  const [row] = await db.query<{ retention: RetentionRow }>(
    'select stayput.member_retention($1, $2, $3::timestamptz) as retention',
    [companyId, userId, now.toISOString()],
  );
  return (
    row?.retention ?? {
      member: null,
      company: null,
      history: null,
      payment: null,
      departure: null,
      survey: null,
    }
  );
}

/**
 * Whether the member may answer the survey: a cancellation scheduled, a member StayPut may
 * contact, and the creator out of test mode (in test mode nothing reaches members: a promise of
 * a code that never comes would be worse than no survey).
 */
export function surveyOpen(row: RetentionRow): boolean {
  return Boolean(
    row.departure &&
    row.member?.joined &&
    !row.member.doNotContact &&
    row.company &&
    !row.company.dryRun,
  );
}

/**
 * The offer for a reason, or null when the guardrails stop it (a code already active, the
 * month's codes given, the quarter's free days, a stop): the member then just leaves their
 * reason.
 */
export function offerFor(reason: ExitReason, row: RetentionRow, now: Date): ExitOffer | null {
  const company = row.company;
  if (!company || !row.member) return null;
  const offer = exitOffer(reason, company.offers);
  const verdict = checkGuardrails(
    {
      type: offer.type,
      sendAt: now.getTime(),
      ...(offer.type === 'extend_offer' && offer.days ? { freeDays: offer.days } : {}),
    },
    {
      settings: {
        ...DEFAULT_GUARDRAILS,
        ...company.guardrails,
        dryRun: company.dryRun,
        killSwitch: company.killSwitch,
        timezone: company.timezone,
      },
      globalKillSwitch: company.globalKillSwitch === true,
      member: {
        doNotContact: row.member.doNotContact,
        messages: [],
        paymentRetries: 0,
        activePromo: row.history?.activePromo ?? false,
        freeDaysLast90: row.history?.freeDaysLast90 ?? 0,
      },
      company: { promosLast30: company.promosLast30 },
    },
  );
  return verdict.allowed ? offer : null;
}

/**
 * What the member view shows. The team previews it (`preview`): no survey of theirs, the
 * creator's offers to try every reason with, nothing recorded.
 */
export function retentionView(
  row: RetentionRow,
  options: {
    preview: boolean;
    whopAppId: string | null;
    alumniUrl?: string | null;
    /** A former member in the Alumni: their return code, and the way back. */
    alumni?: AlumniReturn | null;
    manageUrl?: string | null;
  },
): MemberRetentionView {
  const creatorName = row.company?.name ?? null;
  const whopAppId = options.whopAppId;
  const alumniUrl = options.alumniUrl ?? null;
  if (options.preview) {
    return {
      creatorName,
      whopAppId,
      alumniUrl,
      preview: row.company
        ? { offers: row.company.offers, testMode: row.company.dryRun }
        : { offers: DEFAULT_OFFERS, testMode: false },
      payment: null,
      departure: null,
      alumni: null,
    };
  }
  const payment = row.payment;
  const owed =
    payment && ACTION_REQUIRED.has(payment.status) && payment.recoveryUrl
      ? ('action_required' as const)
      : payment && FAILED_PAYMENT.has(payment.status)
        ? ('failed' as const)
        : null;
  const survey = row.survey;
  return {
    creatorName,
    whopAppId,
    // Only to a member who leaves: the others have no use for it.
    alumniUrl: surveyOpen(row) ? alumniUrl : null,
    preview: null,
    payment:
      payment && owed
        ? {
            kind: owed,
            amount: Number(payment.amount),
            currency: payment.currency,
            url: payment.recoveryUrl ?? options.manageUrl ?? null,
          }
        : null,
    departure: surveyOpen(row)
      ? {
          endsAt: row.departure?.endsAt ? new Date(row.departure.endsAt).toISOString() : null,
          reason: survey?.reason ?? null,
          offer: survey?.offer ?? null,
          outcome:
            survey?.outcome === 'accepted' || survey?.outcome === 'declined'
              ? survey.outcome
              : 'pending',
          result: survey?.action ? offerResult(survey.action) : null,
        }
      : null,
    alumni: options.alumni ?? null,
  };
}

/** The accepted offer's action, as the member sees it. */
function offerResult(
  action: NonNullable<NonNullable<RetentionRow['survey']>['action']>,
): OfferResult {
  const result = action.result ?? {};
  const text = (key: string) => (typeof result[key] === 'string' ? result[key] : undefined);
  switch (action.status) {
    case 'sent':
    case 'simulated':
      return {
        status: 'applied',
        ...(result.kept === true ? { kept: true } : {}),
        ...(text('code') ? { promoCode: text('code') } : {}),
        ...(text('expires_at') ? { expiresAt: text('expires_at') } : {}),
        ...(text('resumes_at') ? { resumesAt: text('resumes_at') } : {}),
      };
    case 'failed':
      return { status: 'failed' };
    case 'cancelled':
    case 'blocked_by_guardrail':
      return { status: 'cancelled' };
    default:
      // proposed (the creator approves it first), approved, scheduled, or tried again soon.
      return { status: 'waiting' };
  }
}

/** The member's answer: the reason, and the offer it brings now. Returns the survey's id. */
export async function answerSurvey(
  db: Db,
  companyId: string,
  row: RetentionRow,
  reason: ExitReason,
  now: Date,
): Promise<string | null> {
  if (!surveyOpen(row) || !row.member || !row.departure) return null;
  const offer = offerFor(reason, row, now);
  const [answered] = await db.query<{ id: string }>(
    `select stayput.answer_exit_survey($1, $2, $3, $4, $5, $6::text::jsonb, $7::timestamptz) as id`,
    [
      companyId,
      row.member.id,
      row.departure.membershipId,
      reason,
      offer?.type ?? null,
      offer ? JSON.stringify(offer) : null,
      now.toISOString(),
    ],
  );
  return answered?.id ?? null;
}

/**
 * The member accepts the offer (with their consent to keep their membership, when it asks for
 * it) or declines it. Returns the action created, null otherwise; `invalid` when the offer needs
 * the consent the member did not give.
 */
export async function decideOffer(
  db: Db,
  companyId: string,
  row: RetentionRow,
  decision: { accept: boolean; keep: boolean },
  now: Date,
): Promise<{ actionId: string | null } | 'invalid' | null> {
  const survey = row.survey;
  if (!surveyOpen(row) || !survey || survey.outcome !== 'pending') return null;
  const offer = survey.offer;
  if (decision.accept && !offer) return 'invalid';
  if (decision.accept && offer?.keep === 'required' && !decision.keep) return 'invalid';
  const keep = decision.accept && offer?.keep !== 'never' && decision.keep;
  const [decided] = await db.query<{ action: string | null }>(
    'select stayput.decide_exit_offer($1, $2::uuid, $3, $4, $5::timestamptz) as action',
    [companyId, survey.id, decision.accept, keep, now.toISOString()],
  );
  return { actionId: decided?.action ?? null };
}
