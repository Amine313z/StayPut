import type { ReactNode } from 'react';
import { AnimatedNumber } from './Motion';

/** Where a figure stands: the brand's mint for money kept, red for money at stake. */
export type MetricTone = 'saved' | 'danger' | 'neutral';

const VALUE_TONES: Record<MetricTone, string> = {
  saved: 'text-saved',
  danger: 'text-danger',
  neutral: 'text-fg',
};

/**
 * One figure: its label, the number counting to its value, a line of context. `hero` is the
 * money row of the home (large figure; `glow` adds the soft light behind the one that matters
 * most). On hover the card rises 2 px and its border turns mint (MOTION.md).
 */
export function MetricCard({
  label,
  value,
  format,
  hint,
  icon,
  tone = 'neutral',
  better = null,
  hero = false,
  lead = false,
  glow = false,
  empty = null,
}: {
  label: ReactNode;
  /** Null: nothing to count yet (`empty` says why). */
  value: number | null;
  format: (value: number) => string;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: MetricTone;
  better?: 'up' | 'down' | null;
  hero?: boolean;
  /** The figure of the row that matters most: a step larger than the other heroes. */
  lead?: boolean;
  glow?: boolean;
  empty?: ReactNode;
}) {
  return (
    <div
      className={`group relative h-full overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-card transition-[transform,border-color,box-shadow] duration-250 ease-brand hover:border-line-strong hover:shadow-lift motion-safe:hover:-translate-y-0.5 ${
        glow ? 'glow-behind' : ''
      }`}
    >
      {/* Room for two lines of label: the figures of a row line up, in every language. */}
      <dt className="flex min-h-8 items-start justify-between gap-3">
        <span className="label-caps">{label}</span>
        {icon ? <span className="text-subtle">{icon}</span> : null}
      </dt>
      <dd
        className={`mt-3 ${hero ? 'metric-hero' : 'metric text-3xl'} ${lead ? 'metric-lead' : ''} ${VALUE_TONES[tone]}`}
      >
        {value === null ? (
          <span className="text-subtle">—</span>
        ) : (
          <AnimatedNumber value={value} format={format} better={better} />
        )}
      </dd>
      {value === null && empty ? (
        <dd className="mt-2 text-sm text-muted">{empty}</dd>
      ) : hint ? (
        <dd className="mt-2 text-sm text-muted">{hint}</dd>
      ) : null}
    </div>
  );
}
