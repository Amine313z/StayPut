import type {
  MemberDetail,
  MemberDetailMembership,
  MemberDetailPayment,
  MemberPlatformActivity,
  MemberRow,
} from '@stayput/core';
import { PAID_PAYMENT_STATUSES, isFailedPayment } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { BellOff, Clock, RotateCw, Store } from 'lucide-react';
import { motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import { putJson, useApi, type ApiError } from '../api';
import { useI18n } from '../i18n';
import { URGENT_MS, isLeaving, memberState, monthlyOf, periodEnd } from '../members';
import { ease } from '../motion';
import { reasonText } from '../risk-text';
import { Avatar } from '../ui/Avatar';
import { DiscordIcon, TelegramIcon } from '../ui/BrandIcons';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { Stagger, StaggerItem } from '../ui/Motion';
import { RiskRing } from '../ui/RiskRing';
import { Skeleton } from '../ui/Skeleton';
import { Switch } from '../ui/Switch';
import { UrgentDot } from '../ui/UrgentDot';
import { Sparkline } from '../ui/charts/Sparkline';
import { MemberActions } from './MemberActions';
import { membershipLine } from './MemberRows';
import { STATE_LABELS } from './MemberTable';
import { LEVELS, RiskReasons } from './Risk';

/** A payment's outcome in a word; Whop's own word when StayPut has none for it. */
const PAYMENT_STATUSES: Readonly<Record<string, MessageKey>> = {
  pending: 'payment.status.pending',
  refunded: 'payment.status.refunded',
  partially_refunded: 'payment.status.partially_refunded',
};

const PLATFORM_NAMES: Readonly<Record<MemberPlatformActivity['platform'], MessageKey>> = {
  whop: 'sources.whop.name',
  discord: 'sources.discord.name',
  telegram: 'sources.telegram.name',
};

/**
 * A member's drawer (brief v4 §9.3), opened from their row: where they stand (the ring, the
 * level, one word for their state), why, what the creator can do now, their score over 30 days,
 * their subscription and payments, what they did on each platform, and the « Do not contact »
 * switch, whose sentence lives here only. The sections come in one after the other.
 */
export function MemberDrawer({
  member,
  api,
  testMode,
  now,
  onClose,
  onChanged,
}: {
  member: MemberRow;
  /** `/api/creator/<company>`. */
  api: string;
  testMode: boolean;
  now: number;
  onClose: () => void;
  /** The member changed (an action queued, the switch turned): read the members again. */
  onChanged: () => void;
}) {
  const { t, date } = useI18n();
  const detail = useApi<MemberDetail>(`${api}/members/${encodeURIComponent(member.id)}`);
  // The switch's answer, until the members read again say the same.
  const [doNotContact, setDoNotContact] = useState(member.doNotContact);
  const name = member.name ?? t('members.unnamed');
  // Someone StayPut acts for: in the community, not the team.
  const actsFor = member.status === 'joined' && member.accessLevel !== 'admin';
  const data = detail.state.status === 'ready' ? detail.state.data : null;
  const failed = detail.state.status === 'error' ? detail.state.error : null;
  return (
    <Drawer
      title={name}
      description={
        member.joinedAt ? t('members.joined', { date: date(new Date(member.joinedAt)) }) : undefined
      }
      onClose={onClose}
    >
      <Stagger className="space-y-7">
        <StaggerItem>
          <Summary member={member} now={now} />
        </StaggerItem>
        {actsFor ? (
          <StaggerItem>
            <Section title={t('member.why')}>
              <Why member={member} />
            </Section>
          </StaggerItem>
        ) : null}
        {actsFor && !doNotContact ? (
          <StaggerItem>
            <Section title={t('member.actions')}>
              <MemberActions
                member={{ ...member, doNotContact }}
                api={api}
                testMode={testMode}
                wide
                onDone={onChanged}
              />
            </Section>
          </StaggerItem>
        ) : null}
        {failed ? (
          <StaggerItem>
            <LoadFailed error={failed} onRetry={detail.retry} />
          </StaggerItem>
        ) : null}
        <StaggerItem>
          <Score member={member} scores={data?.scores ?? null} hidden={failed !== null} />
        </StaggerItem>
        <StaggerItem>
          <Section title={t('member.subscription')}>
            <Subscription member={member} memberships={data?.memberships ?? null} />
          </Section>
        </StaggerItem>
        {failed ? null : (
          <>
            <StaggerItem>
              <Section title={t('member.payments')}>
                <Payments payments={data?.payments ?? null} />
              </Section>
            </StaggerItem>
            <StaggerItem>
              <Section title={t('member.activity')}>
                <Platforms platforms={data?.platforms ?? null} now={now} />
              </Section>
            </StaggerItem>
          </>
        )}
        {actsFor ? (
          <StaggerItem>
            <DoNotContact
              api={api}
              memberId={member.id}
              value={doNotContact}
              onSaved={(value) => {
                setDoNotContact(value);
                onChanged();
              }}
            />
          </StaggerItem>
        ) : null}
      </Stagger>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="label-text">
        {title}
      </h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** The red dot, said to screen readers too. */
function Urgent() {
  const { t } = useI18n();
  return (
    <>
      <UrgentDot />
      <span className="sr-only">{t('dash.row.urgent')}</span>
    </>
  );
}

/**
 * Where the member stands: their ring and level (a word for their state before the first
 * score), then their state when the level does not say it, what they pay a month, and when they
 * leave. A red dot for a payment not recovered, and for a departure within 48 hours.
 */
function Summary({ member, now }: { member: MemberRow; now: number }) {
  const { t, number, currency, day } = useI18n();
  const risk = member.risk;
  const state = memberState(member, now);
  const end = member.status === 'left' ? null : periodEnd(member);
  const leaving = isLeaving(member);
  const monthly = monthlyOf(member.membership);
  const failedNow = state === 'paymentFailed';
  // A departure's level is « Leaving »: the state would say it twice.
  const stateShown = risk !== null && risk.level !== 'scheduled_departure';
  const details: { key: string; node: ReactNode }[] = [];
  if (stateShown) {
    details.push({
      key: 'state',
      node: (
        <span className="inline-flex items-center gap-1.5 text-fg">
          {failedNow ? <Urgent /> : null}
          {t(STATE_LABELS[state])}
        </span>
      ),
    });
  }
  if (monthly !== null && member.membership?.currency) {
    details.push({
      key: 'paid',
      node: (
        <span className="metric text-fg">
          {t('dash.row.perMonth', {
            amount: currency(monthly, member.membership.currency.toUpperCase()),
          })}
        </span>
      ),
    });
  }
  if (leaving && end !== null) {
    details.push({
      key: 'end',
      node: (
        <span className="inline-flex items-center gap-1.5">
          {end - now <= URGENT_MS ? <Urgent /> : null}
          {t('members.endsOn', { date: day(new Date(end)) })}
        </span>
      ),
    });
  }
  return (
    <div className="flex items-center gap-4">
      {risk ? (
        <RiskRing
          score={risk.score}
          size={56}
          delay={0.15}
          label={
            risk.level === 'scheduled_departure'
              ? t(LEVELS[risk.level].label)
              : t('risk.badge', { level: t(LEVELS[risk.level].label), score: number(risk.score) })
          }
        />
      ) : (
        <Avatar name={member.name} size={56} />
      )}
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-base font-medium text-fg">
          {!risk && failedNow ? <Urgent /> : null}
          {risk ? t(LEVELS[risk.level].label) : t(STATE_LABELS[state])}
        </p>
        {details.length > 0 ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-subtle">
            {details.map((detail, index) => (
              <span key={detail.key} className="inline-flex items-center gap-2">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                {detail.node}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The reasons of their score, the one weighing most first; Whop's facts before the first one. */
function Why({ member }: { member: MemberRow }) {
  const i18n = useI18n();
  const { t } = i18n;
  const reasons = member.risk?.reasons ?? [];
  if (reasons.some((reason) => reasonText(reason, i18n) !== null)) {
    return <RiskReasons reasons={reasons} />;
  }
  return <p className="text-sm text-muted">{t('member.why.none')}</p>;
}

/** Their score over the last 30 days of the community's calendar, from 0 to 100. */
function Score({
  member,
  scores,
  hidden,
}: {
  member: MemberRow;
  /** Null while loading. */
  scores: MemberDetail['scores'] | null;
  hidden: boolean;
}) {
  const { t, number, day } = useI18n();
  if (hidden) return null;
  const title = t('member.score.trend');
  if (scores === null) {
    return (
      <Section title={title}>
        <Skeleton className="h-20 w-full" />
      </Section>
    );
  }
  if (scores.length < 2) {
    // One score is the ring itself; none yet is said, for a member StayPut scores.
    if (member.risk !== null || member.status !== 'joined' || member.accessLevel === 'admin') {
      return null;
    }
    return (
      <Section title={title}>
        <p className="text-sm text-muted">{t('member.score.none')}</p>
      </Section>
    );
  }
  const points = scores.map((score) => ({
    label: day(calendarDay(score.day)),
    value: score.score,
  }));
  const first = points[0]!;
  const last = points.at(-1)!;
  return (
    <Section title={title}>
      <Sparkline
        points={points}
        max={100}
        height={80}
        format={(value) => number(value)}
        summary={t('member.score.summary', { from: number(first.value), to: number(last.value) })}
      />
      <p aria-hidden="true" className="mt-1 flex justify-between text-xs text-subtle">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </p>
    </Section>
  );
}

/** « 2026-10-15 », a day of the community's calendar: that day here, whatever the time zone. */
function calendarDay(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

/** The membership that counts, since when, then the ones before it. */
function Subscription({
  member,
  memberships,
}: {
  member: MemberRow;
  /** Null while loading: the row's membership meanwhile. */
  memberships: MemberDetailMembership[] | null;
}) {
  const i18n = useI18n();
  const { t, date } = i18n;
  const current = memberships ? (memberships[0] ?? null) : member.membership;
  if (current === null) return <p className="text-sm text-muted">{t('members.noMembership')}</p>;
  const startedAt = memberships?.[0]?.startedAt ?? null;
  const before = memberships?.slice(1) ?? [];
  return (
    <div className="space-y-2 text-sm">
      <div>
        <p className="text-fg">{membershipLine(current, i18n)}</p>
        {startedAt ? (
          <p className="mt-0.5 text-[0.8125rem] text-subtle">
            {t('member.since', { date: date(new Date(startedAt)) })}
          </p>
        ) : memberships === null ? (
          <Skeleton className="mt-1.5 h-3 w-28" />
        ) : null}
      </div>
      {before.length > 0 ? (
        <ul className="space-y-1 border-t border-line pt-2 text-[0.8125rem] text-subtle">
          {before.map((membership) => (
            <li key={membership.id}>{membershipLine(membership, i18n)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Their latest payments, the latest first: when, how it went, how much. White words; the red dot
 * only on the latest one when it failed (not recovered since).
 */
function Payments({ payments }: { payments: MemberDetailPayment[] | null }) {
  const { t, date, currency } = useI18n();
  if (payments === null) return <ListSkeleton rows={3} />;
  if (payments.length === 0)
    return <p className="text-sm text-muted">{t('member.payments.none')}</p>;
  return (
    <ul className="divide-y divide-line">
      {payments.map((payment, index) => {
        const failed = isFailedPayment(payment.status);
        const key: MessageKey | undefined = PAID_PAYMENT_STATUSES.includes(payment.status)
          ? 'payment.status.paid'
          : failed
            ? 'payment.status.failed'
            : PAYMENT_STATUSES[payment.status];
        return (
          <li key={payment.id} className="py-2 text-[0.8125rem]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                {failed && index === 0 ? <Urgent /> : null}
                <span className="text-fg">{key ? t(key) : payment.status}</span>
                <span className="truncate text-subtle">· {date(new Date(payment.at))}</span>
              </span>
              <span className="metric shrink-0 text-fg">
                {currency(payment.amount, payment.currency.toUpperCase())}
              </span>
            </div>
            {failed && payment.failureReason ? (
              <p className="mt-0.5 truncate text-xs text-subtle">{payment.failureReason}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What they did on each platform over 30 days: a bar each, against the busiest one, drawing from
 * the left; when they were last active there, or that their account there is not tied yet.
 */
function Platforms({
  platforms,
  now,
}: {
  platforms: MemberPlatformActivity[] | null;
  now: number;
}) {
  const { t, plural, relative } = useI18n();
  if (platforms === null) return <ListSkeleton rows={2} />;
  const most = Math.max(1, ...platforms.map((p) => p.events));
  return (
    <ul className="space-y-3.5">
      {platforms.map((platform, index) => (
        <li key={platform.platform}>
          <div className="flex items-center justify-between gap-3 text-[0.8125rem]">
            <span className="flex items-center gap-2 text-fg">
              <PlatformIcon platform={platform.platform} />
              {t(PLATFORM_NAMES[platform.platform])}
            </span>
            <span className="metric text-fg">
              {plural('member.activity.interactions', platform.events)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <motion.span
              className="block h-full origin-left rounded-full bg-turq-300 rtl:origin-right"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: platform.events / most }}
              transition={ease('ring', 0.2 + index * 0.06)}
            />
          </div>
          <p className="mt-1 text-xs text-subtle">
            {!platform.linked
              ? t('member.activity.notLinked')
              : platform.lastAt
                ? t('member.activity.last', {
                    when: relative(new Date(platform.lastAt), new Date(now)),
                  })
                : t('members.noActivity')}
          </p>
        </li>
      ))}
    </ul>
  );
}

function PlatformIcon({ platform }: { platform: MemberPlatformActivity['platform'] }) {
  if (platform === 'discord') {
    return <DiscordIcon aria-hidden="true" className="size-4 text-discord" />;
  }
  if (platform === 'telegram') {
    return <TelegramIcon aria-hidden="true" className="size-4 text-telegram" />;
  }
  return <Store aria-hidden="true" className="size-4 text-fg" />;
}

/**
 * « Do not contact » (SPEC 5.8): on, StayPut takes no action of any kind for the member, from the
 * next run on, and the creator's own buttons hide. The one place that says so.
 */
function DoNotContact({
  api,
  memberId,
  value,
  onSaved,
}: {
  api: string;
  memberId: string;
  value: boolean;
  onSaved: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const toggle = async (next: boolean) => {
    setState('saving');
    try {
      const saved = await putJson<{ doNotContact: boolean }>(
        `${api}/members/${encodeURIComponent(memberId)}/contact`,
        { doNotContact: next },
      );
      setState('idle');
      onSaved(saved.doNotContact);
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line p-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="flex items-center gap-2 text-sm font-medium text-fg">
          <BellOff aria-hidden="true" className="size-4 text-subtle" />
          {t('members.contact.never')}
        </p>
        <p id={`${id}-hint`} className="mt-1 text-[0.8125rem] text-subtle">
          {state === 'failed' ? (
            <span className="text-fg">{t('members.contact.error')}</span>
          ) : value ? (
            t('members.contact.on')
          ) : (
            t('members.contact.off')
          )}
        </p>
      </div>
      <Switch
        checked={value}
        busy={state === 'saving'}
        labelledBy={`${id}-label`}
        describedBy={`${id}-hint`}
        onChange={(next) => void toggle(next)}
      />
    </div>
  );
}

/** The member's history did not come: said in a line, with « Retry ». */
function LoadFailed({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Clock aria-hidden="true" className="size-4 shrink-0 text-subtle" />
        {error.code === 'slow' ? t('error.slow') : t('member.loadError')}
      </p>
      <Button
        size="sm"
        variant="secondary"
        onClick={onRetry}
        icon={<RotateCw aria-hidden="true" className="size-4" />}
      >
        {t('common.retry')}
      </Button>
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
