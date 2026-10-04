import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ease } from '../../motion';
import { DashKey } from './ForecastChart';
import { CHART } from './theme';

const W = 1000;
const H = 220;

export interface RetentionLine {
  id: string;
  /** « June 2026 ». */
  label: string;
  /** What the tooltip says under the label: « 24 members ». */
  detail: string;
  /** The share still there at each mark (the first is 1); null once no member is old enough. */
  values: readonly (number | null)[];
  /** Left faster than the community's average (the weekly analyses' alert). */
  flagged: boolean;
}

/**
 * Retention by cohort (brief v4 §9.5): one line per month of arrival, the share of its members
 * still there at 30, 60 and 90 days; the community's average dashed. Every line is a thin
 * white-500 one; the one under the pointer (or the row hovered in the table below, or the flagged
 * cohort while nothing is pointed at) turns turquoise with its figures, the others fade. Lines
 * draw in from the left (1.2 s). Screen readers get the table below the chart.
 */
export function RetentionChart({
  label,
  summary,
  marks,
  lines,
  average,
  averageLabel,
  highlighted,
  onHighlight,
  percent,
}: {
  label: string;
  summary: string;
  /** Under each mark: « Joined », « 30 days »… */
  marks: readonly string[];
  lines: readonly RetentionLine[];
  average: readonly (number | null)[];
  averageLabel: string;
  /** The line shown in turquoise; null: the flagged one, if any. */
  highlighted: string | null;
  onHighlight: (id: string | null) => void;
  percent: (value: number) => string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  const plot = useRef<HTMLDivElement>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number; width: number } | null>(null);
  const steps = Math.max(1, marks.length - 1);
  const shown = highlighted ?? lines.find((line) => line.flagged)?.id ?? null;

  const geometry = useMemo(() => {
    const known = [...lines.flatMap((l) => l.values), ...average].filter(
      (v): v is number => v !== null,
    );
    const lowest = Math.min(1, ...known);
    // From a round tenth under the lowest point to 100 %.
    const floor = Math.max(0, Math.floor((lowest - 0.05) * 10) / 10);
    const y = (value: number) => ((1 - value) / (1 - floor || 1)) * H;
    const path = (values: readonly (number | null)[]) =>
      values
        .map((value, i) => ({ value, i }))
        .filter((p): p is { value: number; i: number } => p.value !== null)
        .map((p, k) => `${k === 0 ? 'M' : 'L'}${(p.i / steps) * W} ${y(p.value)}`)
        .join('');
    return {
      floor,
      y,
      paths: new Map(lines.map((line) => [line.id, path(line.values)])),
      average: path(average),
    };
  }, [lines, average, steps]);

  /** The line nearest the pointer, read at its place along the plot. */
  const nearest = (x: number, y: number, width: number) => {
    const at = Math.max(0, Math.min(1, x / width)) * steps;
    const i = Math.min(steps - 1, Math.floor(at));
    const t = at - i;
    let best: { id: string; gap: number } | null = null;
    for (const line of lines) {
      const a = line.values[i];
      const b = line.values[i + 1];
      const value =
        a !== null && a !== undefined && b !== null && b !== undefined
          ? a + (b - a) * t
          : a !== null && a !== undefined && t < 0.5
            ? a
            : null;
      if (value === null) continue;
      const gap = Math.abs((geometry.y(value) / H) * (plot.current?.clientHeight ?? H) - y);
      if (!best || gap < best.gap) best = { id: line.id, gap };
    }
    return best?.id ?? null;
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    setPointer({ x, y, width: box.width });
    onHighlight(nearest(x, y, box.width));
  };
  const line = lines.find((l) => l.id === shown) ?? null;
  const follow = reduce ? '' : 'transition-transform duration-[80ms] ease-linear';
  const grid = [1, (1 + geometry.floor) / 2, geometry.floor];

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2">
        {/* The shares, on the left, faint. */}
        <div aria-hidden="true" className="relative h-[220px]">
          {grid.map((value) => (
            <span
              key={value}
              className={`absolute right-0 -translate-y-1/2 ${CHART.axisLabel}`}
              style={{ top: `${(geometry.y(value) / H) * 100}%` }}
            >
              {percent(value)}
            </span>
          ))}
        </div>
        <div
          ref={plot}
          role="img"
          aria-label={label}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={() => {
            setPointer(null);
            onHighlight(null);
          }}
          className="relative h-[220px] touch-pan-y"
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
                  x={-10}
                  y={-12}
                  height={H + 24}
                  initial={{ width: reduce ? W + 20 : 0 }}
                  animate={{ width: W + 20 }}
                  transition={ease('draw')}
                />
              </clipPath>
            </defs>
            {grid.map((value) => (
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
              <path
                d={geometry.average}
                fill="none"
                strokeWidth={1}
                strokeDasharray={CHART.dash}
                vectorEffect="non-scaling-stroke"
                className="stroke-white-300"
              />
              {lines.map((l) =>
                l.id === shown ? null : (
                  <path
                    key={l.id}
                    d={geometry.paths.get(l.id)}
                    fill="none"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    className={`stroke-white-500 transition-opacity duration-200 ${
                      shown ? 'opacity-25' : 'opacity-60'
                    }`}
                  />
                ),
              )}
              {line ? (
                <path
                  data-chart="highlighted"
                  d={geometry.paths.get(line.id)}
                  fill="none"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  className={CHART.line}
                />
              ) : null}
            </g>
          </svg>
          {/* The highlighted cohort's figures, on its points. */}
          {line
            ? line.values.map((value, i) =>
                value === null || i === 0 ? null : (
                  <span
                    key={`${line.id}-${i}`}
                    aria-hidden="true"
                    className="pointer-events-none absolute -translate-x-1/2 -translate-y-full pb-1.5"
                    style={{
                      left: `${(i / steps) * 100}%`,
                      top: `${(geometry.y(value) / H) * 100}%`,
                    }}
                  >
                    <span className="num text-[11px] font-medium text-turq-300">
                      {percent(value)}
                    </span>
                  </span>
                ),
              )
            : null}
          {line
            ? line.values.map((value, i) =>
                value === null ? null : (
                  <span
                    key={`${line.id}-dot-${i}`}
                    aria-hidden="true"
                    className={`pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${CHART.marker} ${CHART.markerRing}`}
                    style={{
                      left: `${(i / steps) * 100}%`,
                      top: `${(geometry.y(value) / H) * 100}%`,
                    }}
                  />
                ),
              )
            : null}
          <AnimatePresence>
            {pointer && line && highlighted ? (
              <motion.div
                key="tooltip"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: ease('tooltip') }}
                exit={{ opacity: 0, transition: ease('tooltip') }}
                className={`pointer-events-none absolute top-0 left-0 z-10 whitespace-nowrap ${CHART.tooltip} ${follow}`}
                style={{
                  transform:
                    pointer.x / pointer.width > 0.6
                      ? `translateX(calc(${pointer.x}px - 100% - 12px))`
                      : `translateX(${pointer.x + 12}px)`,
                }}
              >
                <p className="font-medium text-fg">{line.label}</p>
                <p className="text-subtle">{line.detail}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div />
        <div aria-hidden="true" className="relative mt-2 h-4">
          {marks.map((mark, i) => (
            <span
              key={mark}
              className={`absolute top-0 ${CHART.axisLabel} ${
                i === 0 ? 'left-0' : i === steps ? 'right-0' : '-translate-x-1/2'
              }`}
              style={i === 0 || i === steps ? undefined : { left: `${(i / steps) * 100}%` }}
            >
              {mark}
            </span>
          ))}
        </div>
      </div>
      <div className={`mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 ${CHART.legend}`}>
        {line ? (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-4 shrink-0 rounded-full bg-turq-300" />
            {line.label}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-2">
          <DashKey width={16} />
          {averageLabel}
        </span>
      </div>
    </figure>
  );
}
