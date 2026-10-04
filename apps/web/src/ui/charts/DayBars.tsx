import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n';
import { ease } from '../../motion';
import { ChartTable } from './ChartTable';
import { CHART } from './theme';

export interface DayBar {
  /** In full, for the tooltip and the table: « Oct 3, 2026 ». */
  label: string;
  /** Short, under the bars: « Oct 3 ». */
  tick: string;
  value: number;
  /** The tooltip's second line: « 38 members active ». */
  detail: string;
}

/**
 * Bars a day (brief v4 §9.5: the members' activity over 30 days): one turquoise bar a day, growing
 * from the baseline one after the other (MOTION.md), a day with nothing a dotted stub. Hover,
 * touch or the arrow keys: the day stands out and its tooltip says what members did. The first,
 * middle and last days under the bars. Screen readers get the table of the days.
 */
export function DayBars({
  label,
  summary,
  bars,
  value,
}: {
  label: string;
  summary: string;
  bars: readonly DayBar[];
  /** A day's figure in words: « 142 actions ». */
  value: (n: number) => string;
}) {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const n = bars.length;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const bar = active === null ? null : bars[active];
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? n - 1;
    const next =
      event.key === 'ArrowLeft'
        ? from - 1
        : event.key === 'ArrowRight'
          ? from + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? n - 1
              : null;
    if (event.key === 'Escape') setActive(null);
    if (next === null) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };
  const ticks = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
      <div
        role="group"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((current) => current ?? n - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="relative flex h-40 touch-pan-y items-end gap-[2px] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        {bars.map((b, index) => (
          <div
            key={b.label}
            data-bar={index}
            onPointerEnter={() => setActive(index)}
            onPointerDown={() => setActive(index)}
            className="relative flex h-full min-w-0 flex-1 items-end"
          >
            {b.value > 0 ? (
              <motion.span
                className={`block w-full origin-bottom rounded-t-[2px] transition-colors duration-150 ${
                  active === null || active === index ? 'bg-turq-300' : 'bg-turq-300/35'
                }`}
                style={{ height: `${Math.max(2, (b.value / max) * 100)}%` }}
                initial={{ scaleY: reduce ? 1 : 0 }}
                animate={{ scaleY: 1 }}
                transition={reduce ? { duration: 0 } : ease('standard', 0.15 + index * 0.012)}
              />
            ) : (
              <span className="baseline-dots block h-px w-full" />
            )}
          </div>
        ))}
        <AnimatePresence>
          {bar && active !== null ? (
            <motion.div
              key="tooltip"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: ease('tooltip') }}
              exit={{ opacity: 0, transition: ease('tooltip') }}
              className={`pointer-events-none absolute top-0 z-10 whitespace-nowrap ${CHART.tooltip}`}
              style={
                active / n > 0.6
                  ? { right: `${((n - active - 1) / n) * 100 + 100 / n}%`, marginRight: 8 }
                  : { left: `${((active + 1) / n) * 100}%`, marginLeft: 8 }
              }
            >
              <p className="text-subtle">{bar.label}</p>
              <p className="metric mt-1 text-sm text-fg">{value(bar.value)}</p>
              <p className="text-subtle">{bar.detail}</p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div aria-hidden="true" className="relative mt-2 h-4">
        {ticks.map((index) => (
          <span
            key={index}
            className={`absolute top-0 ${CHART.axisLabel} ${
              index === 0 ? 'left-0' : index === n - 1 ? 'right-0' : '-translate-x-1/2'
            }`}
            style={
              index === 0 || index === n - 1 ? undefined : { left: `${((index + 0.5) / n) * 100}%` }
            }
          >
            {bars[index]?.tick}
          </span>
        ))}
      </div>
      <ChartTable>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.day')}</th>
            <th scope="col">{label}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.label}>
              <th scope="row">{b.label}</th>
              <td>
                {value(b.value)} · {b.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </ChartTable>
    </figure>
  );
}
