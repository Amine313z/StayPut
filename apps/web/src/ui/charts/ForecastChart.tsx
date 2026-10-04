import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../../i18n';
import { ease } from '../../motion';
import { polylinePath } from './curve';
import { ChartTable } from './ChartTable';
import { CHART } from './theme';

/** The plot's own units: as wide as it likes (the SVG stretches), as tall as it is drawn. */
const W = 1000;
const H = 200;

/**
 * The value scale: round steps (1, 2, 2.5 or 5 times a power of ten) around the lines, with a
 * little room above and below. It rests on the « do nothing » line and today's revenue only, so
 * it stays still while the slider moves the other line.
 */
export function forecastScale(
  high: number,
  low: number,
): { lo: number; hi: number; ticks: number[] } {
  const range = high - low || Math.abs(high) * 0.1 || 1;
  const raw = range / 3;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step =
    (normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 2.5
          ? 2.5
          : normalized <= 5
            ? 5
            : 10) * magnitude;
  const lo = Math.max(0, Math.floor((low - range * 0.1) / step) * step);
  const hi = Math.ceil((high + range * 0.05) / step) * step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) ticks.push(value);
  return { lo, hi, ticks };
}

export interface ForecastSeries {
  label: string;
  /** One value a day, from today (0) to the last day. */
  values: readonly number[];
}

/**
 * The 90-day forecast (brief v4 §9.5: « two animated lines, act vs do nothing »): the monthly
 * revenue expected each day if StayPut acts (a 2 px turquoise line) and if nothing is done (a
 * 1 px dashed white-500 line), the money acting keeps between them, lightly filled. The scale
 * starts near the lines, not at zero, so the gap shows: faint round values on the left say it;
 * today and each month to come under the plot. Hover, touch or the arrow keys: a hairline, a dot
 * on each line and a tooltip with both figures and their difference. The
 * lines draw in (1.2 s); when the « and if » slider moves, the turquoise one turns into its new
 * shape (500 ms). Screen readers get a sentence and the table of the figures.
 */
export function ForecastChart({
  label,
  summary,
  ticks,
  act,
  doNothing,
  format,
  axis,
  dayLabel,
  gapLabel,
}: {
  label: string;
  summary: string;
  /** Under the plot: today, then each month to come. */
  ticks: readonly { day: number; label: string }[];
  act: ForecastSeries;
  doNothing: ForecastSeries;
  format: (value: number) => string;
  /** A value on the left of the plot, short: « $2.5K ». */
  axis: (value: number) => string;
  /** A day of the period in full: « Nov 3, 2026 ». */
  dayLabel: (day: number) => string;
  /** What the gap between the two lines is called in the tooltip. */
  gapLabel: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const reduce = useReducedMotion();
  const plot = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const last = Math.max(1, act.values.length - 1);

  const geometry = useMemo(() => {
    const scale = forecastScale(
      Math.max(act.values[0] ?? 0, doNothing.values[0] ?? 0, ...doNothing.values),
      Math.min(...doNothing.values),
    );
    const y = (value: number) => H - ((value - scale.lo) / (scale.hi - scale.lo || 1)) * H;
    const points = (values: readonly number[]) =>
      values.map((value, day) => ({ x: (day / last) * W, y: y(value) }));
    const acting = points(act.values);
    const alone = points(doNothing.values);
    const actLine = polylinePath(acting);
    const band = `${actLine}${[...alone]
      .reverse()
      .map((p) => `L${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`)
      .join('')}Z`;
    return { scale, y, act: actLine, alone: polylinePath(alone), band };
  }, [act.values, doNothing.values, last]);

  const yOf = (value: number) => Math.max(0, Math.min(H, geometry.y(value)));
  const measure = () => setWidth(plot.current?.getBoundingClientRect().width ?? 0);
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setWidth(box.width);
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    setActive(Math.max(0, Math.min(last, Math.round(fraction * last))));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? last;
    const step = event.shiftKey ? 10 : 1;
    const next =
      event.key === 'ArrowLeft'
        ? from - step
        : event.key === 'ArrowRight'
          ? from + step
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (event.key === 'Escape') setActive(null);
    if (next === null) return;
    event.preventDefault();
    measure();
    setActive(Math.max(0, Math.min(last, next)));
  };

  const actNow = active === null ? null : (act.values[active] ?? null);
  const aloneNow = active === null ? null : (doNothing.values[active] ?? null);
  const x = active === null ? 0 : (active / last) * width;
  const follow = reduce ? '' : 'transition-transform duration-[80ms] ease-linear';
  const morph = reduce ? { duration: 0 } : ease('morph');
  const spoken =
    active === null || actNow === null || aloneNow === null
      ? ''
      : t('chart.reading', {
          day: dayLabel(active),
          figures: `${act.label} ${format(actNow)}, ${doNothing.label} ${format(aloneNow)}`,
        });
  const rows = Array.from({ length: Math.floor(last / 15) + 1 }, (_, i) => i * 15);

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2">
        {/* The round values, faint, on the left: the scale does not start at zero. */}
        <div aria-hidden="true" className="relative h-[200px]">
          {geometry.scale.ticks.map((value) => (
            <span
              key={value}
              className={`absolute right-0 -translate-y-1/2 ${CHART.axisLabel}`}
              style={{ top: `${(geometry.y(value) / H) * 100}%` }}
            >
              {axis(value)}
            </span>
          ))}
        </div>
        <div
          ref={plot}
          role="group"
          aria-label={label}
          tabIndex={0}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={() => setActive(null)}
          onFocus={() => {
            measure();
            setActive((current) => current ?? last);
          }}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
          className="relative h-[200px] touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            <defs>
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
            {geometry.scale.ticks.map((value) => (
              <line
                key={value}
                x1={0}
                x2={W}
                y1={geometry.y(value)}
                y2={geometry.y(value)}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                className="stroke-white-500/15"
              />
            ))}
            <g clipPath={`url(#${id}-draw)`}>
              {/* What acting keeps: between the two lines. */}
              <motion.path
                data-chart="gain"
                className="fill-turq-300/15"
                initial={{ d: geometry.band }}
                animate={{ d: geometry.band }}
                transition={{ d: morph }}
              />
              <path
                d={geometry.alone}
                fill="none"
                strokeWidth={1}
                strokeDasharray={CHART.dash}
                vectorEffect="non-scaling-stroke"
                className={CHART.comparison}
              />
              <motion.path
                data-chart="act"
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className={CHART.line}
                initial={{ d: geometry.act }}
                animate={{ d: geometry.act }}
                transition={{ d: morph }}
              />
            </g>
          </svg>
          {active !== null && actNow !== null && aloneNow !== null ? (
            <>
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-0 left-0 w-px ${CHART.crosshair} ${follow}`}
                style={{ transform: `translateX(${x}px)` }}
              />
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-0 left-0 size-2 rounded-full ${CHART.comparisonMarker} ${CHART.markerRing} ${follow}`}
                style={{
                  transform: `translate(calc(${x}px - 50%), calc(${yOf(aloneNow)}px - 50%))`,
                }}
              />
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-0 left-0 size-2.5 rounded-full ${CHART.marker} ${CHART.markerRing} ${follow}`}
                style={{
                  transform: `translate(calc(${x}px - 50%), calc(${yOf(actNow)}px - 50%))`,
                }}
              />
            </>
          ) : null}
          <AnimatePresence>
            {active !== null && actNow !== null && aloneNow !== null ? (
              <motion.div
                key="tooltip"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: ease('tooltip') }}
                exit={{ opacity: 0, transition: ease('tooltip') }}
                className={`pointer-events-none absolute top-1 left-0 z-10 whitespace-nowrap ${CHART.tooltip} ${follow}`}
                style={{
                  transform:
                    active / last > 0.6
                      ? `translateX(calc(${x}px - 100% - 12px))`
                      : `translateX(${x + 12}px)`,
                }}
              >
                <p className="text-subtle">{dayLabel(active)}</p>
                <p className="mt-1 flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-2.5 shrink-0 rounded-full bg-turq-300" />
                    {act.label}
                  </span>
                  <span className="metric text-sm text-fg">{format(actNow)}</span>
                </p>
                <p className="mt-0.5 flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <DashKey />
                    {doNothing.label}
                  </span>
                  <span className="metric text-sm text-fg">{format(aloneNow)}</span>
                </p>
                <p className="mt-0.5 flex items-center justify-between gap-4">
                  <span className="ps-4">{gapLabel}</span>
                  <span className="metric text-sm text-turq-300">
                    {format(Math.max(0, actNow - aloneNow))}
                  </span>
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div />
        {/* Today, then each month to come. */}
        <div aria-hidden="true" className="relative mt-2 h-4">
          {ticks.map((tick) => (
            <span
              key={tick.day}
              className={`absolute top-0 ${CHART.axisLabel} ${
                tick.day === 0 ? 'left-0' : tick.day === last ? 'right-0' : '-translate-x-1/2'
              }`}
              style={
                tick.day === 0 || tick.day === last
                  ? undefined
                  : { left: `${(tick.day / last) * 100}%` }
              }
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>
      <ChartTable>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.day')}</th>
            <th scope="col">{act.label}</th>
            <th scope="col">{doNothing.label}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((day) => (
            <tr key={day}>
              <th scope="row">{dayLabel(day)}</th>
              <td>{format(act.values[day] ?? 0)}</td>
              <td>{format(doNothing.values[day] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </ChartTable>
    </figure>
  );
}

/** The dashed line's key, in a legend or a tooltip. */
export function DashKey({ width = 10 }: { width?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={width}
      height="2"
      viewBox={`0 0 ${width} 2`}
      className="shrink-0"
    >
      <line
        x1="0"
        x2={width}
        y1="1"
        y2="1"
        strokeWidth="1"
        strokeDasharray="2 2"
        className={CHART.comparison}
      />
    </svg>
  );
}
