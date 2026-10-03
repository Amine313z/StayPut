import type { MemberRow } from '@stayput/core';
import { isFailedPayment } from '@stayput/core';
import type { MessageKey, Translator } from '@stayput/i18n';

const MEMBERSHIP_STATUSES: Record<string, MessageKey> = {
  trialing: 'membership.status.trialing',
  active: 'membership.status.active',
  past_due: 'membership.status.past_due',
  canceling: 'membership.status.canceling',
  completed: 'membership.status.completed',
  canceled: 'membership.status.canceled',
  expired: 'membership.status.expired',
  unresolved: 'membership.status.unresolved',
  drafted: 'membership.status.drafted',
};

/** A membership that is over: its period end is when it ended, never a renewal. */
const FINISHED = new Set(['canceled', 'expired']);

/**
 * Why a member needs the creator's attention now, from Whop's facts (never a guess): what the
 * dashboard says before the first scores, and for the team, who has none.
 */
export type AttentionReason = 'paymentFailed' | 'canceling';

export function attentionReasons(member: MemberRow): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (member.lastPayment && isFailedPayment(member.lastPayment.status)) {
    reasons.push('paymentFailed');
  }
  const membership = member.membership;
  if (membership && (membership.cancelAtPeriodEnd || membership.status === 'canceling')) {
    reasons.push('canceling');
  }
  return member.status === 'joined' ? reasons : [];
}

/** "Active · 49,00 $US par mois · renouvellement le 15 oct. 2026". */
export function membershipLine(
  membership: NonNullable<MemberRow['membership']>,
  i18n: Translator,
): string {
  const { t, currency, date } = i18n;
  const statusKey = MEMBERSHIP_STATUSES[membership.status];
  const parts = [statusKey ? t(statusKey) : membership.status];
  if (membership.price !== null && membership.price > 0 && membership.currency) {
    const price = currency(membership.price, membership.currency.toUpperCase());
    parts.push(
      t(priceKey(membership.billingPeriodDays), {
        price,
        days: membership.billingPeriodDays ?? 0,
      }),
    );
  }
  if (membership.currentPeriodEnd) {
    parts.push(
      t(
        FINISHED.has(membership.status)
          ? 'members.ended'
          : membership.cancelAtPeriodEnd
            ? 'members.ends'
            : 'members.renews',
        { date: date(new Date(membership.currentPeriodEnd)) },
      ),
    );
  }
  return parts.join(' · ');
}

function priceKey(days: number | null): MessageKey {
  if (days === null) return 'members.price.once';
  if (days === 7) return 'members.price.week';
  if (days >= 28 && days <= 31) return 'members.price.month';
  if (days >= 365 && days <= 366) return 'members.price.year';
  return 'members.price.days';
}
