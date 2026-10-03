import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../i18n';
import { DURATION, EASE, ease } from '../../motion';
import { LabelTip } from '../LabelTip';
import { monotoneSample, smoothPath } from './curve';
import { CHART } from './theme';

/** The plot's own units: as wide as it likes (the SVG stretches), as tall as it is drawn. */
const W = 1000;
/** 220 px, the brief's (v4 §8): one unit of the plot is one pixel high. */
const H = 220;
/** Room above the highest point, so the line and its dot never touch the top. */
const HEADROOM = 1.15;
/** Every period is drawn with this many points: 7, 30 and 90 days turn into one another. */
const SAMPLES = 90;

export interface BalancePoint {
  /** The day in full, for the tooltip and the table: « Oct 3, 2026 ». */
  label: string;
  /** Short, under the line while hovering: « Oct 3 ». */
  tick: string;
}

/** Where a day has no figure (no score yet), the line is hidden; around it, joined. */
function fillGaps(values: readonly (number | null)[]): number[] | null {
  const known = values.flatMap((value, index) => (value === null ? [] : [{ index, value }]));
  if (known.length === 0) return null;
  return values.map((value, index) => {
    if (value !== null) return value;
    const after = known.find((k) => k.index > index);
    const before = known.findLast((k) => k.index < index);
    if (!before) return after!.value;
    if (!after) return before.value;
    const share = (index - before.index) / (after.index - before.index);
    return before.value + (after.value - before.value) * share;
  });
}

/**
 * The money saved drawn the way Whop draws a balance (brief v4 §8): no box, no grid, no value
 * axis; a 2 px turquoise line over a turquoise area fading out, a dotted baseline, a dot that
 * pulses on today. The members at risk are a thin dashed line on the same scale, shown or hidden
 * from the legend. Hover, touch or the arrow keys: a hairline, a dot on the curve and a compact
 * tooltip, the day under the line. MOTION.md: the line draws in (1.2 s), its area fades in
 * after it, a new period turns the curve into the new one (500 ms) instead of drawing it again.
 * Screen readers get a sentence and the table of the figures.
 */
export function BalanceChart({
  label,
  summary,
  period,
  points,
  saved,
  atRisk,
  format,
}: {
  /** The chart's name. */
  label: string;
  /** What it shows, in a sentence, for screen readers. */
  summary: string;
  /** The period shown (a change morphs the curve). */
  period: string;
  points: readonly BalancePoint[];
  saved: { label: string; values: readonly number[]; info?: ReactNode };
  atRisk: { label: string; values: readonly (number | null)[] } | null;
  format: (value: number) => string;
}) {
  const { t } = useI18n();
  const id = useId();
  const reduce = useReducedMotion();
  const plot = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [showRisk, setShowRisk] = useState(true);
  const n = points.length;
  const riskShown = showRisk && atRisk !== null && atRisk.values.some((v) => v !== null);

  const geometry = useMemo(() => {
    const riskValues = atRisk ? fillGaps(atRisk.values) : null;
    const max = Math.max(1, ...saved.values, ...(riskShown && riskValues ? riskValues : []));
    const top = max * HEADROOM;
    const y = (value: number) => H - (Math.max(0, value) / top) * H;
    const path = (values: readonly number[]) =>
      smoothPath(
        monotoneSample(values, SAMPLES).map((value, k) => ({
          x: (k / (SAMPLES - 1)) * W,
          y: y(value),
        })),
      );
    const line = path(saved.values);
    const first = atRisk ? atRisk.values.findIndex((value) => value !== null) : -1;
    return {
      top,
      line,
      area: `${line}L${W} ${H}L0 ${H}Z`,
      risk: riskValues
        ? { line: path(riskValues), from: n > 1 ? (Math.max(0, first) / (n - 1)) * W : 0 }
        : null,
    };
  }, [saved.values, atRisk, riskShown, n]);

  const share = (index: number) => (n > 1 ? index / (n - 1) : 1);
  const yOf = (value: number) => (1 - Math.max(0, value) / geometry.top) * H;
  const measure = () => setWidth(plot.current?.getBoundingClientRect().width ?? 0);
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setWidth(box.width);
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    setActive(Math.max(0, Math.min(n - 1, Math.round(fraction * (n - 1)))));
  };
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
    measure();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };

  const said = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : format(value);
  const point = active === null ? null : points[active];
  const savedNow = active === null ? null : (saved.values[active] ?? null);
  const riskNow = active === null || !atRisk ? null : (atRisk.values[active] ?? null);
  const spoken = point
    ? `${point.label}: ${[
        `${saved.label} ${said(savedNow)}`,
        ...(atRisk ? [`${atRisk.label} ${said(riskNow)}`] : []),
      ].join(', ')}`
    : '';
  const x = active === null ? 0 : share(active) * width;
  const last = saved.values.at(-1) ?? 0;
  // Follows the pointer with 80 ms of smoothing (brief v4 §14), never its layout.
  const follow = reduce ? '' : 'transition-transform duration-[80ms] ease-linear';
  const morph = reduce ? { duration: 0 } : ease('morph');

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
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
          setActive((current) => current ?? n - 1);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative h-[220px] touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
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
            {/* The lines draw in from the left, once (MOTION.md). */}
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
            {geometry.risk ? (
              <clipPath id={`${id}-risk`}>
                <rect x={geometry.risk.from} y={-12} width={W} height={H + 24} />
              </clipPath>
            ) : null}
          </defs>
          {/* The area, once the line is drawn. */}
          <motion.path
            fill={`url(#${id}-fill)`}
            initial={{ opacity: reduce ? 1 : 0, d: geometry.area }}
            animate={{ opacity: 1, d: geometry.area }}
            transition={{
              opacity: reduce ? { duration: 0 } : ease('fill', DURATION.draw),
              d: morph,
            }}
          />
          <g clipPath={`url(#${id}-draw)`}>
            {geometry.risk && atRisk ? (
              <g clipPath={`url(#${id}-risk)`}>
                <motion.path
                  fill="none"
                  strokeWidth={1}
                  strokeDasharray={CHART.dash}
                  vectorEffect="non-scaling-stroke"
                  className={CHART.comparison}
                  initial={{ d: geometry.risk.line, opacity: riskShown ? 1 : 0 }}
                  animate={{ d: geometry.risk.line, opacity: riskShown ? 1 : 0 }}
                  transition={{ d: morph, opacity: ease('hover') }}
                />
              </g>
            ) : null}
            <motion.path
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={CHART.line}
              initial={{ d: geometry.line }}
              animate={{ d: geometry.line }}
              transition={{ d: morph }}
            />
          </g>
        </svg>
        {/* The dotted baseline, as Whop draws it (`.baseline-dots`). */}
        <span
          aria-hidden="true"
          className="baseline-dots pointer-events-none absolute inset-x-0 bottom-0 h-px"
        />
        {/* Today: a 6 px dot where the line arrives, pulsing every 2.4 s once it is drawn. */}
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-full"
          initial={{ opacity: reduce ? 1 : 0 }}
          animate={{ opacity: 1 }}
          transition={ease('micro', DURATION.draw)}
          style={{
            transform: `translate(-50%, calc(${yOf(last)}px - 50%))`,
            transition: reduce
              ? undefined
              : `transform ${DURATION.morph * 1000}ms var(--ease-brand)`,
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
        {active !== null && point ? (
          <>
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-y-0 left-0 w-px ${CHART.crosshair} ${follow}`}
              style={{ transform: `translateX(${x}px)` }}
            />
            {riskShown && riskNow !== null ? (
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-0 left-0 size-2 rounded-full ${CHART.comparisonMarker} ${CHART.markerRing} ${follow}`}
                style={{
                  transform: `translate(calc(${x}px - 50%), calc(${yOf(riskNow)}px - 50%))`,
                }}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 left-0 size-2.5 rounded-full ${CHART.marker} ${CHART.markerRing} ${follow}`}
              style={{
                transform: `translate(calc(${x}px - 50%), calc(${yOf(savedNow ?? 0)}px - 50%))`,
              }}
            />
          </>
        ) : null}
        <AnimatePresence>
          {active !== null && point ? (
            <motion.div
              key="tooltip"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: ease('tooltip') }}
              exit={{ opacity: 0, transition: ease('tooltip') }}
              className={`pointer-events-none absolute top-1 left-0 z-10 whitespace-nowrap ${CHART.tooltip} ${follow}`}
              style={{
                transform:
                  share(active) > 0.6
                    ? `translateX(calc(${x}px - 100% - 12px))`
                    : `translateX(${x + 12}px)`,
              }}
            >
              <p className="text-subtle">{point.label}</p>
              <p className="mt-1 flex items-center justify-between gap-4">
                <span>{saved.label}</span>
                <span className="metric text-sm text-fg">{said(savedNow)}</span>
              </p>
              {riskShown && atRisk ? (
                <p className="mt-0.5 flex items-center justify-between gap-4">
                  <span>{atRisk.label}</span>
                  <span className="metric text-sm text-fg">{said(riskNow)}</span>
                </p>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {/* The days stay out of the way: only the one under the pointer shows (brief v4 §8). */}
      <div aria-hidden="true" className="relative h-5">
        {active !== null && point ? (
          <span
            className={`absolute top-1.5 left-0 ${CHART.axisLabel} ${follow}`}
            style={{
              transform: `translateX(clamp(0px, calc(${x}px - 50%), calc(${width}px - 100%)))`,
            }}
          >
            {point.tick}
          </span>
        ) : null}
      </div>
      <div className={`mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 ${CHART.legend}`}>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-4 shrink-0 rounded-[2px] border-t-2 border-turq-300 bg-turq-300/20"
          />
          {saved.info ? <LabelTip tip={saved.info}>{saved.label}</LabelTip> : saved.label}
        </span>
        {atRisk && atRisk.values.some((v) => v !== null) ? (
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
            {atRisk.label}
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.day')}</th>
            <th scope="col">{saved.label}</th>
            {atRisk ? <th scope="col">{atRisk.label}</th> : null}
          </tr>
        </thead>
        <tbody>
          {points.map((p, index) => (
            <tr key={`${period}-${p.label}`}>
              <th scope="row">{p.label}</th>
              <td>{said(saved.values[index])}</td>
              {atRisk ? <td>{said(atRisk.values[index])}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
