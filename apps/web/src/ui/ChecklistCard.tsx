import { ArrowRight, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { useId } from 'react';
import { Link } from 'react-router';
import { ease } from '../motion';

export interface ChecklistStep {
  key: string;
  label: string;
  done: boolean;
  /** The screen where it is done. */
  to: string;
}

/**
 * A short list of things to set up (« Getting started », brief §7): how far along, then each
 * step leading to its screen, ticked once done. Its parent stops showing it when all are done.
 */
export function ChecklistCard({
  title,
  steps,
  progress,
  doneLabel,
}: {
  title: string;
  steps: readonly ChecklistStep[];
  /** « 2 of 4 done ». */
  progress: (done: number, total: number) => string;
  /** Said to screen readers after a step done. */
  doneLabel: string;
}) {
  const titleId = useId();
  const done = steps.filter((step) => step.done).length;
  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-line bg-surface/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={titleId} className="font-semibold text-fg">
          {title}
        </h2>
        <p className="tabular text-xs text-subtle">{progress(done, steps.length)}</p>
      </div>
      <div aria-hidden="true" className="mt-3 h-1 overflow-hidden rounded-full bg-surface-2">
        <motion.div
          className="h-full origin-left rounded-full bg-accent"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: steps.length > 0 ? done / steps.length : 0 }}
          transition={ease('count')}
        />
      </div>
      <ol className="mt-4 grid gap-2 @lg:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step.key}>
            <Link
              to={step.to}
              className="group flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-sm transition-colors duration-150 ease-brand hover:border-line-strong hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span
                aria-hidden="true"
                className={`tabular flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                  step.done ? 'bg-accent text-on-accent' : 'border border-line-strong text-muted'
                }`}
              >
                {step.done ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
              </span>
              <span className={`min-w-0 flex-1 ${step.done ? 'text-subtle' : 'text-fg'}`}>
                {step.label}
                {step.done ? <span className="sr-only">{` · ${doneLabel}`}</span> : null}
              </span>
              <ArrowRight
                aria-hidden="true"
                className="size-4 shrink-0 text-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
