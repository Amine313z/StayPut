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

/** A group whose children (StaggerItem) come in 60 ms apart (MOTION.md). */
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
 * A number on its way to `value`: counts up from 0 the first time (900 ms), then moves from its
 * old value to each new one (600 ms). When the device asks for less motion, the value shows at
 * once.
 */
export function useCountUp(value: number): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(reduce ? value : 0);
  const counted = useRef(false);
  useEffect(() => {
    if (reduce) {
      from.current = value;
      return;
    }
    const duration = counted.current ? DURATION.change : DURATION.count;
    counted.current = true;
    const controls = animate(from.current, value, {
      duration,
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

/** How long the turquoise light stays once a better figure has landed, in ms. */
const PULSE_MS = 700;

/** How long a worse figure dims (brief v4 §14), in ms. */
const DIP_MS = 200;

/**
 * A figure that counts up from 0 the first time it shows (900 ms) and moves from its old value to
 * each new one (600 ms), cents included (MOTION.md). When it gets better, a soft turquoise light
 * pulses behind it once it has landed; when it gets worse it dims for 200 ms instead (never red).
 * At rest, no light at all: a hero amount stays solid white (brief v4 §8). Which way is better
 * belongs to the figure (`better`; none: every change pulses). The light is a blurred turquoise
 * copy behind the figure whose opacity alone moves (60 fps). Less motion asked for: the value at
 * once, no light, no dip.
 */
export function AnimatedNumber({
  value,
  format,
  better = null,
  className = '',
  tone = '',
}: {
  value: number;
  format: (value: number) => string;
  /** « up »: more is better (money saved); « down »: less is better (revenue at risk). */
  better?: 'up' | 'down' | null;
  /** The figure's type (size, weight): its light wears it too. */
  className?: string;
  /** The figure's colour (`text-fg`): the figure alone, never its light. */
  tone?: string;
}) {
  const reduce = useReducedMotion();
  const shown = useCountUp(value);
  const previous = useRef(value);
  const [flash, setFlash] = useState<'good' | 'bad' | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (reduce || before === value) return;
    const improved = better === null || (better === 'up' ? value > before : value < before);
    const change = DURATION.change * 1000;
    const timers = improved
      ? [
          window.setTimeout(() => setFlash('good'), change),
          window.setTimeout(() => setFlash(null), change + PULSE_MS),
        ]
      : [
          window.setTimeout(() => setFlash('bad'), 0),
          window.setTimeout(() => setFlash(null), DIP_MS),
        ];
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [value, better, reduce]);
  // The light is the number again, turquoise and blurred, behind it (`.number-glow`, drawn by
  // CSS so the page's text holds the number once): only its opacity moves.
  const text = format(shown);
  return (
    <span className="relative inline-block">
      <span
        aria-hidden="true"
        data-glow={text}
        className={`tabular ${className} number-glow ${flash === 'good' ? 'opacity-60' : 'opacity-0'}`}
      />
      <span
        className={`tabular relative inline-block transition-opacity duration-200 ease-brand ${
          flash === 'bad' ? 'opacity-55' : ''
        } ${className} ${tone}`}
      >
        {text}
      </span>
    </span>
  );
}
