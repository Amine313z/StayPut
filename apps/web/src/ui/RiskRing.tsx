import { motion } from 'motion/react';
import { ease } from '../motion';

/**
 * A risk score from 0 to 100 (brief v3 §5): a turquoise ring that draws itself from 0 to the
 * value (MOTION.md, 800 ms), the score in white in its middle. The number and `label` (the
 * level's name) carry the meaning: never a color.
 */
export function RiskRing({
  score,
  label,
  size = 40,
  delay = 0,
}: {
  score: number;
  label: string;
  size?: number;
  /** Seconds before it draws: the rows of a list one after the other. */
  delay?: number;
}) {
  const stroke = size >= 40 ? 3 : 2.5;
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
          className="stroke-black-600"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="stroke-turq-300"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: share }}
          transition={ease('count', delay)}
        />
      </svg>
      <span
        className="metric absolute text-fg"
        style={{ fontSize: Math.max(10, Math.round(size * 0.3)) }}
      >
        {Math.round(score)}
      </span>
    </span>
  );
}
