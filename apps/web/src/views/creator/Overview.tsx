import type { IntegrationsStatus, MemberRow, MembersPage, RevenueSummary } from '@stayput/core';
import {
  Activity,
  ArrowRight,
  CalendarClock,
  CircleCheck,
  CreditCard,
  Plug,
  Sprout,
  TriangleAlert,
  Users,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { attentionReasons, membershipLine } from '../../components/MemberRows';
import { RiskBadge, RiskDistribution, RiskReasons } from '../../components/Risk';
import { SyncPanel } from '../../components/SyncPanel';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Avatar } from '../../ui/Avatar';
import { Badge } from '../../ui/Badge';
import { DiscordIcon, TelegramIcon } from '../../ui/BrandIcons';
import { Card } from '../../ui/Card';
import { Stat } from '../../ui/Stat';
import { useCreatorData } from '../CreatorView';

/** Members listed at most in « Needs attention » and in the activation radar. */
const LIST_LIMIT = 5;

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-accent ' +
  'hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent';

/**
 * The first section: the figures, who is about to leave and why, the new members who did not
 * start, how the risk spreads, and where the data stands.
 */
export function Overview() {
  const { members, sync, integrations, root } = useCreatorData();
  const page = members.state.status === 'ready' ? members.state.data : null;
  return (
    <div className="space-y-6">
      {members.state.status === 'loading' ? (
        <Loading />
      ) : members.state.status === 'error' ? (
        <ErrorPanel
          error={members.state.error}
          forbiddenKey="error.forbidden.creator"
          onRetry={members.retry}
        />
      ) : (
        <Figures page={members.state.data} />
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="min-w-0 space-y-6 lg:col-span-3">
          {page ? (
            <>
              <Attention members={page.members} root={root} />
              <Newcomers members={page.members} root={root} />
            </>
          ) : null}
        </div>
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {page ? <RiskDistribution summary={page.summary.risk} root={root} /> : null}
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

function Figures({ page }: { page: MembersPage }) {
  const { t, number } = useI18n();
  const { summary } = page;
  return (
    <section aria-labelledby="figures-title">
      <h2 id="figures-title" className="sr-only">
        {t('overview.figures')}
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label={t('members.summary.members')}
          value={number(summary.members)}
          hint={t('members.summary.membersHint')}
          icon={<Users aria-hidden="true" className="size-4" />}
          tone="accent"
        />
        <RevenueStat revenue={summary.revenue} />
        <Stat
          label={t('members.summary.highRisk')}
          value={number(summary.risk.high)}
          icon={<TriangleAlert aria-hidden="true" className="size-4" />}
          tone={summary.risk.high > 0 ? 'serious' : 'neutral'}
        />
        <Stat
          label={t('members.summary.cancellations')}
          value={number(summary.scheduledCancellations)}
          icon={<CalendarClock aria-hidden="true" className="size-4" />}
          tone={summary.scheduledCancellations > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label={t('members.summary.failed')}
          value={number(summary.failedPayments)}
          icon={<CreditCard aria-hidden="true" className="size-4" />}
          tone={summary.failedPayments > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label={t('members.summary.activity')}
          value={number(summary.activity30d)}
          hint={t('members.summary.activityHint')}
          icon={<Activity aria-hidden="true" className="size-4" />}
          tone="info"
        />
      </dl>
    </section>
  );
}

/** What the memberships still paying bring each month, and how much of it is at risk. */
function RevenueStat({ revenue }: { revenue: RevenueSummary | null }) {
  const { t, currency } = useI18n();
  const icon = <Wallet aria-hidden="true" className="size-4" />;
  if (!revenue) {
    return (
      <Stat
        label={t('members.summary.revenue')}
        value="—"
        hint={t('members.summary.noRevenue')}
        icon={icon}
      />
    );
  }
  const amount = (value: number) => currency(value, revenue.currency, { whole: true });
  return (
    <Stat
      label={t('members.summary.revenue')}
      value={amount(revenue.monthly)}
      hint={t(
        revenue.otherCurrencies
          ? 'members.summary.revenueAtRiskMain'
          : 'members.summary.revenueAtRisk',
        { amount: amount(revenue.atRisk), currency: revenue.currency },
      )}
      icon={icon}
      tone="accent"
    />
  );
}

/**
 * The members most likely to leave, the highest score first (the members arrive sorted): the
 * departures scheduled and the high risks, a failed payment among them whatever the activity,
 * each with the reasons. Before the first scores, Whop's facts.
 */
function Attention({ members, root }: { members: readonly MemberRow[]; root: string }) {
  const i18n = useI18n();
  const { t, number } = i18n;
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
        flagged.length > 0 ? (
          <Link to={`${root}/members`} className={LINK_CLASS}>
            {t('attention.byRisk')}
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
        <ul className="divide-y divide-line">
          {flagged.slice(0, LIST_LIMIT).map((member) => (
            <li key={member.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <Avatar name={member.name} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{member.name ?? t('members.unnamed')}</p>
                  {member.risk ? (
                    <RiskBadge risk={member.risk} />
                  ) : (
                    attentionReasons(member).map((reason) => (
                      <Badge key={reason} tone={reason === 'paymentFailed' ? 'danger' : 'warning'}>
                        {t(
                          reason === 'paymentFailed'
                            ? 'attention.paymentFailed'
                            : 'attention.canceling',
                        )}
                      </Badge>
                    ))
                  )}
                </div>
                {member.risk ? <RiskReasons reasons={member.risk.reasons} /> : null}
                {member.membership ? (
                  <p className="mt-1 truncate text-xs text-muted">
                    {membershipLine(member.membership, i18n)}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {flagged.length > LIST_LIMIT ? (
        <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
          {t('attention.more', { count: number(flagged.length - LIST_LIMIT) })}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The activation radar (SPEC Phase 3): joined 3 to 7 days ago and nothing since. The welcome
 * action of Phase 4 will start from here.
 */
function Newcomers({ members, root }: { members: readonly MemberRow[]; root: string }) {
  const { t, date } = useI18n();
  const newcomers = members.filter((m) => m.risk?.inactiveNewcomer === true);
  return (
    <Card
      icon={<Sprout aria-hidden="true" className="size-4" />}
      title={t('newcomers.title')}
      description={t('newcomers.description')}
      actions={
        newcomers.length > 0 ? (
          <Link to={`${root}/members?filter=newcomers`} className={LINK_CLASS}>
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
          {newcomers.slice(0, LIST_LIMIT).map((member) => (
            <li key={member.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Avatar name={member.name} />
              <div className="min-w-0">
                <p className="truncate font-medium">{member.name ?? t('members.unnamed')}</p>
                {member.joinedAt ? (
                  <p className="text-xs text-muted">
                    {t('members.joined', { date: date(new Date(member.joinedAt)) })}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Whop, Discord and Telegram at a glance, with the way to the sources section. */
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
        <Link to={`${root}/sources`} className={LINK_CLASS}>
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
