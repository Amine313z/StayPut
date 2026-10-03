import type {
  CreatorMessagesResult,
  CreatorOffersResult,
  CreatorRetryResult,
  DashboardView,
  GettingStarted,
  MemberRow,
  MembersPage,
  PriorityAction,
  RevenueDay,
} from '@stayput/core';
import {
  ArrowRight,
  CheckCheck,
  CircleCheck,
  LoaderCircle,
  PauseCircle,
  RotateCw,
  Send,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { postJson, useApi, useReloadOnChange, type Loadable } from '../../api';
import { MemberActions, failureText } from '../../components/MemberActions';
import { MemberListRow } from '../../components/MemberListRow';
import { attentionReasons } from '../../components/MemberRows';
import { LEVELS } from '../../components/Risk';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { STAGGER, ease, itemVariants } from '../../motion';
import { reasonText } from '../../risk-text';
import { ActionButton } from '../../ui/ActionButton';
import { SECTION_LINK_CLASS, buttonClass } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { GettingStartedPill } from '../../ui/GettingStartedPill';
import { LabelTip } from '../../ui/LabelTip';
import { MetricHero, SecondaryMetric } from '../../ui/Metric';
import { AnimatedNumber, Stagger, StaggerItem } from '../../ui/Motion';
import { Segmented } from '../../ui/Segmented';
import { MetricSkeleton, RowsSkeleton, Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { AreaChart } from '../../ui/charts/AreaChart';
import { useCreatorData } from '../CreatorView';

/** Members in « Needs attention »: the most urgent only, the others in Members. */
export const ATTENTION_LIMIT = 5;

/** A departure this close is urgent: the red dot (the brief: within 48 hours). */
const URGENT_MS = 48 * 3_600_000;

/** The chart's periods, in days. */
const PERIODS = ['7', '30', '90'] as const;
type Period = (typeof PERIODS)[number];

/**
 * The Dashboard (brief v3 §6.2), one question: « Am I losing money, and what do I do today? ».
 * Top to bottom and nothing else: the « Getting started » pill under the title; one hero block
 * (the revenue saved this month, the revenue and the members at risk, and beneath them the
 * chart of saved against at risk); the one action of the day; the five members who need
 * attention most; what StayPut did in 30 days. Sections 32 px apart, coming in 60 ms after one
 * another; StayPut's mark at 3 % in the bottom right corner.
 */
export function Overview() {
  const { api, root, members, sync, testMode } = useCreatorData();
  const dashboard = useApi<DashboardView>(`${api}/dashboard`);
  // New data from Whop: the figures again.
  useReloadOnChange(sync.status?.lastSyncAt, dashboard.reload);
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  const importing = sync.status !== null && !sync.status.backfillDone;
  const acted = () => {
    dashboard.reload();
    members.reload();
  };

  return (
    <div className="relative">
      {view && !setupDone(view.gettingStarted) ? (
        <div className="-mt-3 mb-8">
          <Setup steps={view.gettingStarted} root={root} />
        </div>
      ) : null}
      <Stagger className="space-y-8">
        {importing ? (
          <StaggerItem>
            <ImportingBar />
          </StaggerItem>
        ) : null}
        {dashboard.state.status === 'error' ? (
          <StaggerItem>
            <ErrorPanel
              error={dashboard.state.error}
              forbiddenKey="error.forbidden.creator"
              onRetry={dashboard.retry}
            />
          </StaggerItem>
        ) : (
          <>
            <StaggerItem>
              <HeroBlock view={view} />
            </StaggerItem>
            <StaggerItem>
              <Priority view={view} api={api} root={root} testMode={testMode.on} onDone={acted} />
            </StaggerItem>
          </>
        )}
        <StaggerItem>
          <NeedsAttention
            state={members.state}
            retry={members.retry}
            api={api}
            root={root}
            testMode={testMode.on}
            onDone={dashboard.reload}
          />
        </StaggerItem>
        <StaggerItem>
          <ActionsStrip view={view} />
        </StaggerItem>
      </Stagger>
      {/*
        StayPut's mark at 3 %, in the bottom right corner of the dashboard (brief v3 §4): after
        the last block, in its own room, so it never shows through the chart or a row.
      */}
      <img
        src="/logo-256.png"
        alt=""
        aria-hidden="true"
        width={160}
        height={160}
        decoding="async"
        className="pointer-events-none ms-auto mt-16 hidden size-40 opacity-[0.03] select-none md:block"
      />
    </div>
  );
}

/** While the history comes from Whop, the figures fill in: said in a slim line. */
function ImportingBar() {
  const { t } = useI18n();
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-lg border border-line px-4 py-1.5 text-[0.8125rem] text-subtle"
    >
      <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
      {t('sync.importing')}
    </p>
  );
}

function setupDone(steps: GettingStarted): boolean {
  return steps.discord && steps.automation && steps.reviewed && steps.guardrails;
}

/** « Getting started » (brief v3 §7): four steps, each leading to its screen, until all are done. */
function Setup({ steps, root }: { steps: GettingStarted; root: string }) {
  const { t } = useI18n();
  return (
    <GettingStartedPill
      title={t('start.title')}
      doneLabel={t('start.done')}
      progress={(done, total) => t('start.progress', { done, total })}
      steps={[
        { key: 'discord', label: t('start.discord'), done: steps.discord, to: `${root}/sources` },
        {
          key: 'automation',
          label: t('start.automation'),
          done: steps.automation,
          to: `${root}/actions`,
        },
        {
          key: 'reviewed',
          label: t('start.reviewed'),
          done: steps.reviewed,
          to: `${root}/members?filter=high`,
        },
        {
          key: 'guardrails',
          label: t('start.guardrails'),
          done: steps.guardrails,
          to: `${root}/settings/actions`,
        },
      ]}
    />
  );
}

/**
 * An amount of the dashboard in the community's currency, with its symbol and its cents
 * (brief v4 §7: « $247.00 »); a count without one.
 */
function useMoney(currency: string | null): (value: number) => string {
  const i18n = useI18n();
  return (value) => (currency ? i18n.currency(value, currency) : i18n.number(Math.round(value)));
}

/**
 * The one hero block (brief v3 §6.2): no box inside it, thin dividers only. On the left the
 * revenue saved this month, the screen's one giant number, in the signature gradient on the
 * turquoise light; on the right, in white, the revenue at risk (never red) and the members at
 * risk; beneath, in the same block, saved against at risk over time. What each counts is in its
 * label's tooltip, never under the number.
 */
function HeroBlock({ view }: { view: DashboardView | null }) {
  const { t, number } = useI18n();
  const titleId = useId();
  const money = useMoney(view?.currency ?? null);
  const atRisk = view?.atRisk;
  return (
    <section aria-labelledby={titleId} className="relative isolate rounded-xl border border-line">
      <h2 id={titleId} className="sr-only">
        {t('dash.money')}
      </h2>
      <div className="grid grid-cols-1 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="relative flex flex-col justify-center p-5 @3xl:py-8">
          <span
            aria-hidden="true"
            className="hero-glow -z-10"
            style={{ left: -210, top: 'calc(50% - 350px)' }}
          />
          {view ? (
            <MetricHero
              better="up"
              label={t('dash.saved')}
              tip={t('dash.saved.info')}
              value={view.currency ? view.saved.thisMonth.direct : null}
              format={money}
              empty={t('dash.noRevenue')}
            />
          ) : (
            <MetricSkeleton hero />
          )}
        </div>
        <div className="grid grid-cols-2 border-t border-line @3xl:grid-cols-1 @3xl:border-s @3xl:border-t-0">
          <div className="p-5">
            {view && atRisk ? (
              <SecondaryMetric
                better="down"
                label={t('dash.atRisk')}
                tip={
                  view.monthlyRevenue === null
                    ? undefined
                    : t('dash.atRisk.info', { total: money(view.monthlyRevenue) })
                }
                value={view.currency ? atRisk.revenue : null}
                format={money}
                empty={t('dash.noRevenue')}
              />
            ) : (
              <MetricSkeleton />
            )}
          </div>
          <div className="border-s border-line p-5 @3xl:border-s-0 @3xl:border-t">
            {view && atRisk ? (
              <SecondaryMetric
                better="down"
                label={t('dash.membersAtRisk')}
                tip={t('dash.membersAtRisk.info', {
                  departures: number(atRisk.departures),
                  high: number(atRisk.high),
                })}
                value={atRisk.members}
                format={(value) => number(Math.round(value))}
              />
            ) : (
              <MetricSkeleton />
            )}
          </div>
        </div>
      </div>
      <div className="border-t border-line p-5">
        <RevenueChart view={view} />
      </div>
    </section>
  );
}

/** A day of the history (`YYYY-MM-DD`, the community's calendar) at noon: never the day before. */
function dayOf(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

/** The last `days` days: the money saved added up from the first one, and the money at risk. */
export function chartWindow(history: readonly RevenueDay[], days: number) {
  const window = history.slice(-days);
  let total = 0;
  const saved = window.map((day) => (total += day.saved));
  return { window, saved, atRisk: window.map((day) => day.atRisk) };
}

/**
 * Saved against at risk, inside the hero block: what StayPut saved, added up over the period
 * (the turquoise line over its area), and what the members at risk paid each month, day by day
 * (the dashed white line); over 7, 30 or 90 days, each period drawing in.
 */
function RevenueChart({ view }: { view: DashboardView | null }) {
  const i18n = useI18n();
  const { t, plural, date, day } = i18n;
  const [period, setPeriod] = useState<Period>('30');
  const money = useMoney(view?.currency ?? null);
  const currency = view?.currency ?? null;
  const data = useMemo(
    () => (view ? chartWindow(view.revenueHistory, Number(period)) : null),
    [view, period],
  );
  const title = t('dash.chart.title');
  const header = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h3 className="title-section">
        <LabelTip tip={t('dash.chart.info')}>{title}</LabelTip>
      </h3>
      <Segmented
        label={t('dash.chart.period')}
        value={period}
        onChange={setPeriod}
        options={PERIODS.map((value) => ({
          value,
          label: plural('dash.chart.days', Number(value)),
        }))}
      />
    </div>
  );
  if (!view || !data) {
    return (
      <>
        {header}
        <Skeleton className="h-64 w-full" />
      </>
    );
  }
  const empty = view.revenueHistory.every((d) => d.atRisk === null && d.saved === 0);
  const first = data.atRisk.find((value) => value !== null) ?? null;
  const last = data.atRisk.at(-1) ?? null;
  const savedTotal = data.saved.at(-1) ?? 0;
  const summary =
    first !== null && last !== null
      ? t('dash.chart.summary', {
          days: period,
          saved: money(savedTotal),
          from: money(first),
          to: money(last),
        })
      : t('dash.chart.summaryNoRisk', { days: period, saved: money(savedTotal) });
  return (
    <>
      {header}
      {empty ? (
        <EmptyState inset body={t('dash.chart.empty')} />
      ) : (
        <AreaChart
          label={title}
          summary={summary}
          period={period}
          points={data.window.map((d) => ({ label: date(dayOf(d.day)), tick: day(dayOf(d.day)) }))}
          series={[
            { key: 'saved', label: t('dash.chart.saved'), values: data.saved, look: 'area' },
            { key: 'atRisk', label: t('dash.chart.atRisk'), values: data.atRisk, look: 'line' },
          ]}
          format={money}
          formatTick={(value) =>
            currency ? i18n.currency(value, currency, { compact: true }) : i18n.number(value)
          }
        />
      )}
    </>
  );
}

/** What changes with each action of the day: a new one is a new section (its button fresh). */
function identityOf(priority: PriorityAction | null): string {
  if (priority === null) return 'none';
  switch (priority.kind) {
    case 'approve':
      return `approve:${priority.actions}`;
    case 'retry':
      return `retry:${priority.payments}`;
    case 'review':
      return `review:${priority.filter}:${priority.members}`;
    default:
      return `${priority.kind}:${priority.memberIds.join(',')}`;
  }
}

/**
 * The one action of the day (brief v3 §6.2): one sentence with the revenue it touches (what
 * those payments or members bring each month, never a promise) and the page's only primary
 * button. Computed from the data: while a payment stays failed or a member is leaving it never
 * says « nothing urgent ».
 */
function Priority({
  view,
  api,
  root,
  testMode,
  onDone,
}: {
  view: DashboardView | null;
  api: string;
  root: string;
  testMode: boolean;
  onDone: () => void;
}) {
  const { t, plural } = useI18n();
  const toast = useToast();
  const titleId = useId();
  const money = useMoney(view?.currency ?? null);
  if (!view) return <Skeleton className="h-24 w-full rounded-xl" />;
  const priority = view.priority;
  const sent = (title: string, body: string) =>
    toast({ title, body: testMode ? t('dash.toast.simulated') : body });
  const fail = (error: unknown) => toast({ tone: 'error', title: failureText(error, t) });

  let sentence: string;
  let button: ReactNode = null;
  let aside: ReactNode = null;
  if (priority === null) {
    sentence = t('dash.priority.none.title');
  } else {
    const amount = money(priority.revenue);
    switch (priority.kind) {
      case 'approve':
        sentence = plural('dash.priority.approve.sentence', priority.actions, { amount });
        aside = (
          <Link to={`${root}/actions`} className={SECTION_LINK_CLASS}>
            {t('dash.priority.reviewFirst')}
          </Link>
        );
        button = (
          <ActionButton
            stayDone
            icon={<CheckCheck aria-hidden="true" className="size-4" />}
            run={async () => {
              const result = await postJson<{ approved: number }>(`${api}/actions/approve`);
              sent(plural('dash.toast.approved', result.approved), t('dash.toast.messaged.body'));
              onDone();
            }}
            onError={fail}
          >
            {t('dash.priority.approve.button')}
          </ActionButton>
        );
        break;
      case 'retry':
        sentence = plural('dash.priority.retry.sentence', priority.payments, { amount });
        button = (
          <ActionButton
            stayDone
            icon={<RotateCw aria-hidden="true" className="size-4" />}
            run={async () => {
              const result = await postJson<CreatorRetryResult>(`${api}/payments/retry`);
              if (result.queued > 0) {
                sent(plural('dash.toast.retried', result.queued), t('dash.toast.retried.body'));
              } else toast({ title: t('dash.toast.nothingToRetry') });
              onDone();
            }}
            onError={fail}
          >
            {t('dash.priority.retry.button')}
          </ActionButton>
        );
        break;
      case 'pause':
        sentence = plural('dash.priority.pause.sentence', priority.memberIds.length, { amount });
        button = (
          <ActionButton
            stayDone
            icon={<PauseCircle aria-hidden="true" className="size-4" />}
            run={async () => {
              const result = await postJson<CreatorOffersResult>(`${api}/members/offers`, {
                memberIds: priority.memberIds,
                kind: 'pause_offer',
              });
              if (result.made > 0) {
                sent(plural('dash.toast.paused', result.made), t('dash.toast.paused.body'));
              } else toast({ title: t('dash.toast.noPause') });
              onDone();
            }}
            onError={fail}
          >
            {t('dash.priority.pause.button')}
          </ActionButton>
        );
        break;
      case 'message':
        sentence = plural('dash.priority.message.sentence', priority.memberIds.length, {
          amount,
        });
        button = (
          <ActionButton
            stayDone
            icon={<Send aria-hidden="true" className="size-4" />}
            run={async () => {
              const result = await postJson<CreatorMessagesResult>(`${api}/members/message`, {
                memberIds: priority.memberIds,
              });
              if (result.queued > 0) {
                sent(plural('dash.toast.messaged', result.queued), t('dash.toast.messaged.body'));
              } else toast({ title: t('dash.toast.nothingNew') });
              onDone();
            }}
            onError={fail}
          >
            {t('dash.priority.message.button')}
          </ActionButton>
        );
        break;
      case 'review':
        sentence = plural(
          priority.filter === 'failed'
            ? 'dash.priority.review.failed'
            : 'dash.priority.review.cancelling',
          priority.members,
          { amount },
        );
        button = (
          <Link
            to={`${root}/members?filter=${priority.filter === 'failed' ? 'high' : 'leaving'}`}
            className={buttonClass('primary')}
          >
            {t('dash.priority.review.button')}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        );
        break;
    }
  }
  return (
    <motion.section
      key={identityOf(priority)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={ease('standard')}
      aria-labelledby={titleId}
      className="flex flex-col gap-4 border-y border-line py-5 @3xl:flex-row @3xl:items-center @3xl:justify-between"
    >
      <div className="min-w-0">
        <p>
          <LabelTip tip={t('dash.priority.info')} className="label-text">
            {t('dash.priority')}
          </LabelTip>
        </p>
        <h2 id={titleId} className="mt-2 flex items-start gap-2 text-base font-medium text-fg">
          {priority === null ? (
            <CircleCheck aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent" />
          ) : null}
          {sentence}
        </h2>
      </div>
      {button ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 @3xl:shrink-0">
          {aside}
          {button}
        </div>
      ) : null}
    </motion.section>
  );
}

/** A membership's price brought back to a month (the Worker's monthlyPrice). */
function monthlyOf(membership: MemberRow['membership']): number | null {
  if (!membership?.price || !membership.billingPeriodDays) return null;
  const days = membership.billingPeriodDays;
  if (days >= 28 && days <= 31) return membership.price;
  if (days === 7) return (membership.price * 52) / 12;
  if (days >= 365 && days <= 366) return membership.price / 12;
  return (membership.price * 30) / days;
}

export interface Urgency {
  member: MemberRow;
  /** Leaving within 48 hours, or a payment failed and not recovered: the red dot. */
  urgent: boolean;
  /** Leaving within 48 hours. */
  leavingSoon: boolean;
  leaving: boolean;
  paymentFailed: boolean;
  /** When they leave, or renew (ms). */
  end: number | null;
}

const LEVEL_RANK = { scheduled_departure: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * The members who need attention, the most urgent first: leaving within 48 hours or a payment
 * failed, then the departures, then the highest scores, the soonest end first. Before the first
 * scores, Whop's facts (a cancellation scheduled, a payment failed).
 */
export function mostUrgent(members: readonly MemberRow[], now: number): Urgency[] {
  const scored = members.some((m) => m.risk !== null);
  return members
    .filter((m) => m.status === 'joined')
    .map((member) => {
      const reasons = attentionReasons(member);
      const leaving = reasons.includes('canceling');
      const paymentFailed = reasons.includes('paymentFailed');
      const end = member.membership?.currentPeriodEnd
        ? Date.parse(member.membership.currentPeriodEnd)
        : null;
      const leavingSoon = leaving && end !== null && end - now <= URGENT_MS;
      return {
        member,
        urgent: leavingSoon || paymentFailed,
        leavingSoon,
        leaving,
        paymentFailed,
        end,
      };
    })
    .filter(({ member, leaving, paymentFailed }) =>
      scored
        ? member.risk?.level === 'scheduled_departure' ||
          member.risk?.level === 'high' ||
          paymentFailed
        : leaving || paymentFailed,
    )
    .sort(
      (a, b) =>
        Number(b.urgent) - Number(a.urgent) ||
        (a.member.risk ? LEVEL_RANK[a.member.risk.level] : 4) -
          (b.member.risk ? LEVEL_RANK[b.member.risk.level] : 4) ||
        (b.member.risk?.score ?? 0) - (a.member.risk?.score ?? 0) ||
        (a.end ?? Infinity) - (b.end ?? Infinity),
    );
}

/**
 * « Needs attention » (brief v3 §6.2): the five most urgent members, each with the main reason,
 * their risk ring drawing in, when they leave or renew, and Message / Pause / Offer on the spot;
 * « See all » leads to Members. Not a box: a title, then the rows between thin dividers.
 */
function NeedsAttention({
  state,
  retry,
  api,
  root,
  testMode,
  onDone,
}: {
  state: Loadable<MembersPage>;
  retry: () => void;
  api: string;
  root: string;
  testMode: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  // The moment the page opened: the order does not shift while the creator reads it.
  const [now] = useState(() => Date.now());
  const flagged = useMemo(
    () => (state.status === 'ready' ? mostUrgent(state.data.members, now) : []),
    [state, now],
  );
  const shown = flagged.slice(0, ATTENTION_LIMIT);
  // Who was there when the list first showed: anyone else is new.
  const [firstIds, setFirstIds] = useState<ReadonlySet<string> | null>(null);
  if (firstIds === null && state.status === 'ready') {
    setFirstIds(new Set(shown.map((item) => item.member.id)));
  }
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return (
    <section aria-labelledby={titleId}>
      <header className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="title-section">
          {t('attention.title')}
        </h2>
        {flagged.length > 0 ? (
          <Link to={`${root}/members`} className={SECTION_LINK_CLASS}>
            {t('attention.seeAll', { count: flagged.length })}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        ) : null}
      </header>
      <div className="mt-2">
        {state.status === 'loading' ? (
          <div className="py-3">
            <RowsSkeleton rows={5} />
          </div>
        ) : flagged.length === 0 ? (
          <EmptyState inset body={t('attention.none')} />
        ) : (
          <Stagger as="ul" className="@container/list divide-y divide-line">
            {/* The first rows come in with the page; one that shows up later slides in with a
                turquoise pulse, one that goes folds away while the others move up (MOTION.md). */}
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((item, index) => (
                <motion.li
                  key={item.member.id}
                  layout
                  variants={itemVariants}
                  exit={{ opacity: 0, scale: 0.98, transition: ease('micro') }}
                  className="relative"
                >
                  {firstIds !== null && !firstIds.has(item.member.id) ? (
                    <motion.span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-xl bg-turq-300/10"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 1, 0] }}
                      transition={ease('draw')}
                    />
                  ) : null}
                  <AttentionRow
                    item={item}
                    api={api}
                    testMode={testMode}
                    onDone={onDone}
                    delay={0.15 + index * STAGGER}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </Stagger>
        )}
      </div>
    </section>
  );
}

/** A member who needs attention: the dashboard's words for them, in the list's row. */
function AttentionRow({
  item,
  api,
  testMode,
  onDone,
  delay,
}: {
  item: Urgency;
  api: string;
  testMode: boolean;
  onDone: () => void;
  delay: number;
}) {
  const i18n = useI18n();
  const { t, day, currency, number } = i18n;
  const { member, leavingSoon, leaving, paymentFailed, end } = item;
  const main = (member.risk?.reasons ?? []).find((reason) => reason.code !== 'cancel_scheduled');
  // A payment that failed is said first: it is what is urgent.
  const reason = paymentFailed
    ? t('attention.paymentFailed')
    : ((main ? reasonText(main, i18n) : null) ?? (leaving ? t('attention.canceling') : null));
  const membership = member.membership;
  const monthly = monthlyOf(membership);
  const risk = member.risk;
  return (
    <MemberListRow
      name={member.name ?? t('members.unnamed')}
      reason={reason}
      reasonUrgent={paymentFailed}
      risk={
        risk
          ? {
              score: risk.score,
              label:
                risk.level === 'scheduled_departure'
                  ? t(LEVELS[risk.level].label)
                  : t('risk.badge', {
                      level: t(LEVELS[risk.level].label),
                      score: number(risk.score),
                    }),
            }
          : null
      }
      when={
        end === null
          ? null
          : t(leaving ? 'risk.reason.cancel_scheduled' : 'dash.row.renews', {
              date: day(new Date(end)),
            })
      }
      whenUrgent={leavingSoon}
      paid={
        monthly !== null && membership?.currency
          ? t('dash.row.perMonth', {
              amount: currency(monthly, membership.currency.toUpperCase()),
            })
          : null
      }
      actions={<MemberActions member={member} api={api} testMode={testMode} onDone={onDone} />}
      delay={delay}
    />
  );
}

/** The strip's cells: two a row on a narrow screen, four in a row; a thin divider between. */
const STRIP_CELLS = [
  '',
  'border-s border-line ps-6',
  '@3xl:border-s @3xl:border-line @3xl:ps-6',
  'border-s border-line ps-6',
];

/**
 * What StayPut did in 30 days (brief v3 §6.2), one strip under a thin divider: messages sent,
 * payments retried, pauses offered, members saved. No icon: each number says it with its words.
 */
function ActionsStrip({ view }: { view: DashboardView | null }) {
  const { t, plural, number } = useI18n();
  const titleId = useId();
  if (!view) return <Skeleton className="h-20 w-full rounded-xl" />;
  const done = view.stayputActions30d;
  const stats = [
    { key: 'messages', value: done.messages, label: plural('dash.strip.messages', done.messages) },
    {
      key: 'retries',
      value: done.paymentRetries,
      label: plural('dash.strip.retries', done.paymentRetries),
    },
    { key: 'pauses', value: done.pauses, label: plural('dash.strip.pauses', done.pauses) },
    { key: 'saved', value: done.saved, label: plural('dash.strip.saved', done.saved) },
  ];
  return (
    <section aria-labelledby={titleId} className="border-t border-line pt-6">
      <h2 id={titleId} className="label-text">
        {t('dash.stayputActions')}
      </h2>
      <dl className="mt-4 grid grid-cols-2 gap-y-6 @3xl:grid-cols-4">
        {stats.map((stat, index) => (
          <div key={stat.key} className={`flex flex-col-reverse gap-1 ${STRIP_CELLS[index]}`}>
            <dt className="text-[0.8125rem] text-subtle">{stat.label}</dt>
            <dd className="metric text-2xl text-fg">
              <AnimatedNumber
                value={stat.value}
                format={(value) => number(Math.round(value))}
                better="up"
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
