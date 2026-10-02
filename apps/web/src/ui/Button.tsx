import { LoaderCircle } from 'lucide-react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium ' +
  'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60';

/**
 * One primary (mint) button per screen at most; every other action is a ghost: outlined
 * (`secondary`) or bare (`ghost`). Red only for what destroys (`danger`).
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'button-primary',
  secondary: 'border border-line text-fg hover:border-line-strong hover:bg-surface-2/60',
  ghost: 'text-muted hover:bg-surface-2/60 hover:text-fg',
  danger: 'border border-line text-danger hover:bg-danger-soft',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
};

/** A link inside a card that leads to another section: a ghost, mint text. */
export const SECTION_LINK_CLASS =
  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-accent ' +
  'hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent';

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
        {icon}
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
      {icon}
      {children}
    </a>
  );
}
