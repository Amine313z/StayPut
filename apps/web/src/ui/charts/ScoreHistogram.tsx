import { motion, useReducedMotion } from 'motion/react';
import { useI18n } from '../../i18n';
import { ease } from '../../motion';
import { ChartTable } from './ChartTable';
import { CHART } from './theme';

/**
 * How the members' scores spread (brief v4 §9.6, the signals' live preview): a bar for each ten
 * points, 0–9 to 90–100, the scores these settings would give in turquoise, today's as a white
 * outline behind them, so what moves shows at a glance. The levels' thresholds are hairlines
 * with their names. Bars grow and shrink as the settings move (transform only, MOTION.md); the
 * figures are in the table for screen readers.
 */
export function ScoreHistogram({
  label,
  now,
  next,
  thresholds,
  labels,
}: {
  label: string;
  /** Members per ten points with the settings saved. */
  now: readonly number[];
  /** With the settings shown. */
  next: readonly number[];
  thresholds: { mediumFrom: number; highFrom: number };
  labels: { now: string; next: string; medium: string; high: string; range: string };
}) {
  const { t, number } = useI18n();
  const reduce = useReducedMotion();
  const max = Math.max(1, ...now, ...next);
  const bins = next.map((count, i) => ({ count, before: now[i] ?? 0, from: i * 10 }));
  return (
    <figure className="min-w-0">
      <div aria-hidden="true" className="relative h-28">
        <div className="absolute inset-0 flex items-end gap-1">
          {bins.map((bin) => (
            <div
              key={bin.from}
              data-bin={bin.from}
              data-count={bin.count}
              className="relative flex h-full flex-1 items-end"
            >
              {/* Today's, an outline behind. */}
              <span
                className="absolute inset-x-0 bottom-0 rounded-t-[2px] border border-b-0 border-white-500/70"
                style={{ height: `${(bin.before / max) * 100}%` }}
              />
              {bin.count > 0 ? (
                <motion.span
                  className="relative block w-full origin-bottom rounded-t-[2px] bg-turq-300/80"
                  initial={false}
                  animate={{ height: `${(bin.count / max) * 100}%` }}
                  transition={reduce ? { duration: 0 } : ease('standard')}
                />
              ) : null}
            </div>
          ))}
        </div>
        {[
          { at: thresholds.mediumFrom, name: labels.medium },
          { at: thresholds.highFrom, name: labels.high },
        ].map((line) => (
          <span
            key={line.name}
            className="pointer-events-none absolute inset-y-0 w-0"
            style={{ left: `${Math.min(100, line.at)}%` }}
          >
            <span className={`absolute inset-y-0 left-0 w-px ${CHART.reference}`} />
            <span className={`absolute -top-0.5 left-1.5 ${CHART.axisLabel}`}>
              {line.name} {number(line.at)}
            </span>
          </span>
        ))}
      </div>
      <div aria-hidden="true" className="relative mt-1.5 h-4">
        {[0, 50, 100].map((score) => (
          <span
            key={score}
            className={`absolute top-0 ${CHART.axisLabel} ${
              score === 0 ? 'left-0' : score === 100 ? 'right-0' : '-translate-x-1/2'
            }`}
            style={score === 50 ? { left: '50%' } : undefined}
          >
            {number(score)}
          </span>
        ))}
      </div>
      <figcaption className={`mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 ${CHART.legend}`}>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="h-2.5 w-3 rounded-[2px] bg-turq-300/80" />
          {labels.next}
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-3 rounded-[2px] border border-b-0 border-white-500/70"
          />
          {labels.now}
        </span>
      </figcaption>
      <ChartTable>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{labels.range}</th>
            <th scope="col">{labels.now}</th>
            <th scope="col">{labels.next}</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin) => (
            <tr key={bin.from}>
              <th scope="row">
                {t('signals.preview.bin', {
                  from: number(bin.from),
                  to: number(bin.from === 90 ? 100 : bin.from + 9),
                })}
              </th>
              <td>{number(bin.before)}</td>
              <td>{number(bin.count)}</td>
            </tr>
          ))}
        </tbody>
      </ChartTable>
    </figure>
  );
}
