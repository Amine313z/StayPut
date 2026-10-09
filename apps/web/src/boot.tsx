import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

/**
 * StayPut's loading screen (#boot in index.html): its mark and a thin light, drawn with the very
 * first paint, before any JavaScript, and kept until the screen opened is ready to show, so that
 * the page goes from it straight to its content (never a blank page, a spinner, then a frame
 * that fills in). It goes once and for all: later waits are the screens' own (skeletons).
 *
 * Who keeps it: the first frame to draw (`useBootReady`, the dashboard's and the other pages'),
 * and every screen still waiting on its first answer (`BootHold`). It fades out after the paint
 * in which nothing holds it any more. Should no frame ever draw (a file missing after a
 * deployment), it goes after BOOT_GIVE_UP_MS all the same, so the error shows.
 */
export const BOOT_GIVE_UP_MS = 8_000;

let holds = 0;
let firstFrame = false;
let gone = false;
let checking = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isGone = () => gone;

function element(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('boot');
}

/** Whether StayPut's loading screen is still on the page. */
export function bootShowing(): boolean {
  return !gone && element() !== null;
}

/** Called once by main.tsx: the loading screen waits for the first frame (or the give-up). */
export function startBoot(): void {
  if (!bootShowing()) return;
  window.setTimeout(() => {
    firstFrame = true;
    hide();
  }, BOOT_GIVE_UP_MS);
}

function hide(): void {
  const boot = element();
  gone = true;
  for (const listener of listeners) listener();
  if (!boot) return;
  boot.classList.add('boot-out');
  const remove = () => boot.remove();
  boot.addEventListener('transitionend', remove, { once: true });
  // No transition (less motion asked for, or the tab hidden): removed all the same.
  window.setTimeout(remove, 400);
}

/** After the next paint: hidden if the first frame drew and nothing holds it any more. */
function check(): void {
  if (gone || checking) return;
  checking = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      checking = false;
      if (!gone && firstFrame && holds === 0) hide();
    }),
  );
}

/** A frame of the app (the dashboard's, the pages'): drawn, the loading screen may go. */
export function useBootReady(): void {
  useLayoutEffect(() => {
    if (gone) return;
    firstFrame = true;
    check();
  }, []);
}

/**
 * A screen waiting for its first answer: while StayPut's loading screen is up, it stays up
 * (nothing is drawn under it); once it has gone, `fallback` shows (a skeleton, « Loading… »).
 */
export function BootHold({ fallback }: { fallback: ReactNode }) {
  const [showing] = useState(bootShowing);
  // Gone meanwhile (BOOT_GIVE_UP_MS): the screen shows its own wait.
  const goneNow = useSyncExternalStore(subscribe, isGone, isGone);
  const holding = showing && !goneNow;
  useLayoutEffect(() => {
    if (!holding) return;
    holds += 1;
    return () => {
      holds -= 1;
      check();
    };
  }, [holding]);
  return holding ? null : <>{fallback}</>;
}
