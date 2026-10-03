import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  CUT_RADIUS,
  cutOut,
  findTarget,
  placeTip,
  type Box,
  type Side,
  type Size,
  type Targets,
  type TipPlace,
} from '../../guide';
import { EASE, ease } from '../../motion';

/** How long a place may take to show up (its page reading its data), in ms. */
const FIND_MS = 5_000;
const LOOK_EVERY_MS = 100;
/** A place's fallback (its page's tabs, its list) is lit only once the place is this late. */
const FALLBACK_AFTER_MS = 1_500;
/** A scroll is over when no scroll event came for this long; never waited for longer than MAX. */
const SCROLL_IDLE_MS = 120;
const SCROLL_MAX_MS = 1_500;
/** The place has landed (its entrance animations, a count-up) once its box held this long. */
const STILL_MS = 150;
const SETTLE_MAX_MS = 2_000;
/** A place already this close to the window's middle (share of its height) stays where it is. */
const NEAR_MIDDLE = 0.25;
/** The bars over and under the page: a place behind them is not on screen. */
const TOP_BAR = 64;
const PHONE_BAR = 72;
/** The page around the light: black at 72 %. */
const DIM = 0.72;
/** The cut-out and the halo gliding from one place to the next: 400 ms on the brand's easing. */
const GLIDE = { duration: 0.4, ease: EASE } as const;
/** The tooltip comes in sliding this far toward its place. */
const SLIDE = 6;
/** A non-blocking light (a shortcut): in, held, out. */
const FLASH_MS = 2_000;

function viewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

function boxOf(element: Element): Box {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function same(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Brings the place to the middle of the window (smoothly, unless the device asks for less
 * motion) and resolves once the scroll is over: no scroll event for 120 ms, 1.5 s at most. A
 * place already whole on screen and near the middle is left where it is.
 */
async function bringIntoView(element: HTMLElement, reduce: boolean): Promise<void> {
  const view = viewport();
  const box = boxOf(element);
  const bottom = view.height - (view.width < 768 ? PHONE_BAR : 0);
  const middle = (TOP_BAR + bottom) / 2;
  const whole = box.y >= TOP_BAR && box.y + box.height <= bottom;
  if (whole && Math.abs(box.y + box.height / 2 - middle) <= view.height * NEAR_MIDDLE) return;
  let last = performance.now();
  const moved = () => {
    last = performance.now();
  };
  window.addEventListener('scroll', moved, { capture: true, passive: true });
  try {
    element.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reduce ? 'auto' : 'smooth',
    });
    const started = performance.now();
    let frames = 0;
    while (performance.now() - started < SCROLL_MAX_MS) {
      await nextFrame();
      frames += 1;
      if (frames > 2 && performance.now() - last >= SCROLL_IDLE_MS) break;
    }
  } finally {
    window.removeEventListener('scroll', moved, { capture: true });
  }
}

/** Resolves once the place's box held still for 150 ms (its page, its count-up landed), 2 s at most. */
async function settle(element: HTMLElement, alive: () => boolean): Promise<void> {
  const started = performance.now();
  let previous = boxOf(element);
  let since = started;
  while (alive() && element.isConnected) {
    await nextFrame();
    const now = performance.now();
    const box = boxOf(element);
    if (!same(box, previous)) {
      previous = box;
      since = now;
    }
    if (now - since >= STILL_MS || now - started >= SETTLE_MAX_MS) return;
  }
}

/** What the light shows: the place a search found, measured, and what the tooltip must clear. */
interface Shown {
  /** The search it answers. */
  key: string;
  element: HTMLElement;
  /** The element's box; null once it left the page. */
  box: Box | null;
  /** What is lit next, when it is on screen: the tooltip never covers it. */
  avoid: Box[];
  /** The side menu's right edge, when the place is in the menu: the tooltip goes beyond it. */
  menuEdge: number | null;
  /** A new place (the light glides there) or the page moving under it (it follows at once). */
  how: 'arrive' | 'follow';
}

function measure(
  key: string,
  element: HTMLElement,
  next: Targets | undefined,
  how: Shown['how'],
): Shown {
  const view = viewport();
  const nextElement = next ? findTarget(next) : null;
  const nextBox = nextElement && nextElement !== element ? boxOf(nextElement) : null;
  const onScreen =
    nextBox !== null &&
    nextBox.y + nextBox.height > 0 &&
    nextBox.y < view.height &&
    nextBox.x + nextBox.width > 0 &&
    nextBox.x < view.width;
  const menu = element.closest('aside');
  return {
    key,
    element,
    box: element.isConnected ? boxOf(element) : null,
    avoid: onScreen && nextBox ? [cutOut(nextBox)] : [],
    menuEdge: menu ? menu.getBoundingClientRect().right : null,
    how,
  };
}

/**
 * Finds the place of `key`, waiting for its page to show it; brings it to the middle of the
 * window, waits for the scroll to end and the place to land, then measures it. While the next
 * place is looked for, the last one stays lit and followed (the light then glides from it). The
 * box keeps following the page: a scroll, a new window size, the place or the page changing.
 */
function useShown(
  targets: Targets,
  key: string,
  next: Targets | undefined,
  reduce: boolean,
): { shown: Shown | null; late: boolean } {
  const [shown, setShown] = useState<Shown | null>(null);
  const [lateKey, setLateKey] = useState<string | null>(null);
  const nextRef = useRef(next);
  useEffect(() => {
    nextRef.current = next;
  });

  // One search per place. The place itself is waited for a while before a fallback is taken
  // (a page reading its data shows its tabs before its content); a place that leaves the page
  // while it is brought forward (the previous page, still there for a moment) is looked for again.
  useEffect(() => {
    let alive = true;
    const isAlive = () => alive;
    void (async () => {
      const started = performance.now();
      while (alive) {
        const waited = performance.now() - started;
        const element = findTarget(waited < FALLBACK_AFTER_MS ? targets.slice(0, 1) : targets);
        if (!element) {
          if (waited >= FIND_MS) {
            setLateKey(key);
            return;
          }
          await pause(LOOK_EVERY_MS);
          continue;
        }
        await bringIntoView(element, reduce);
        if (!alive) return;
        await settle(element, isAlive);
        if (!alive) return;
        if (element.isConnected) {
          setShown(measure(key, element, nextRef.current, 'arrive'));
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, targets, reduce]);

  // The place found follows the page.
  const element = shown?.element ?? null;
  const shownKey = shown?.key ?? null;
  useEffect(() => {
    if (!element || shownKey === null) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setShown((current) => {
          if (!current || current.element !== element) return current;
          const now = measure(shownKey, element, nextRef.current, 'follow');
          const unchanged =
            (current.box === null && now.box === null) ||
            (current.box !== null && now.box !== null && same(current.box, now.box));
          // Unchanged, it keeps how it came (a glide under way goes on).
          return unchanged ? current : now;
        }),
      );
    };
    window.addEventListener('scroll', follow, { capture: true, passive: true });
    window.addEventListener('resize', follow);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    observer?.observe(element);
    observer?.observe(document.body);
    // What no event says (a block above it growing, the page changing under it).
    const watch = window.setInterval(follow, 300);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(watch);
      observer?.disconnect();
      window.removeEventListener('scroll', follow, { capture: true });
      window.removeEventListener('resize', follow);
    };
  }, [element, shownKey]);

  return { shown, late: lateKey === key };
}

/** Only the page under the light is out of reach: StayPut's root, while it shows. */
function useInertPage() {
  useEffect(() => {
    const page = document.getElementById('root');
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    page?.setAttribute('inert', '');
    return () => {
      page?.removeAttribute('inert');
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A place of the app in the light (brief v4 §10, fix prompt v4.1 block 1), for the tour and for
 * « Show me » alike. The page is dimmed to 72 % black with a real cut-out around the place (8 px
 * of room, 12 px corners) under a 2 px turquoise halo that glows softly: the place stays wholly
 * visible. The place is first brought to the middle of the window and allowed to land, then
 * measured; the light follows it as the page moves. From one place to the next the cut-out and
 * the halo glide (position and size, 400 ms). The tooltip (320 px at most) stands on the first
 * side with room, in the order right, bottom, left, top, never over the place nor over what is
 * lit next, its 12 px arrow pointing at the place; it comes in with a fade and a 6 px slide. The
 * keyboard stays in the tooltip; Escape closes; a click on the dimmed page calls `onBackdrop`.
 * When the place never shows up, the tooltip stays in the middle of the dimmed page.
 */
export function Spotlight({
  targets,
  stepKey,
  next,
  label,
  onClose,
  onBackdrop,
  onKey,
  children,
}: {
  targets: Targets;
  stepKey: string;
  /** What is lit after this place, when it is on the same page. */
  next?: Targets;
  /** The tooltip's name, for screen readers. */
  label: string;
  onClose: () => void;
  onBackdrop?: () => void;
  /** Other keys while it shows (the tour's arrows). */
  onKey?: (key: string) => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  const { shown, late } = useShown(targets, stepKey, next, reduce);
  const maskId = useId();
  const [tip, setTip] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [view, setView] = useState(viewport);
  useInertPage();

  useEffect(() => {
    const resize = () => setView(viewport());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // The tooltip's size, read as soon as it is drawn (before it shows) and whenever it changes.
  useLayoutEffect(() => {
    if (!tip) return;
    const read = () =>
      setSize((current) =>
        current?.width === tip.offsetWidth && current.height === tip.offsetHeight
          ? current
          : { width: tip.offsetWidth, height: tip.offsetHeight },
      );
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(tip);
    return () => observer.disconnect();
  }, [tip]);

  const keys = useRef({ onClose, onKey, tip });
  useEffect(() => {
    keys.current = { onClose, onKey, tip };
  });
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        keys.current.onClose();
        return;
      }
      if (event.key === 'Tab') {
        // The keyboard stays in the tooltip.
        const box = keys.current.tip;
        const inside = [...(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        const first = inside[0];
        const last = inside.at(-1);
        if (!box || !first || !last) return;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !box.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !box.contains(active))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      keys.current.onKey?.(event.key);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);

  const current = shown?.key === stepKey ? shown : null;
  const cut = shown?.box ? cutOut(shown.box) : null;
  const ready = current !== null || late;
  const place: TipPlace | null =
    ready && size
      ? placeTip(current?.box ? cutOut(current.box) : null, size, view, {
          avoid: current?.avoid ?? [],
          menuEdge: current?.menuEdge ?? null,
        })
      : null;
  const placed = place !== null;
  const move = shown?.how === 'arrive' && !reduce ? GLIDE : { duration: 0 };

  // Each new place: the keyboard on the tooltip's main button, once it shows.
  useEffect(() => {
    if (!placed || !tip) return;
    tip.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [placed, tip]);

  return createPortal(
    <div role="presentation" className="fixed inset-0 z-[60]" onClick={() => onBackdrop?.()}>
      <svg aria-hidden="true" data-spot="dim" className="absolute inset-0 h-full w-full">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect width="100%" height="100%" fill="white" />
            {cut ? (
              <motion.rect
                fill="black"
                rx={CUT_RADIUS}
                ry={CUT_RADIUS}
                initial={{ attrX: cut.x, attrY: cut.y, width: cut.width, height: cut.height }}
                animate={{ attrX: cut.x, attrY: cut.y, width: cut.width, height: cut.height }}
                transition={move}
              />
            ) : null}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="#050607"
          fillOpacity={DIM}
          mask={`url(#${maskId})`}
        />
      </svg>
      <AnimatePresence>
        {cut ? (
          <motion.div
            key="halo"
            data-spot="cut"
            aria-hidden="true"
            className="pointer-events-none fixed top-0 left-0"
            style={{
              borderRadius: CUT_RADIUS,
              boxShadow: '0 0 0 2px var(--turq-300), 0 0 22px 2px var(--turq-glow)',
            }}
            initial={{ opacity: 0, x: cut.x, y: cut.y, width: cut.width, height: cut.height }}
            animate={{ opacity: 1, x: cut.x, y: cut.y, width: cut.width, height: cut.height }}
            exit={{ opacity: 0, transition: ease('standard') }}
            transition={{ ...move, opacity: ease('standard') }}
          />
        ) : null}
      </AnimatePresence>
      <motion.div
        className="fixed top-0 left-0"
        style={{ x: place?.x ?? 0, y: place?.y ?? 0, pointerEvents: placed ? 'auto' : 'none' }}
        onClick={(event) => event.stopPropagation()}
      >
        <motion.div
          // A new place, or the same seen from another side: the tooltip comes in again.
          key={`${stepKey}:${place?.side ?? ''}`}
          ref={setTip}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          data-spot="tip"
          data-side={place?.side}
          initial={place && !reduce ? { opacity: 0, ...slideFrom(place.side) } : { opacity: 0 }}
          animate={placed ? { opacity: 1, x: 0, y: 0 } : { opacity: 0 }}
          transition={ease('standard')}
          className="relative w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line-strong bg-surface-2 p-4 text-sm shadow-lift"
        >
          {children}
          {place && place.side !== 'center' ? <Arrow side={place.side} at={place.arrow} /> : null}
        </motion.div>
      </motion.div>
    </div>,
    document.body,
  );
}

/** Where the tooltip starts its 6 px slide: away from the place it then moves toward. */
function slideFrom(side: Side | 'center'): { x: number; y: number } {
  switch (side) {
    case 'right':
      return { x: SLIDE, y: 0 };
    case 'left':
      return { x: -SLIDE, y: 0 };
    case 'bottom':
      return { x: 0, y: SLIDE };
    case 'top':
      return { x: 0, y: -SLIDE };
    default:
      return { x: 0, y: 0 };
  }
}

/** The 12 px arrow on the tooltip's edge, pointing at the place. */
function Arrow({ side, at }: { side: Side; at: number }) {
  // Drawn pointing up (the tooltip under the place), turned for the other sides; its base sits
  // on the tooltip's border, which it covers.
  const turn = { bottom: 0, left: 90, top: 180, right: -90 }[side];
  const position =
    side === 'bottom'
      ? { left: at - 6, top: -6 }
      : side === 'top'
        ? { left: at - 6, bottom: -6 }
        : side === 'right'
          ? { top: at - 3, left: -9 }
          : { top: at - 3, right: -9 };
  return (
    <svg
      aria-hidden="true"
      data-spot="arrow"
      width="12"
      height="6"
      viewBox="0 0 12 6"
      className="absolute overflow-visible"
      style={{ ...position, transform: `rotate(${turn}deg)` }}
    >
      <path d="M0 7 L6 1 L12 7 Z" fill="var(--surface-2)" />
      <path d="M0.5 6.5 L6 1 L11.5 6.5" fill="none" stroke="var(--border-strong)" />
    </svg>
  );
}

/**
 * A shortcut's light: the page scrolls to the control, a 2 px turquoise halo comes on around it
 * and fades (2 s), without dimming anything or stopping a click; the cursor goes into its first
 * field. Nothing found: nothing shows.
 */
export function Flash({ targets, onDone }: { targets: Targets; onDone: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const { shown, late } = useShown(targets, 'flash', undefined, reduce);
  const element = shown?.element ?? null;
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    if (late) {
      done.current();
      return;
    }
    if (!element) return;
    const field = element.matches('input, select, textarea')
      ? element
      : element.querySelector<HTMLElement>('input, select, textarea');
    field?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => done.current(), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [element, late]);
  if (!shown?.box) return null;
  const halo = cutOut(shown.box);
  return createPortal(
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[60]"
      style={{
        borderRadius: CUT_RADIUS,
        boxShadow: '0 0 0 2px var(--turq-300), 0 0 24px 2px var(--turq-glow)',
      }}
      initial={{ opacity: 0, ...halo }}
      animate={{ opacity: [0, 1, 1, 0], ...halo }}
      transition={{
        duration: 0,
        opacity: { duration: FLASH_MS / 1000, times: [0, 0.1, 0.75, 1], ease: EASE },
      }}
    />,
    document.body,
  );
}
