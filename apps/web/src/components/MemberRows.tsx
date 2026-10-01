import type { MemberRow } from '@stayput/core';
import { isFailedPayment } from '@stayput/core';
import type { MessageKey, Translator } from '@stayput/i18n';
import { BellOff, CalendarClock, CreditCard, ShieldCheck, Sprout } from 'lucide-react';
import { useId, useState } from 'react';
import { putJson } from '../api';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RiskBadge, RiskReasons } from './Risk';

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

/**
 * The members, one row each: who and their risk, their membership and payments, their activity,
 * and the « never contact » switch (`api`: `/api/creator/<company>`).
 */
export function MemberList({ members, api }: { members: readonly MemberRow[]; api: string }) {
  return (
    <ul className="divide-y divide-line">
      {members.map((member) => (
        <MemberItem key={member.id} member={member} api={api} />
      ))}
    </ul>
  );
}

function MemberItem({ member, api }: { member: MemberRow; api: string }) {
  const i18n = useI18n();
  const { t, date, currency, plural } = i18n;
  const { membership, lastPayment, activity, risk } = member;
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
            {risk ? <RiskBadge risk={risk} /> : null}
            {risk?.inactiveNewcomer ? (
              <Badge tone="info" icon={<Sprout aria-hidden="true" className="size-3" />}>
                {t('risk.newcomer')}
              </Badge>
            ) : null}
            {member.accessLevel === 'admin' ? (
              <Badge tone="info" icon={<ShieldCheck aria-hidden="true" className="size-3" />}>
                {t('members.team')}
              </Badge>
            ) : null}
            {member.status === 'left' ? <Badge>{t('members.status.left')}</Badge> : null}
            {/* Before the first score, Whop's facts; once scored, the reasons say them. */}
            {!risk && reasons.includes('paymentFailed') ? (
              <Badge tone="danger" icon={<CreditCard aria-hidden="true" className="size-3" />}>
                {t('attention.paymentFailed')}
              </Badge>
            ) : null}
            {!risk && reasons.includes('canceling') ? (
              <Badge tone="warning" icon={<CalendarClock aria-hidden="true" className="size-3" />}>
                {t('attention.canceling')}
              </Badge>
            ) : null}
          </div>
          {risk ? <RiskReasons reasons={risk.reasons} /> : null}
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
        {member.status === 'joined' && member.accessLevel !== 'admin' ? (
          <NeverContact api={api} member={member} />
        ) : null}
      </div>
    </li>
  );
}

/**
 * The « never contact » switch of one member (SPEC 5.8): on, StayPut takes no action of any kind
 * for them, from the next run on.
 */
function NeverContact({ api, member }: { api: string; member: MemberRow }) {
  const { t } = useI18n();
  const id = useId();
  const [value, setValue] = useState<boolean | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const on = value ?? member.doNotContact;
  const toggle = async () => {
    setState('saving');
    try {
      const next = await putJson<{ doNotContact: boolean }>(
        `${api}/members/${encodeURIComponent(member.id)}/contact`,
        { doNotContact: !on },
      );
      setValue(next.doNotContact);
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="mt-2">
      <Button
        variant={on ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={on}
        aria-describedby={`${id}-hint`}
        loading={state === 'saving'}
        icon={<BellOff aria-hidden="true" className="size-4" />}
        onClick={() => void toggle()}
        className={on ? '' : '-ms-3'}
      >
        {t('members.contact.never')}
      </Button>
      <p id={`${id}-hint`} className="text-xs text-muted">
        {state === 'failed' ? (
          <span className="text-danger">{t('members.contact.error')}</span>
        ) : on ? (
          t('members.contact.on')
        ) : (
          t('members.contact.off')
        )}
      </p>
    </div>
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
