import { Check, LoaderCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SUCCESS_MS, ease } from '../motion';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button';

/**
 * A button that does something and says how it went (MOTION.md): pressed, it scales to 0.98;
 * while it works a spinner takes the icon's place (the label stays, the size never changes);
 * done, a check mark shows for 1.2 s. `run` rejects to say it failed: the button is offered
 * again and `onError` says why.
 */
export function ActionButton({
  run,
  onError,
  icon,
  variant = 'primary',
  size = 'md',
  disabled = false,
  className = '',
  children,
  doneLabel,
  stayDone = false,
  'aria-label': ariaLabel,
}: {
  run: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  /** What the button says while its check mark shows. */
  doneLabel?: ReactNode;
  /** Once done, stays done (its check mark and `doneLabel`): a thing that cannot be redone. */
  stayDone?: boolean;
  /** A name for a short label (« Message » on a member's row: « Message Ana »). */
  'aria-label'?: string;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <motion.button
      type="button"
      whileTap={state === 'idle' && !disabled ? { scale: 0.98 } : undefined}
      transition={ease('micro')}
      className={buttonClass(variant, size, className)}
      disabled={disabled || state !== 'idle'}
      aria-busy={state === 'running' || undefined}
      aria-label={ariaLabel}
      onClick={() => {
        setState('running');
        run().then(
          () => {
            setState('done');
            if (!stayDone) timer.current = window.setTimeout(() => setState('idle'), SUCCESS_MS);
          },
          (error: unknown) => {
            setState('idle');
            onError?.(error);
          },
        );
      }}
    >
      {state === 'running' ? (
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      ) : state === 'done' ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        icon
      )}
      {state === 'done' && doneLabel ? doneLabel : children}
    </motion.button>
  );
}
