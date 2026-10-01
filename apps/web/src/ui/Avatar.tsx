import { User } from 'lucide-react';

/** The initials of a name in a circle; a person for someone without a name. */
export function Avatar({ name }: { name: string | null }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
    >
      {initials || <User className="size-4" />}
    </span>
  );
}
