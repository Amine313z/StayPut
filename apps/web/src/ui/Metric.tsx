import type { ReactNode } from 'react';
import { LabelTip } from './LabelTip';
import { AnimatedNumber } from './Motion';

/**
 * The numbers of a hero block (brief v4 §7): a label in sentence case that explains itself on
 * hover, and the number in Satoshi, solid white, nothing under it. Each counts to its value
 * (MOTION.md); one that worsens dims a moment, never red.
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
 * The one large amount of the screen, as Whop writes a balance (brief v4 §8): its label in Geist
 * 500, 13 px, white; the amount in Satoshi 700, 48 px, solid white (the signature gradient is the
 * primary button's and the logo's, never an amount's), on the light behind it (`.hero-glow`).
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
        <LabelTip tip={tip} className="text-[0.8125rem] font-medium text-fg">
          {label}
        </LabelTip>
      </dt>
      <dd className="mt-2">
        {value === null ? (
          <span className="metric-hero text-subtle">{empty}</span>
        ) : (
          <AnimatedNumber
            value={value}
            format={format}
            better={better}
            className="metric-lead"
            tone="text-fg"
          />
        )}
      </dd>
    </dl>
  );
}

/** A compact figure beside the balance: its label Geist 13 px white-500, Satoshi 600 28 px. */
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
        <LabelTip tip={tip} className="text-[0.8125rem] font-medium text-subtle">
          {label}
        </LabelTip>
      </dt>
      <dd className="mt-1">
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
