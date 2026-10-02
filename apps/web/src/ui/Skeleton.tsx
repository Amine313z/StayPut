/**
 * A block still loading: its own shape, a light passing over it (styles.css `.skeleton`).
 * Never an empty box, never a page-wide spinner: the screen keeps its layout while it fills.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/** A figure loading: its label, then its value (56 px for the hero, 32 px beside it). */
export function MetricSkeleton({ hero = false }: { hero?: boolean }) {
  return (
    <div>
      <Skeleton className="h-3 w-28" />
      <Skeleton className={`mt-4 ${hero ? 'h-14 w-48' : 'h-8 w-24'}`} />
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
