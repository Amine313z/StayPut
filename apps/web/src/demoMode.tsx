import { createContext, useContext, type ReactNode } from 'react';

/**
 * Whether the screens show the imaginary community of /demo (fix prompt v4.1, block 5). There,
 * nothing leaves StayPut: every button to a page outside it shows, said disabled, and opens
 * nothing (ui/ExternalLink.tsx). What the creator does inside (message, pause, offer, retry,
 * approve) stays: it changes only the imaginary community, answered in the browser (demo/api.ts).
 */
const DemoContext = createContext(false);

export function DemoMode({ on, children }: { on: boolean; children: ReactNode }) {
  return <DemoContext.Provider value={on}>{children}</DemoContext.Provider>;
}

/** True inside /demo; false anywhere else, a test of one screen included. */
export function useDemo(): boolean {
  return useContext(DemoContext);
}
