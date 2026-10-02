import type { ReactNode } from 'react';
import { LabelTip } from './LabelTip';
import { AnimatedNumber } from './Motion';

/**
 * The numbers of a hero block (brief v3 §5, §6.2): a label in capitals that explains itself on
 * hover, and the number, nothing under it. Each counts to its value and pulses a soft turquoise
 * light at the end (MOTION.md); one that worsens dims a moment, never red.
 */

interface MetricProps {
  label: string;
  className?: string;
  /** What the number means and how it is counted: the label's tooltip. */
  tip?: ReactNode;
  /** Null: nothing to count yet (no paying member), said by `empty`. */
  value: number | null;
  format: (value: number) => string;
  empty?: string;
  /** « up »: more is better (money saved); « down »: less is better (revenue at risk). */
  better: 'up' | 'down';
}

/**
 * The one giant number of the screen: 56 px, the signature gradient, on the light that sits
 * behind the hero block (the page draws it: `.hero-glow`).
 */
export function MetricHero({
  label,
  tip,
  value,
  format,
  empty,
  better,
  className = '',
}: MetricProps) {
  return (
    <dl className={`flex min-w-0 flex-col ${className}`}>
      <dt>
        <LabelTip tip={tip} className="label-caps">
          {label}
        </LabelTip>
      </dt>
      <dd className="mt-4">
        {value === null ? (
          <span className="metric-hero text-subtle">{empty}</span>
        ) : (
          <AnimatedNumber
            value={value}
            format={format}
            better={better}
            className="metric-lead"
            tone="text-hero"
          />
        )}
      </dd>
    </dl>
  );
}

/** A number of second rank beside the hero: 32 px, white. */
export function SecondaryMetric({
  label,
  tip,
  value,
  format,
  empty,
  better,
  className = '',
}: MetricProps) {
  return (
    <dl className={`flex min-w-0 flex-col ${className}`}>
      <dt>
        <LabelTip tip={tip} className="label-caps">
          {label}
        </LabelTip>
      </dt>
      <dd className="mt-3">
        {value === null ? (
          <span className="metric-hero text-subtle">{empty}</span>
        ) : (
          <AnimatedNumber
            value={value}
            format={format}
            better={better}
            className="metric-hero"
            tone="text-fg"
          />
        )}
      </dd>
    </dl>
  );
}
