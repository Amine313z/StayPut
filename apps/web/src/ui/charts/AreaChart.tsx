import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../../i18n';
import { ease } from '../../motion';

export interface ChartPoint {
  /** The point in full, for the tooltip and the table: « Oct 12, 2026 ». */
  label: string;
  /** Short, for the axis: « Oct 12 ». */
  tick: string;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** One value per point; null where there is no figure (a gap, never a zero). */
  values: readonly (number | null)[];
  /**
   * `area`: the main series, a mint line over a mint gradient that fades out. `line`: a dashed
   * silver line. Each also has its name in the legend: a series is never told by its color alone.
   */
  look: 'area' | 'line';
}

/** The plot's own units: the SVG stretches to its box, its strokes keep their width. */
const W = 1000;
const H = 300;

/** Round steps for the value axis (0, 250, 500, 750 rather than 0, 219, 437), from 0. */
export function niceTicks(max: number, count = 4): number[] {
  const top = Math.max(max, 10);
  const raw = top / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const last = Math.ceil(top / step) * step;
  return Array.from({ length: Math.round(last / step) + 1 }, (_, i) => i * step);
}

interface XY {
  x: number;
  y: number;
}

/**
 * A smooth line through the points that never overshoots them (monotone cubic, Fritsch–Carlson):
 * a total that only grows is drawn growing, never dipping between two days.
 */
export function smoothPath(points: readonly XY[]): string {
  const n = points.length;
  const first = points[0];
  if (!first) return '';
  if (n === 1) return `M${first.x} ${first.y}`;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    slopes.push((b.y - a.y) / (b.x - a.x));
  }
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === n - 1) return slopes[n - 2]!;
    const before = slopes[i - 1]!;
    const after = slopes[i]!;
    return before * after <= 0 ? 0 : (before + after) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    const slope = slopes[i]!;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i]! / slope;
    const b = tangents[i + 1]! / slope;
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      tangents[i] = s * a * slope;
      tangents[i + 1] = s * b * slope;
    }
  }
  const r = (value: number) => Math.round(value * 10) / 10;
  let d = `M${r(first.x)} ${r(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const third = (b.x - a.x) / 3;
    d +=
      `C${r(a.x + third)} ${r(a.y + tangents[i]! * third)} ` +
      `${r(b.x - third)} ${r(b.y - tangents[i + 1]! * third)} ${r(b.x)} ${r(b.y)}`;
  }
  return d;
}

/** The runs of consecutive figures of a series (a null breaks the line). */
function runsOf(values: readonly (number | null)[]): { index: number; value: number }[][] {
  const runs: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else current.push({ index, value });
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Two series over time on one value axis (MOTION.md: the lines draw in from the left, the area
 * fades in; a new `period` draws again while the old one fades out). Hover, touch or the arrow
 * keys: a crosshair, a marker on each line and a tooltip with the day's figures, which screen
 * readers hear too. The figures are also a table for them.
 */
export function AreaChart({
  points,
  series,
  format,
  formatTick,
  label,
  summary,
  period,
}: {
  points: readonly ChartPoint[];
  series: readonly ChartSeries[];
  /** A figure in the tooltip and the table. */
  format: (value: number) => string;
  /** A step of the value axis, short. */
  formatTick: (value: number) => string;
  /** The chart's name. */
  label: string;
  /** What it shows, in a sentence, for screen readers. */
  summary: string;
  /** What is shown (the period): a new one draws in. */
  period: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const geometry = useMemo(() => {
    const max = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
    const ticks = niceTicks(max);
    const top = ticks.at(-1) ?? 1;
    const x = (index: number) => (n > 1 ? (index / (n - 1)) * W : W / 2);
    const y = (value: number) => H - (value / top) * H;
    const paths = series.map((s) => {
      const runs = runsOf(s.values).map((run) => {
        const xy = run.map((p) => ({ x: x(p.index), y: y(p.value) }));
        const line = smoothPath(xy);
        const area = `${line}L${xy.at(-1)?.x ?? 0} ${H}L${xy[0]?.x ?? 0} ${H}Z`;
        return { line, area };
      });
      return { key: s.key, look: s.look, runs };
    });
    return { ticks, top, paths };
  }, [series, n]);

  const share = (index: number) => (n > 1 ? index / (n - 1) : 0.5);
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
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
    setActive(Math.max(0, Math.min(n - 1, next)));
  };
  const point = active === null ? null : points[active];
  const said = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : format(value);
  const spoken = point
    ? `${point.label}: ${series.map((s) => `${s.label} ${said(s.values[active!])}`).join(', ')}`
    : '';
  // Four days on the axis: the first, two between, the last.
  const tickIndexes = [...new Set([0, 1, 2, 3].map((k) => Math.round((k * (n - 1)) / 3)))];

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
      <ul aria-hidden="true" className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {series.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-2">
            <Swatch look={s.look} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <motion.div
          key={`values-${period}`}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={ease('standard')}
          className="relative h-48 min-w-10 @2xl:h-56"
        >
          {geometry.ticks.map((tick) => (
            <span
              key={tick}
              className="tabular absolute end-0 -translate-y-1/2 text-xs whitespace-nowrap text-subtle"
              style={{ top: `${(1 - tick / geometry.top) * 100}%` }}
            >
              {formatTick(tick)}
            </span>
          ))}
        </motion.div>
        <div
          role="group"
          aria-label={label}
          tabIndex={0}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((current) => current ?? n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKey}
          className="relative h-48 touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent @2xl:h-56"
        >
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" className="[stop-color:var(--accent)] [stop-opacity:0.3]" />
                <stop offset="100%" className="[stop-color:var(--accent)] [stop-opacity:0]" />
              </linearGradient>
            </defs>
            {geometry.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={W}
                y1={H - (tick / geometry.top) * H}
                y2={H - (tick / geometry.top) * H}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                className={tick === 0 ? 'stroke-line-strong' : 'stroke-line'}
              />
            ))}
            <AnimatePresence initial={false}>
              <motion.g
                key={period}
                exit={{ opacity: 0, transition: ease('micro') }}
                clipPath={`url(#${id}-${period})`}
              >
                <clipPath id={`${id}-${period}`}>
                  <motion.rect
                    x={0}
                    y={-8}
                    height={H + 16}
                    initial={{ width: reduce ? W : 0 }}
                    animate={{ width: W }}
                    transition={ease('draw')}
                  />
                </clipPath>
                {geometry.paths.map((path) =>
                  path.runs.map((run, i) => (
                    <g key={`${path.key}-${i}`}>
                      {path.look === 'area' ? (
                        <motion.path
                          d={run.area}
                          fill={`url(#${id}-fill)`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={ease('count', 0.1)}
                        />
                      ) : null}
                      <path
                        d={run.line}
                        fill="none"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray={path.look === 'line' ? '5 5' : undefined}
                        vectorEffect="non-scaling-stroke"
                        className={path.look === 'area' ? 'stroke-accent' : 'stroke-muted'}
                      />
                    </g>
                  )),
                )}
              </motion.g>
            </AnimatePresence>
          </svg>
          {active !== null && point ? (
            <>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-line-strong"
                style={{ left: `${share(active) * 100}%` }}
              />
              {series.map((s) => {
                const value = s.values[active];
                if (value === null || value === undefined) return null;
                return (
                  <span
                    key={s.key}
                    aria-hidden="true"
                    className={`pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface ${
                      s.look === 'area' ? 'bg-accent' : 'bg-muted'
                    }`}
                    style={{
                      left: `${share(active) * 100}%`,
                      top: `${(1 - value / geometry.top) * 100}%`,
                    }}
                  />
                );
              })}
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
                className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lift"
                style={
                  share(active) > 0.55
                    ? { right: `calc(${(1 - share(active)) * 100}% + 12px)` }
                    : { left: `calc(${share(active) * 100}% + 12px)` }
                }
              >
                <p className="text-subtle">{point.label}</p>
                <ul className="mt-1.5 space-y-1">
                  {series.map((s) => (
                    <li key={s.key} className="flex items-center justify-between gap-4">
                      <span className="inline-flex items-center gap-2">
                        <Swatch look={s.look} />
                        {s.label}
                      </span>
                      <span className="tabular font-semibold text-fg">
                        {said(s.values[active])}
                      </span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div />
        <motion.div
          key={`days-${period}`}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={ease('standard')}
          className="relative mt-2 h-4"
        >
          {tickIndexes.map((index, k) => (
            <span
              key={index}
              className={`tabular absolute top-0 text-xs whitespace-nowrap text-subtle ${
                k === 0
                  ? ''
                  : k === tickIndexes.length - 1
                    ? '-translate-x-full'
                    : '-translate-x-1/2'
              }`}
              style={{ left: `${share(index) * 100}%` }}
            >
              {points[index]?.tick}
            </span>
          ))}
        </motion.div>
      </div>
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t('chart.day')}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p, index) => (
            <tr key={p.label}>
              <th scope="row">{p.label}</th>
              {series.map((s) => (
                <td key={s.key}>{said(s.values[index])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** A series' mark in the legend and the tooltip: a line over a fill, or a dashed line. */
function Swatch({ look }: { look: ChartSeries['look'] }) {
  return look === 'area' ? (
    <span
      aria-hidden="true"
      className="h-2.5 w-4 shrink-0 rounded-[2px] border-t-2 border-accent bg-accent/25"
    />
  ) : (
    <svg aria-hidden="true" width="16" height="10" viewBox="0 0 16 10" className="shrink-0">
      <line
        x1="0"
        x2="16"
        y1="5"
        y2="5"
        strokeWidth="2"
        strokeDasharray="4 3"
        className="stroke-muted"
      />
    </svg>
  );
}
