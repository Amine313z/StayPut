import { AnimatePresence, motion } from 'motion/react';
import { useId, useMemo, useState } from 'react';
import { ease } from '../../motion';

export interface SparkPoint {
  /** What the tooltip says of the point: its day. */
  label: string;
  value: number;
}

/**
 * One series over time, small (MOTION.md: the line draws in). A single series needs no legend:
 * the card's title names it. Hover or focus a day: a crosshair, a marker and its value. Its
 * figures are also said to screen readers (`summary`).
 */
export function Sparkline({
  points,
  format,
  summary,
  height = 96,
  max,
}: {
  points: readonly SparkPoint[];
  format: (value: number) => string;
  summary: string;
  height?: number;
  /** The top of the scale (a score's 100); else the highest point. */
  max?: number;
}) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);
  const width = 320;
  const pad = { top: 8, bottom: 6, side: 4 };
  const geometry = useMemo(() => {
    const top = max ?? Math.max(1, ...points.map((p) => p.value));
    const step = points.length > 1 ? (width - pad.side * 2) / (points.length - 1) : 0;
    const xy = points.map((p, i) => ({
      x: pad.side + i * step,
      y: pad.top + (1 - p.value / top) * (height - pad.top - pad.bottom),
    }));
    const line = xy
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join('');
    const area = `${line}L${xy.at(-1)?.x ?? 0} ${height}L${xy[0]?.x ?? 0} ${height}Z`;
    return { xy, line, area, step };
  }, [points, height, max, pad.bottom, pad.side, pad.top]);
  const at = hover === null ? null : geometry.xy[hover];
  const point = hover === null ? null : points[hover];
  return (
    <figure className="relative">
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-24 w-full overflow-visible"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - box.left) / box.width) * width;
          const index = geometry.step > 0 ? Math.round((x - pad.side) / geometry.step) : 0;
          setHover(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="[stop-color:var(--accent-2)] [stop-opacity:0.28]" />
            <stop offset="100%" className="[stop-color:var(--accent-2)] [stop-opacity:0]" />
          </linearGradient>
        </defs>
        <motion.path
          d={geometry.area}
          fill={`url(#${gradient})`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={ease('count', 0.2)}
        />
        <motion.path
          d={geometry.line}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-accent-2"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={ease('draw')}
        />
        {at ? (
          <>
            <line
              x1={at.x}
              x2={at.x}
              y1={0}
              y2={height}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              className="stroke-line-strong"
            />
            <circle
              cx={at.x}
              cy={at.y}
              r={4}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="fill-surface stroke-accent"
            />
          </>
        ) : null}
      </svg>
      <AnimatePresence>
        {at && point ? (
          <motion.figcaption
            key="tip"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: ease('tooltip') }}
            exit={{ opacity: 0, transition: ease('tooltip') }}
            className="pointer-events-none absolute -top-2 rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow-lift"
            style={{
              left: `${(at.x / width) * 100}%`,
              transform: `translate(${at.x / width > 0.7 ? '-100%' : '-50%'}, -100%)`,
            }}
          >
            <span className="text-muted">{point.label}</span>{' '}
            <span className="num font-semibold">{format(point.value)}</span>
          </motion.figcaption>
        ) : null}
      </AnimatePresence>
    </figure>
  );
}
