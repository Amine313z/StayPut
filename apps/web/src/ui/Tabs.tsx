import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

export interface TabItem {
  to: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Active only on this exact path (the first tab). */
  end?: boolean;
  /** How many things the tab holds, when the screen knows it. */
  count?: string;
}

/** The sections of a view, as links: the address says which one is open. */
export function NavTabs({ items, label }: { items: readonly TabItem[]; label: string }) {
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-sm font-medium sm:gap-2 sm:px-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  isActive
                    ? 'border-accent text-fg'
                    : 'border-transparent text-muted hover:border-line hover:text-fg'
                }`
              }
            >
              {item.icon}
              {item.label}
              {item.count === undefined ? null : (
                <span className="tabular rounded-full bg-surface-2 px-1.5 text-xs text-muted">
                  {item.count}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
