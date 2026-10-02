import { Info } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { ease } from '../motion';

/**
 * The « i » beside a label: what a figure or a term means, on hover, focus or tap, instead of a
 * sentence under it (the brief: two text sizes per card, label and value). Screen readers hear it
 * with the button (aria-describedby), shown or not.
 */
export function InfoTip({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label ?? t('common.moreInfo')}
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
        className="-m-1 rounded-full p-1 text-subtle transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <Info aria-hidden="true" className="size-3.5" />
      </button>
      <span id={id} role="tooltip" className="sr-only">
        {children}
      </span>
      <AnimatePresence>
        {open ? (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: ease('tooltip') }}
            exit={{ opacity: 0, transition: ease('tooltip') }}
            className="absolute start-1/2 top-6 z-40 w-64 -translate-x-1/2 rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed font-normal tracking-normal text-muted normal-case shadow-lift"
          >
            {children}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
