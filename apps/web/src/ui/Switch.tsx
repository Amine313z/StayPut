import { motion } from 'motion/react';
import { SPRING } from '../motion';

/**
 * On or off, said at once (a switch, not a checkbox): turquoise when on, its knob moving on the
 * toggles' spring (MOTION.md). Its name and its sentence are elsewhere on the page
 * (`labelledBy`, `describedBy`). While `busy`, a press does nothing and screen readers hear it.
 */
export function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
  busy = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy: string;
  describedBy?: string;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!busy) onChange(!checked);
      }}
      className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-200 ease-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        checked ? 'border-turq-300 bg-turq-300' : 'border-line-strong bg-surface-3'
      } ${busy ? 'opacity-60' : ''}`}
    >
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ x: checked ? 16 : 0 }}
        transition={SPRING}
        className={`block size-[18px] rounded-full ${checked ? 'bg-on-accent' : 'bg-fg'}`}
      />
    </button>
  );
}
