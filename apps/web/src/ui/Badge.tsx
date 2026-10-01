import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'danger' | 'serious' | 'warning' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  serious: 'bg-serious-soft text-serious',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
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
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

/** A tinted line of explanation: what is going on, what to do. */
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
    <div className={`flex gap-2 rounded-xl px-3 py-2.5 text-sm ${TONES[tone]}`}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 text-fg">{children}</div>
    </div>
  );
}
