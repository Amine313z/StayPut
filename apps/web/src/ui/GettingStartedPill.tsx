import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ease } from '../motion';

export interface StartStep {
  key: string;
  label: string;
  done: boolean;
  /** The screen where it is done. */
  to: string;
}

/**
 * « Getting started » (brief v3 §6.2, §7): a slim pill under the page title. Four steps, each
 * leading to its screen and ticked once done. While fewer than two are done the steps show; from
 * two it folds to the pill alone (its steps a click away); all done, it is gone (the parent stops
 * showing it).
 */
export function GettingStartedPill({
  title,
  steps,
  progress,
  doneLabel,
}: {
  title: string;
  steps: readonly StartStep[];
  /** « 2 of 4 ». */
  progress: (done: number, total: number) => string;
  /** Said to screen readers after a step done. */
  doneLabel: string;
}) {
  const listId = useId();
  const done = steps.filter((step) => step.done).length;
  const [open, setOpen] = useState(done < 2);
  const share = steps.length > 0 ? done / steps.length : 0;
  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
        className="group inline-flex h-8 items-center gap-3 rounded-full border border-line ps-3.5 pe-3 text-[0.8125rem] transition-colors duration-150 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="font-medium text-fg">{title}</span>
        <span
          aria-hidden="true"
          className="relative h-1 w-14 overflow-hidden rounded-full bg-surface-3"
        >
          <motion.span
            className="absolute inset-0 origin-left rounded-full bg-turq-300"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: share }}
            transition={ease('count')}
          />
        </span>
        <span className="num text-subtle">{progress(done, steps.length)}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 text-subtle transition-transform duration-250 ease-brand ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ol
            id={listId}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: ease('standard') }}
            exit={{ opacity: 0, transition: ease('micro') }}
            className="flex flex-wrap gap-2"
          >
            {steps.map((step, index) => (
              <li key={step.key}>
                <Link
                  to={step.to}
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-line ps-1.5 pe-3 text-[0.8125rem] transition-colors duration-150 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span
                    aria-hidden="true"
                    className={`tabular flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-medium ${
                      step.done
                        ? 'border border-turq-300 text-turq-300'
                        : 'border border-line text-subtle'
                    }`}
                  >
                    {step.done ? <Check className="size-3" strokeWidth={3} /> : index + 1}
                  </span>
                  <span className={step.done ? 'text-subtle' : 'text-fg'}>
                    {step.label}
                    {step.done ? <span className="sr-only">{` · ${doneLabel}`}</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </motion.ol>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
