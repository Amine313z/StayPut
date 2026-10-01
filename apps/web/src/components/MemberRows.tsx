import type { MemberRow } from '@stayput/core';
import { isFailedPayment } from '@stayput/core';
import type { MessageKey, Translator } from '@stayput/i18n';
import { CalendarClock, CreditCard, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';

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

/** Why a member needs the creator's attention now, from Whop's facts (never a guess). */
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

/** The members, one row each: who, their membership and payments, their activity. */
export function MemberList({ members }: { members: readonly MemberRow[] }) {
  return (
    <ul className="divide-y divide-line">
      {members.map((member) => (
        <MemberItem key={member.id} member={member} />
      ))}
    </ul>
  );
}

function MemberItem({ member }: { member: MemberRow }) {
  const i18n = useI18n();
  const { t, date, currency, plural } = i18n;
  const { membership, lastPayment, activity } = member;
  const failed = lastPayment !== null && isFailedPayment(lastPayment.status);
  const reasons = attentionReasons(member);
  const counts = [
    plural('members.messages', activity.messages),
    plural('members.reactions', activity.reactions),
    plural('members.posts', activity.posts),
    plural('members.lessons', activity.lessons),
  ];
  return (
    <li className="grid grid-cols-1 gap-3 py-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1.3fr)] md:gap-6">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={member.name} />
        <div className="min-w-0">
          <p className="truncate font-medium">{member.name ?? t('members.unnamed')}</p>
          {member.joinedAt ? (
            <p className="text-xs text-muted">
              {t('members.joined', { date: date(new Date(member.joinedAt)) })}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {member.accessLevel === 'admin' ? (
              <Badge tone="info" icon={<ShieldCheck aria-hidden="true" className="size-3" />}>
                {t('members.team')}
              </Badge>
            ) : null}
            {member.status === 'left' ? <Badge>{t('members.status.left')}</Badge> : null}
            {reasons.includes('paymentFailed') ? (
              <Badge tone="danger" icon={<CreditCard aria-hidden="true" className="size-3" />}>
                {t('attention.paymentFailed')}
              </Badge>
            ) : null}
            {reasons.includes('canceling') ? (
              <Badge tone="warning" icon={<CalendarClock aria-hidden="true" className="size-3" />}>
                {t('attention.canceling')}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      <div className="min-w-0 text-sm">
        <p>{membership ? membershipLine(membership, i18n) : t('members.noMembership')}</p>
        {lastPayment ? (
          <p className={`mt-1 ${failed ? 'font-medium text-danger' : 'text-muted'}`}>
            {t(failed ? 'members.payment.failed' : 'members.payment.last', {
              amount: currency(lastPayment.amount, lastPayment.currency.toUpperCase()),
              date: date(new Date(lastPayment.at)),
            })}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 text-sm text-muted">
        <p>{t('members.activity30', { list: counts.join(', ') })}</p>
        <p className="mt-1">
          {member.lastActivityAt
            ? t('members.lastActivity', { date: date(new Date(member.lastActivityAt)) })
            : member.lastActionAt
              ? t('members.lastAction', { date: date(new Date(member.lastActionAt)) })
              : t('members.noActivity')}
        </p>
      </div>
    </li>
  );
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
      t(membership.cancelAtPeriodEnd ? 'members.ends' : 'members.renews', {
        date: date(new Date(membership.currentPeriodEnd)),
      }),
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
