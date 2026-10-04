import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { ease, STAGGER } from '../../motion';

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
}

/**
 * The slices' strokes, the largest first: the main one in turquoise, the others in white steps
 * (one accent, brief v4 §6). Each is named with its count and share in the legend beside it, and
 * a 2-unit gap parts every slice from the next: never color alone.
 */
const TONES = [
  { stroke: 'stroke-turq-300', key: 'bg-turq-300' },
  { stroke: 'stroke-white-300', key: 'bg-white-300' },
  { stroke: 'stroke-white-500', key: 'bg-white-500' },
  { stroke: 'stroke-white-500/55', key: 'bg-white-500/55' },
  { stroke: 'stroke-white-500/30', key: 'bg-white-500/30' },
] as const;

const R = 40;
const C = 2 * Math.PI * R;
/** The gap between two slices, along the ring. */
const GAP = 1.6;

/**
 * A donut (brief v4 §9.5: why members leave, from the departure survey): slices from twelve
 * o'clock clockwise, the largest first, drawn in one after the other; the total in the middle.
 * A slice or its legend row pointed at stands out and the middle says its share. The legend gives
 * every figure in words, so the chart needs no table of its own.
 */
export function Donut({
  label,
  slices,
  total,
  totalLabel,
  count,
  percent,
}: {
  label: string;
  slices: readonly DonutSlice[];
  total: number;
  /** Under the total: « answers ». */
  totalLabel: string;
  /** A slice's count in words: « 3 answers ». */
  count: (value: number) => string;
  percent: (ratio: number) => string;
}) {
  const reduce = useReducedMotion();
  const [active, setActive] = useState<string | null>(null);
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const sum = sorted.reduce((t, s) => t + s.value, 0) || 1;
  const arcs = sorted.map((slice, index) => {
    // Where it starts: after every larger slice.
    const offset = sorted.slice(0, index).reduce((t, s) => t + (s.value / sum) * C, 0);
    return {
      ...slice,
      index,
      tone: TONES[Math.min(index, TONES.length - 1)]!,
      offset,
      length: Math.max(0, (slice.value / sum) * C - (sorted.length > 1 ? GAP : 0)),
    };
  });
  const shown = arcs.find((a) => a.id === active) ?? null;

  return (
    <figure className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-5">
      <div className="relative size-40 shrink-0">
        <svg role="img" aria-label={label} viewBox="0 0 100 100" className="size-full -rotate-90">
          <circle cx={50} cy={50} r={R} fill="none" strokeWidth={12} className="stroke-surface-2" />
          {arcs.map((arc) => (
            <motion.circle
              key={arc.id}
              data-slice={arc.id}
              cx={50}
              cy={50}
              r={R}
              fill="none"
              strokeWidth={shown?.id === arc.id ? 14 : 12}
              strokeDashoffset={-arc.offset}
              className={`${arc.tone.stroke} transition-[opacity,stroke-width] duration-200 ${
                shown && shown.id !== arc.id ? 'opacity-40' : ''
              }`}
              // Each slice draws in from its start, one after the other (MOTION.md).
              initial={{ strokeDasharray: `${reduce ? arc.length : 0} ${C}` }}
              animate={{ strokeDasharray: `${arc.length} ${C}` }}
              transition={reduce ? { duration: 0 } : ease('draw', 0.1 + arc.index * STAGGER)}
              onPointerEnter={() => setActive(arc.id)}
              onPointerLeave={() => setActive(null)}
            />
          ))}
        </svg>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
        >
          <span className="metric text-2xl text-fg">
            {shown ? percent(shown.value / sum) : total}
          </span>
          <span className="max-w-24 truncate text-xs text-subtle">
            {shown ? shown.label : totalLabel}
          </span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 basis-52 space-y-1">
        {arcs.map((arc) => (
          <li
            key={arc.id}
            data-reason={arc.id}
            onPointerEnter={() => setActive(arc.id)}
            onPointerLeave={() => setActive(null)}
            className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 ${
              active === arc.id ? 'bg-surface-2' : ''
            }`}
          >
            <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${arc.tone.key}`} />
            <span className="min-w-0 flex-1 truncate text-fg">{arc.label}</span>
            <span className="tabular text-muted">{count(arc.value)}</span>
            <span className="num w-10 text-end text-fg">{percent(arc.value / sum)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
