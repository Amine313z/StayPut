import { User } from 'lucide-react';

/**
 * A member: their initials, white on an elevated surface, inside a 1 px turquoise ring at 15 %
 * (brief v3 §6.2); a person for someone without a name. Decorative: the name is written beside.
 */
export function Avatar({ name, size = 36 }: { name: string | null; size?: number }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-display text-[0.8125rem] font-medium text-fg ring-1 ring-turq-300/15"
      style={{ width: size, height: size }}
    >
      {initials || <User className="size-4 text-subtle" />}
    </span>
  );
}
