import type {
  CreatorMessagesResult,
  CreatorOffersResult,
  CreatorRetryResult,
  DashboardView,
  GettingStarted,
  MemberRow,
  MembersPage,
  PriorityAction,
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
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import { postJson, useApi, useReloadOnChange, type Loadable } from '../../api';
import { useGuide } from '../../components/guide/context';
import { Welcome } from '../../components/guide/Welcome';
import { MemberActions, failureText } from '../../components/MemberActions';
import { MemberListRow } from '../../components/MemberListRow';
import { attentionReasons } from '../../components/MemberRows';
import { LEVELS } from '../../components/Risk';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { URGENT_MS, monthlyOf, unpaidSince } from '../../members';
import { STAGGER, ease, itemVariants } from '../../motion';
import { reasonText } from '../../risk-text';
import { ActionButton } from '../../ui/ActionButton';
import { SECTION_LINK_CLASS, buttonClass } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Figures } from '../../ui/Figures';
import { GettingStartedPill } from '../../ui/GettingStartedPill';
import { LabelTip } from '../../ui/LabelTip';
import { MetricHero, SecondaryMetric } from '../../ui/Metric';
import { AnimatedNumber, Stagger, StaggerItem } from '../../ui/Motion';
import { Segmented } from '../../ui/Segmented';
import { MetricSkeleton, RowsSkeleton, Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { BalanceChart } from '../../ui/charts/BalanceChart';
import { useCreatorData } from '../CreatorView';
import { balanceWindow, monthOverMonth, savedOver, type MonthCompare } from './balance';

/** Members in « Needs attention »: the most urgent only, the others in Members. */
export const ATTENTION_LIMIT = 5;

/** A departure this close comes first in « Needs attention » (brief v4 §13: within 7 days). */
const FIRST_MS = 7 * 86_400_000;

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
  const { api, root, members, sync, testMode, integrations, demo } = useCreatorData();
  const guide = useGuide();
  const dashboard = useApi<DashboardView>(`${api}/dashboard`);
  // New data from Whop: the figures again.
  useReloadOnChange(sync.status?.lastSyncAt, dashboard.reload);
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  const importing = sync.status !== null && !sync.status.backfillDone;
  const acted = () => {
    dashboard.reload();
    members.reload();
  };
  // The welcome (brief v4 §10): by itself the first time a community opens StayPut (never in the
  // demo, which opens on its dashboard), or asked for with `?welcome`.
  const [search, setSearch] = useSearchParams();
  const asked = search.has('welcome');
  const [welcomed, setWelcomed] = useState(false);
  const welcome = !welcomed && (asked || (view !== null && !view.welcomed && !demo));
  const closeWelcome = (then: 'tour' | 'dashboard') => {
    setWelcomed(true);
    if (asked) {
      setSearch(
        (current) => {
          current.delete('welcome');
          return current;
        },
        { replace: true },
      );
    }
    // The mode may have changed, and with it the action of the day.
    dashboard.reload();
    if (then === 'tour') guide.startTour();
  };

  return (
    <div className="relative">
      {welcome ? (
        <Welcome
          view={view}
          integrations={integrations.state.status === 'ready' ? integrations.state.data : null}
          api={api}
          root={root}
          importing={importing}
          onClose={closeWelcome}
        />
      ) : null}
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
              <BalanceHero view={view} />
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

/** How far the hero's light moves with the cursor, at most, in px (desktop only). */
const GLOW_REACH = 20;

/**
 * The hero's light follows the cursor a little (brief v4 §14), on a computer only and never when
 * the device asks for less motion. Moved by style, never by React: the chart does not redraw.
 */
function useFollowingGlow() {
  const reduce = useReducedMotion();
  const glow = useRef<HTMLSpanElement>(null);
  const fine =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: fine)').matches;
  const on = fine && !reduce;
  const place = (x: number, y: number) => {
    if (glow.current) glow.current.style.transform = `translate(${x}px, ${y}px)`;
  };
  return {
    glow,
    onPointerMove: on
      ? (event: ReactPointerEvent<HTMLElement>) => {
          const box = event.currentTarget.getBoundingClientRect();
          const x = box.width ? (event.clientX - box.left) / box.width - 0.5 : 0;
          const y = box.height ? (event.clientY - box.top) / box.height - 0.5 : 0;
          place(Math.round(x * 2 * GLOW_REACH), Math.round(y * 2 * GLOW_REACH));
        }
      : undefined,
    onPointerLeave: on ? () => place(0, 0) : undefined,
  };
}

/**
 * The balance (brief v4 §8), as Whop shows « Total balance »: what StayPut saved this month, one
 * large amount, how it compares with the same days last month, and beneath it, with no box, the
 * month's balance day by day against what the members at risk pay. The revenue and the members
 * at risk sit to its right (under the chart on a narrow screen); 7D, 30D, 90D at the top right.
 * The amount, the end of the line and the tooltip on today are one number.
 */
function BalanceHero({ view }: { view: DashboardView | null }) {
  const { t, plural, number } = useI18n();
  const titleId = useId();
  const [period, setPeriod] = useState<Period>('30');
  const money = useMoney(view?.currency ?? null);
  const { glow, onPointerMove, onPointerLeave } = useFollowingGlow();
  const monthTotal = view?.currency ? view.saved.thisMonth.direct : null;
  const compare = useMemo(
    () => (view && monthTotal !== null ? monthOverMonth(view.revenueHistory, monthTotal) : null),
    [view, monthTotal],
  );
  const atRisk = view?.atRisk;
  return (
    <section
      aria-labelledby={titleId}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="relative isolate grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-6 [grid-template-areas:'balance_period'_'chart_chart'_'stats_stats'] @3xl:[grid-template-areas:'balance_period'_'balance_stats'_'chart_chart']"
    >
      <h2 id={titleId} className="sr-only">
        {t('dash.money')}
      </h2>
      <span
        ref={glow}
        aria-hidden="true"
        className="hero-glow -z-10 transition-transform duration-700 ease-brand"
        style={{ left: -260, top: -300 }}
      />
      <div className="min-w-0 [grid-area:balance]">
        {view ? (
          // The guide lights up the label, the amount and its delta: never the room beside them,
          // never the skeleton before them.
          <div data-tour="hero-amount" className="w-fit max-w-full">
            <MetricHero
              better="up"
              label={t('dash.saved')}
              tip={t('dash.saved.info')}
              value={monthTotal}
              format={money}
              empty={t('dash.noRevenue')}
            />
            {compare ? <Delta compare={compare} money={money} /> : null}
          </div>
        ) : (
          <MetricSkeleton hero />
        )}
      </div>
      <div className="justify-self-end [grid-area:period]">
        <Segmented
          look="pills"
          label={t('dash.chart.period')}
          value={period}
          onChange={setPeriod}
          options={PERIODS.map((value) => ({
            value,
            label: plural('dash.chart.days', Number(value)),
          }))}
        />
      </div>
      <div className="flex gap-10 [grid-area:stats] @3xl:self-end @3xl:justify-self-end">
        {view && atRisk ? (
          <>
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
          </>
        ) : (
          <>
            <MetricSkeleton />
            <MetricSkeleton />
          </>
        )}
      </div>
      <div className="min-w-0 [grid-area:chart]">
        <SavedChart view={view} period={period} money={money} />
      </div>
    </section>
  );
}

/**
 * « +$84.00 vs last month »: the month so far against the same days of last month, turquoise
 * when ahead, white-500 otherwise (never red). What is compared is its tooltip.
 */
function Delta({ compare, money }: { compare: MonthCompare; money: (value: number) => string }) {
  const { t, calendarDay } = useI18n();
  // The sign is the amount's, in its font: « +$84.00 », « −$12.50 ».
  const amount = `${compare.delta < 0 ? '−' : '+'}${money(Math.abs(compare.delta))}`;
  const text = t('dash.delta', { amount });
  const then = money(compare.lastMonth);
  return (
    <p className={`mt-2 text-[0.8125rem] ${compare.delta > 0 ? 'text-accent' : 'text-subtle'}`}>
      <LabelTip
        tip={
          // On the 1st, one day against one day.
          compare.from === compare.to
            ? t('dash.delta.infoDay', { day: calendarDay(compare.from), amount: then })
            : t('dash.delta.info', {
                from: calendarDay(compare.from),
                to: calendarDay(compare.to),
                amount: then,
              })
        }
      >
        <Figures text={text} figures={[amount]} />
      </LabelTip>
    </p>
  );
}

/**
 * Under the balance, with no box (fix prompt v4.1, block 2): what the period saved, added up day
 * by day from $0.00 so it only climbs, a hairline where the current month starts (what the line
 * climbs after it is the amount above) and, dashed, what the members at risk paid a month; over
 * 7, 30 or 90 days, the curve turning into the next period. The days are the community's (its
 * time zone's), written the same whatever the reader's time zone.
 */
function SavedChart({
  view,
  period,
  money,
}: {
  view: DashboardView | null;
  period: Period;
  money: (value: number) => string;
}) {
  const { t, calendarDate, calendarDay, calendarMonth } = useI18n();
  const days = Number(period);
  const data = useMemo(
    () =>
      view
        ? balanceWindow(
            view.revenueHistory,
            days,
            view.currency ? view.saved.thisMonth.direct : undefined,
          )
        : null,
    [view, days],
  );
  if (!view || !data) return <Skeleton className="h-[220px] w-full" />;
  if (view.revenueHistory.every((d) => d.atRisk === null && d.saved === 0)) {
    return <EmptyState inset body={t('dash.chart.empty')} />;
  }
  const shown = data.days;
  const risks = shown.map((d) => d.atRisk);
  const first = risks.find((value) => value !== null) ?? null;
  const last = risks.at(-1) ?? null;
  const total = money(savedOver(view.revenueHistory, days));
  const summary =
    first !== null && last !== null
      ? t('dash.chart.summary', { days: period, saved: total, from: money(first), to: money(last) })
      : t('dash.chart.summaryNoRisk', { days: period, saved: total });
  const thisMonth = shown.at(-1)?.day.slice(0, 7);
  return (
    <BalanceChart
      label={t('dash.chart.title')}
      summary={summary}
      period={period}
      points={shown.map((d) => ({ label: calendarDate(d.day), tick: calendarDay(d.day) }))}
      saved={{
        label: t('dash.chart.saved'),
        values: shown.map((d) => d.inPeriod),
        info: t('dash.chart.info'),
      }}
      month={{
        label: t('dash.chart.monthToDate'),
        labels: shown.map((d) =>
          d.day.startsWith(thisMonth ?? '-')
            ? t('dash.chart.savedThisMonth')
            : t('dash.chart.savedIn', { month: calendarMonth(d.day) }),
        ),
        values: shown.map((d) => d.inMonth),
      }}
      marker={
        data.monthStart === null
          ? null
          : { index: data.monthStart, label: calendarDay(shown[data.monthStart]!.day) }
      }
      atRisk={{ label: t('dash.chart.atRisk'), values: risks, before: data.atRiskBefore }}
      format={money}
    />
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
  let figure = '';
  let button: ReactNode = null;
  let aside: ReactNode = null;
  if (priority === null) {
    sentence = t('dash.priority.none.title');
  } else {
    const amount = money(priority.revenue);
    figure = amount;
    switch (priority.kind) {
      case 'approve':
        sentence = plural('dash.priority.approve.sentence', priority.actions, { amount });
        aside = (
          <Link to={`${root}/actions/queue`} className={SECTION_LINK_CLASS}>
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
      data-tour="priority-action"
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
          <span>
            <Figures text={sentence} figures={[figure]} />
          </span>
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
  /** Since when their payment is unpaid (ms): the renewal that failed. */
  unpaid: number | null;
}

/**
 * The members who need attention, the most urgent first (brief v4 §13), in this order: leaving
 * within 7 days, then a payment failed and not recovered, then the highest risk score, then what
 * they pay a month, the soonest end last. A member at 100 leaving in six days always comes
 * before a failed payment at 79. Before the first scores, Whop's facts (a cancellation
 * scheduled, a payment failed).
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
        leavingThisWeek: leaving && end !== null && end - now <= FIRST_MS,
        paymentFailed,
        end,
        unpaid: unpaidSince(member),
        monthly: monthlyOf(member.membership) ?? 0,
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
        Number(b.leavingThisWeek) - Number(a.leavingThisWeek) ||
        Number(b.paymentFailed) - Number(a.paymentFailed) ||
        (b.member.risk?.score ?? 0) - (a.member.risk?.score ?? 0) ||
        b.monthly - a.monthly ||
        (a.end ?? Infinity) - (b.end ?? Infinity),
    )
    .map(({ leavingThisWeek: _week, monthly: _monthly, ...urgency }) => urgency);
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
    <section aria-labelledby={titleId} data-tour="attention">
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
            {/* The first rows come in with the page; one that shows up later comes in with a
                turquoise edge (600 ms); one that goes fades out, then the others close up (250 ms
                each, MOTION.md). Never « popLayout »: it injects a style the CSP refuses. */}
            <AnimatePresence initial={false}>
              {shown.map((item, index) => (
                <motion.li
                  key={item.member.id}
                  layout
                  variants={itemVariants}
                  exit={{ opacity: 0, transition: ease('collapse') }}
                  transition={{ layout: ease('collapse') }}
                  className="relative"
                >
                  {firstIds !== null && !firstIds.has(item.member.id) ? (
                    <motion.span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-2 -start-3 w-0.5 rounded-full bg-turq-300"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 1, 0] }}
                      transition={ease('flash')}
                    />
                  ) : null}
                  <AttentionRow
                    item={item}
                    api={api}
                    root={root}
                    testMode={testMode}
                    onDone={onDone}
                    delay={0.15 + index * STAGGER}
                    first={index === 0}
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
  root,
  testMode,
  onDone,
  delay,
  first,
}: {
  item: Urgency;
  api: string;
  /** The dashboard's root: the row opens the member's drawer in Members. */
  root: string;
  testMode: boolean;
  onDone: () => void;
  delay: number;
  /** The list's first row: the guide lights up it and its ring. */
  first: boolean;
}) {
  const i18n = useI18n();
  const { t, day, currency, number } = i18n;
  const { member, leavingSoon, leaving, paymentFailed, end, unpaid } = item;
  // A date of another year keeps its year (an annual plan's end).
  const today = new Date();
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
      href={`${root}/members?member=${encodeURIComponent(member.id)}`}
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
        // When they leave; else, for a payment that failed, since when it is unpaid, never a
        // renewal still to come; else the next renewal.
        leaving && end !== null
          ? t('risk.reason.cancel_scheduled', { date: day(new Date(end), today) })
          : unpaid !== null
            ? t('members.unpaidSince', { date: day(new Date(unpaid), today) })
            : end === null
              ? null
              : t('dash.row.renews', { date: day(new Date(end), today) })
      }
      whenUrgent={leavingSoon}
      paid={
        monthly !== null && membership?.currency
          ? t('dash.row.perMonth', {
              amount: currency(monthly, membership.currency.toUpperCase()),
            })
          : null
      }
      actions={
        <MemberActions member={member} api={api} testMode={testMode} compact onDone={onDone} />
      }
      delay={delay}
      rowTour={first ? 'attention-row' : undefined}
      ringTour={first ? 'risk-ring' : undefined}
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
  const money = useMoney(view?.currency ?? null);
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
            <dt className="text-[0.8125rem] text-subtle">
              {stat.key === 'saved' && view.currency ? (
                // What those members' plans paid in 30 days: the chart's 30-day total (§13).
                <LabelTip
                  tip={t('dash.strip.savedInfo', {
                    amount: money(savedOver(view.revenueHistory, 30)),
                  })}
                >
                  {stat.label}
                </LabelTip>
              ) : (
                stat.label
              )}
            </dt>
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
