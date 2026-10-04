import type { PriorityAction, SentWeeklyReport, WeeklyReportsView } from '@stayput/core';
import { addDays } from '@stayput/core';
import { CalendarClock, CircleCheck, Mail } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { putJson, useApi } from '../../api';
import { failureText } from '../../components/MemberActions';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { LabelTip } from '../../ui/LabelTip';
import { Skeleton } from '../../ui/Skeleton';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/Toast';
import { useCreatorData } from '../CreatorView';

/**
 * Analytics › Reports (SPEC Phase 6.9): the Monday report, every Monday at 8:00 in the community's
 * time zone, to its team as a Whop notification. The switch that turns it off, when the next one
 * goes, then the last 12 weeks as they were sent: members saved and lost, money saved, why
 * members left, the week's priority.
 */
export function ReportsTab() {
  const { t } = useI18n();
  const { api } = useCreatorData();
  const { state, retry } = useApi<WeeklyReportsView>(`${api}/reports`);
  const [saved, setSaved] = useState<WeeklyReportsView | null>(null);
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  const view = saved ?? (state.status === 'ready' ? state.data : null);
  return (
    <div className="space-y-8">
      <Setting api={api} view={view} onSaved={setSaved} />
      {view === null ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : view.reports.length === 0 ? (
        <EmptyState
          icon={<CalendarClock aria-hidden="true" className="size-5" />}
          body={<FirstOne view={view} />}
        />
      ) : (
        <ol aria-label={t('reports.list')} className="space-y-4">
          {view.reports.map((report) => (
            <li key={report.weekStart}>
              <Report report={report} zone={view.timezone} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A moment as the community's clock says it: « Monday, October 12 at 8:00 AM ». */
function useZonedMoment(): (iso: string, zone: string, weekday?: 'long' | 'short') => string {
  const { locale } = useI18n();
  return (iso, zone, weekday = 'long') => {
    const options: Intl.DateTimeFormatOptions = {
      weekday,
      month: weekday === 'long' ? 'long' : 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    };
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
    }
  };
}

function FirstOne({ view }: { view: WeeklyReportsView }) {
  const { t } = useI18n();
  const moment = useZonedMoment();
  return view.enabled
    ? t('reports.empty', { when: moment(view.nextAt, view.timezone) })
    : t('reports.off');
}

/** On or off, and when the next one goes. */
function Setting({
  api,
  view,
  onSaved,
}: {
  api: string;
  view: WeeklyReportsView | null;
  onSaved: (view: WeeklyReportsView) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const moment = useZonedMoment();
  const titleId = useId();
  const switchId = useId();
  const [busy, setBusy] = useState(false);
  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      onSaved(await putJson<WeeklyReportsView>(`${api}/reports`, { enabled }));
    } catch (error) {
      toast({ tone: 'error', title: failureText(error, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 border-b border-line pb-6 @3xl:flex-row @3xl:items-start @3xl:justify-between"
    >
      <div className="min-w-0 max-w-2xl">
        <h2 id={titleId} className="title-section flex items-center gap-2">
          <Mail aria-hidden="true" className="size-4 text-accent" />
          {t('reports.title')}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {view ? (
            t('reports.description', { zone: view.timezone })
          ) : (
            <Skeleton className="h-4 w-80" />
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1.5 @3xl:items-end">
        <div className="flex items-center gap-3">
          <span id={switchId} className="text-sm font-medium text-fg">
            {t('reports.switch')}
          </span>
          {view ? (
            <Switch
              checked={view.enabled}
              onChange={(enabled) => void change(enabled)}
              labelledBy={switchId}
              busy={busy}
            />
          ) : (
            <Skeleton className="h-6 w-10 rounded-full" />
          )}
        </div>
        {view?.enabled ? (
          <p className="text-[0.8125rem] text-subtle">
            {t('reports.next', { when: moment(view.nextAt, view.timezone) })}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** One week, as it was sent. */
function Report({ report, zone }: { report: SentWeeklyReport; zone: string }) {
  const { t, plural, calendarDay, calendarDate, currency: format, number } = useI18n();
  const moment = useZonedMoment();
  const titleId = useId();
  const money = (value: number) =>
    report.currency ? format(value, report.currency) : number(Math.round(value));
  const answers = report.reasons.reduce((sum, r) => sum + r.count, 0);
  return (
    <article
      aria-labelledby={titleId}
      data-report={report.weekStart}
      className="rounded-xl border border-line bg-surface/60 p-5 shadow-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-medium text-fg">
          {t('reports.week', {
            start: calendarDay(report.weekStart),
            end: calendarDate(addDays(report.weekStart, 6)),
          })}
        </h3>
        {report.sentAt ? (
          <Badge tone="accent" icon={<CircleCheck aria-hidden="true" className="size-3.5" />}>
            {t('reports.sent', { when: moment(report.sentAt, zone, 'short') })}
          </Badge>
        ) : report.failed ? (
          <Badge tone="danger">{t('reports.failed')}</Badge>
        ) : (
          <Badge>{t('reports.sending')}</Badge>
        )}
      </header>
      <dl className="mt-4 grid grid-cols-1 gap-4 @xl:grid-cols-3">
        <Figure label={t('reports.saved')} tip={t('reports.saved.tip')}>
          {number(report.saved.members)}
        </Figure>
        <Figure label={t('reports.money')} tip={t('reports.money.tip')}>
          {money(report.saved.direct)}
          {report.saved.influenced > 0 ? (
            <span className="ms-2 text-[0.8125rem] font-normal text-subtle">
              {t('reports.money.influenced', { amount: money(report.saved.influenced) })}
            </span>
          ) : null}
        </Figure>
        <Figure label={t('reports.lost')} tip={t('reports.lost.tip')}>
          {number(report.lost)}
        </Figure>
      </dl>
      <div className="mt-5 grid grid-cols-1 gap-4 border-t border-line pt-4 @3xl:grid-cols-2">
        <div className="min-w-0">
          <p className="label-text">{t('reports.reasons')}</p>
          {answers === 0 ? (
            <p className="mt-1.5 text-sm text-muted">{t('reports.reasons.none')}</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {report.reasons.map((r) => (
                <li
                  key={r.reason}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[0.8125rem] text-fg"
                >
                  {t(`reasons.${r.reason}`)}
                  <span className="num text-subtle">· {plural('reasons.count', r.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <p className="label-text">{t('reports.priority')}</p>
          <p className="mt-1.5 text-sm text-fg">
            {prioritySentence(report.priority, money, t, plural)}
          </p>
        </div>
      </div>
    </article>
  );
}

function Figure({ label, tip, children }: { label: string; tip: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt>
        <LabelTip tip={tip} className="text-[0.8125rem] font-medium text-subtle">
          {label}
        </LabelTip>
      </dt>
      <dd className="num mt-1 text-2xl font-semibold text-fg">{children}</dd>
    </div>
  );
}

/** The priority as the dashboard said it that morning. */
function prioritySentence(
  priority: PriorityAction | null,
  money: (value: number) => string,
  t: ReturnType<typeof useI18n>['t'],
  plural: ReturnType<typeof useI18n>['plural'],
): string {
  if (priority === null) return t('reports.priority.none');
  const amount = money(priority.revenue);
  switch (priority.kind) {
    case 'approve':
      return plural('dash.priority.approve.sentence', priority.actions, { amount });
    case 'retry':
      return plural('dash.priority.retry.sentence', priority.payments, { amount });
    case 'pause':
      return plural('dash.priority.pause.sentence', priority.memberIds.length, { amount });
    case 'message':
      return plural('dash.priority.message.sentence', priority.memberIds.length, { amount });
    case 'review':
      return plural(
        priority.filter === 'failed'
          ? 'dash.priority.review.failed'
          : 'dash.priority.review.cancelling',
        priority.members,
        { amount },
      );
  }
}
