import {
  BadgePercent,
  BellOff,
  Check,
  CreditCard,
  MessagesSquare,
  Moon,
  PauseCircle,
  RotateCw,
  Send,
} from 'lucide-react';
import { motion, useInView, useReducedMotion, type Transition } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import type { GuideCard } from '../../guide';
import { EASE } from '../../motion';
import { DiscordIcon, StayPutMark, TelegramIcon } from '../../ui/BrandIcons';

/**
 * The guide cards' micro-animations (brief v4 §10 and §14): each a few seconds long, then a 1 s
 * pause, looping while its card is on screen. Transform and opacity only (the ring's stroke
 * aside, as every risk ring draws), no words: the card says them. Out of sight, a picture waits
 * on its first frame, so it starts again without a jump; when the device asks for less motion,
 * it shows its telling frame, still.
 */

/** The pause between two loops (brief v4 §14). */
const PAUSE_S = 1;

/** Playing; waiting out of sight on its first frame; or still on its telling frame. */
type Mode = 'play' | 'rest' | 'still';

/** One loop of `duration` seconds over `times` (0 to 1), then the pause. */
function loop(mode: Mode, duration: number, times: readonly number[]): Transition {
  return mode === 'play'
    ? { duration, times: [...times], ease: EASE, repeat: Infinity, repeatDelay: PAUSE_S }
    : { duration: 0 };
}

/** The keyframes while playing; otherwise the first frame, or the telling one (`still`). */
function frames<T>(mode: Mode, keyframes: readonly T[], still: number): T | T[] {
  if (mode === 'play') return [...keyframes];
  return keyframes[mode === 'rest' ? 0 : still]!;
}

function Stage({ children }: { children: (mode: Mode) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotion() ?? false;
  const mode: Mode = reduce ? 'still' : seen ? 'play' : 'rest';
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-loop={mode}
      className="relative flex h-24 items-center justify-center overflow-hidden rounded-lg border border-line bg-bg"
    >
      <div className="relative h-[84px] w-[280px] shrink-0">{children(mode)}</div>
    </div>
  );
}

/** Card 1, who is about to leave: a member slips to the top of the list, the reason beside them. */
function Who({ mode }: { mode: Mode }) {
  const t = loop(mode, 4, [0, 0.15, 0.45, 0.8, 1]);
  const at = <T,>(keyframes: readonly T[]) => frames(mode, keyframes, 2);
  const row = (y: readonly number[], width: number, risky = false) => (
    <motion.div
      className={`absolute inset-x-0 top-0 flex h-6 items-center gap-2 rounded-md px-2 ${risky ? 'z-10' : ''}`}
      initial={false}
      animate={{ y: at(y) }}
      transition={t}
    >
      {risky ? (
        <motion.span
          className="absolute inset-0 rounded-md border-s-2 border-turq-300 bg-surface-2"
          initial={false}
          animate={{ opacity: at([0, 0, 1, 1, 0]) }}
          transition={t}
        />
      ) : null}
      <span className="relative size-4 shrink-0 rounded-full bg-black-600" />
      <span className="relative h-2 rounded-full bg-black-600" style={{ width }} />
      <span className="flex-1" />
      {risky ? (
        <motion.span
          className="relative text-fg"
          initial={false}
          animate={{ opacity: at([0, 0, 1, 1, 0]), scale: at([0.6, 0.6, 1, 1, 0.6]) }}
          transition={t}
        >
          <CreditCard className="size-3.5" />
        </motion.span>
      ) : null}
      <svg width="18" height="18" viewBox="0 0 18 18" className="relative -rotate-90">
        <circle cx="9" cy="9" r="7.5" fill="none" strokeWidth="2" className="stroke-black-600" />
        <motion.circle
          cx="9"
          cy="9"
          r="7.5"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          className="stroke-turq-300"
          initial={false}
          animate={{ pathLength: risky ? at([0.18, 0.18, 0.86, 0.86, 0.18]) : width / 400 }}
          transition={risky ? t : { duration: 0 }}
        />
      </svg>
    </motion.div>
  );
  return (
    <div className="absolute inset-x-0 top-1">
      {row([0, 0, 28, 28, 0], 84)}
      {row([28, 28, 56, 56, 28], 104)}
      {row([56, 56, 0, 0, 56], 70, true)}
    </div>
  );
}

/** Card 2, keep them: a payment retried, a pause offered, a message sent, each checked. */
function Keep({ mode }: { mode: Mode }) {
  const lines = [
    { id: 'retry', icon: <RotateCw className="size-3.5" />, width: 112 },
    { id: 'pause', icon: <PauseCircle className="size-3.5" />, width: 92 },
    { id: 'message', icon: <Send className="size-3.5" />, width: 128 },
  ] as const;
  return (
    <div className="flex h-full flex-col justify-center gap-2.5">
      {lines.map((line, index) => {
        const start = 0.05 + index * 0.25;
        const t = loop(mode, 4.5, [0, start, start + 0.2, 0.9, 1]);
        const at = <T,>(keyframes: readonly T[]) => frames(mode, keyframes, 3);
        const gesture =
          line.id === 'retry'
            ? { rotate: at([0, 0, 360, 360, 360]), opacity: at([0.5, 0.5, 1, 1, 0.5]) }
            : line.id === 'pause'
              ? { scale: at([1, 1, 1.15, 1, 1]), opacity: at([0.5, 0.5, 1, 1, 0.5]) }
              : { x: at([0, 0, 5, 0, 0]), opacity: at([0.5, 0.5, 1, 1, 0.5]) };
        return (
          <div key={line.id} className="flex h-5 items-center gap-2.5 px-2">
            <motion.span className="text-turq-300" initial={false} animate={gesture} transition={t}>
              {line.icon}
            </motion.span>
            <span
              className="relative h-2 overflow-hidden rounded-full bg-black-600"
              style={{ width: line.width }}
            >
              <motion.span
                className="absolute inset-0 origin-left rounded-full bg-turq-300/70"
                initial={false}
                animate={{ scaleX: at([0, 0, 1, 1, 0]) }}
                transition={t}
              />
            </span>
            <span className="flex-1" />
            <motion.span
              className="flex size-4 items-center justify-center rounded-full border border-line-strong text-turq-300"
              initial={false}
              animate={{ opacity: at([0, 0, 1, 1, 0]), scale: at([0.7, 0.7, 1, 1, 0.7]) }}
              transition={t}
            >
              <Check className="size-3" />
            </motion.span>
          </div>
        );
      })}
    </div>
  );
}

/** The mini balance's curve, in a 280 × 84 box: up month after month, as a balance grows. */
const CURVE =
  'M0 76 C 30 74, 48 70, 70 66 S 110 58, 130 54 S 170 44, 190 36 S 236 22, 252 16 S 272 10, 276 9';

/** Card 3, the money kept: the month's balance drawn left to right, its last point lit. */
function Money({ mode }: { mode: Mode }) {
  const t = loop(mode, 4, [0, 0.08, 0.1, 0.12, 0.6, 0.62, 0.64, 0.95, 1]);
  const at = <T,>(keyframes: readonly T[]) => frames(mode, keyframes, 8);
  return (
    <>
      <svg viewBox="0 0 280 84" className="absolute inset-0 h-full w-full" fill="none">
        <defs>
          <linearGradient id="guide-money-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--turq-300)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--turq-300)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.g
          initial={false}
          animate={{ opacity: at([1, 0, 0, 1, 1, 1, 1, 1, 1]) }}
          transition={t}
        >
          <path d={`${CURVE} L276 84 L0 84 Z`} fill="url(#guide-money-area)" />
          <path d={CURVE} stroke="var(--turq-300)" strokeWidth="2" strokeLinecap="round" />
        </motion.g>
      </svg>
      {/* The page's black slides off the curve: it draws in left to right, transform only. */}
      <motion.span
        className="absolute inset-y-0 -end-1 start-0 bg-bg"
        initial={false}
        animate={{ x: at(['101%', '101%', '0%', '0%', '101%', '101%', '101%', '101%', '101%']) }}
        transition={t}
      />
      <span className="baseline-dots absolute inset-x-0 bottom-0 h-px" />
      <motion.span
        className="absolute size-1.5 rounded-full bg-turq-300"
        style={{ left: 273, top: 6 }}
        initial={false}
        animate={{
          scale: at([1, 1, 1, 1, 1, 1, 1, 1.8, 1]),
          opacity: at([0, 0, 0, 0, 0, 0, 0.6, 0, 0]),
        }}
        transition={t}
      />
      <motion.span
        className="absolute size-1.5 rounded-full bg-turq-300"
        style={{ left: 273, top: 6 }}
        initial={false}
        animate={{
          opacity: at([1, 0, 0, 0, 0, 1, 1, 1, 1]),
          scale: at([1, 0, 0, 0, 0, 1, 1, 1, 1]),
        }}
        transition={t}
      />
    </>
  );
}

/** Card 4, in control: the four limits turned on one after the other. */
function Control({ mode }: { mode: Mode }) {
  const limits = [
    { id: 'messages', icon: <MessagesSquare className="size-4" /> },
    { id: 'night', icon: <Moon className="size-4" /> },
    { id: 'discounts', icon: <BadgePercent className="size-4" /> },
    { id: 'never', icon: <BellOff className="size-4" /> },
  ];
  return (
    <div className="grid h-full grid-cols-4 items-center">
      {limits.map((limit, index) => {
        const on = 0.2 + index * 0.15;
        const t = loop(mode, 4, [0, 0.08, on, on + 0.08, 1]);
        const at = <T,>(keyframes: readonly T[]) => frames(mode, keyframes, 4);
        return (
          <div key={limit.id} className="flex flex-col items-center gap-2.5">
            <motion.span
              className="text-fg"
              initial={false}
              animate={{ opacity: at([1, 0.4, 0.4, 1, 1]) }}
              transition={t}
            >
              {limit.icon}
            </motion.span>
            <span className="relative h-4 w-7 rounded-full bg-black-600">
              <motion.span
                className="absolute inset-0 rounded-full bg-turq-300"
                initial={false}
                animate={{ opacity: at([1, 0, 0, 1, 1]) }}
                transition={t}
              />
              <motion.span
                className="absolute top-0.5 left-0.5 size-3 rounded-full bg-white-100"
                initial={false}
                animate={{ x: at([12, 0, 0, 12, 12]) }}
                transition={t}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Where a signal leaves each logo and where it reaches StayPut's mark (top left of a 6 px dot). */
const FROM = { discord: { x: 33, y: 17 }, telegram: { x: 33, y: 61 } };
const TO = { x: 103, y: 39 };

/** Card 5, Discord and Telegram: who is active reaches StayPut, the days' activity rises. */
function Connect({ mode }: { mode: Mode }) {
  const bars = [0.35, 0.6, 0.45, 0.8, 0.55, 0.95, 0.7];
  const dot = (from: { x: number; y: number }, start: number) => {
    const t = loop(mode, 4.5, [0, start, start + 0.3, start + 0.32, 1]);
    const at = <T,>(keyframes: readonly T[]) => frames(mode, keyframes, 0);
    return (
      <motion.span
        className="absolute size-1.5 rounded-full bg-turq-300"
        style={{ left: from.x, top: from.y }}
        initial={false}
        animate={{
          x: at([0, 0, TO.x - from.x, TO.x - from.x, 0]),
          y: at([0, 0, TO.y - from.y, TO.y - from.y, 0]),
          opacity: at([0, 1, 1, 0, 0]),
        }}
        transition={t}
      />
    );
  };
  return (
    <>
      <svg viewBox="0 0 280 84" className="absolute inset-0 h-full w-full" fill="none">
        <path
          d={`M36 20 L106 42 M36 64 L106 42`}
          stroke="var(--black-600)"
          strokeWidth="1.5"
          strokeDasharray="2 4"
        />
      </svg>
      <span className="absolute top-1.5 left-1 flex size-7 items-center justify-center rounded-lg border border-line bg-surface text-turq-300">
        <DiscordIcon className="size-4" />
      </span>
      <span className="absolute bottom-1.5 left-1 flex size-7 items-center justify-center rounded-lg border border-line bg-surface text-turq-100">
        <TelegramIcon className="size-4" />
      </span>
      {dot(FROM.discord, 0.04)}
      {dot(FROM.telegram, 0.16)}
      <span className="absolute top-7 left-[106px]">
        <StayPutMark size={28} />
      </span>
      <div className="absolute inset-y-2 right-1 flex w-[132px] items-end gap-2">
        {bars.map((height, index) => {
          const start = 0.4 + index * 0.04;
          const t = loop(mode, 4.5, [0, start, start + 0.18, 0.9, 1]);
          return (
            <span key={index} className="relative h-full flex-1">
              <motion.span
                className="absolute inset-x-0 bottom-0 h-full origin-bottom rounded-sm bg-turq-300/80"
                initial={false}
                animate={{ scaleY: frames(mode, [0.12, 0.12, height, height, 0.12], 3) }}
                transition={t}
              />
            </span>
          );
        })}
      </div>
    </>
  );
}

const PICTURES: Record<GuideCard['id'], (props: { mode: Mode }) => ReactNode> = {
  who: Who,
  keep: Keep,
  money: Money,
  control: Control,
  connect: Connect,
};

/** A guide card's picture: its few seconds, looping with a 1 s pause while it is on screen. */
export function GuideLoop({ card }: { card: GuideCard['id'] }) {
  const Picture = PICTURES[card];
  return <Stage>{(mode) => <Picture mode={mode} />}</Stage>;
}
