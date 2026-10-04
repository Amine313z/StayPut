import { motion, useReducedMotion } from 'motion/react';
import { ease, STAGGER } from '../../motion';

export interface LessonBar {
  id: string;
  label: string;
  /** Under the label: « 6 of 12 members stalled ». */
  detail: string;
  /** The share of the members who stalled right after the lesson. */
  rate: number;
  /** The same share over the lessons of its course. */
  average: number;
  flagged: boolean;
}

/**
 * The lessons members stall after (brief v4 §9.5: the blocking lesson as horizontal bars): a bar
 * per lesson, its share of members who stalled after it, a white hairline at its course's
 * average. A lesson flagged (twice its course's average, SPEC Phase 3) is turquoise, the others
 * white-500: no red (brief v4 §6). Bars grow from the left one after the other; every figure is
 * also in words on its row, and in the table below.
 */
export function LessonBars({
  label,
  bars,
  percent,
  averageLabel,
}: {
  label: string;
  bars: readonly LessonBar[];
  percent: (ratio: number) => string;
  /** The hairline's name, in the legend: « Course average ». */
  averageLabel: string;
}) {
  const reduce = useReducedMotion();
  const max = Math.max(0.01, ...bars.flatMap((b) => [b.rate, b.average]));
  return (
    <figure className="min-w-0">
      <ul aria-label={label} className="space-y-3">
        {bars.map((bar, index) => (
          <li key={bar.id} data-lesson={bar.id} data-flagged={bar.flagged} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className={`min-w-0 truncate ${bar.flagged ? 'text-fg' : 'text-muted'}`}>
                {bar.label}
              </span>
              <span className={`num shrink-0 ${bar.flagged ? 'text-turq-300' : 'text-fg'}`}>
                {percent(bar.rate)}
              </span>
            </div>
            <div className="relative mt-1.5 h-2 rounded-full bg-surface-2">
              <motion.span
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 origin-left rounded-full ${
                  bar.flagged ? 'bg-turq-300' : 'bg-white-500/60'
                }`}
                style={{ width: `${(bar.rate / max) * 100}%` }}
                initial={{ scaleX: reduce ? 1 : 0 }}
                animate={{ scaleX: 1 }}
                transition={reduce ? { duration: 0 } : ease('standard', 0.1 + index * STAGGER)}
              />
              <span
                aria-hidden="true"
                className="absolute -inset-y-1 w-px bg-white-300"
                style={{ left: `${(bar.average / max) * 100}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-subtle">{bar.detail}</p>
          </li>
        ))}
      </ul>
      <figcaption className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span aria-hidden="true" className="h-3 w-px bg-white-300" />
        {averageLabel}
      </figcaption>
    </figure>
  );
}
