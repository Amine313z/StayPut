/**
 * The shape of StayPut's lines: monotone cubic curves (Fritsch–Carlson), smooth and never
 * overshooting their points, so a total that only grows is drawn growing, never dipping between
 * two days.
 */

export interface XY {
  x: number;
  y: number;
}

/** The slope of the curve at each point, softened where it would overshoot. */
function monotoneTangents(points: readonly XY[]): number[] {
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    slopes.push((b.y - a.y) / (b.x - a.x));
  }
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === n - 1) return slopes[n - 2]!;
    const before = slopes[i - 1]!;
    const after = slopes[i]!;
    return before * after <= 0 ? 0 : (before + after) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    const slope = slopes[i]!;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i]! / slope;
    const b = tangents[i + 1]! / slope;
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      tangents[i] = s * a * slope;
      tangents[i + 1] = s * b * slope;
    }
  }
  return tangents;
}

/** An SVG path through the points along the monotone curve. */
export function smoothPath(points: readonly XY[]): string {
  const n = points.length;
  const first = points[0];
  if (!first) return '';
  if (n === 1) return `M${first.x} ${first.y}`;
  const tangents = monotoneTangents(points);
  const r = (value: number) => Math.round(value * 10) / 10;
  let d = `M${r(first.x)} ${r(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const third = (b.x - a.x) / 3;
    d +=
      `C${r(a.x + third)} ${r(a.y + tangents[i]! * third)} ` +
      `${r(b.x - third)} ${r(b.y - tangents[i + 1]! * third)} ${r(b.x)} ${r(b.y)}`;
  }
  return d;
}

/**
 * An SVG path through the points in straight steps, for points read densely off a curve: it
 * keeps exactly what the points do (flat where they are equal, never beyond them).
 */
export function polylinePath(points: readonly XY[]): string {
  const r = (value: number) => Math.round(value * 10) / 10;
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r(p.x)} ${r(p.y)}`).join('');
}

/**
 * The curve through `values` (one a day) read at `count` evenly spaced places, first and last
 * included: every period becomes the same number of points, so a 7-day line can turn into a
 * 90-day one (its path keeps its shape of commands) instead of being drawn again.
 */
export function monotoneSample(values: readonly number[], count: number): number[] {
  const n = values.length;
  if (n === 0) return Array.from({ length: count }, () => 0);
  if (n === 1) return Array.from({ length: count }, () => values[0]!);
  const points = values.map((y, x) => ({ x, y }));
  const tangents = monotoneTangents(points);
  return Array.from({ length: count }, (_, k) => {
    const x = count > 1 ? (k * (n - 1)) / (count - 1) : 0;
    const i = Math.min(n - 2, Math.floor(x));
    const t = x - i;
    const a = values[i]!;
    const b = values[i + 1]!;
    // Hermite basis on a one-day step.
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * a +
      (t3 - 2 * t2 + t) * tangents[i]! +
      (-2 * t3 + 3 * t2) * b +
      (t3 - t2) * tangents[i + 1]!
    );
  });
}
