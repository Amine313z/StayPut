/**
 * The money StayPut saved (SPEC Phase 6.4): which payments it may claim, and why. Pure: the
 * database gathers a company's facts (what StayPut carried out, the payments, the members'
 * first activity after a message), this decides. Every save names its proof, a payment is
 * counted once, and only an action that really went out can save anything: a simulated one
 * (test mode) never does.
 */

import type { ActionType } from './actions';
import { DAY_MS } from './risk';
import { isPaidPayment } from './whop-status';

export type SaveType =
  | 'payment_recovered'
  | 'cancellation_reverted'
  | 'pause_resumed'
  | 'winback'
  | 'renewal_after_message';

/** Direct: StayPut's action is the reason. Influenced: it helped, shown apart. */
export type SaveCategory = 'direct' | 'influenced';

export const SAVE_CATEGORY: Readonly<Record<SaveType, SaveCategory>> = {
  payment_recovered: 'direct',
  cancellation_reverted: 'direct',
  pause_resumed: 'direct',
  winback: 'direct',
  renewal_after_message: 'influenced',
};

/** A failed payment that comes in within 14 days after StayPut's action on it. */
export const RECOVERY_DAYS = 14;
/** A cancellation undone within 7 days after the member accepted StayPut's offer. */
export const REVERT_DAYS = 7;
/** A member at high risk active again within 14 days after StayPut's message. */
export const REACTIVATION_DAYS = 14;
/** A renewal counts within the membership's period after the message, and these days more. */
export const RENEWAL_GRACE_DAYS = 7;
/** The period of a membership StayPut does not know the billing of. */
export const DEFAULT_PERIOD_DAYS = 30;

/** What StayPut carried out (status `sent`), as attribution needs it. */
export interface AttributedAction {
  id: string;
  memberId: string;
  type: ActionType;
  /** When it went out. */
  sentAt: number;
  /** The membership it was about, when it was about one. */
  membershipId: string | null;
  /** A payment action: the payment it was about. */
  paymentId: string | null;
  /** An accepted offer: when the member accepted it in the departure survey. */
  acceptedAt: number | null;
  /** An accepted offer: StayPut undid the cancellation with the member's consent. */
  kept: boolean;
  /** A promo code StayPut created (Whop's id): a return code or a survey's code. */
  promoCodeId: string | null;
}

export interface AttributedPayment {
  id: string;
  memberId: string | null;
  membershipId: string | null;
  status: string;
  amount: number;
  currency: string;
  /** When it came in; null until it did. */
  paidAt: number | null;
  promoCodeId: string | null;
}

export interface AttributionFacts {
  actions: readonly AttributedAction[];
  payments: readonly AttributedPayment[];
  /** For a message (its action id): the member's first activity after it went out. */
  firstActivityAfter: Readonly<Record<string, number>>;
  /** The billing period of a membership, in days, when Whop gave one. */
  periodDays: Readonly<Record<string, number>>;
  /** Payments already counted by an earlier run. */
  counted: ReadonlySet<string>;
}

export interface Save {
  type: SaveType;
  category: SaveCategory;
  memberId: string;
  actionId: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** When the payment came in. */
  savedAt: number;
  /** The ids that prove it: StayPut's action, then the payments. */
  proof: string[];
}

const PAYMENT_ACTIONS: ReadonlySet<ActionType> = new Set([
  'payment_retry',
  'payment_failed_notice',
  'payment_action_notice',
]);

const OFFER_ACTIONS: ReadonlySet<ActionType> = new Set([
  'pause_offer',
  'promo_offer',
  'extend_offer',
  'coaching_offer',
  'affiliate_invite',
]);

const WINBACK_ACTIONS: ReadonlySet<ActionType> = new Set(['alumni_followup', 'promo_offer']);

/**
 * Every save the facts prove. A payment is claimed once, by the first rule that holds, in the
 * SPEC's order (the direct ones first); an action saves one payment at most: the first one
 * after it.
 */
export function attributeSaves(facts: AttributionFacts): Save[] {
  const paid = facts.payments
    .filter(
      (p): p is AttributedPayment & { paidAt: number } =>
        p.paidAt !== null && isPaidPayment(p.status) && p.amount > 0,
    )
    .sort((a, b) => a.paidAt - b.paidAt || a.id.localeCompare(b.id));
  const actions = [...facts.actions].sort(
    (a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id),
  );
  const usedPayments = new Set(facts.counted);
  const usedActions = new Set<string>();
  const saves: Save[] = [];

  const claim = (
    type: SaveType,
    action: AttributedAction,
    payment: AttributedPayment & { paidAt: number },
    proof: string[],
  ) => {
    usedPayments.add(payment.id);
    usedActions.add(action.id);
    saves.push({
      type,
      category: SAVE_CATEGORY[type],
      memberId: action.memberId,
      actionId: action.id,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      savedAt: payment.paidAt,
      proof,
    });
  };

  /** The first payment after `from` that `fits`, among those nobody claimed yet. */
  const firstPaid = (from: number, fits: (p: AttributedPayment) => boolean, until = Infinity) =>
    paid.find((p) => p.paidAt > from && p.paidAt <= until && !usedPayments.has(p.id) && fits(p));

  const sameMembership = (action: AttributedAction) => (p: AttributedPayment) =>
    action.membershipId !== null && p.membershipId === action.membershipId;

  // Direct, payment recovered: the payment StayPut acted on, or the next one of its membership,
  // comes in within 14 days.
  for (const action of actions) {
    if (!PAYMENT_ACTIONS.has(action.type) || usedActions.has(action.id)) continue;
    const payment = firstPaid(
      action.sentAt,
      (p) => p.id === action.paymentId || sameMembership(action)(p),
      action.sentAt + RECOVERY_DAYS * DAY_MS,
    );
    if (payment) {
      const failed = action.paymentId && action.paymentId !== payment.id ? [action.paymentId] : [];
      claim('payment_recovered', action, payment, [action.id, ...failed, payment.id]);
    }
  }

  // Direct, cancellation undone: StayPut undid it with the member's consent within 7 days after
  // they accepted its offer, and the next renewal came in.
  for (const action of actions) {
    if (!OFFER_ACTIONS.has(action.type) || !action.kept || usedActions.has(action.id)) continue;
    if (action.acceptedAt === null || action.sentAt - action.acceptedAt > REVERT_DAYS * DAY_MS) {
      continue;
    }
    const payment = firstPaid(action.sentAt, sameMembership(action));
    if (payment) claim('cancellation_reverted', action, payment, [action.id, payment.id]);
  }

  // Direct, pause resumed: a membership StayPut paused pays again.
  for (const action of actions) {
    if (action.type !== 'pause_offer' || usedActions.has(action.id)) continue;
    const payment = firstPaid(action.sentAt, sameMembership(action));
    if (payment) claim('pause_resumed', action, payment, [action.id, payment.id]);
  }

  // Direct, win-back: a former member comes back with a code StayPut gave.
  for (const action of actions) {
    if (!WINBACK_ACTIONS.has(action.type) || !action.promoCodeId || usedActions.has(action.id)) {
      continue;
    }
    const payment = firstPaid(action.sentAt, (p) => p.promoCodeId === action.promoCodeId);
    if (payment) claim('winback', action, payment, [action.id, payment.id]);
  }

  // Influenced: a member at high risk got StayPut's message, was active again within 14 days,
  // then renewed within their period.
  for (const action of actions) {
    if (action.type !== 'high_risk_message' || usedActions.has(action.id)) continue;
    const back = facts.firstActivityAfter[action.id];
    if (back === undefined || back <= action.sentAt) continue;
    if (back - action.sentAt > REACTIVATION_DAYS * DAY_MS) continue;
    const payment = firstPaid(back, (p) => p.memberId === action.memberId, Infinity);
    if (!payment) continue;
    const period =
      (payment.membershipId && facts.periodDays[payment.membershipId]) || DEFAULT_PERIOD_DAYS;
    if (payment.paidAt - action.sentAt > (period + RENEWAL_GRACE_DAYS) * DAY_MS) continue;
    claim('renewal_after_message', action, payment, [action.id, payment.id]);
  }

  return saves.sort((a, b) => a.savedAt - b.savedAt);
}

/** What saves add up to, by category, in one currency (the others are left out and flagged). */
export interface SavedTotals {
  currency: string | null;
  direct: number;
  influenced: number;
  /** Saves in other currencies exist (and are not counted here). */
  otherCurrencies: boolean;
  count: number;
}

/** The totals of `saves` between `from` (inclusive) and `to` (exclusive), in their main currency. */
export function savedTotals(
  saves: readonly Pick<Save, 'category' | 'amount' | 'currency' | 'savedAt'>[],
  from: number,
  to: number,
): SavedTotals {
  const inside = saves.filter((s) => s.savedAt >= from && s.savedAt < to);
  const byCurrency = new Map<string, number>();
  for (const s of inside) byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + s.amount);
  const currency =
    [...byCurrency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    null;
  const mine = inside.filter((s) => s.currency === currency);
  const sum = (category: SaveCategory) =>
    round2(mine.filter((s) => s.category === category).reduce((total, s) => total + s.amount, 0));
  return {
    currency,
    direct: sum('direct'),
    influenced: sum('influenced'),
    otherCurrencies: byCurrency.size > 1,
    count: mine.length,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
