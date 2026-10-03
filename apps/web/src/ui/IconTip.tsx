import type { ReactNode } from 'react';

/**
 * The short name of an icon button, over it while it is hovered or focused (fix prompt v4.1,
 * block 3): fades in in 120 ms (MOTION.md), nothing to wait for. Visual only: the button carries
 * its own full name for screen readers (« Message Hugo Bernard »).
 */
export function IconTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        aria-hidden="true"
        data-tip=""
        className="pointer-events-none absolute start-1/2 bottom-full z-20 mb-1.5 -translate-x-1/2 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs whitespace-nowrap text-fg opacity-0 shadow-lift transition-opacity duration-[120ms] ease-brand group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
