import type {
  CreatorMessagesResult,
  DashboardView,
  FeedItem,
  FeedView,
  IntegrationsStatus,
  MemberRow,
  MembersPage,
  RiskDay,
  RiskSummary,
} from '@stayput/core';
import type { Translator } from '@stayput/i18n';
import {
  Activity,
  ArrowRight,
  BookOpen,
  CalendarClock,
  CalendarX,
  CheckCheck,
  CircleCheck,
  CreditCard,
  FlaskConical,
  Gauge,
  Gift,
  HeartHandshake,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  PiggyBank,
  Plug,
  RotateCw,
  Send,
  Sprout,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Trophy,
  UserPlus,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import { postJson, useApi, usePolling, useReloadOnChange, type Loadable } from '../../api';
import { MemberActions, failureText } from '../../components/MemberActions';
import { attentionReasons } from '../../components/MemberRows';
import { LEVELS, LEVEL_FILTERS, LEVEL_ORDER, RiskBadge } from '../../components/Risk';
import { SyncPanel } from '../../components/SyncPanel';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { EASE, ease, feedItemVariants } from '../../motion';
import { reasonText } from '../../risk-text';
import { ActionButton } from '../../ui/ActionButton';
import { Avatar } from '../../ui/Avatar';
import { Badge, Notice } from '../../ui/Badge';
import { DiscordIcon, StayPutMark, TelegramIcon } from '../../ui/BrandIcons';
import { SECTION_LINK_CLASS } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { MetricCard } from '../../ui/MetricCard';
import { Stagger, StaggerItem } from '../../ui/Motion';
import { MetricSkeleton, RowsSkeleton, Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { Sparkline } from '../../ui/charts/Sparkline';
import { StackedBar, type BarPart } from '../../ui/charts/StackedBar';
import { useCreatorData } from '../CreatorView';

/** Members listed at most in « Needs attention », and in the activation radar. */
const ATTENTION_LIMIT = 6;
const NEWCOMERS_LIMIT = 4;

/** How often the live activity is read again while the page is open. */
export const FEED_REFRESH_MS = 30_000;

/**
 * The home of the dashboard (the redesign, SPEC Phase 6.2): in five seconds, how much money is
 * at stake and how much StayPut saved; then the one thing to do today, who needs attention (with
 * the means to act on the spot), what just happened, how the risk evolves, and the community's
 * figures. Every screen answers: what is at risk, what StayPut did, what to do next.
 */
export function Overview() {
  const { api, root, members, sync, integrations } = useCreatorData();
  const dashboard = useApi<DashboardView>(`${api}/dashboard`);
  const feed = useApi<FeedView>(`${api}/feed`);
  usePolling(feed.reload, FEED_REFRESH_MS);
  const refresh = () => {
    dashboard.reload();
    feed.reload();
  };
  // New data from Whop: the figures and the feed again.
  useReloadOnChange(sync.status?.lastSyncAt, refresh);
  const view = dashboard.state.status === 'ready' ? dashboard.state.data : null;
  const page = members.state.status === 'ready' ? members.state.data : null;
  const testMode = view?.testMode ?? false;

  return (
    <div className="space-y-6">
      {testMode ? <TestModeNotice root={root} /> : null}
      {dashboard.state.status === 'error' ? (
        <ErrorPanel
          error={dashboard.state.error}
          forbiddenKey="error.forbidden.creator"
          onRetry={dashboard.retry}
        />
      ) : (
        <>
          <Money view={view} />
          <Priority view={view} api={api} root={root} onDone={refresh} />
        </>
      )}
      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,8fr)_minmax(0,5fr)]">
        <div className="min-w-0">
          <MembersOr state={members.state} retry={members.retry} kind="attention">
            {(data) => (
              <Attention
                members={data.members}
                api={api}
                testMode={testMode}
                limit={ATTENTION_LIMIT}
                seeAll={`${root}/attention`}
                onDone={refresh}
              />
            )}
          </MembersOr>
        </div>
        <div className="min-w-0">
          <Feed state={feed.state} retry={feed.retry} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,7fr)_minmax(0,6fr)]">
        <RiskPanel
          summary={page?.summary.risk ?? null}
          history={view?.riskHistory ?? null}
          root={root}
        />
        <Community view={view} />
      </div>
      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,7fr)_minmax(0,6fr)]">
        <div className="min-w-0">
          <MembersOr state={members.state} retry={members.retry} kind="newcomers">
            {(data) => (
              <Newcomers
                members={data.members}
                api={api}
                testMode={testMode}
                limit={NEWCOMERS_LIMIT}
                seeAll={`${root}/new-members`}
                onDone={refresh}
              />
            )}
          </MembersOr>
        </div>
        <div className="min-w-0 space-y-6">
          <SyncPanel sync={sync} />
          <SourcesSummary
            status={integrations.state.status === 'ready' ? integrations.state.data : null}
            root={root}
          />
        </div>
      </div>
    </div>
  );
}

/** Dashboard › Needs attention: every member at risk of leaving soon, with the means to act. */
export function AttentionTab() {
  const { api, members } = useCreatorData();
  const dashboard = useApi<DashboardView>(`${api}/dashboard`);
  const testMode = dashboard.state.status === 'ready' && dashboard.state.data.testMode;
  return (
    <MembersOr state={members.state} retry={members.retry} kind="attention">
      {(page) => (
        <Attention members={page.members} api={api} testMode={testMode} onDone={dashboard.reload} />
      )}
    </MembersOr>
  );
}

/** Dashboard › New members: every newcomer who has not started (the activation radar). */
export function NewMembersTab() {
  const { api, members } = useCreatorData();
  const dashboard = useApi<DashboardView>(`${api}/dashboard`);
  const testMode = dashboard.state.status === 'ready' && dashboard.state.data.testMode;
  return (
    <MembersOr state={members.state} retry={members.retry} kind="newcomers">
      {(page) => (
        <Newcomers members={page.members} api={api} testMode={testMode} onDone={dashboard.reload} />
      )}
    </MembersOr>
  );
}

/** The members once read; meanwhile, the list's own shape, or what went wrong. */
function MembersOr({
  state,
  retry,
  kind,
  children,
}: {
  state: Loadable<MembersPage>;
  retry: () => void;
  kind: 'attention' | 'newcomers';
  children: (page: MembersPage) => ReactNode;
}) {
  const { t } = useI18n();
  if (state.status === 'loading') {
    return (
      <Card
        icon={
          kind === 'attention' ? (
            <TriangleAlert aria-hidden="true" className="size-4" />
          ) : (
            <Sprout aria-hidden="true" className="size-4" />
          )
        }
        title={t(kind === 'attention' ? 'attention.title' : 'newcomers.title')}
      >
        <RowsSkeleton rows={4} />
      </Card>
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <>{children(state.data)}</>;
}

/** Test mode: everything computed, nothing sent; said at the top, with where to change it. */
function TestModeNotice({ root }: { root: string }) {
  const { t } = useI18n();
  return (
    <Notice tone="warning" icon={<FlaskConical aria-hidden="true" className="size-4" />}>
      <span>{t('dash.testMode')}</span>{' '}
      <Link
        to={`${root}/settings/actions`}
        className="font-medium underline underline-offset-2 hover:no-underline"
      >
        {t('dash.testMode.settings')}
      </Link>
    </Notice>
  );
}

/** An amount of the dashboard, whole, in the community's currency (a count without one). */
function useMoney(currency: string | null): (value: number) => string {
  const i18n = useI18n();
  return (value) =>
    currency ? i18n.currency(value, currency, { whole: true }) : i18n.number(Math.round(value));
}

/**
 * The money first (required fix 1): the revenue saved this month, the largest, with the brand's
 * glow; the revenue at risk; the members at risk; the retention. Each figure counts to its value
 * and flashes when it changes (MOTION.md).
 */
function Money({ view }: { view: DashboardView | null }) {
  const { t, plural, number, percent } = useI18n();
  const titleId = useId();
  const money = useMoney(view?.currency ?? null);
  const grid = 'grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-[1.35fr_1fr_1fr_1fr]';
  if (!view) {
    return (
      <div className={grid} aria-hidden="true">
        <MetricSkeleton hero />
        <MetricSkeleton hero />
        <MetricSkeleton hero />
        <MetricSkeleton hero />
      </div>
    );
  }
  const saved = view.saved;
  const savedLines = [
    saved.thisMonth.saves > 0
      ? [
          plural('dash.saved.kept', saved.thisMonth.saves),
          saved.thisMonth.influenced > 0
            ? t('dash.saved.influenced', { amount: money(saved.thisMonth.influenced) })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : t('dash.saved.empty'),
    saved.lastMonth.direct > 0
      ? t('dash.saved.lastMonth', { amount: money(saved.lastMonth.direct) })
      : null,
    saved.otherCurrencies && view.currency
      ? t('dash.currencyOnly', { currency: view.currency })
      : null,
  ].filter((line): line is string => line !== null);
  const atRisk = view.atRisk;
  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        {t('dash.money')}
      </h2>
      <Stagger as="dl" className={grid}>
        <StaggerItem>
          <MetricCard
            hero
            lead
            glow
            tone="saved"
            better="up"
            label={t('dash.saved')}
            value={view.currency ? saved.thisMonth.direct : null}
            format={money}
            icon={<PiggyBank aria-hidden="true" className="size-4" />}
            empty={t('dash.noRevenue')}
            hint={savedLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            hero
            tone={atRisk.revenue > 0 ? 'danger' : 'neutral'}
            better="down"
            label={t('dash.atRisk')}
            value={view.currency ? atRisk.revenue : null}
            format={money}
            icon={<Wallet aria-hidden="true" className="size-4" />}
            empty={t('dash.noRevenue')}
            hint={
              view.monthlyRevenue === null
                ? null
                : t('dash.atRisk.hint', { total: money(view.monthlyRevenue) })
            }
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            hero
            tone={atRisk.members > 0 ? 'danger' : 'neutral'}
            better="down"
            label={t('dash.membersAtRisk')}
            value={atRisk.members}
            format={(value) => number(Math.round(value))}
            icon={<TriangleAlert aria-hidden="true" className="size-4" />}
            hint={t('dash.membersAtRisk.hint', {
              departures: number(atRisk.departures),
              high: number(atRisk.high),
            })}
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            hero
            better="up"
            label={t('dash.retention')}
            value={view.retention30.rate}
            format={(value) => percent(value)}
            icon={<HeartHandshake aria-hidden="true" className="size-4" />}
            empty={t('dash.retention.empty')}
            hint={t('dash.retention.hint', {
              kept: number(view.retention30.kept),
              base: number(view.retention30.base),
            })}
          />
        </StaggerItem>
      </Stagger>
    </section>
  );
}

/**
 * The one action of the day (required fix 2): what it is, the revenue at stake (what those
 * members pay, never a promise), and one button that does it.
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
  if (!view) return <Skeleton className="h-36 w-full rounded-2xl" />;
  const priority = view.priority;
  const done = (title: string) =>
    toast({
      title,
      body: t(view.testMode ? 'dash.toast.simulated' : 'dash.toast.messaged.body'),
    });
  return (
    <AnimatePresence mode="wait" initial={false}>
      {priority === null ? (
        <motion.section
          key="none"
          aria-labelledby={titleId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: ease('standard') }}
          exit={{ opacity: 0, transition: ease('micro') }}
          className="flex items-start gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <CircleCheck aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="label-caps">{t('dash.priority')}</p>
            <h2 id={titleId} className="mt-1 text-lg font-semibold">
              {t('dash.priority.none.title')}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{t('dash.priority.none.body')}</p>
          </div>
        </motion.section>
      ) : (
        <motion.section
          key={priority.kind}
          aria-labelledby={titleId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: ease('standard') }}
          exit={{ opacity: 0, transition: ease('micro') }}
          className="relative overflow-hidden rounded-2xl border border-line-strong bg-surface p-5 shadow-card sm:p-6"
        >
          <div aria-hidden="true" className="priority-light pointer-events-none absolute inset-0" />
          <div className="relative flex flex-col gap-5 @3xl:flex-row @3xl:items-center @3xl:justify-between">
            <div className="max-w-2xl min-w-0">
              <p className="label-caps flex items-center gap-1.5">
                <Zap aria-hidden="true" className="size-3.5 text-accent" />
                {t('dash.priority')}
              </p>
              <h2 id={titleId} className="mt-2 text-xl font-semibold tracking-tight">
                {priority.kind === 'message'
                  ? plural('dash.priority.message.title', priority.memberIds.length)
                  : plural('dash.priority.approve.title', priority.actions)}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {priority.kind === 'message'
                  ? t('dash.priority.message.body')
                  : plural('dash.priority.approve.body', priority.members)}
              </p>
              {view.testMode ? (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-warning">
                  <FlaskConical aria-hidden="true" className="size-4" />
                  {t('dash.priority.testMode')}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4 @3xl:shrink-0 @3xl:flex-nowrap">
              <div className="max-w-56">
                <p className="label-caps">{t('dash.priority.stake')}</p>
                <p className="metric mt-1 text-2xl text-danger">
                  {t('dash.priority.perMonth', { amount: money(priority.revenue) })}
                </p>
                <p className="mt-0.5 text-xs text-subtle">{t('dash.priority.stakeHint')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  stayDone
                  run={async () => {
                    if (priority.kind === 'message') {
                      const result = await postJson<CreatorMessagesResult>(
                        `${api}/members/message`,
                        { memberIds: priority.memberIds },
                      );
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
                {priority.kind === 'approve' ? (
                  <Link to={`${root}/actions`} className={SECTION_LINK_CLASS}>
                    {t('dash.priority.review')}
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
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

/**
 * The members most likely to leave, the highest score first (the members arrive sorted): the
 * departures scheduled and the high risks, each with the main reason, when they renew or leave,
 * what they pay, and Message / Pause / Offer on the spot. Before the first scores, Whop's facts.
 */
function Attention({
  members,
  api,
  testMode,
  limit,
  seeAll,
  onDone,
}: {
  members: readonly MemberRow[];
  api: string;
  testMode: boolean;
  /** Only the first ones, with a link to all of them (the home). */
  limit?: number;
  seeAll?: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const scored = members.some((m) => m.risk !== null);
  const flagged = scored
    ? members.filter((m) => m.risk?.level === 'scheduled_departure' || m.risk?.level === 'high')
    : members.filter((m) => attentionReasons(m).length > 0);
  return (
    <Card
      icon={<TriangleAlert aria-hidden="true" className="size-4" />}
      title={t('attention.title')}
      description={t('attention.description')}
      actions={
        seeAll && flagged.length > 0 ? (
          <Link to={seeAll} className={SECTION_LINK_CLASS}>
            {t('attention.seeAll', { count: flagged.length })}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        ) : null
      }
    >
      {flagged.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleCheck aria-hidden="true" className="size-4 text-accent" />
          {t('attention.none')}
        </p>
      ) : (
        <Stagger as="ul" className="@container/list divide-y divide-line">
          {flagged.slice(0, limit).map((member) => (
            <StaggerItem as="li" key={member.id} className="py-3.5 first:pt-0 last:pb-0">
              <AttentionRow member={member} api={api} testMode={testMode} onDone={onDone} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </Card>
  );
}

function AttentionRow({
  member,
  api,
  testMode,
  onDone,
}: {
  member: MemberRow;
  api: string;
  testMode: boolean;
  onDone: () => void;
}) {
  const i18n = useI18n();
  const { t, date, currency } = i18n;
  const reasons = member.risk?.reasons ?? [];
  const main = reasons.find((reason) => reason.code !== 'cancel_scheduled');
  const mainText = main ? reasonText(main, i18n) : null;
  const membership = member.membership;
  const leaving =
    membership !== null && (membership.cancelAtPeriodEnd || membership.status === 'canceling');
  const end = membership?.currentPeriodEnd ? date(new Date(membership.currentPeriodEnd)) : null;
  const monthly = monthlyOf(membership);
  const paid =
    monthly !== null && membership?.currency
      ? t('dash.row.perMonth', {
          amount: currency(monthly, membership.currency.toUpperCase(), { whole: true }),
        })
      : null;
  return (
    <div className="flex flex-col gap-2.5 @lg/list:flex-row @lg/list:items-center @lg/list:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Avatar name={member.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate font-medium">{member.name ?? t('members.unnamed')}</p>
            {member.risk ? (
              <RiskBadge risk={member.risk} />
            ) : (
              attentionReasons(member).map((reason) => (
                <Badge key={reason} tone={reason === 'paymentFailed' ? 'danger' : 'warning'}>
                  {t(
                    reason === 'paymentFailed' ? 'attention.paymentFailed' : 'attention.canceling',
                  )}
                </Badge>
              ))
            )}
          </div>
          {mainText ? <p className="mt-0.5 text-sm text-muted">{mainText}</p> : null}
          {end || paid ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-subtle">
              {end ? (
                <span className={`inline-flex items-center gap-1 ${leaving ? 'text-danger' : ''}`}>
                  <CalendarClock aria-hidden="true" className="size-3.5" />
                  {leaving
                    ? t('risk.reason.cancel_scheduled', { date: end })
                    : t('dash.row.renews', { date: end })}
                </span>
              ) : null}
              {end && paid ? <span aria-hidden="true">·</span> : null}
              {paid ? <span className="tabular">{paid}</span> : null}
            </p>
          ) : null}
        </div>
      </div>
      <div className="ps-12 @lg/list:shrink-0 @lg/list:ps-0">
        <MemberActions member={member} api={api} testMode={testMode} onDone={onDone} />
      </div>
    </div>
  );
}

/**
 * The activation radar (SPEC Phase 3): joined 3 to 7 days ago and nothing since, with a word of
 * welcome in one click.
 */
function Newcomers({
  members,
  api,
  testMode,
  limit,
  seeAll,
  onDone,
}: {
  members: readonly MemberRow[];
  api: string;
  testMode: boolean;
  limit?: number;
  seeAll?: string;
  onDone: () => void;
}) {
  const { t, date } = useI18n();
  const newcomers = members.filter((m) => m.risk?.inactiveNewcomer === true);
  return (
    <Card
      icon={<Sprout aria-hidden="true" className="size-4" />}
      title={t('newcomers.title')}
      description={t('newcomers.description')}
      actions={
        seeAll && newcomers.length > 0 ? (
          <Link to={seeAll} className={SECTION_LINK_CLASS}>
            {t('attention.seeAll', { count: newcomers.length })}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        ) : null
      }
    >
      {newcomers.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleCheck aria-hidden="true" className="size-4 text-accent" />
          {t('newcomers.none')}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {newcomers.slice(0, limit).map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={member.name} />
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.name ?? t('members.unnamed')}</p>
                  {member.joinedAt ? (
                    <p className="text-xs text-muted">
                      {t('members.joined', { date: date(new Date(member.joinedAt)) })}
                    </p>
                  ) : null}
                </div>
              </div>
              <MemberActions
                member={member}
                api={api}
                testMode={testMode}
                offers={false}
                onDone={onDone}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A day of the history (`YYYY-MM-DD`, the community's calendar) at noon: never the day before. */
function dayOf(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

/**
 * How the risk spreads now (one bar, a part per level, each with its name, icon and count) and
 * how the members at risk evolved over 30 days (a line that draws in). A level opens its members.
 */
function RiskPanel({
  summary,
  history,
  root,
}: {
  summary: RiskSummary | null;
  history: readonly RiskDay[] | null;
  root: string;
}) {
  const { t, number, percent, relative, date } = useI18n();
  const icon = <Gauge aria-hidden="true" className="size-4" />;
  if (!summary) {
    return (
      <Card icon={icon} title={t('dash.risk.title')}>
        <Skeleton className="h-3 w-full rounded-full" />
        <Skeleton className="mt-6 h-24 w-full" />
      </Card>
    );
  }
  const counts = {
    scheduled_departure: summary.scheduledDeparture,
    high: summary.high,
    medium: summary.medium,
    low: summary.low,
  };
  const total = LEVEL_ORDER.reduce((sum, level) => sum + counts[level], 0);
  const parts: BarPart[] = LEVEL_ORDER.map((level) => ({
    key: level,
    label: t(LEVELS[level].label),
    value: counts[level],
    fill: LEVELS[level].fill,
    href: `${root}/members?filter=${LEVEL_FILTERS[level]}`,
  }));
  const points = (history ?? []).map((day) => ({
    label: date(dayOf(day.day)),
    value: day.departure + day.high,
  }));
  const first = points[0];
  const last = points.at(-1);
  const change = first && last ? last.value - first.value : 0;
  return (
    <Card icon={icon} title={t('dash.risk.title')} description={t('dash.risk.description')}>
      {summary.computedAt === null ? (
        <p className="text-sm text-muted">{t('distribution.pending')}</p>
      ) : (
        <>
          <StackedBar
            parts={parts}
            total={total}
            label={t('distribution.label')}
            format={(part, share) =>
              t('dash.risk.share', { count: number(part.value), share: percent(share) })
            }
          />
          {first && last && points.length > 1 ? (
            <div className="mt-6 border-t border-line pt-5">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{t('dash.risk.trend')}</p>
                <p
                  className={`inline-flex items-center gap-1 text-xs font-medium ${
                    change < 0 ? 'text-accent' : change > 0 ? 'text-danger' : 'text-muted'
                  }`}
                >
                  {change < 0 ? (
                    <TrendingDown aria-hidden="true" className="size-3.5" />
                  ) : change > 0 ? (
                    <TrendingUp aria-hidden="true" className="size-3.5" />
                  ) : null}
                  {change < 0
                    ? t('dash.risk.fewer', { count: number(-change) })
                    : change > 0
                      ? t('dash.risk.more', { count: number(change) })
                      : t('dash.risk.same')}
                </p>
              </div>
              <Sparkline
                points={points}
                format={(value) => number(value)}
                summary={t('dash.risk.trendSummary', {
                  first: number(first.value),
                  from: first.label,
                  last: number(last.value),
                  to: last.label,
                })}
              />
            </div>
          ) : null}
          <p className="mt-4 text-xs text-muted">
            {t('distribution.computed', { when: relative(new Date(summary.computedAt)) })}
          </p>
        </>
      )}
    </Card>
  );
}

const FEED_ICONS: Readonly<Record<Exclude<FeedItem['event'], 'activity'>, LucideIcon>> = {
  message_sent: MessageSquareText,
  message_simulated: FlaskConical,
  payment_retry: RotateCw,
  offer_applied: Gift,
  saved: PiggyBank,
  joined: UserPlus,
  payment_succeeded: CreditCard,
  payment_failed: CreditCard,
  cancellation_scheduled: CalendarX,
};

const ACTIVITY_ICONS: Readonly<Record<NonNullable<FeedItem['activity']>, LucideIcon>> = {
  message: MessageCircle,
  lesson: BookOpen,
  post: MessagesSquare,
  result: Trophy,
};

/** The tint of an event's icon: mint for what StayPut did or saved, red for money going wrong. */
function feedTone(item: FeedItem): string {
  if (item.event === 'payment_failed' || item.event === 'cancellation_scheduled') {
    return 'bg-danger-soft text-danger';
  }
  if (item.by === 'stayput') return 'bg-accent-soft text-accent';
  return 'bg-surface-2 text-muted';
}

/** An event in the creator's words: « StayPut messaged Ana », « Ana paid $49 ». */
function feedText(item: FeedItem, i18n: Translator): string {
  const { t, currency } = i18n;
  const name = item.memberName ?? t('feed.someone');
  if (item.event === 'activity') {
    return t(`feed.activity.${item.activity ?? 'message'}`, {
      name,
      source: t(`sources.${item.source ?? 'whop'}.name`),
    });
  }
  const amount =
    item.amount !== undefined && item.currency
      ? currency(item.amount, item.currency, { whole: Number.isInteger(item.amount) })
      : '';
  return t(`feed.${item.event}`, { name, amount });
}

/**
 * What just happened, the newest first, read again every 30 s: what StayPut did, what members
 * did. A new line slides in from the top with a short mint highlight (MOTION.md).
 */
function Feed({ state, retry }: { state: Loadable<FeedView>; retry: () => void }) {
  const i18n = useI18n();
  const { t, relative, dateTime } = i18n;
  return (
    <Card
      icon={<Activity aria-hidden="true" className="size-4" />}
      title={t('feed.title')}
      description={t('feed.description')}
      actions={
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
          <span aria-hidden="true" className="relative flex size-2">
            <span className="absolute inline-flex size-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-accent" />
          </span>
          {t('feed.live')}
        </span>
      }
    >
      {state.status === 'loading' ? (
        <RowsSkeleton rows={6} />
      ) : state.status === 'error' ? (
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      ) : state.data.items.length === 0 ? (
        <EmptyState icon={<StayPutMark size={24} />} body={t('feed.empty')} />
      ) : (
        <ul
          aria-label={t('feed.title')}
          className="fade-end -mx-2 max-h-[34rem] overflow-y-auto pb-8 [scrollbar-width:thin]"
        >
          <AnimatePresence initial={false}>
            {state.data.items.map((item) => {
              const Icon =
                item.event === 'activity'
                  ? ACTIVITY_ICONS[item.activity ?? 'message']
                  : FEED_ICONS[item.event];
              return (
                <motion.li
                  key={item.id}
                  layout="position"
                  variants={feedItemVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="relative flex items-start gap-3 rounded-lg px-2 py-2.5"
                >
                  {/* A new line's mint highlight, fading out (opacity only). */}
                  <motion.span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-lg bg-accent-soft"
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: 1.2, ease: EASE, delay: 0.3 }}
                  />
                  <span
                    className={`relative flex size-8 shrink-0 items-center justify-center rounded-lg ${feedTone(item)}`}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <div className="relative min-w-0 flex-1">
                    <p className="text-sm">{feedText(item, i18n)}</p>
                    <p className="tabular text-xs text-subtle" title={dateTime(new Date(item.at))}>
                      {relative(new Date(item.at))}
                    </p>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

/**
 * The community's own figures, second to the money (required fixes 1 and 3): its members and
 * the new ones, its monthly revenue, what the members did, and what StayPut did, apart.
 */
function Community({ view }: { view: DashboardView | null }) {
  const { t, plural, number } = useI18n();
  const titleId = useId();
  const money = useMoney(view?.currency ?? null);
  // By its own width: two by two beside the risk, in a row when alone on a wide page.
  const grid = 'grid grid-cols-1 gap-4 @sm:grid-cols-2 @4xl:grid-cols-4';
  if (!view) {
    return (
      <div className="@container">
        <div className={grid} aria-hidden="true">
          <MetricSkeleton />
          <MetricSkeleton />
          <MetricSkeleton />
          <MetricSkeleton />
        </div>
      </div>
    );
  }
  const whole = (value: number) => number(Math.round(value));
  const done = view.stayputActions30d;
  return (
    <section aria-labelledby={titleId} className="@container min-w-0">
      <h2 id={titleId} className="sr-only">
        {t('dash.community')}
      </h2>
      <Stagger as="dl" className={grid}>
        <StaggerItem>
          <MetricCard
            label={t('members.summary.members')}
            value={view.members.total}
            format={whole}
            icon={<Users aria-hidden="true" className="size-4" />}
            hint={plural('dash.members.new', view.members.newLast7Days)}
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label={t('members.summary.revenue')}
            value={view.monthlyRevenue}
            format={money}
            icon={<Wallet aria-hidden="true" className="size-4" />}
            hint={t('dash.revenue.hint')}
            empty={t('dash.noRevenue')}
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label={t('dash.memberActivity')}
            value={view.memberActivity30d}
            format={whole}
            icon={<Activity aria-hidden="true" className="size-4" />}
            hint={t('dash.memberActivity.hint')}
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label={t('dash.stayputActions')}
            value={done.total}
            format={whole}
            icon={<StayPutMark size={16} />}
            hint={[
              plural('members.messages', done.messages),
              plural('dash.count.retries', done.paymentRetries),
              plural('dash.count.offers', done.offers),
            ].join(' · ')}
          />
        </StaggerItem>
      </Stagger>
    </section>
  );
}

/** Whop, Discord and Telegram at a glance, with the way to the integrations section. */
function SourcesSummary({ status, root }: { status: IntegrationsStatus | null; root: string }) {
  const { t, plural } = useI18n();
  const discord = status?.discord;
  const telegram = status?.telegram;
  const row = (icon: ReactNode, name: string, state: ReactNode) => (
    <li className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {name}
      </span>
      {state}
    </li>
  );
  return (
    <Card
      icon={<Plug aria-hidden="true" className="size-4" />}
      title={t('sources.title')}
      actions={
        <Link to={`${root}/sources`} className={SECTION_LINK_CLASS}>
          {t('sources.manage')}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      }
    >
      <ul className="divide-y divide-line">
        {row(
          <span aria-hidden="true" className="size-4 rounded bg-accent" />,
          t('sources.whop.name'),
          <Badge tone="accent">{t('sources.connected')}</Badge>,
        )}
        {row(
          <DiscordIcon className="size-4 text-discord" />,
          t('sources.discord.name'),
          !discord ? null : discord.servers.length > 0 ? (
            <Badge tone="accent">{plural('sources.discord.servers', discord.servers.length)}</Badge>
          ) : (
            <Badge>{t(discord.available ? 'sources.notConnected' : 'sources.unavailable')}</Badge>
          ),
        )}
        {row(
          <TelegramIcon className="size-4 text-telegram" />,
          t('sources.telegram.name'),
          !telegram ? null : telegram.groups.some((g) => g.active) ? (
            <Badge tone="accent">
              {plural('sources.telegram.groups', telegram.groups.filter((g) => g.active).length)}
            </Badge>
          ) : (
            <Badge>{t(telegram.available ? 'sources.notConnected' : 'sources.unavailable')}</Badge>
          ),
        )}
      </ul>
    </Card>
  );
}
