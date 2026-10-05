/**
 * The Alumni's figures (SPEC Phase 6.13 and 5.9): how many former members came back, out of all
 * those who ever entered it.
 */

/** Who entered the Alumni and where they are now: still in it, gone from it, or paying again. */
export interface AlumniCounts {
  entered: number;
  left: number;
  returned: number;
}

/**
 * The share of the former members who ever entered the Alumni who pay again, from 0 to 1; null
 * while nobody entered it.
 */
export function alumniReturnRate({ entered, left, returned }: AlumniCounts): number | null {
  const total = entered + left + returned;
  return total > 0 ? returned / total : null;
}
