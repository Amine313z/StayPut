import type { OperatorJob, OperatorStatus, WebhookReplay } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Users,
  Webhook,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { postJson, useApi } from '../../api';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Badge, type Tone } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useCreatorData } from '../CreatorView';

/**
 * Settings › Status (SPEC Phase 8.5): StayPut's internal status page, for the team of the
 * operator's own community only. The scheduled jobs, Whop's deliveries (the failed ones replayed
 * here), the communities, the readings refused, the failed actions and the error log. Every
 * message is scrubbed by the Worker: no secret, no person.
 */
export function OperatorTab() {
  const { root, operator } = useCreatorData();
  // Anyone else: the address leads back to the settings.
  if (!operator) return <Navigate to={`${root}/settings`} replace />;
  return <OperatorStatusPage />;
}

const STATES: Readonly<Record<OperatorJob['state'], { key: MessageKey; tone: Tone }>> = {
  ok: { key: 'ops.state.ok', tone: 'accent' },
  failing: { key: 'ops.state.failing', tone: 'danger' },
  late: { key: 'ops.state.late', tone: 'danger' },
  never: { key: 'ops.state.never', tone: 'neutral' },
};

const DELIVERY_STATUSES = ['processed', 'ignored', 'failed', 'received'] as const;

function OperatorStatusPage() {
  const { t, relative, number, dateTime } = useI18n();
  const { api } = useCreatorData();
  const { state, retry, reload } = useApi<OperatorStatus>(`${api}/operator/status`);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<string | null>(null);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  const status = state.data;
  const now = new Date(status.checkedAt);
  const when = (iso: string | null) => (iso ? relative(new Date(iso), now) : '—');
  const attention =
    status.database !== 'ok' ||
    status.jobs.some((job) => job.state === 'failing' || job.state === 'late') ||
    status.webhooks.failed.some((delivery) => !delivery.retrying);

  const replay = async (id: string | null) => {
    setReplaying(id ?? 'all');
    try {
      const result = await postJson<WebhookReplay>(
        `${api}/operator/webhooks/replay`,
        id ? { id } : {},
      );
      setReplayed(describeReplay(result, t));
      reload();
    } finally {
      setReplaying(null);
    }
  };

  return (
    <div className="space-y-6" data-operator-status>
      <Card
        icon={
          attention ? (
            <CircleAlert aria-hidden="true" className="size-4" />
          ) : (
            <CircleCheck aria-hidden="true" className="size-4 text-accent" />
          )
        }
        title={t(attention ? 'ops.attention' : 'ops.ok')}
        description={t('ops.hint')}
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw aria-hidden="true" className="size-4" />}
            onClick={reload}
          >
            {t('ops.refresh')}
          </Button>
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Fact label={t('ops.whop')} value={t(`ops.env.${status.whopEnv}`)} />
          <Fact
            label={t('ops.database')}
            value={t(`ops.db.${status.database}`)}
            icon={<Database aria-hidden="true" className="size-3.5" />}
          />
          <Fact label={t('ops.schema')} value={status.migration.replace(/\.sql$/, '')} />
        </dl>
        <p className="mt-3 text-xs text-subtle">
          {t('ops.checked', { when: dateTime(new Date(status.checkedAt)) })}
        </p>
      </Card>

      <Card
        icon={<Clock aria-hidden="true" className="size-4" />}
        title={t('ops.jobs')}
        description={t('ops.jobs.hint')}
      >
        <ul className="divide-y divide-line" aria-label={t('ops.jobs')}>
          {status.jobs.map((job) => (
            <li key={job.job} className="py-3 first:pt-0 last:pb-0" data-job={job.job}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-fg">{job.job}</p>
                  <p className="text-xs text-subtle">
                    {every(job.everyMinutes, t)}
                    {job.lastFinishedAt
                      ? ` · ${t('ops.jobs.ran', {
                          when: when(job.lastFinishedAt),
                          duration: duration(job.lastDurationMs),
                        })}`
                      : ''}
                    {job.failures > 0
                      ? ` · ${t('ops.jobs.failures', {
                          failures: number(job.failures),
                          runs: number(job.runs),
                        })}`
                      : ''}
                  </p>
                </div>
                <Badge tone={STATES[job.state].tone}>{t(STATES[job.state].key)}</Badge>
              </div>
              {job.lastError && job.state === 'failing' ? (
                <p className="mt-1 text-xs break-words text-muted">
                  {t('ops.jobs.lastError', {
                    when: when(job.lastFailedAt),
                    message: job.lastError,
                  })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        icon={<Webhook aria-hidden="true" className="size-4" />}
        title={t('ops.webhooks')}
        description={t('ops.webhooks.hint')}
        actions={
          status.webhooks.failedCount > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw aria-hidden="true" className="size-4" />}
              loading={replaying === 'all'}
              disabled={replaying !== null}
              onClick={() => void replay(null)}
            >
              {t('ops.replayAll', { count: number(status.webhooks.failedCount) })}
            </Button>
          ) : null
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {DELIVERY_STATUSES.map((key) => (
            <Fact
              key={key}
              label={t(`ops.webhooks.${key}`)}
              value={number(status.webhooks.lastDay[key] ?? 0)}
            />
          ))}
        </dl>
        <p className="mt-3 text-sm text-muted">
          {status.webhooks.lastReceivedAt
            ? t('ops.webhooks.last', { when: when(status.webhooks.lastReceivedAt) })
            : t('ops.webhooks.never')}
        </p>
        {replayed ? (
          <p role="status" className="mt-2 text-sm text-accent">
            {replayed}
          </p>
        ) : null}
        <ul className="mt-3 divide-y divide-line" aria-label={t('ops.webhooks.failed')}>
          {status.webhooks.failed.length === 0 ? (
            <li className="py-2 text-sm text-muted">{t('ops.webhooks.noneFailed')}</li>
          ) : (
            status.webhooks.failed.map((delivery) => (
              <li
                key={delivery.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
                data-delivery={delivery.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg">
                    <span className="font-mono">{delivery.type}</span>
                    {' · '}
                    {delivery.companyName ?? delivery.companyId ?? t('ops.noCommunity')}
                  </p>
                  <p className="text-xs text-subtle">
                    {when(delivery.receivedAt)}
                    {' · '}
                    {t(delivery.retrying ? 'ops.webhooks.retrying' : 'ops.webhooks.gaveUp', {
                      attempts: number(delivery.attempts),
                    })}
                  </p>
                  {delivery.lastError ? (
                    <p className="mt-1 text-xs break-words text-muted">{delivery.lastError}</p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RotateCcw aria-hidden="true" className="size-4" />}
                  aria-label={t('ops.replayOne', { type: delivery.type })}
                  loading={replaying === delivery.id}
                  disabled={replaying !== null}
                  onClick={() => void replay(delivery.id)}
                >
                  {t('ops.replay')}
                </Button>
              </li>
            ))
          )}
        </ul>
      </Card>

      <Card icon={<Users aria-hidden="true" className="size-4" />} title={t('ops.companies')}>
        <dl className="grid grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <Fact label={t('ops.companies.active')} value={number(status.companies.active)} />
          <Fact label={t('ops.companies.accessLost')} value={number(status.companies.accessLost)} />
          <Fact
            label={t('ops.companies.uninstalled')}
            value={number(status.companies.uninstalled)}
          />
        </dl>
        <h3 className="mt-5 text-sm font-medium text-fg">{t('ops.sync')}</h3>
        <Rows
          empty={t('ops.sync.none')}
          items={status.syncErrors.map((error) => ({
            key: `${error.companyId}:${error.stream}`,
            title: `${error.companyName ?? error.companyId} · ${error.stream}`,
            meta: when(error.at),
            detail: error.error,
          }))}
        />
      </Card>

      <Card icon={<Zap aria-hidden="true" className="size-4" />} title={t('ops.actions')}>
        <Rows
          empty={t('ops.actions.none')}
          items={status.failedActions.map((action) => ({
            key: `${action.companyId}:${action.type}`,
            title: `${action.companyName ?? action.companyId} · ${action.type}`,
            meta: `${t('ops.errors.times', { count: number(action.count) })} · ${when(action.lastAt)}`,
            detail: action.lastError,
          }))}
        />
      </Card>

      <Card
        icon={<ScrollText aria-hidden="true" className="size-4" />}
        title={t('ops.errors')}
        description={t('ops.errors.hint')}
      >
        <Rows
          empty={t('ops.errors.none')}
          items={status.errors.map((error) => ({
            key: `${error.source}:${error.companyId ?? ''}:${error.message}`,
            title: error.message,
            meta: [
              error.source,
              error.companyId ?? t('ops.noCommunity'),
              t('ops.errors.times', { count: number(error.count) }),
              when(error.lastAt),
            ].join(' · '),
            detail: null,
          }))}
          mono
        />
      </Card>
    </div>
  );
}

/** A figure with its label. */
function Fact({ label, value, icon }: { label: string; value: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="flex items-center gap-1.5 text-fg">
        {icon}
        <span className="truncate">{value}</span>
      </dd>
    </div>
  );
}

/** A list of what went wrong, or the sentence saying nothing did. */
function Rows({
  items,
  empty,
  mono = false,
}: {
  items: { key: string; title: string; meta: string; detail: string | null }[];
  empty: string;
  mono?: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-2 text-sm text-muted">
        <Activity aria-hidden="true" className="size-4 text-accent" />
        {empty}
      </p>
    );
  }
  return (
    <ul className="mt-2 divide-y divide-line">
      {items.map((item) => (
        <li key={item.key} className="py-2.5">
          <p className={`text-sm break-words text-fg ${mono ? 'font-mono' : ''}`}>{item.title}</p>
          <p className="text-xs text-subtle">{item.meta}</p>
          {item.detail ? (
            <p className="mt-1 text-xs break-words text-muted">{item.detail}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function every(minutes: number, t: ReturnType<typeof useI18n>['t']): string {
  if (minutes >= 7 * 24 * 60) return t('ops.every.week');
  if (minutes >= 60) return t('ops.every.hours', { n: Math.round(minutes / 60) });
  return t('ops.every.minutes', { n: minutes });
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** What a replay did: « 2 processed, 1 still failing ». */
function describeReplay(result: WebhookReplay, t: ReturnType<typeof useI18n>['t']): string {
  const parts = (['processed', 'failed', 'ignored', 'missing'] as const)
    .filter((key) => (result.counts[key] ?? 0) > 0)
    .map((key) => t(`ops.result.${key}`, { count: result.counts[key] ?? 0 }));
  return parts.length > 0 ? parts.join(', ') : t('ops.result.none');
}
