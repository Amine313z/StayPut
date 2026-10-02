import type { ReactNode } from 'react';
import { InfoTip } from './InfoTip';
import { AnimatedNumber } from './Motion';

/**
 * One figure, in two text sizes only (the brief): its label, with what it means behind the « i »,
 * and its value counting up. `hero` is the money row of the dashboard (40 px, silver); `lead`
 * makes it the largest (48 px) in the logo's silver-to-mint gradient, `glow` adds the soft light
 * behind it. On hover the card rises 2 px and its border turns mint (MOTION.md).
 */
export function MetricCard({
  label,
  value,
  format,
  info,
  better = null,
  hero = false,
  lead = false,
  glow = false,
  empty = null,
}: {
  label: ReactNode;
  /** Null: nothing to count yet (`empty` says why, behind the « i »). */
  value: number | null;
  format: (value: number) => string;
  /** What the figure means and how it is counted: behind the « i ». */
  info?: ReactNode;
  better?: 'up' | 'down' | null;
  hero?: boolean;
  lead?: boolean;
  glow?: boolean;
  empty?: ReactNode;
}) {
  const explanation = value === null && empty ? empty : info;
  return (
    <div
      className={`relative h-full rounded-xl border border-line bg-surface/60 p-5 transition-[transform,border-color] duration-250 ease-brand hover:border-line-strong motion-safe:hover:-translate-y-0.5 ${
        glow ? 'glow-behind' : ''
      }`}
    >
      <dt className="flex items-center gap-1.5">
        <span className="label-caps">{label}</span>
        {explanation ? <InfoTip>{explanation}</InfoTip> : null}
      </dt>
      <dd
        className={`mt-3 ${hero ? 'metric-hero' : 'metric text-2xl'} ${lead ? 'metric-lead' : ''}`}
      >
        {value === null ? (
          <span className="text-subtle">—</span>
        ) : (
          <AnimatedNumber
            value={value}
            format={format}
            better={better}
            className={lead ? 'text-hero' : 'text-fg'}
          />
        )}
      </dd>
    </div>
  );
}
