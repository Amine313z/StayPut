import {
  COHORT_HORIZONS,
  addDays,
  forecastRevenue,
  type CohortHorizon,
  type InsightsOverview,
  type InsightsReport,
  type LessonRow,
} from '@stayput/core';
import { BookOpen, CalendarRange, ChartColumn, CircleCheck, TrendingDown } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../../api';
import { ErrorPanel, Loading } from '../../components/Status';
import { useI18n } from '../../i18n';
import { Badge, Notice } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { MetricHero, SecondaryMetric } from '../../ui/Metric';
import { Skeleton } from '../../ui/Skeleton';
import { DayBars } from '../../ui/charts/DayBars';
import { Donut } from '../../ui/charts/Donut';
import { DashKey, ForecastChart } from '../../ui/charts/ForecastChart';
import { LessonBars } from '../../ui/charts/LessonBars';
import { RetentionChart } from '../../ui/charts/RetentionChart';
import { useCreatorData } from '../CreatorView';

/** Lessons shown before « Show all »; bars drawn above the table. */
const LESSON_PREVIEW = 8;

/** The « and if » slider's start: every member at risk reached. */
const FULL_REACH = 100;

// The tables scroll sideways on a phone. `relative` keeps their screen-reader-only words
// (positioned absolutely) inside the scrolling box: without it they would widen the page.
const TABLE_SCROLL = 'relative -mx-5 overflow-x-auto px-5';
const HEAD_CELL = 'px-3 py-2 text-end text-xs font-medium text-muted';
const CELL = 'tabular px-3 py-2.5 text-end';

/** An amount in the community's currency, with its cents; a count when it has none. */
function useMoney(currency: string | null): (value: number) => string {
  const { currency: format, number } = useI18n();
  return (value) => (currency ? format(value, currency) : number(Math.round(value)));
}

/**
 * Analytics › Overview (brief v4 §9.5): the revenue of the next 90 days if you act and if you do
 * nothing, with the « and if » slider (SPEC 6.5–6.6); why members leave (the departure survey,
 * SPEC 6.8) and what they did over 30 days. Read at once, not by the weekly analyses.
 */
export function OverviewTab() {
  const { api } = useCreatorData();
  const { state, retry } = useApi<InsightsOverview>(`${api}/insights/overview`);
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  const view = state.status === 'ready' ? state.data : null;
  return (
    <div className="space-y-10">
      <Forecast view={view} />
      <div className="grid grid-cols-1 gap-10 border-t border-line pt-8 @4xl:grid-cols-2">
        <Reasons view={view} />
        <Activity view={view} />
      </div>
    </div>
  );
}

/**
 * The 90-day forecast, the page's hero: what acting keeps (the one large amount), what each way
 * brings, the two lines, and the slider that says how many members at risk StayPut reaches.
 */
function Forecast({ view }: { view: InsightsOverview | null }) {
  const { t, percent, calendarDay, calendarDate, number, currency } = useI18n();
  const { members } = useCreatorData();
  const titleId = useId();
  const [reach, setReach] = useState(FULL_REACH);
  const money = useMoney(view?.currency ?? null);
  const forecast = useMemo(
    () =>
      view
        ? forecastRevenue({
            revenue: view.revenue,
            stay: view.stay,
            saveRate: view.saveRate,
            reached: reach / 100,
          })
        : null,
    [view, reach],
  );
  const summary = members.state.status === 'ready' ? members.state.data.summary.risk : null;
  const atRisk = summary ? summary.high + summary.scheduledDeparture : null;
  // The community's today: the last day of its 30 days of activity.
  const today = view?.activity.at(-1)?.day ?? null;
  const own = view ? view.calibrated.length + (view.saveRateObserved ? 1 : 0) : 0;

  return (
    <section aria-labelledby={titleId} className="relative isolate space-y-6">
      <span aria-hidden="true" className="hero-glow -z-10" style={{ left: -260, top: -300 }} />
      <h2 id={titleId} className="title-section">
        {t('forecast.title')}
      </h2>
      {view && view.currency === null ? (
        <EmptyState
          icon={<ChartColumn aria-hidden="true" className="size-5" />}
          body={t('forecast.empty')}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
            {forecast ? (
              <MetricHero
                better="up"
                label={t('forecast.gain')}
                tip={t('forecast.gain.info')}
                value={forecast.gain}
                format={(value) => (value > 0 ? `+${money(value)}` : money(value))}
              />
            ) : (
              <Skeleton className="h-20 w-64" />
            )}
            <div className="flex gap-10">
              {forecast ? (
                <>
                  <SecondaryMetric
                    better="up"
                    label={t('forecast.act')}
                    tip={t('forecast.act.info')}
                    value={forecast.total.act}
                    format={money}
                  />
                  <SecondaryMetric
                    better="up"
                    label={t('forecast.doNothing')}
                    tip={t('forecast.doNothing.info')}
                    value={forecast.total.doNothing}
                    format={money}
                  />
                </>
              ) : (
                <>
                  <Skeleton className="h-14 w-32" />
                  <Skeleton className="h-14 w-32" />
                </>
              )}
            </div>
          </div>
          {forecast && today ? (
            <ForecastChart
              label={t('forecast.chart')}
              summary={t('forecast.summary', {
                act: money(forecast.act.at(-1) ?? 0),
                alone: money(forecast.doNothing.at(-1) ?? 0),
              })}
              ticks={[0, 30, 60, 90].map((day) => ({
                day,
                label: day === 0 ? t('forecast.today') : calendarDay(addDays(today, day)),
              }))}
              act={{ label: t('forecast.act'), values: forecast.act }}
              doNothing={{ label: t('forecast.doNothing'), values: forecast.doNothing }}
              format={money}
              axis={(value) =>
                view?.currency ? currency(value, view.currency, { compact: true }) : number(value)
              }
              dayLabel={(day) => calendarDate(addDays(today, day))}
              gapLabel={t('forecast.gap')}
            />
          ) : (
            <Skeleton className="h-[200px] w-full rounded-xl" />
          )}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="h-0.5 w-4 shrink-0 rounded-full bg-turq-300" />
              {t('forecast.act')}
            </span>
            <span className="inline-flex items-center gap-2">
              <DashKey width={16} />
              {t('forecast.doNothing')}
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-4 shrink-0 rounded-[2px] bg-turq-300/15"
              />
              {t('forecast.gain')}
            </span>
          </div>
          <label className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5 text-sm">
            <span className="text-muted">{t('forecast.reach')}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={10}
              value={reach}
              disabled={!view}
              onChange={(event) => setReach(Number(event.target.value))}
              aria-valuetext={t('forecast.reach.value', { percent: percent(reach / 100) })}
              className="w-48 cursor-pointer accent-turq-300 disabled:cursor-default"
            />
            <span className="text-fg">
              {t('forecast.reach.value', { percent: percent(reach / 100) })}
              {atRisk !== null ? (
                <span className="text-subtle">
                  {' · '}
                  {t('forecast.reach.count', {
                    count: number(Math.round((atRisk * reach) / 100)),
                    total: number(atRisk),
                  })}
                </span>
              ) : null}
            </span>
          </label>
          {view ? (
            <p className="max-w-3xl text-xs text-subtle">
              {t('forecast.how', {
                low: percent(view.stay.low),
                medium: percent(view.stay.medium),
                high: percent(view.stay.high),
                save: percent(view.saveRate),
              })}{' '}
              {t(
                own === 0
                  ? 'forecast.how.default'
                  : own === 5
                    ? 'forecast.how.own'
                    : 'forecast.how.mixed',
              )}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Why members leave: the departure survey's answers of 90 days, as a donut. */
function Reasons({ view }: { view: InsightsOverview | null }) {
  const { t, plural, percent } = useI18n();
  const titleId = useId();
  const total = view?.reasons.reduce((sum, r) => sum + r.count, 0) ?? 0;
  return (
    <section aria-labelledby={titleId} className="min-w-0 space-y-4">
      <header>
        <h2 id={titleId} className="title-section">
          {t('reasons.title')}
        </h2>
        <p className="mt-1 text-sm text-muted">{t('reasons.description')}</p>
      </header>
      {view === null ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : total === 0 ? (
        <EmptyState inset body={t('reasons.empty')} />
      ) : (
        <Donut
          label={t('reasons.chart')}
          slices={view.reasons.map((r) => ({
            id: r.reason,
            label: t(`reasons.${r.reason}`),
            value: r.count,
          }))}
          total={total}
          totalLabel={plural('reasons.center', total)}
          count={(n) => plural('reasons.count', n)}
          percent={percent}
        />
      )}
    </section>
  );
}

/** What members did each day over 30 days: the dashboard's « Member activity (30d) », drawn. */
function Activity({ view }: { view: InsightsOverview | null }) {
  const { t, plural, calendarDay, calendarDate } = useI18n();
  const titleId = useId();
  const total = view?.activity.reduce((sum, d) => sum + d.actions, 0) ?? 0;
  return (
    <section aria-labelledby={titleId} className="min-w-0 space-y-4">
      <header>
        <h2 id={titleId} className="title-section">
          {t('activity30.title')}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {view ? plural('activity30.total', total) : <Skeleton className="h-4 w-48" />}
        </p>
      </header>
      {view === null ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : (
        <DayBars
          label={t('activity30.chart')}
          summary={t('activity30.summary')}
          bars={view.activity.map((d) => ({
            label: calendarDate(d.day),
            tick: calendarDay(d.day),
            value: d.actions,
            detail: plural('activity30.members', d.members),
          }))}
          value={(n) => plural('activity30.day', n)}
        />
      )}
    </section>
  );
}

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
function Rate({ value, flagged = false }: { value: number | null; flagged?: boolean }) {
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
    <td className={`${CELL} ${flagged ? 'font-semibold text-turq-300' : ''}`}>
      {percent(value)}
      {flagged ? <span className="sr-only"> ({t('cohorts.flagged')})</span> : null}
    </td>
  );
}

/**
 * Each month of arrivals against the creator's average, at 30, 60 and 90 days: the retention
 * curves first (brief v4 §9.5), the table below as detail, the flagged month with a turquoise
 * edge (no red). A row pointed at lights its curve.
 */
function Cohorts({ report }: { report: InsightsReport }) {
  const { t, number, month, percent, plural } = useI18n();
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const kept = (rate: number | null) => (rate === null ? null : Math.max(0, 1 - rate));
  const alerts = report.cohorts.flatMap((cohort) => {
    const horizon = cohort.alertHorizon;
    const rate = horizon === null ? null : cohort.rates[horizon];
    const average = horizon === null ? null : report.averages[horizon];
    return horizon !== null && rate !== null && average
      ? [{ month: cohort.month, horizon, ratio: Math.round((rate / average) * 10) / 10 }]
      : [];
  });
  return (
    <div className="space-y-8">
      {report.cohorts.length > 0 ? (
        <section className="space-y-4">
          <h2 className="title-section">{t('cohorts.chart')}</h2>
          <RetentionChart
            label={t('cohorts.chart')}
            summary={t('cohorts.chart.summary')}
            marks={[
              t('cohorts.mark.joined'),
              ...COHORT_HORIZONS.map((days) => t('cohorts.mark.days', { days })),
            ]}
            lines={[...report.cohorts].reverse().map((cohort) => ({
              id: cohort.month,
              label: month(new Date(cohort.month)),
              detail: plural('cohorts.detail', cohort.members),
              values: [1, ...COHORT_HORIZONS.map((days) => kept(cohort.rates[days]))],
              flagged: cohort.alertHorizon !== null,
            }))}
            average={[1, ...COHORT_HORIZONS.map((days) => kept(report.averages[days]))]}
            averageLabel={t('cohorts.average')}
            highlighted={highlighted}
            onHighlight={setHighlighted}
            percent={percent}
          />
        </section>
      ) : null}
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
                    tone="info"
                    icon={<TrendingDown aria-hidden="true" className="size-4" />}
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
                    <th scope="col" className={`${HEAD_CELL} ps-3 text-start`}>
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
                  {report.cohorts.map((cohort) => {
                    const flagged = cohort.alertHorizon !== null;
                    return (
                      <tr
                        key={cohort.month}
                        data-cohort={cohort.month}
                        data-flagged={flagged}
                        onPointerEnter={() => setHighlighted(cohort.month)}
                        onPointerLeave={() => setHighlighted(null)}
                        className={`transition-colors duration-150 ${
                          highlighted === cohort.month ? 'bg-surface-2/60' : ''
                        }`}
                      >
                        <th
                          scope="row"
                          className={`border-s-2 py-2.5 ps-3 pe-3 text-start font-medium ${
                            flagged ? 'border-turq-300' : 'border-transparent'
                          }`}
                        >
                          {month(new Date(cohort.month))}
                        </th>
                        <td className={CELL}>{number(cohort.members)}</td>
                        {COHORT_HORIZONS.map((days: CohortHorizon) => (
                          <Rate
                            key={days}
                            value={cohort.rates[days]}
                            flagged={cohort.alertHorizon === days}
                          />
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line">
                    <th
                      scope="row"
                      className="border-s-2 border-transparent py-2.5 ps-3 pe-3 text-start font-medium text-muted"
                    >
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
    </div>
  );
}

/**
 * The lessons members stall after, the flagged ones first (as the Worker sends them): bars first
 * (brief v4 §9.5), the table below as detail. Flagged in turquoise, never red.
 */
function Lessons({ lessons }: { lessons: readonly LessonRow[] }) {
  const { t, number, percent } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? lessons : lessons.slice(0, LESSON_PREVIEW);
  const title = (lesson: LessonRow) => lesson.title ?? t('lessons.untitled');
  return (
    <div className="space-y-8">
      {lessons.length > 0 ? (
        <section className="space-y-4">
          <h2 className="title-section">{t('lessons.chart')}</h2>
          <LessonBars
            label={t('lessons.chart')}
            bars={lessons.slice(0, LESSON_PREVIEW).map((lesson) => ({
              id: lesson.lessonId,
              label: title(lesson),
              detail: t('lessons.detail', {
                stalled: number(lesson.stalled),
                reached: number(lesson.reached),
              }),
              rate: lesson.rate,
              average: lesson.courseAverage,
              flagged: lesson.flagged,
            }))}
            percent={percent}
            averageLabel={t('lessons.courseAverage')}
          />
        </section>
      ) : null}
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
                          <span className="min-w-0">{title(lesson)}</span>
                          {lesson.flagged ? (
                            <Badge tone="accent">{t('lessons.flagged')}</Badge>
                          ) : null}
                        </span>
                      </th>
                      <td className={CELL}>
                        {t('lessons.stalledOf', {
                          stalled: number(lesson.stalled),
                          reached: number(lesson.reached),
                        })}
                      </td>
                      <td
                        className={`${CELL} ${lesson.flagged ? 'font-semibold text-turq-300' : ''}`}
                      >
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
    </div>
  );
}
