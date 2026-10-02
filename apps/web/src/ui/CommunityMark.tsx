import { useState } from 'react';

/**
 * The community's logo, served by StayPut (`src`); without one, or while it cannot be read, its
 * initials on the brand's mint. Decorative: the name is written next to it.
 */
export function CommunityMark({
  name,
  src,
  size = 32,
}: {
  name: string | null;
  src: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initials =
    (name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'S';
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-lg border border-line object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-lg border border-line bg-accent-soft font-display text-xs font-bold text-accent"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}
