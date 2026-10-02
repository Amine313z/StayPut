import {
  COHORT_HORIZONS,
  type CohortHorizon,
  type InsightsReport,
  type LessonRow,
} from '@stayput/core';
import { BookOpen, CalendarRange, ChartColumn, CircleCheck, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApi } from '../../api';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Badge, Notice } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { useCreatorData } from '../CreatorView';

/** Lessons shown before « Show all ». */
const LESSON_PREVIEW = 8;

// The tables scroll sideways on a phone. `relative` keeps their screen-reader-only words
// (positioned absolutely) inside the scrolling box: without it they would widen the page.
const TABLE_SCROLL = 'relative -mx-5 overflow-x-auto px-5';
const HEAD_CELL = 'px-3 py-2 text-end text-xs font-medium text-muted';
const CELL = 'tabular px-3 py-2.5 text-end';

/**
 * The weekly analyses (SPEC Phase 3), once read: when they ran, then the tab's part. Before the
 * first ones, what is coming.
 */
function WithReport({ children }: { children: (report: InsightsReport) => ReactNode }) {
  const { t, relative } = useI18n();
  const { api } = useCreatorData();
  const { state, retry } = useApi<InsightsReport>(`${api}/insights`);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  const report = state.data;
  if (report.computedAt === null) {
    return (
      <EmptyState
        icon={<ChartColumn aria-hidden="true" className="size-5" />}
        body={t('insights.pending')}
      />
    );
  }
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {t('insights.computed', { when: relative(new Date(report.computedAt)) })}
      </p>
      {children(report)}
    </div>
  );
}

/** Analytics › Cohorts: the months of arrival whose members leave faster. */
export function CohortsTab() {
  return <WithReport>{(report) => <Cohorts report={report} />}</WithReport>;
}

/** Analytics › Lessons: the lessons members stall after. */
export function LessonsTab() {
  return <WithReport>{(report) => <Lessons lessons={report.lessons} />}</WithReport>;
}

/** A departure rate; « — » while no member of the month is old enough. */
function Rate({ value, alert = false }: { value: number | null; alert?: boolean }) {
  const { t, percent } = useI18n();
  if (value === null) {
    return (
      <td className={`${CELL} text-muted`}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('cohorts.tooEarly')}</span>
      </td>
    );
  }
  return (
    <td className={`${CELL} ${alert ? 'font-semibold text-serious' : ''}`}>
      <span className="inline-flex items-center justify-end gap-1">
        {alert ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
        {percent(value)}
        {alert ? <span className="sr-only">{t('cohorts.flagged')}</span> : null}
      </span>
    </td>
  );
}

/** Each month of arrivals against the creator's average, at 30, 60 and 90 days. */
function Cohorts({ report }: { report: InsightsReport }) {
  const { t, number, month } = useI18n();
  const alerts = report.cohorts.flatMap((cohort) => {
    const horizon = cohort.alertHorizon;
    const rate = horizon === null ? null : cohort.rates[horizon];
    const average = horizon === null ? null : report.averages[horizon];
    return horizon !== null && rate !== null && average
      ? [{ month: cohort.month, horizon, ratio: Math.round((rate / average) * 10) / 10 }]
      : [];
  });
  return (
    <Card
      icon={<CalendarRange aria-hidden="true" className="size-4" />}
      title={t('cohorts.title')}
      description={t('cohorts.description')}
    >
      {report.cohorts.length === 0 ? (
        <p className="text-sm text-muted">{t('cohorts.empty')}</p>
      ) : (
        <div className="space-y-4">
          {alerts.length > 0 ? (
            <div className="space-y-2">
              {alerts.map((alert) => (
                <Notice
                  key={alert.month}
                  tone="serious"
                  icon={<TriangleAlert aria-hidden="true" className="size-4" />}
                >
                  {t('cohorts.alert', {
                    month: month(new Date(alert.month)),
                    ratio: number(alert.ratio),
                    days: alert.horizon,
                  })}
                </Notice>
              ))}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <CircleCheck aria-hidden="true" className="size-4 text-accent" />
              {t('cohorts.noAlert')}
            </p>
          )}
          <div className={TABLE_SCROLL}>
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={`${HEAD_CELL} ps-0 text-start`}>
                    {t('cohorts.month')}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t('cohorts.members')}
                  </th>
                  {COHORT_HORIZONS.map((days) => (
                    <th key={days} scope="col" className={HEAD_CELL}>
                      {t('cohorts.horizon', { days })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {report.cohorts.map((cohort) => (
                  <tr key={cohort.month}>
                    <th scope="row" className="py-2.5 pe-3 text-start font-medium">
                      {month(new Date(cohort.month))}
                    </th>
                    <td className={CELL}>{number(cohort.members)}</td>
                    {COHORT_HORIZONS.map((days: CohortHorizon) => (
                      <Rate
                        key={days}
                        value={cohort.rates[days]}
                        alert={cohort.alertHorizon === days}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line">
                  <th scope="row" className="py-2.5 pe-3 text-start font-medium text-muted">
                    {t('cohorts.average')}
                  </th>
                  <td />
                  {COHORT_HORIZONS.map((days) => (
                    <Rate key={days} value={report.averages[days]} />
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

/** The lessons members stall after, the flagged ones first (as the Worker sends them). */
function Lessons({ lessons }: { lessons: readonly LessonRow[] }) {
  const { t, number, percent } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? lessons : lessons.slice(0, LESSON_PREVIEW);
  return (
    <Card
      icon={<BookOpen aria-hidden="true" className="size-4" />}
      title={t('lessons.title')}
      description={t('lessons.description')}
    >
      {lessons.length === 0 ? (
        <p className="text-sm text-muted">{t('lessons.empty')}</p>
      ) : (
        <div className="space-y-4">
          {lessons.some((lesson) => lesson.flagged) ? null : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <CircleCheck aria-hidden="true" className="size-4 text-accent" />
              {t('lessons.noFlag')}
            </p>
          )}
          <div className={TABLE_SCROLL}>
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={`${HEAD_CELL} ps-0 text-start`}>
                    {t('lessons.lesson')}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t('lessons.stalled')}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t('lessons.rate')}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t('lessons.courseAverage')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((lesson) => (
                  <tr key={lesson.lessonId}>
                    <th scope="row" className="py-2.5 pe-3 text-start font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0">{lesson.title ?? t('lessons.untitled')}</span>
                        {lesson.flagged ? (
                          <Badge
                            tone="serious"
                            icon={<TriangleAlert aria-hidden="true" className="size-3" />}
                          >
                            {t('lessons.flagged')}
                          </Badge>
                        ) : null}
                      </span>
                    </th>
                    <td className={CELL}>
                      {t('lessons.stalledOf', {
                        stalled: number(lesson.stalled),
                        reached: number(lesson.reached),
                      })}
                    </td>
                    <td className={`${CELL} ${lesson.flagged ? 'font-semibold text-serious' : ''}`}>
                      {percent(lesson.rate)}
                    </td>
                    <td className={`${CELL} text-muted`}>{percent(lesson.courseAverage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!all && lessons.length > LESSON_PREVIEW ? (
            <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
              {t('lessons.showAll', { count: number(lessons.length) })}
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
