import { useMemo } from 'react';
import { QR_QUIET, qrModules } from '../card';

/**
 * The QR code of an address, to scan on the screen with a phone: one square per module, in
 * vector form, sharp at any size (a card's image shrunk to fit a page blurs its QR code past what
 * a camera reads), dark on white with its quiet zone, whatever the page's theme.
 */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { count, path } = useMemo(() => {
    const modules = qrModules(value);
    return { count: modules.length + QR_QUIET * 2, path: modulePath(modules) };
  }, [value]);
  // At least `size`, in whole pixels per module: every module the same, edges never blurred.
  const side = Math.max(2, Math.ceil(size / count)) * count;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${count} ${count}`}
      width={side}
      height={side}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-lg"
    >
      <rect width={count} height={count} fill="#ffffff" />
      <path d={path} fill="#0d1f1a" />
    </svg>
  );
}

/** The dark modules as one path: a unit square for each, after the quiet zone. */
export function modulePath(modules: boolean[][]): string {
  return modules
    .flatMap((row, r) =>
      row.map((dark, c) => (dark ? `M${c + QR_QUIET} ${r + QR_QUIET}h1v1h-1z` : '')),
    )
    .join('');
}
