import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  findTarget,
  haloBox,
  inView,
  placeCard,
  type Box,
  type Size,
  type Targets,
} from '../../guide';
import { DURATION, EASE, ease } from '../../motion';

/** How long a place may take to show up (its page reading its data), in ms. */
const FIND_MS = 5_000;
const LOOK_EVERY_MS = 100;
/** The card waits this long for its place, then shows in the middle without it. */
const GRACE_MS = 700;
/** The halo gliding from one place to the next (brief v4 §14: 400 ms). */
const GLIDE = { duration: 0.4, ease: EASE } as const;
/** The bars over and under the page: a place behind them is not on screen. */
const TOP_BAR = 64;
const PHONE_BAR = 72;
/** A non-blocking light (a shortcut): in, held, out. */
const FLASH_MS = 2_000;

/** The page dimmed around the lit place: black at 70 % (brief v4 §10), the halo 2 px turquoise. */
const HALO_SHADOW = '0 0 0 2px var(--turq-300), 0 0 0 200vmax rgb(5 6 7 / 0.7)';

function viewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

interface Place {
  /** The search this answers. */
  key: string;
  element: HTMLElement | null;
  /** The place on screen; null while looked for, or when it never showed up. */
  box: Box | null;
  /** A new place (the halo glides there) or the page moving under it (it follows at once). */
  how: 'arrive' | 'follow';
  /** Looked for long enough: what is drawn shows without it. */
  late: boolean;
  view: Size;
}

/**
 * Finds the place to light up, waiting for its page to show it; brings it on screen; then keeps
 * its box as the page scrolls or the window changes. A new `key` starts a new search, the last
 * place kept meanwhile (the halo glides from it).
 */
function usePlace(targets: Targets, key: string, scroll: ScrollBehavior): Place {
  const [place, setPlace] = useState<Place>(() => ({
    key,
    element: null,
    box: null,
    how: 'arrive',
    late: false,
    view: viewport(),
  }));
  useEffect(() => {
    let element: HTMLElement | null = null;
    let frame = 0;
    let timer = 0;
    const started = Date.now();
    const measure = (how: Place['how']) => {
      if (!element?.isConnected) return;
      const r = element.getBoundingClientRect();
      const box = { x: r.left, y: r.top, width: r.width, height: r.height };
      setPlace({ key, element, box, how, late: false, view: viewport() });
    };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure('follow'));
    };
    const giveUp = () =>
      setPlace((current) =>
        current.key === key && current.box
          ? current
          : { key, element: null, box: null, how: 'arrive', late: true, view: viewport() },
      );
    const look = () => {
      element = findTarget(targets);
      if (element) {
        const r = element.getBoundingClientRect();
        const view = viewport();
        const box = { x: r.left, y: r.top, width: r.width, height: r.height };
        if (!inView(box, view, TOP_BAR, view.width < 768 ? PHONE_BAR : 0)) {
          element.scrollIntoView({ block: 'center', behavior: scroll });
        }
        measure('arrive');
        window.addEventListener('scroll', follow, { capture: true, passive: true });
        window.addEventListener('resize', follow);
        return;
      }
      if (Date.now() - started >= FIND_MS) giveUp();
      else timer = window.setTimeout(look, LOOK_EVERY_MS);
    };
    timer = window.setTimeout(look, 0);
    const grace = window.setTimeout(giveUp, GRACE_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(grace);
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', follow, { capture: true });
      window.removeEventListener('resize', follow);
    };
  }, [key, targets, scroll]);
  return place;
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

/**
 * A place of the app in the light (brief v4 §10): the page dimmed to 70 % black around it, a
 * 2 px turquoise halo on it, and a card beside it that says what it is. Between two places
 * (`stepKey`), the halo and the card glide in 400 ms (transform for the move; the cut-out's size
 * follows). Escape closes it; a click on the dimmed page calls `onBackdrop`. When its place
 * never shows up, the card stays in the middle of the dimmed page: what it says still holds.
 */
export function Spotlight({
  targets,
  stepKey,
  label,
  onClose,
  onBackdrop,
  onKey,
  children,
}: {
  targets: Targets;
  stepKey: string;
  /** The card's name, for screen readers. */
  label: string;
  onClose: () => void;
  onBackdrop?: () => void;
  /** Other keys while it shows (the tour's arrows). */
  onKey?: (key: string) => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  const place = usePlace(targets, stepKey, 'instant');
  const card = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 320, height: 168 });
  // Once seen, the card glides to its next place; the first time it fades in where it lands.
  const [seen, setSeen] = useState(false);
  useInertPage();

  useEffect(() => {
    const element = card.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.offsetWidth, height: element.offsetHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Each new place: the keyboard on its main button.
  useEffect(() => {
    card.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [stepKey]);

  const keys = useRef({ onClose, onKey });
  useEffect(() => {
    keys.current = { onClose, onKey };
  });
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        keys.current.onClose();
      } else keys.current.onKey?.(event.key);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, []);

  const halo = place.box ? haloBox(place.box, place.view) : null;
  const visible = place.box !== null || place.late;
  const at = placeCard(halo, size, place.view);
  const move = place.how === 'arrive' && !reduce ? GLIDE : { duration: 0 };

  return createPortal(
    <div role="presentation" className="fixed inset-0 z-[60]" onClick={() => onBackdrop?.()}>
      <AnimatePresence>
        {halo ? (
          <motion.div
            key="halo"
            data-spot="halo"
            aria-hidden="true"
            className="pointer-events-none fixed top-0 left-0 rounded-xl"
            style={{ boxShadow: HALO_SHADOW }}
            initial={{ opacity: 0, ...halo }}
            animate={{ opacity: 1, ...halo }}
            exit={{ opacity: 0, transition: ease('standard') }}
            transition={{ ...move, opacity: ease('standard') }}
          />
        ) : visible ? (
          <motion.div
            key="dim"
            data-spot="dim"
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 bg-black-900/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ease('standard')}
          />
        ) : null}
      </AnimatePresence>
      <motion.div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        initial={false}
        animate={{ opacity: visible ? 1 : 0, x: at.x, y: at.y }}
        transition={{
          ...(seen ? move : { duration: 0 }),
          opacity: { duration: DURATION.standard, ease: EASE },
        }}
        onAnimationComplete={() => {
          if (visible && !seen) setSeen(true);
        }}
        className="fixed top-0 left-0 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line-strong bg-surface-2 p-4 text-sm shadow-lift"
      >
        {children}
      </motion.div>
    </div>,
    document.body,
  );
}

/**
 * A shortcut's light: the page scrolls to the control, a 2 px turquoise halo comes on around it
 * and fades (2 s), without dimming anything or stopping a click; the cursor goes into its first
 * field. Nothing found: nothing shows.
 */
export function Flash({ targets, onDone }: { targets: Targets; onDone: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const place = usePlace(targets, 'flash', reduce ? 'instant' : 'smooth');
  const element = place.element;
  const late = place.late && !place.box;
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
  if (!place.box) return null;
  const halo = haloBox(place.box, place.view);
  return createPortal(
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[60] rounded-xl"
      style={{ boxShadow: '0 0 0 2px var(--turq-300), 0 0 24px 2px var(--turq-glow)' }}
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
