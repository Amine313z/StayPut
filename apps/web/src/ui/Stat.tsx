import type { ReactNode } from 'react';
import type { Tone } from './Badge';

const ICON_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  serious: 'bg-serious-soft text-serious',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
};

/** One figure of the community: what it counts, the number, and a word of context. */
export function Stat({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-card">
      {/* Room for two lines of label: the figures of a row line up, with a hint or without. */}
      <dt className="flex min-h-11 items-start justify-between gap-2 text-sm text-muted">
        <span className="pt-1">{label}</span>
        {icon ? (
          <span
            className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${ICON_TONES[tone]}`}
          >
            {icon}
          </span>
        ) : null}
      </dt>
      <dd className="tabular mt-2 text-2xl font-semibold tracking-tight">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-muted">{hint}</dd> : null}
    </div>
  );
}
