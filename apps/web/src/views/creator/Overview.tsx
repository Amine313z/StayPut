import type {
  CreatorMessagesResult,
  DashboardView,
  GettingStarted,
  MemberRow,
  MembersPage,
  RevenueDay,
} from '@stayput/core';
import {
  ArrowRight,
  CheckCheck,
  CircleCheck,
  FlaskConical,
  LoaderCircle,
  MessageSquareText,
  PauseCircle,
  PiggyBank,
  RotateCw,
  Send,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { postJson, useApi, useReloadOnChange, type Loadable } from '../../api';
import { MemberActions, failureText } from '../../components/MemberActions';
import { attentionReasons } from '../../components/MemberRows';
import { LEVELS, UrgentDot } from '../../components/Risk';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { ease } from '../../motion';
import { reasonText } from '../../risk-text';
import { ActionButton } from '../../ui/ActionButton';
import { Avatar } from '../../ui/Avatar';
import { SECTION_LINK_CLASS } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ChecklistCard } from '../../ui/ChecklistCard';
import { EmptyState } from '../../ui/EmptyState';
import { InfoTip } from '../../ui/InfoTip';
import { MetricCard } from '../../ui/MetricCard';
import { AnimatedNumber, Stagger, StaggerItem } from '../../ui/Motion';
import { RiskRing } from '../../ui/RiskRing';
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
 * The home of the dashboard (the redesign, brief §6.2), one question: « Am I losing money, and
 * what do I do today? ». Five things only: the money (saved, at risk, members at risk), the one
 * action of the day, saved against at risk over time, the five members who need attention most,
 * and what StayPut did in 30 days. Until the setup is done, « Getting started » sits on top.
 */
export function Overview() {
  const { api, root, members, sync } = useCreatorData();
  const dashboard = useApi<DashboardView>(`${api}/dashboard`);
  // New data from Whop: the figures again.
  useReloadOnChange(sync.status?.lastSyncAt, dashboard.reload);
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  const testMode = view?.testMode ?? false;
  const importing = sync.status !== null && !sync.status.backfillDone;

  return (
    <div className="space-y-6">
      {testMode ? <TestModeBar root={root} /> : null}
      {importing ? <ImportingBar /> : null}
      {dashboard.state.status === 'error' ? (
        <ErrorPanel
          error={dashboard.state.error}
          forbiddenKey="error.forbidden.creator"
          onRetry={dashboard.retry}
        />
      ) : (
        <>
          {view && !setupDone(view.gettingStarted) ? (
            <Setup steps={view.gettingStarted} root={root} />
          ) : null}
          <HeroRow view={view} />
          <Priority view={view} api={api} root={root} onDone={dashboard.reload} />
          <RevenueChart view={view} />
        </>
      )}
      <NeedsAttention
        state={members.state}
        retry={members.retry}
        api={api}
        root={root}
        testMode={testMode}
        onDone={dashboard.reload}
      />
      {view ? <ActionsStrip view={view} /> : <Skeleton className="h-24 w-full rounded-xl" />}
    </div>
  );
}

/**
 * Test mode: everything computed, nothing sent. A thin mint-outlined line with muted words (the
 * brief: never an amber fill), and where to change it.
 */
function TestModeBar({ root }: { root: string }) {
  const { t } = useI18n();
  return (
    <p className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-line-strong px-4 py-1.5 text-sm">
      <span className="inline-flex items-center gap-2">
        <FlaskConical aria-hidden="true" className="size-4 shrink-0 text-subtle" />
        {t('dash.testMode')}
      </span>
      <Link to={`${root}/settings/actions`} className={SECTION_LINK_CLASS}>
        {t('dash.testMode.settings')}
      </Link>
    </p>
  );
}

/** While the history comes from Whop, the figures fill in: said in the same thin line. */
function ImportingBar() {
  const { t } = useI18n();
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm"
    >
      <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-subtle" />
      {t('sync.importing')}
    </p>
  );
}

function setupDone(steps: GettingStarted): boolean {
  return steps.discord && steps.automation && steps.reviewed && steps.guardrails;
}

/** « Getting started » (brief §7): four steps, each leading to its screen, until all are done. */
function Setup({ steps, root }: { steps: GettingStarted; root: string }) {
  const { t } = useI18n();
  return (
    <ChecklistCard
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

/** An amount of the dashboard, whole, in the community's currency (a count without one). */
function useMoney(currency: string | null): (value: number) => string {
  const i18n = useI18n();
  return (value) =>
    currency ? i18n.currency(value, currency, { whole: true }) : i18n.number(Math.round(value));
}

/** The lines of an « i », one under the other. */
function Lines({ lines }: { lines: readonly (string | null)[] }) {
  return (
    <>
      {lines
        .filter((line): line is string => line !== null)
        .map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
    </>
  );
}

/**
 * The money first (brief §6.2): the revenue saved this month, the largest, in the logo's
 * gradient with its soft glow; the revenue at risk, in silver (never red); the members at risk.
 * Each counts to its value and says what it means behind its « i ».
 */
function HeroRow({ view }: { view: DashboardView | null }) {
  const { t, plural, number } = useI18n();
  const titleId = useId();
  const money = useMoney(view?.currency ?? null);
  const grid = 'grid grid-cols-1 gap-6 @lg:grid-cols-2 @4xl:grid-cols-[1.4fr_1fr_1fr]';
  if (!view) {
    return (
      <div className={grid} aria-hidden="true">
        <MetricSkeleton hero />
        <MetricSkeleton hero />
        <MetricSkeleton hero />
      </div>
    );
  }
  const saved = view.saved;
  const atRisk = view.atRisk;
  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        {t('dash.money')}
      </h2>
      <Stagger as="dl" className={grid}>
        <StaggerItem className="@lg:col-span-2 @4xl:col-span-1">
          <MetricCard
            hero
            lead
            glow
            better="up"
            label={t('dash.saved')}
            value={view.currency ? saved.thisMonth.direct : null}
            format={money}
            empty={t('dash.noRevenue')}
            info={
              <Lines
                lines={[
                  t('dash.saved.info'),
                  saved.thisMonth.saves > 0
                    ? plural('dash.saved.kept', saved.thisMonth.saves)
                    : t('dash.saved.empty'),
                  saved.thisMonth.influenced > 0
                    ? t('dash.saved.influenced', { amount: money(saved.thisMonth.influenced) })
                    : null,
                  saved.lastMonth.direct > 0
                    ? t('dash.saved.lastMonth', { amount: money(saved.lastMonth.direct) })
                    : null,
                  saved.otherCurrencies && view.currency
                    ? t('dash.currencyOnly', { currency: view.currency })
                    : null,
                ]}
              />
            }
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            hero
            better="down"
            label={t('dash.atRisk')}
            value={view.currency ? atRisk.revenue : null}
            format={money}
            empty={t('dash.noRevenue')}
            info={
              view.monthlyRevenue === null
                ? null
                : t('dash.atRisk.info', { total: money(view.monthlyRevenue) })
            }
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            hero
            better="down"
            label={t('dash.membersAtRisk')}
            value={atRisk.members}
            format={(value) => number(Math.round(value))}
            info={t('dash.membersAtRisk.info', {
              departures: number(atRisk.departures),
              high: number(atRisk.high),
            })}
          />
        </StaggerItem>
      </Stagger>
    </section>
  );
}

/**
 * The one action of the day (brief §6.2): one sentence, the revenue it touches (what those
 * members pay, never a promise), and the page's only primary button. How it works is behind
 * the « i ».
 */
function Priority({
  view,
  api,
  root,
  onDone,
}: {
  view: DashboardView | null;
  api: string;
  root: string;
  onDone: () => void;
}) {
  const { t, plural } = useI18n();
  const toast = useToast();
  const titleId = useId();
  const money = useMoney(view?.currency ?? null);
  if (!view) return <Skeleton className="h-28 w-full rounded-xl" />;
  const priority = view.priority;
  const done = (title: string) =>
    toast({
      title,
      body: t(view.testMode ? 'dash.toast.simulated' : 'dash.toast.messaged.body'),
    });
  // A new action of the day is a new card (its button starts fresh), fading in.
  const identity =
    priority === null
      ? 'none'
      : priority.kind === 'message'
        ? `message:${priority.memberIds.join(',')}`
        : `approve:${priority.actions}`;
  return (
    <motion.section
      key={identity}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={ease('standard')}
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface/60 p-5 @3xl:flex-row @3xl:items-center @3xl:justify-between"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5">
          <span className="label-caps">{t('dash.priority')}</span>
          <InfoTip>
            {priority === null ? (
              t('dash.priority.none.body')
            ) : (
              <Lines
                lines={[
                  priority.kind === 'message'
                    ? t('dash.priority.message.body')
                    : plural('dash.priority.approve.body', priority.members),
                  t('dash.priority.stakeHint'),
                ]}
              />
            )}
          </InfoTip>
        </p>
        <h2 id={titleId} className="mt-2 flex items-start gap-2 text-sm font-medium text-fg">
          {priority === null ? (
            <>
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
              {t('dash.priority.none.title')}
            </>
          ) : priority.kind === 'message' ? (
            plural('dash.priority.message.title', priority.memberIds.length)
          ) : (
            plural('dash.priority.approve.title', priority.actions)
          )}
        </h2>
      </div>
      {priority === null ? null : (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 @3xl:shrink-0">
          <p className="text-sm">
            {t('dash.priority.stake')}{' '}
            <span className="tabular font-semibold text-fg">
              {t('dash.priority.perMonth', { amount: money(priority.revenue) })}
            </span>
          </p>
          {priority.kind === 'approve' ? (
            <Link to={`${root}/actions`} className={SECTION_LINK_CLASS}>
              {t('dash.priority.review')}
            </Link>
          ) : null}
          <ActionButton
            stayDone
            run={async () => {
              if (priority.kind === 'message') {
                const result = await postJson<CreatorMessagesResult>(`${api}/members/message`, {
                  memberIds: priority.memberIds,
                });
                if (result.queued > 0) done(plural('dash.toast.messaged', result.queued));
                else toast({ title: t('dash.toast.nothingNew') });
              } else {
                const result = await postJson<{ approved: number }>(`${api}/actions/approve`);
                done(plural('dash.toast.approved', result.approved));
              }
              onDone();
            }}
            onError={(error) => toast({ tone: 'error', title: failureText(error, t) })}
            icon={
              priority.kind === 'message' ? (
                <Send aria-hidden="true" className="size-4" />
              ) : (
                <CheckCheck aria-hidden="true" className="size-4" />
              )
            }
          >
            {priority.kind === 'message'
              ? plural('dash.priority.message.button', priority.memberIds.length)
              : plural('dash.priority.approve.button', priority.actions)}
          </ActionButton>
        </div>
      )}
    </motion.section>
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
 * Saved against at risk (brief §6.2): what StayPut saved, added up over the period (the mint
 * area), and what the members at risk paid each month, day by day (the dashed silver line);
 * over 7, 30 or 90 days, each period drawing in.
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
  const toggle = (
    <Segmented
      label={t('dash.chart.period')}
      value={period}
      onChange={setPeriod}
      options={PERIODS.map((value) => ({
        value,
        label: plural('dash.chart.days', Number(value)),
      }))}
    />
  );
  if (!view || !data) {
    return (
      <Card title={title} info={t('dash.chart.info')} actions={toggle}>
        <Skeleton className="h-64 w-full" />
      </Card>
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
    <Card title={title} info={t('dash.chart.info')} actions={toggle}>
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
    </Card>
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
 * « Needs attention » (brief §6.2): the five most urgent members, each with their risk ring, the
 * main reason, when they leave, and Message / Pause / Offer on the spot; the others in Members.
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
  // The moment the page opened: the order does not shift while the creator reads it.
  const [now] = useState(() => Date.now());
  const flagged = useMemo(
    () => (state.status === 'ready' ? mostUrgent(state.data.members, now) : []),
    [state, now],
  );
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return (
    <Card
      title={t('attention.title')}
      actions={
        flagged.length > 0 ? (
          <Link to={`${root}/members`} className={SECTION_LINK_CLASS}>
            {t('attention.seeAll', { count: flagged.length })}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        ) : null
      }
    >
      {state.status === 'loading' ? (
        <RowsSkeleton rows={5} />
      ) : flagged.length === 0 ? (
        <EmptyState inset body={t('attention.none')} />
      ) : (
        <Stagger as="ul" className="@container/list divide-y divide-line">
          {flagged.slice(0, ATTENTION_LIMIT).map((item) => (
            <StaggerItem as="li" key={item.member.id} className="py-3 first:pt-0 last:pb-0">
              <AttentionRow item={item} api={api} testMode={testMode} onDone={onDone} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </Card>
  );
}

/** A member who needs attention, on two lines at most. */
function AttentionRow({
  item,
  api,
  testMode,
  onDone,
}: {
  item: Urgency;
  api: string;
  testMode: boolean;
  onDone: () => void;
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
  const paid =
    monthly !== null && membership?.currency
      ? t('dash.row.perMonth', {
          amount: currency(monthly, membership.currency.toUpperCase(), { whole: true }),
        })
      : null;
  const when =
    end === null
      ? null
      : t(leaving ? 'risk.reason.cancel_scheduled' : 'dash.row.renews', {
          date: day(new Date(end)),
        });
  const risk = member.risk;
  return (
    <div className="flex flex-col gap-2 @2xl/list:flex-row @2xl/list:items-center @2xl/list:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={member.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-fg">{member.name ?? t('members.unnamed')}</p>
          {reason ? (
            <p className="flex items-center gap-1.5 text-xs">
              {paymentFailed ? <Urgent /> : null}
              <span className="truncate">{reason}</span>
            </p>
          ) : null}
        </div>
        {risk ? (
          <RiskRing
            score={risk.score}
            size={36}
            label={
              risk.level === 'scheduled_departure'
                ? t(LEVELS[risk.level].label)
                : t('risk.badge', { level: t(LEVELS[risk.level].label), score: number(risk.score) })
            }
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ps-12 @2xl/list:ps-0">
        <div className="tabular text-xs @2xl/list:w-44">
          {when ? (
            <p className="flex items-center gap-1.5">
              {leavingSoon ? <Urgent /> : null}
              {when}
            </p>
          ) : null}
          {paid ? <p className="text-subtle">{paid}</p> : null}
        </div>
        <MemberActions member={member} api={api} testMode={testMode} onDone={onDone} />
      </div>
    </div>
  );
}

/** The red dot of what is urgent, said to screen readers too. */
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
 * What StayPut did in 30 days (brief §6.2), in one compact strip: messages sent, payments
 * retried, pauses offered, members saved. « Actions » only ever means what StayPut did.
 */
function ActionsStrip({ view }: { view: DashboardView }) {
  const { t, plural, number } = useI18n();
  const titleId = useId();
  const done = view.stayputActions30d;
  const stats: { key: string; value: number; label: string; icon: ReactNode }[] = [
    {
      key: 'messages',
      value: done.messages,
      label: plural('dash.strip.messages', done.messages),
      icon: <MessageSquareText aria-hidden="true" className="size-4" />,
    },
    {
      key: 'retries',
      value: done.paymentRetries,
      label: plural('dash.strip.retries', done.paymentRetries),
      icon: <RotateCw aria-hidden="true" className="size-4" />,
    },
    {
      key: 'pauses',
      value: done.pauses,
      label: plural('dash.strip.pauses', done.pauses),
      icon: <PauseCircle aria-hidden="true" className="size-4" />,
    },
    {
      key: 'saved',
      value: done.saved,
      label: plural('dash.strip.saved', done.saved),
      icon: <PiggyBank aria-hidden="true" className="size-4" />,
    },
  ];
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface/60 p-5 @4xl:flex-row @4xl:items-center"
    >
      <h2 id={titleId} className="label-caps whitespace-nowrap @4xl:shrink-0">
        {t('dash.stayputActions')}
      </h2>
      <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 @3xl:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.key} className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
              {stat.icon}
            </span>
            <div className="flex min-w-0 flex-col-reverse">
              <dt className="truncate text-xs">{stat.label}</dt>
              <dd className="metric text-xl text-fg">
                <AnimatedNumber
                  value={stat.value}
                  format={(value) => number(Math.round(value))}
                  better="up"
                />
              </dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}
