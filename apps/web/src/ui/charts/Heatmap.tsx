import { AnimatePresence, motion } from 'motion/react';
import { useState, type KeyboardEvent } from 'react';
import { ease } from '../../motion';
import { ChartTable } from './ChartTable';
import { CHART } from './theme';

export interface HeatSlot {
  /** 1 Monday to 7 Sunday. */
  dow: number;
  /** 0 to 23. */
  hour: number;
  messages: number;
  members: number;
}

/**
 * The steps of the scale, black to light turquoise (one hue, darker for fewer: brief v4 §9.6):
 * how much of turquoise-100 a cell takes over the black, from the quietest fifth of the busiest
 * cell to the busiest. An hour with nothing stays the surface's.
 */
export const HEAT_STEPS = [14, 30, 48, 68, 90] as const;

/** A cell's step on the scale: 0 for nothing, then 1 to 5. */
export function heatStep(messages: number, max: number): number {
  if (messages <= 0 || max <= 0) return 0;
  return Math.min(HEAT_STEPS.length, Math.ceil((messages / max) * HEAT_STEPS.length));
}

function shade(step: number): string | undefined {
  return step === 0
    ? undefined
    : `color-mix(in oklab, var(--turq-100) ${HEAT_STEPS[step - 1]}%, var(--black-900))`;
}

/**
 * When a community writes (brief v4 §9.6): a cell for each hour of each day of the week over 30
 * days, black for none to light turquoise for the busiest. Hover, touch or the arrow keys read a
 * cell (its day and hour, its messages and members); a click, Enter or Space picks it, and the
 * page lists who wrote then. The scale is under the grid; screen readers get the table.
 */
export function Heatmap({
  label,
  summary,
  slots,
  days,
  hours,
  picked,
  onPick,
  describe,
  legend,
}: {
  label: string;
  summary: string;
  /** The hours with messages; the others are empty. */
  slots: readonly HeatSlot[];
  /** The days' names, Monday first: short beside the rows, full in the tooltip. */
  days: readonly { short: string; full: string }[];
  /** An hour's name: « 9 PM », « 21 h ». */
  hours: (hour: number) => string;
  picked: { dow: number; hour: number } | null;
  onPick: (slot: { dow: number; hour: number } | null) => void;
  /** A cell in words: « 34 messages · 12 members ». */
  describe: (slot: HeatSlot) => string;
  legend: { fewer: string; more: string };
}) {
  const [active, setActive] = useState<{ dow: number; hour: number } | null>(null);
  const max = Math.max(0, ...slots.map((s) => s.messages));
  const at = (dow: number, hour: number): HeatSlot =>
    slots.find((s) => s.dow === dow && s.hour === hour) ?? { dow, hour, messages: 0, members: 0 };
  const pick = (slot: { dow: number; hour: number }) =>
    onPick(picked && picked.dow === slot.dow && picked.hour === slot.hour ? null : slot);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? picked ?? { dow: 1, hour: 9 };
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
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setActive({
      dow: Math.max(1, Math.min(7, from.dow + move[0])),
      hour: Math.max(0, Math.min(23, from.hour + move[1])),
    });
  };
  const shown = active ? at(active.dow, active.hour) : null;

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="flex min-w-0 gap-2">
        <div aria-hidden="true" className="flex shrink-0 flex-col gap-[3px] self-start">
          {days.map((day) => (
            <span key={day.short} className={`flex h-5 items-center ${CHART.axisLabel}`}>
              {day.short}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            role="group"
            aria-label={label}
            tabIndex={0}
            data-chart="heatmap"
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
            className="grid grid-rows-7 gap-[3px] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            {days.map((day, row) => (
              <div key={day.short} className="grid grid-cols-24 gap-[3px]">
                {Array.from({ length: 24 }, (_, hour) => {
                  const slot = at(row + 1, hour);
                  const step = heatStep(slot.messages, max);
                  const isPicked = picked?.dow === row + 1 && picked.hour === hour;
                  const isActive = active?.dow === row + 1 && active.hour === hour;
                  return (
                    <span
                      key={hour}
                      data-cell={`${row + 1}:${hour}`}
                      data-step={step}
                      onPointerEnter={() => setActive({ dow: row + 1, hour })}
                      onPointerDown={() => setActive({ dow: row + 1, hour })}
                      onClick={() => pick({ dow: row + 1, hour })}
                      className={`h-5 min-w-0 cursor-pointer rounded-[3px] transition-[box-shadow,transform] duration-150 ease-brand ${
                        step === 0 ? 'bg-surface-2' : ''
                      } ${isPicked ? 'ring-2 ring-turq-300 ring-offset-1 ring-offset-bg' : ''} ${
                        isActive && !isPicked ? 'ring-1 ring-white-300' : ''
                      }`}
                      style={{ backgroundColor: shade(step) }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <AnimatePresence>
            {shown && active ? (
              <motion.div
                key="tooltip"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: ease('tooltip') }}
                exit={{ opacity: 0, transition: ease('tooltip') }}
                className={`pointer-events-none absolute z-10 whitespace-nowrap ${CHART.tooltip}`}
                style={{
                  top: `calc(${(active.dow / 7) * 100}% + 6px)`,
                  ...(active.hour > 15
                    ? { right: `${((23 - active.hour) / 24) * 100}%` }
                    : { left: `${(active.hour / 24) * 100}%` }),
                }}
              >
                <p className="text-subtle">
                  {days[active.dow - 1]?.full} · {hours(active.hour)}
                </p>
                <p className="mt-1 text-sm text-fg">{describe(shown)}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div aria-hidden="true" className="relative mt-1.5 h-4">
            {[0, 6, 12, 18].map((hour) => (
              <span
                key={hour}
                className={`absolute top-0 ${CHART.axisLabel}`}
                style={{ left: `${(hour / 24) * 100}%` }}
              >
                {hours(hour)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className={`mt-3 flex items-center gap-2 ${CHART.legend}`}>
        {legend.fewer}
        {HEAT_STEPS.map((_, i) => (
          <span
            key={i}
            className="size-3 rounded-[3px]"
            style={{ backgroundColor: shade(i + 1) }}
          />
        ))}
        {legend.more}
      </div>
      <ChartTable>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {Array.from({ length: 24 }, (_, hour) => (
              <th key={hour} scope="col">
                {hours(hour)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day, row) => (
            <tr key={day.full}>
              <th scope="row">{day.full}</th>
              {Array.from({ length: 24 }, (_, hour) => (
                <td key={hour}>{at(row + 1, hour).messages}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </ChartTable>
    </figure>
  );
}
