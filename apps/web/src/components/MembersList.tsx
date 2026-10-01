import type { MemberRow, MembersPage } from '@stayput/core';
import { isFailedPayment } from '@stayput/core';
import type { MessageKey, Translator } from '@stayput/i18n';
import { useI18n } from '../i18n';

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

/** The figures of the community, then one card per member (mobile first). */
export function MembersList({ page }: { page: MembersPage }) {
  const i18n = useI18n();
  const { t, number } = i18n;
  const figures: [MessageKey, number][] = [
    ['members.summary.members', page.summary.members],
    ['members.summary.live', page.summary.liveMemberships],
    ['members.summary.cancellations', page.summary.scheduledCancellations],
    ['members.summary.failed', page.summary.failedPayments],
    ['members.summary.activity', page.summary.activity30d],
  ];
  return (
    <section aria-labelledby="members-title" className="space-y-4">
      <h2 id="members-title" className="text-xl font-semibold">
        {t('members.title')}
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {figures.map(([key, value]) => (
          <div key={key} className="rounded-xl border border-line bg-surface p-3">
            <dt className="text-sm text-muted">{t(key)}</dt>
            <dd className="mt-1 text-2xl font-semibold">{number(value)}</dd>
          </div>
        ))}
      </dl>
      {page.members.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-5 text-muted">
          {t('members.empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {page.members.map((member) => (
            <MemberCard key={member.id} member={member} i18n={i18n} />
          ))}
        </ul>
      )}
      {page.truncated ? (
        <p className="text-sm text-muted">
          {t('members.truncated', { count: number(page.members.length) })}
        </p>
      ) : null}
    </section>
  );
}

function MemberCard({ member, i18n }: { member: MemberRow; i18n: Translator }) {
  const { t, date, currency, plural } = i18n;
  const { membership, lastPayment, activity } = member;
  const failed = lastPayment !== null && isFailedPayment(lastPayment.status);
  const counts = [
    plural('members.messages', activity.messages),
    plural('members.reactions', activity.reactions),
    plural('members.posts', activity.posts),
    plural('members.lessons', activity.lessons),
  ];
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{member.name ?? t('members.unnamed')}</p>
        <p className="flex gap-2 text-sm text-muted">
          {member.accessLevel === 'admin' ? <span>{t('members.team')}</span> : null}
          {member.status === 'left' ? <span>{t('members.status.left')}</span> : null}
          {member.joinedAt ? (
            <span>{t('members.joined', { date: date(new Date(member.joinedAt)) })}</span>
          ) : null}
        </p>
      </div>
      <p className="mt-2 text-sm">
        {membership ? membershipLine(membership, i18n) : t('members.noMembership')}
      </p>
      {lastPayment ? (
        <p className={`mt-1 text-sm ${failed ? 'font-medium text-danger' : 'text-muted'}`}>
          {t(failed ? 'members.payment.failed' : 'members.payment.last', {
            amount: currency(lastPayment.amount, lastPayment.currency.toUpperCase()),
            date: date(new Date(lastPayment.at)),
          })}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-muted">
        {t('members.activity30', { list: counts.join(', ') })}
      </p>
      <p className="mt-1 text-sm text-muted">
        {member.lastActivityAt
          ? t('members.lastActivity', { date: date(new Date(member.lastActivityAt)) })
          : member.lastActionAt
            ? t('members.lastAction', { date: date(new Date(member.lastActionAt)) })
            : t('members.noActivity')}
      </p>
    </li>
  );
}

/** "Active · 49,00 $US par mois · renouvellement le 15 oct. 2026". */
function membershipLine(membership: NonNullable<MemberRow['membership']>, i18n: Translator) {
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
