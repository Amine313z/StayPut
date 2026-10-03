import type { ReactNode } from 'react';

/**
 * A sentence whose amounts are drawn in Satoshi like every number of the app (brief v4 §7):
 * « Retry 3 failed payments: $347.00 at risk ». The words stay Geist; the text reads the same.
 */
export function Figures({ text, figures }: { text: string; figures: readonly string[] }) {
  const parts: ReactNode[] = [];
  let rest = text;
  figures.forEach((figure, index) => {
    const at = figure ? rest.indexOf(figure) : -1;
    if (at < 0) return;
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push(
      <span key={index} className="num">
        {figure}
      </span>,
    );
    rest = rest.slice(at + figure.length);
  });
  if (rest) parts.push(rest);
  return <>{parts}</>;
}
