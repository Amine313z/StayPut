/**
 * The small red dot of what is urgent (brief v3 §5): a member leaving within 48 hours, a payment
 * not recovered, an automation error, a destructive action. Red at 70 %, never a number, a fill
 * or a border; the words beside it always say the same thing.
 */
export function UrgentDot({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full bg-urgent/70 ${className}`}
    />
  );
}
