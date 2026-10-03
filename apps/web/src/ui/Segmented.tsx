import { motion } from 'motion/react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ease } from '../motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** The option's own language, when it is named in it (« Français »). */
  lang?: string;
}

/**
 * A choice among a few, side by side (a period, a language): a radio group the keyboard walks
 * with the arrows. The chosen one is turquoise, on a pill that slides to it (MOTION.md: the
 * standard duration, the brand's easing; at once when the device asks for less motion).
 * `pills`: small separate pills without a frame (the balance's 7D / 30D / 90D, brief v4 §8).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  look = 'box',
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Its name for screen readers, unless `labelledBy` points to a visible one. */
  label?: string;
  labelledBy?: string;
  look?: 'box' | 'pills';
}) {
  const pills = look === 'pills';
  const pill = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    buttons.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={pills ? 'inline-flex gap-1' : 'inline-flex rounded-lg border border-line p-0.5'}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            lang={option.lang}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={`relative font-medium transition-colors duration-200 ease-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              pills ? 'rounded-full px-2.5 py-0.5 text-xs' : 'rounded-md px-3 py-1 text-[0.8125rem]'
            } ${checked ? 'text-turq-300' : 'text-subtle hover:text-fg'}`}
          >
            {checked ? (
              <motion.span
                layoutId={pill}
                transition={ease('standard')}
                aria-hidden="true"
                className={`absolute inset-0 bg-surface-3 ${pills ? 'rounded-full' : 'rounded-md'}`}
              />
            ) : null}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
