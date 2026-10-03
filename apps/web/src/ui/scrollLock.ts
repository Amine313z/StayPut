import { useEffect } from 'react';

/** The windows and drawers open now: the page stays still until the last one closes. */
let locks = 0;

/**
 * While a window or a drawer is open, the page behind it does not scroll (fix prompt v4.1,
 * block 3): `<html data-scroll-lock>`, which styles.css turns into `overflow: hidden`. The page
 * keeps its scrollbar's room (`scrollbar-gutter: stable`), so nothing shifts when it locks.
 */
export function useScrollLock(): void {
  useEffect(() => {
    const root = document.documentElement;
    locks += 1;
    root.setAttribute('data-scroll-lock', '');
    return () => {
      locks -= 1;
      if (locks === 0) root.removeAttribute('data-scroll-lock');
    };
  }, []);
}
