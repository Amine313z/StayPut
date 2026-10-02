import { motion } from 'motion/react';
import type { RiskLevel } from '@stayput/core';
import { ease } from '../motion';

/** The ring's color by level: the risk marks of styles.css (never text). */
const STROKES: Readonly<Record<RiskLevel, string>> = {
  scheduled_departure: 'stroke-risk-departure',
  high: 'stroke-risk-high',
  medium: 'stroke-risk-medium',
  low: 'stroke-risk-low',
};

/**
 * A risk score from 0 to 100 as a ring that draws itself to the value (MOTION.md), the score in
 * its middle. Its meaning is said by `label` (the level's name): never the color alone.
 */
export function RiskRing({
  score,
  level,
  label,
  size = 40,
}: {
  score: number;
  level: RiskLevel;
  label: string;
  size?: number;
}) {
  const stroke = 3.5;
  const radius = (size - stroke) / 2;
  const share = Math.max(0, Math.min(100, score)) / 100;
  return (
    <span
      role="img"
      aria-label={label}
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-surface-2"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className={STROKES[level]}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: share }}
          transition={ease('count')}
        />
      </svg>
      <span className="tabular absolute text-xs font-semibold">{Math.round(score)}</span>
    </span>
  );
}
