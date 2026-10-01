import type { IntegrationsStatus, MemberRow, MembersPage } from '@stayput/core';
import {
  Activity,
  ArrowRight,
  CalendarClock,
  CircleCheck,
  CreditCard,
  Plug,
  TriangleAlert,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { attentionReasons, membershipLine } from '../../components/MemberRows';
import { SyncPanel } from '../../components/SyncPanel';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Avatar } from '../../ui/Avatar';
import { Badge } from '../../ui/Badge';
import { DiscordIcon, TelegramIcon } from '../../ui/BrandIcons';
import { Card } from '../../ui/Card';
import { Stat } from '../../ui/Stat';
import { useCreatorData } from '../CreatorView';

/** Members listed at most in « Needs attention »; the members section has them all. */
const ATTENTION_LIMIT = 5;

/** The first section: the figures, who needs attention now, and where the data stands. */
export function Overview() {
  const { members, sync, integrations, root } = useCreatorData();
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
        <div className="min-w-0 lg:col-span-3">
          {members.state.status === 'ready' ? (
            <Attention members={members.state.data.members} root={root} />
          ) : null}
        </div>
        <div className="min-w-0 space-y-6 lg:col-span-2">
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
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label={t('members.summary.members')}
          value={number(summary.members)}
          icon={<Users aria-hidden="true" className="size-4" />}
          tone="accent"
        />
        <Stat
          label={t('members.summary.live')}
          value={number(summary.liveMemberships)}
          icon={<CircleCheck aria-hidden="true" className="size-4" />}
          tone="accent"
        />
        <Stat
          label={t('members.summary.cancellations')}
          value={number(summary.scheduledCancellations)}
          icon={<CalendarClock aria-hidden="true" className="size-4" />}
          tone={summary.scheduledCancellations > 0 ? 'warning' : 'neutral'}
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
          icon={<Activity aria-hidden="true" className="size-4" />}
          tone="info"
        />
      </dl>
    </section>
  );
}

/** Members a failed payment or a scheduled cancellation is about to make leave. */
function Attention({ members, root }: { members: readonly MemberRow[]; root: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const flagged = members.filter((m) => attentionReasons(m).length > 0);
  return (
    <Card
      icon={<TriangleAlert aria-hidden="true" className="size-4" />}
      title={t('attention.title')}
      description={t('attention.description')}
      actions={
        flagged.length > 0 ? (
          <Link
            to={`${root}/members?filter=attention`}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
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
        <ul className="divide-y divide-line">
          {flagged.slice(0, ATTENTION_LIMIT).map((member) => (
            <li key={member.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <Avatar name={member.name} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{member.name ?? t('members.unnamed')}</p>
                  {attentionReasons(member).map((reason) => (
                    <Badge key={reason} tone={reason === 'paymentFailed' ? 'danger' : 'warning'}>
                      {t(
                        reason === 'paymentFailed'
                          ? 'attention.paymentFailed'
                          : 'attention.canceling',
                      )}
                    </Badge>
                  ))}
                </div>
                {member.membership ? (
                  <p className="mt-0.5 truncate text-sm text-muted">
                    {membershipLine(member.membership, i18n)}
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
        <Link
          to={`${root}/sources`}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
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
