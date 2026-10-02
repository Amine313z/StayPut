import type { ReactNode } from 'react';
import { StayPutMark } from './BrandIcons';

/**
 * Nothing to show yet (brief v3 §7): the logo, one sentence, and the one thing to do about it,
 * never default text. `inset` inside a block: no frame of its own (page → section → row, never a
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
        inset ? 'px-4 py-8' : 'rounded-xl border border-line px-6 py-12'
      }`}
    >
      {icon ? (
        <span className="mb-4 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted">
          {icon}
        </span>
      ) : (
        <StayPutMark size={40} className="mb-4" />
      )}
      {title ? <p className="title-section">{title}</p> : null}
      <p className="mt-1 max-w-md text-sm">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
