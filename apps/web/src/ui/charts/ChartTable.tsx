import type { ReactNode } from 'react';

/**
 * A chart's figures as a table, for screen readers only. A table is never narrower than its
 * content, so hiding the table itself would still widen the page on a phone: the hidden wrapper
 * holds it instead.
 */
export function ChartTable({ children }: { children: ReactNode }) {
  return (
    <div className="sr-only">
      <table>{children}</table>
    </div>
  );
}
