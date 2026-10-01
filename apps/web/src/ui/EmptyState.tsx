import type { ReactNode } from 'react';

/** Nothing to show yet: what will appear here, and how to get there. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center">
      {icon ? (
        <span className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-surface-2 text-muted">
          {icon}
        </span>
      ) : null}
      {title ? <p className="font-semibold">{title}</p> : null}
      <p className="mt-1 max-w-md text-sm text-muted">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
