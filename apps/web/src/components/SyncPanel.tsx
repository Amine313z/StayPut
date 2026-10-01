import type { MessageKey } from '@stayput/i18n';
import { CircleCheck, Clock, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import type { SyncState } from '../sync';
import { Notice } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const STREAM_LABELS: Record<string, MessageKey> = {
  plans: 'sync.stream.plans',
  members: 'sync.stream.members',
  memberships: 'sync.stream.memberships',
  payments: 'sync.stream.payments',
  support_channels: 'sync.stream.support_channels',
  chat_channels: 'sync.stream.chat_channels',
  forums: 'sync.stream.forums',
  courses: 'sync.stream.courses',
  messages: 'sync.stream.messages',
  forum_posts: 'sync.stream.forum_posts',
  lesson_interactions: 'sync.stream.lesson_interactions',
};

/** Where the reading of Whop's data stands, what could not be read, and "Sync now". */
export function SyncPanel({ sync }: { sync: SyncState }) {
  const { t, relative, dateTime } = useI18n();
  const { status, running, notice } = sync;
  // One line per kind of data (all chat channels together).
  const problems = new Map<string, string>();
  let permissionMissing = false;
  for (const stream of status?.streams ?? []) {
    const kind = stream.stream.split(':')[0] ?? stream.stream;
    if (!stream.error || problems.has(kind)) continue;
    const label = STREAM_LABELS[kind];
    const refused = /^403\b/.test(stream.error);
    permissionMissing ||= refused;
    problems.set(
      kind,
      t(refused ? 'sync.problem.permission' : 'sync.problem.other', {
        stream: label ? t(label) : kind,
      }),
    );
  }
  const state = !status
    ? null
    : !status.lastSyncAt
      ? 'never'
      : status.backfillDone
        ? 'upToDate'
        : 'importing';

  return (
    <Card
      icon={<RefreshCw aria-hidden="true" className="size-4" />}
      title={t('sync.title')}
      description={
        <span role="status">
          {state === null
            ? t('common.loading')
            : state === 'never'
              ? t('sync.never')
              : state === 'upToDate'
                ? t('sync.upToDate')
                : t('sync.importing')}
        </span>
      }
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={sync.syncNow}
          loading={running}
          icon={<RefreshCw aria-hidden="true" className="size-4" />}
        >
          {running ? t('sync.running') : t('sync.now')}
        </Button>
      }
    >
      <div className="space-y-3">
        {status?.lastSyncAt ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            {state === 'importing' ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-info" />
            ) : (
              <CircleCheck aria-hidden="true" className="size-4 text-accent" />
            )}
            <span title={dateTime(new Date(status.lastSyncAt))}>
              {t('sync.last', { date: relative(new Date(status.lastSyncAt)) })}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Clock aria-hidden="true" className="size-4" />
            {t('sync.badge.never')}
          </p>
        )}
        {notice ? (
          <p className="text-sm" role="alert">
            {t(notice === 'tooSoon' ? 'sync.tooSoon' : 'sync.failed')}
          </p>
        ) : null}
        {problems.size > 0 ? (
          <Notice tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-4" />}>
            <p className="font-medium">{t('sync.problems')}</p>
            <ul className="mt-1 list-disc space-y-1 ps-5">
              {[...problems].map(([kind, text]) => (
                <li key={kind}>{text}</li>
              ))}
            </ul>
            {permissionMissing ? <p className="mt-2">{t('sync.permissionHint')}</p> : null}
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}
