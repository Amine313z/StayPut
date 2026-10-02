/**
 * A block still loading: its own shape, a light passing over it (styles.css `.skeleton`).
 * Never an empty box, never a page-wide spinner: the screen keeps its layout while it fills.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/** A card loading: a label, a figure, a line of context. */
export function MetricSkeleton({ hero = false }: { hero?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <Skeleton className="h-3 w-28" />
      <Skeleton className={`mt-4 ${hero ? 'h-12 w-40' : 'h-8 w-24'}`} />
      <Skeleton className="mt-3 h-3 w-36" />
    </div>
  );
}

/** A list loading: rows of an avatar and two lines. */
export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
