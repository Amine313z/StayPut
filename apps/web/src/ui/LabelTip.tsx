import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import { ease } from '../motion';

/**
 * A label that explains itself (brief v3 §5: no « i » icon, the tooltip on the label's own
 * words): hovered, focused or tapped, what a figure or a term means, two lines at most. A dotted
 * underline says there is more. Screen readers hear it with the label (aria-describedby). How
 * StayPut counts lives here, never in a sentence under a number.
 */
export function LabelTip({
  tip,
  children,
  className = '',
}: {
  /** What the label means; without one, the label is plain words. */
  tip?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!tip) return <span className={className}>{children}</span>;
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        className={`cursor-help rounded-sm text-start underline decoration-white-500/40 decoration-dotted underline-offset-4 transition-colors duration-150 hover:decoration-white-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
      >
        {children}
      </button>
      <span id={id} role="tooltip" className="sr-only">
        {tip}
      </span>
      <AnimatePresence>
        {open ? (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0, transition: ease('tooltip') }}
            exit={{ opacity: 0, transition: ease('tooltip') }}
            className="absolute start-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs leading-relaxed font-normal tracking-normal text-muted normal-case shadow-lift"
          >
            {tip}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
