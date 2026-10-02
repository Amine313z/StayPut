import { animate, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DURATION, EASE, groupVariants, itemVariants, pageVariants } from '../motion';

/**
 * The motion system's building blocks (MOTION.md): a page that comes in, a group whose children
 * come in one after the other, and a number that counts to its value and says whether it got
 * better.
 */

/** A page: fades in while rising 8 px. Key it by the address so each page comes in. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={pageVariants} initial="initial" animate="enter" className={className}>
      {children}
    </motion.div>
  );
}

/** A group whose children (Stagger.Item) come in 40 ms apart. */
export function Stagger({
  children,
  className = '',
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'ul' | 'dl';
}) {
  const Tag = motion[as];
  return (
    <Tag variants={groupVariants} initial="hidden" animate="show" className={className}>
      {children}
    </Tag>
  );
}

export function StaggerItem({
  children,
  className = '',
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li';
}) {
  const Tag = motion[as];
  return (
    <Tag variants={itemVariants} className={className}>
      {children}
    </Tag>
  );
}

/**
 * A number on its way to `value`: counts from where it was (0 the first time) in 600 ms. When
 * the device asks for less motion, the value shows at once.
 */
export function useCountUp(value: number): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(reduce ? value : 0);
  useEffect(() => {
    if (reduce) {
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration: DURATION.count,
      ease: EASE,
      onUpdate: (latest) => {
        from.current = latest;
        setShown(latest);
      },
    });
    return () => controls.stop();
  }, [value, reduce]);
  return reduce ? value : shown;
}

/**
 * A figure that counts to its value. When it changes, it flashes mint if it got better and a
 * soft red if it got worse; which way is better belongs to the figure (`better`).
 */
export function AnimatedNumber({
  value,
  format,
  better = null,
  className = '',
}: {
  value: number;
  format: (value: number) => string;
  /** « up »: more is better (money saved); « down »: less is better (revenue at risk). */
  better?: 'up' | 'down' | null;
  className?: string;
}) {
  const shown = useCountUp(value);
  const previous = useRef(value);
  const [flash, setFlash] = useState<'good' | 'bad' | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (better === null || before === value) return;
    const improved = better === 'up' ? value > before : value < before;
    setFlash(improved ? 'good' : 'bad');
    const timer = window.setTimeout(() => setFlash(null), DURATION.count * 1000 + 200);
    return () => window.clearTimeout(timer);
  }, [value, better]);
  return (
    <span
      className={`tabular transition-colors duration-500 ease-brand ${
        flash === 'good' ? 'text-accent' : flash === 'bad' ? 'text-danger' : ''
      } ${className}`}
    >
      {format(shown)}
    </span>
  );
}
