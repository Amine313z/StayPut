import type { Transition, Variants } from 'motion/react';

/**
 * StayPut's motion system (MOTION.md): one easing, three durations, the same few gestures on
 * every screen. Only transform and opacity move (60 fps); no bounce on data. When the device
 * asks for less motion, MotionConfig (App) keeps the fades and drops the movement.
 */

/** The only easing: quick out of the gate, a soft landing. Same as `--ease-brand` (styles.css). */
export const EASE = [0.22, 1, 0.36, 1] as const;

/** Seconds, as Motion counts them; the CSS twins are `--dur-*` in styles.css. */
export const DURATION = {
  /** A press, a hover, a tooltip. */
  micro: 0.15,
  /** A card, a list item, a value. */
  standard: 0.25,
  /** A page coming in. */
  page: 0.4,
  /** A number counting to its value, a ring filling to it. */
  count: 0.8,
  /** A chart drawing its line. */
  draw: 1.2,
  /** A chart's tooltip. */
  tooltip: 0.12,
} as const;

/** Between two sections (or rows) of a group coming in. */
export const STAGGER = 0.06;

/** How long a button keeps its check mark after it succeeded. */
export const SUCCESS_MS = 1_200;

/** How long a toast stays. */
export const TOAST_MS = 4_000;

export function ease(duration: keyof typeof DURATION = 'standard', delay = 0): Transition {
  return { duration: DURATION[duration], ease: EASE, delay };
}

/** A page: fades in while rising 8 px; the menu around it never moves. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: ease('page') },
  exit: { opacity: 0, transition: ease('micro') },
};

/** A group whose children come in one after the other. */
export const groupVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: STAGGER } },
};

/** A child of such a group (a card, a row). */
export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: ease('standard') },
};
