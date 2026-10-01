import { useId, type ReactNode } from 'react';

/**
 * A titled block of a screen: an icon, a title and a line of description on the left, actions
 * on the right, then the content.
 */
export function Card({
  title,
  description,
  icon,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={`rounded-2xl border border-line bg-surface shadow-card ${className}`}
    >
      {title ? (
        <header
          className={`flex flex-wrap items-start justify-between gap-3 p-5 ${children ? 'pb-0' : ''}`}
        >
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
            {icon ? (
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg">
                {icon}
              </span>
            ) : null}
            <div className="min-w-0">
              <h2 id={id} className="font-semibold">
                {title}
              </h2>
              {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
            </div>
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
      ) : null}
      {children ? <div className="p-5">{children}</div> : null}
    </section>
  );
}
