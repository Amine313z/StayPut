import type { ReactNode } from 'react';
import { StayPutMark } from './BrandIcons';

/**
 * Nothing to show yet (brief §7): the logo (or a more telling icon), one sentence, and the one
 * thing to do about it. `inset` inside a card: no frame of its own (page → card → row, never a
 * box in a box).
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  inset = false,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  body: ReactNode;
  action?: ReactNode;
  inset?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center text-center ${
        inset ? 'px-4 py-6' : 'rounded-xl border border-line bg-surface/60 px-6 py-10'
      }`}
    >
      <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-surface-2 text-muted">
        {icon ?? <StayPutMark size={26} />}
      </span>
      {title ? <p className="font-semibold text-fg">{title}</p> : null}
      <p className="mt-1 max-w-md text-sm">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
