import { LoaderCircle } from 'lucide-react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { UrgentDot } from './UrgentDot';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

// Pressed, a button scales to 0.98 (MOTION.md): transform only, never its layout.
const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium ' +
  'transition-[background-color,border-color,color,transform] duration-150 ease-brand ' +
  'active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 ' +
  'disabled:active:scale-100 motion-reduce:active:scale-100';

/**
 * One primary button per screen at most (brief v3 §5): the signature gradient, black text.
 * Every other action is a ghost: 1 px turquoise at 25 %, white text (`secondary`), or bare words
 * (`ghost`). What destroys (`danger`) is a ghost with the small red dot: never a red fill.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'button-primary',
  secondary: 'button-ghost',
  ghost: 'text-muted hover:bg-surface-3 hover:text-fg',
  danger: 'button-ghost',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.8125rem]',
  md: 'h-10 px-4 text-sm',
};

/** A link inside a block that leads to another section: bare turquoise words. */
export const SECTION_LINK_CLASS =
  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[0.8125rem] font-medium ' +
  'text-accent transition-colors duration-150 hover:text-turq-100 focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-accent';

export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}

interface Look {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon before the label (lucide-react, aria-hidden). */
  icon?: ReactNode;
}

/** What a destructive button wears before its words: the red dot, its only red. */
export function leadingMark(variant: ButtonVariant | undefined, icon: ReactNode): ReactNode {
  return variant === 'danger' ? (
    <>
      <UrgentDot />
      {icon}
    </>
  ) : (
    icon
  );
}

/**
 * A button of the design system; `loading` puts a spinner in the label's place (same size, the
 * label kept for screen readers) and blocks a second click.
 */
export function Button({
  variant,
  size,
  icon,
  loading = false,
  className = '',
  disabled,
  children,
  ...rest
}: Look & ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      type="button"
      className={buttonClass(variant, size, `relative ${className}`)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      <span className={`inline-flex items-center gap-2 ${loading ? 'opacity-0' : ''}`}>
        {leadingMark(variant, icon)}
        {children}
      </span>
      {loading ? (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <LoaderCircle className="size-4 animate-spin" />
        </span>
      ) : null}
    </button>
  );
}

/** A link that looks like a button. */
export function ButtonLink({
  variant,
  size,
  icon,
  className = '',
  children,
  ...rest
}: Look & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {leadingMark(variant, icon)}
      {children}
    </a>
  );
}
