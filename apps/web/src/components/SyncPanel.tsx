import type { MessageKey } from '@stayput/i18n';
import { useI18n } from '../i18n';
import type { SyncState } from '../sync';

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
  const { t, dateTime } = useI18n();
  const { status, running, notice } = sync;
  // One line per kind of data (all chat channels together), the latest failure first.
  const problems = new Map<string, string>();
  for (const stream of status?.streams ?? []) {
    const kind = stream.stream.split(':')[0] ?? stream.stream;
    if (!stream.error || problems.has(kind)) continue;
    const label = STREAM_LABELS[kind];
    problems.set(
      kind,
      t(/^403\b/.test(stream.error) ? 'sync.problem.permission' : 'sync.problem.other', {
        stream: label ? t(label) : kind,
      }),
    );
  }

  return (
    <section aria-labelledby="sync-title" className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sync-title" className="font-semibold">
            {t('sync.title')}
          </h2>
          <p className="mt-1 text-muted" role="status">
            {!status
              ? t('common.loading')
              : !status.lastSyncAt
                ? t('sync.never')
                : status.backfillDone
                  ? t('sync.upToDate')
                  : t('sync.importing')}
          </p>
          {status?.lastSyncAt ? (
            <p className="mt-1 text-sm text-muted">
              {t('sync.last', { date: dateTime(new Date(status.lastSyncAt)) })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={sync.syncNow}
          disabled={running}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {running ? t('sync.running') : t('sync.now')}
        </button>
      </div>
      {notice ? (
        <p className="mt-3 text-sm" role="alert">
          {t(notice === 'tooSoon' ? 'sync.tooSoon' : 'sync.failed')}
        </p>
      ) : null}
      {problems.size > 0 ? (
        <div className="mt-3 text-sm">
          <p className="font-medium">{t('sync.problems')}</p>
          <ul className="mt-1 list-disc space-y-1 ps-5 text-danger">
            {[...problems].map(([kind, text]) => (
              <li key={kind}>{text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
