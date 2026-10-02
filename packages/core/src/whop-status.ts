/**
 * What Whop's statuses mean for StayPut. Whop returns them as is; these lists are the one place
 * that decides which count as a member still paying, or as a charge left unpaid.
 */

/** Membership statuses that still give access (`completed`: a one-time purchase). */
export const LIVE_MEMBERSHIP_STATUSES: readonly string[] = [
  'trialing',
  'active',
  'past_due',
  'canceling',
  'completed',
];

/** Payment outcomes (Whop's sub-status, or status without one) that leave a charge unpaid. */
export const FAILED_PAYMENT_STATUSES: readonly string[] = [
  'failed',
  'past_due',
  'uncollectible',
  'unresolved',
];

export function isLiveMembership(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && LIVE_MEMBERSHIP_STATUSES.includes(status);
}

export function isFailedPayment(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && FAILED_PAYMENT_STATUSES.includes(status);
}

/**
 * Payment outcomes that brought the money in. A refunded, disputed or partly refunded payment is
 * not one: StayPut never counts it as saved (SPEC Phase 6.4).
 */
export const PAID_PAYMENT_STATUSES: readonly string[] = ['succeeded', 'paid'];

export function isPaidPayment(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && PAID_PAYMENT_STATUSES.includes(status);
}
