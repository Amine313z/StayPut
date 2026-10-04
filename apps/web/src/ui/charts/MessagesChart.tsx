import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../../i18n';
import { DURATION, EASE, ease } from '../../motion';
import { smoothPath } from './curve';
import { ChartTable } from './ChartTable';
import { CHART } from './theme';

/** The plot's own units: as wide as it likes (the SVG stretches), 200 px high. */
const W = 1000;
const H = 200;
/** Room above the highest point, so the line and its dot never touch the top. */
const HEADROOM = 1.15;

export interface MessagesDay {
  /** In full, for the tooltip and the table: « Oct 3, 2026 ». */
  label: string;
  /** Short, under the plot: « Oct 3 ». */
  tick: string;
  /** Everyone's messages that day. */
  messages: number;
  /** The members'. */
  members: number;
  /** The members' at risk today. */
  atRisk: number;
}

/**
 * The messages of a platform day by day (brief v4 §9.6), drawn as the balance is (brief v4 §8):
 * no box, no grid, no value axis; everyone's messages as a 2 px turquoise line over its area
 * fading out, the members at risk today as a thin dashed line on the same scale (shown or hidden
 * from the legend), a dotted baseline, a dot pulsing on today. Hover, touch or the arrow keys
 * read a day (a hairline, a dot on each line, a tooltip with the members' share); a click,
 * Enter or Space picks it, and the page shows that day's channels and members until it is
 * picked again or Escape. MOTION.md: the lines draw in (1.2 s), the area fades in after them.
 * Screen readers get a sentence and the table of the days.
 */
export function MessagesChart({
  label,
  summary,
  days,
  picked,
  onPick,
  labels,
}: {
  label: string;
  summary: string;
  days: readonly MessagesDay[];
  /** The day picked, by its index; null: none. */
  picked: number | null;
  onPick: (index: number | null) => void;
  labels: { all: string; members: string; atRisk: string };
}) {
  const { t, number } = useI18n();
  const id = useId();
  const reduce = useReducedMotion();
  const plot = useRef<HTMLDivElement>(null);
  const pressed = useRef<{ x: number; index: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [showRisk, setShowRisk] = useState(true);
  const n = days.length;
  /** A day's place across the plot: the middle of its slice. */
  const along = (index: number) => (n > 0 ? (index + 0.5) / n : 0);

  const geometry = useMemo(() => {
    const count = days.length;
    const at = (index: number) => ((index + 0.5) / count) * W;
    const max = Math.max(1, ...days.map((d) => d.messages));
    const top = max * HEADROOM;
    const y = (value: number) => H - (Math.max(0, value) / top) * H;
    const line = smoothPath(days.map((d, i) => ({ x: at(i), y: y(d.messages) })));
    return {
      top,
      line,
      area: count > 0 ? `${line}L${at(count - 1)} ${H}L${at(0)} ${H}Z` : '',
      risk: smoothPath(days.map((d, i) => ({ x: at(i), y: y(d.atRisk) }))),
    };
  }, [days]);

  const yOf = (value: number) => (1 - Math.max(0, value) / geometry.top) * H;
  const measure = () => setWidth(plot.current?.getBoundingClientRect().width ?? 0);
  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setWidth(box.width);
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    return Math.max(0, Math.min(n - 1, Math.floor(fraction * n)));
  };
  const pick = (index: number) => onPick(index === picked ? null : index);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? picked ?? n - 1;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(from);
      return;
    }
    if (event.key === 'Escape') {
      setActive(null);
      onPick(null);
      return;
    }
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
    if (next === null) return;
    event.preventDefault();
    measure();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };

  const day = active === null ? null : days[active];
  const x = active === null ? 0 : along(active) * width;
  const today = days.at(-1);
  const follow = reduce ? '' : 'transition-transform duration-[80ms] ease-linear';
  const riskShown = showRisk && days.some((d) => d.atRisk > 0);
  const spoken = day
    ? t('chart.reading', {
        day: day.label,
        figures: [
          `${labels.all} ${number(day.messages)}`,
          `${labels.members} ${number(day.members)}`,
          `${labels.atRisk} ${number(day.atRisk)}`,
        ].join(', '),
      })
    : '';

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
      <div
        ref={plot}
        role="group"
        aria-label={label}
        tabIndex={0}
        data-chart="messages"
        onPointerMove={(event) => setActive(indexAt(event))}
        onPointerDown={(event) => {
          const index = indexAt(event);
          setActive(index);
          pressed.current = { x: event.clientX, index };
        }}
        onPointerUp={(event) => {
          // A press that did not slide along the plot picks its day.
          const start = pressed.current;
          pressed.current = null;
          if (start && Math.abs(event.clientX - start.x) < 8) pick(start.index);
        }}
        onPointerLeave={() => {
          pressed.current = null;
          setActive(null);
        }}
        onFocus={() => {
          measure();
          setActive((current) => current ?? picked ?? n - 1);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative h-[200px] cursor-pointer touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        {/* The day picked: a soft band behind the lines. */}
        {picked !== null ? (
          <span
            aria-hidden="true"
            data-chart="picked"
            className="pointer-events-none absolute inset-y-0 bg-turq-300/10"
            style={{ left: `${(picked / n) * 100}%`, width: `${100 / n}%` }}
          />
        ) : null}
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
              {CHART.areaStops.map((stop) => (
                <stop
                  key={stop.offset}
                  offset={stop.offset}
                  style={{ stopColor: stop.color, stopOpacity: stop.opacity }}
                />
              ))}
            </linearGradient>
            <clipPath id={`${id}-draw`}>
              <motion.rect
                x={0}
                y={-12}
                height={H + 24}
                initial={{ width: reduce ? W : 0 }}
                animate={{ width: W }}
                transition={ease('draw')}
              />
            </clipPath>
          </defs>
          <motion.path
            fill={`url(#${id}-fill)`}
            initial={{ opacity: reduce ? 1 : 0, d: geometry.area }}
            animate={{ opacity: 1, d: geometry.area }}
            transition={{
              opacity: reduce ? { duration: 0 } : ease('fill', DURATION.draw),
              d: reduce ? { duration: 0 } : ease('morph'),
            }}
          />
          <g clipPath={`url(#${id}-draw)`}>
            <motion.path
              data-chart="at-risk"
              fill="none"
              strokeWidth={1}
              strokeDasharray={CHART.dash}
              vectorEffect="non-scaling-stroke"
              className={CHART.comparison}
              initial={{ d: geometry.risk, opacity: riskShown ? 1 : 0 }}
              animate={{ d: geometry.risk, opacity: riskShown ? 1 : 0 }}
              transition={{ d: reduce ? { duration: 0 } : ease('morph'), opacity: ease('hover') }}
            />
            <motion.path
              data-chart="all"
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={CHART.line}
              initial={{ d: geometry.line }}
              animate={{ d: geometry.line }}
              transition={{ d: reduce ? { duration: 0 } : ease('morph') }}
            />
          </g>
        </svg>
        <span
          aria-hidden="true"
          className="baseline-dots pointer-events-none absolute inset-x-0 bottom-0 h-px"
        />
        {/* Today: a dot where the line arrives, pulsing once it is drawn. */}
        {today ? (
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute top-0"
            initial={{ opacity: reduce ? 1 : 0 }}
            animate={{ opacity: 1 }}
            transition={ease('micro', DURATION.draw)}
            style={{
              left: `${along(n - 1) * 100}%`,
              transform: `translate(-50%, calc(${yOf(today.messages)}px - 50%))`,
            }}
          >
            <span className="relative flex size-1.5">
              {reduce ? null : (
                <motion.span
                  className="absolute inset-0 rounded-full bg-turq-300"
                  initial={{ scale: 1, opacity: 0 }}
                  animate={{ scale: [1, 1.8], opacity: [0.6, 0] }}
                  transition={{
                    duration: DURATION.pulse,
                    ease: EASE,
                    repeat: Infinity,
                    repeatDelay: DURATION.pulse,
                    delay: DURATION.draw,
                  }}
                />
              )}
              <span className="relative size-1.5 rounded-full bg-turq-300" />
            </span>
          </motion.span>
        ) : null}
        {active !== null && day ? (
          <>
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-y-0 left-0 w-px ${CHART.crosshair} ${follow}`}
              style={{ transform: `translateX(${x}px)` }}
            />
            {riskShown ? (
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-0 left-0 size-2 rounded-full ${CHART.comparisonMarker} ${CHART.markerRing} ${follow}`}
                style={{
                  transform: `translate(calc(${x}px - 50%), calc(${yOf(day.atRisk)}px - 50%))`,
                }}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 left-0 size-2.5 rounded-full ${CHART.marker} ${CHART.markerRing} ${follow}`}
              style={{
                transform: `translate(calc(${x}px - 50%), calc(${yOf(day.messages)}px - 50%))`,
              }}
            />
          </>
        ) : null}
        <AnimatePresence>
          {active !== null && day ? (
            <motion.div
              key="tooltip"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: ease('tooltip') }}
              exit={{ opacity: 0, transition: ease('tooltip') }}
              className={`pointer-events-none absolute top-1 left-0 z-10 whitespace-nowrap ${CHART.tooltip} ${follow}`}
              style={{
                transform:
                  along(active) > 0.6
                    ? `translateX(calc(${x}px - 100% - 12px))`
                    : `translateX(${x + 12}px)`,
              }}
            >
              <p className="text-subtle">{day.label}</p>
              <p className="mt-1 flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-2.5 shrink-0 rounded-full bg-turq-300" />
                  {labels.all}
                </span>
                <span className="metric text-sm text-fg">{number(day.messages)}</span>
              </p>
              <p className="mt-0.5 flex items-center justify-between gap-4">
                <span className="ps-4">{labels.members}</span>
                <span className="metric text-sm text-fg">{number(day.members)}</span>
              </p>
              {riskShown ? (
                <p className="mt-0.5 flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <svg width="10" height="2" viewBox="0 0 10 2" className="shrink-0">
                      <line
                        x1="0"
                        x2="10"
                        y1="1"
                        y2="1"
                        strokeWidth="1"
                        strokeDasharray="2 2"
                        className={CHART.comparison}
                      />
                    </svg>
                    {labels.atRisk}
                  </span>
                  <span className="metric text-sm text-fg">{number(day.atRisk)}</span>
                </p>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {/* Under the plot, the day read, else the day picked: never all thirty. */}
      <div aria-hidden="true" className="relative h-5">
        {(active ?? picked) !== null ? (
          <span
            className={`absolute top-1.5 left-0 ${CHART.axisLabel} ${follow}`}
            style={{
              transform: `translateX(clamp(0px, calc(${along((active ?? picked)!) * width}px - 50%), calc(${width}px - 100%)))`,
            }}
          >
            {days[(active ?? picked)!]?.tick}
          </span>
        ) : null}
      </div>
      <div className={`mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 ${CHART.legend}`}>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-4 shrink-0 rounded-[2px] border-t-2 border-turq-300 bg-turq-300/20"
          />
          {labels.all}
        </span>
        <button
          type="button"
          aria-pressed={showRisk}
          onClick={() => setShowRisk((shown) => !shown)}
          className={`-mx-1 inline-flex items-center gap-2 rounded-md px-1 transition-opacity duration-200 ease-brand hover:text-fg focus-visible:outline-2 focus-visible:outline-accent ${
            showRisk ? '' : 'opacity-50'
          }`}
        >
          <svg aria-hidden="true" width="16" height="10" viewBox="0 0 16 10" className="shrink-0">
            <line
              x1="0"
              x2="16"
              y1="5"
              y2="5"
              strokeWidth="1"
              strokeDasharray="3 3"
              className={CHART.comparison}
            />
          </svg>
          {labels.atRisk}
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>
      <ChartTable>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.day')}</th>
            <th scope="col">{labels.all}</th>
            <th scope="col">{labels.members}</th>
            <th scope="col">{labels.atRisk}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{number(d.messages)}</td>
              <td>{number(d.members)}</td>
              <td>{number(d.atRisk)}</td>
            </tr>
          ))}
        </tbody>
      </ChartTable>
    </figure>
  );
}
