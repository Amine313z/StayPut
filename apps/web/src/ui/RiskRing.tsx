import { motion } from 'motion/react';
import { ease } from '../motion';

/**
 * A risk score from 0 to 100 as a mint ring that draws itself to the value (MOTION.md), the score
 * in its middle. The number carries the meaning, said in words by `label` (the level's name):
 * never a color.
 */
export function RiskRing({
  score,
  label,
  size = 40,
}: {
  score: number;
  label: string;
  size?: number;
}) {
  const stroke = 3;
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
          className="stroke-line"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="stroke-accent"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: share }}
          transition={ease('count')}
        />
      </svg>
      <span className="metric absolute text-xs text-fg">{Math.round(score)}</span>
    </span>
  );
}
