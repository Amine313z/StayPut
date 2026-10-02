import type { ReactNode } from 'react';
import { UrgentDot } from './UrgentDot';

export type Tone = 'neutral' | 'accent' | 'danger' | 'serious' | 'warning' | 'info';

/**
 * Outlines only (brief v3 §5): white for a status, turquoise for what is on or done. Red is the
 * small dot of what is urgent, beside white words, never a fill. Amber, a second accent or a
 * tinted fill do not exist: `serious` and `warning` are plain white outlines.
 */
const TONES: Record<Tone, string> = {
  neutral: 'border border-white-100/20 text-muted',
  accent: 'border border-line-strong text-accent',
  danger: 'border border-white-100/20 text-fg',
  serious: 'border border-white-100/20 text-muted',
  warning: 'border border-white-100/20 text-muted',
  info: 'border border-line-strong text-accent',
};

/** A short status: « Active », « Payment failed », « Team »… */
export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {icon ?? (tone === 'danger' ? <UrgentDot /> : null)}
      {children}
    </span>
  );
}

/** A line of explanation on an elevated surface: what is going on, what to do. */
export function Notice({
  tone = 'info',
  icon,
  children,
}: {
  tone?: Exclude<Tone, 'neutral'>;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm">
      {icon ? (
        <span className={`mt-0.5 shrink-0 ${tone === 'danger' ? '' : 'text-accent'}`}>{icon}</span>
      ) : tone === 'danger' ? (
        <UrgentDot className="mt-2" />
      ) : null}
      <div className="min-w-0 text-fg">{children}</div>
    </div>
  );
}
