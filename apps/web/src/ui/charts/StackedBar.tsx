import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { STAGGER, ease } from '../../motion';

export interface BarPart {
  key: string;
  label: string;
  value: number;
  /** The mark's color class (a risk token: bg-risk-*). */
  fill: string;
  /** Where the part's legend line leads (its members), if anywhere. */
  href?: string;
}

/**
 * Parts of one whole on a single bar (MOTION.md: each part grows from the left, one after the
 * other). A 2 px gap of the card's surface between parts, rounded ends; every part also has its
 * name and count in the legend below, so its color is never alone. Hover or focus a part: its
 * share.
 */
export function StackedBar({
  parts,
  total,
  format,
  label,
}: {
  parts: readonly BarPart[];
  total: number;
  /** A part's line in its tooltip: « 7 · 28 % ». */
  format: (part: BarPart, share: number) => string;
  label: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const shown = parts.filter((p) => p.value > 0);
  return (
    // A container: the legend takes two columns only where its names fit.
    <div className="@container">
      <div role="group" aria-label={label} className="relative">
        <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2">
          {shown.map((part, i) => (
            <motion.button
              key={part.key}
              type="button"
              aria-label={`${part.label} · ${format(part, part.value / total)}`}
              onMouseEnter={() => setHover(part.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(part.key)}
              onBlur={() => setHover(null)}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={ease('count', i * STAGGER * 2)}
              className={`h-full origin-left first:rounded-s-full last:rounded-e-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${part.fill}`}
              style={{ flexGrow: part.value, flexBasis: 0 }}
            />
          ))}
        </div>
        <AnimatePresence>
          {hover ? (
            <motion.p
              key={hover}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: ease('tooltip') }}
              exit={{ opacity: 0, transition: ease('tooltip') }}
              className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 rounded-lg border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-lift"
            >
              {(() => {
                const part = shown.find((p) => p.key === hover);
                return part ? `${part.label} · ${format(part, part.value / total)}` : null;
              })()}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1.5 @sm:grid-cols-2 @sm:gap-y-2.5">
        {parts.map((part) => {
          const line = (
            <>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-2.5 shrink-0 rounded-full ${part.fill}`}
                />
                <span className="truncate text-muted" title={part.label}>
                  {part.label}
                </span>
              </span>
              <span className="tabular shrink-0 font-semibold whitespace-nowrap">
                {format(part, total ? part.value / total : 0)}
              </span>
            </>
          );
          const look = `flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-sm transition-colors duration-150 ${
            hover === part.key ? 'bg-surface-2' : ''
          }`;
          return (
            <li key={part.key}>
              {part.href ? (
                <Link
                  to={part.href}
                  onMouseEnter={() => setHover(part.key)}
                  onMouseLeave={() => setHover(null)}
                  className={`${look} hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
                >
                  {line}
                </Link>
              ) : (
                <div className={look}>{line}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
