import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/ui/charts/BalanceChart';
import { monotoneSample, polylinePath, smoothPath } from '../src/ui/charts/curve';

describe('the chart’s curve', () => {
  it('draws a line that never overshoots its points (a total that grows never dips)', () => {
    const d = smoothPath([
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 40 },
      { x: 30, y: 40 },
    ]);
    expect(d.startsWith('M0 100C')).toBe(true);
    const ys = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(40);
      expect(y).toBeLessThanOrEqual(100);
    }
    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 5, y: 5 }])).toBe('M5 5');
  });

  it('reads every period at the same number of places, through each day, never beyond it', () => {
    // A month's balance: it grows, starts again on the 1st, grows again.
    const days = [149, 445, 445, 49, 247];
    const samples = monotoneSample(days, 9);
    expect(samples).toHaveLength(9);
    // Every other place is a day: the curve goes through each one.
    expect(samples.filter((_, k) => k % 2 === 0)).toEqual(days);
    // Between two days it stays between them: no bump above $445, no dip under $49.
    for (let k = 1; k < 8; k += 2) {
      const a = days[(k - 1) / 2]!;
      const b = days[(k + 1) / 2]!;
      expect(samples[k]).toBeGreaterThanOrEqual(Math.min(a, b));
      expect(samples[k]).toBeLessThanOrEqual(Math.max(a, b));
    }
    // 7 days or 90: the same count of places, so one line can turn into the other.
    expect(
      monotoneSample(
        Array.from({ length: 90 }, (_, i) => i),
        90,
      ),
    ).toHaveLength(90);
    expect(monotoneSample([49, 49, 49], 5)).toEqual([49, 49, 49, 49, 49]);
    expect(monotoneSample([7], 3)).toEqual([7, 7, 7]);
    expect(monotoneSample([], 3)).toEqual([0, 0, 0]);
  });

  it('draws a period’s money as it adds up: from the baseline, never down, flat between equal days', () => {
    // As BalanceChart draws it: the period's start at $0.00, then each day's total, across the
    // 1st of a month (no going back to zero there), read densely off the monotone curve.
    const H = 220;
    for (const days of [7, 30, 90]) {
      // Each period's days are whole steps of the drawing: every day's end is one of its points.
      expect((SAMPLES - 1) % days).toBe(0);
      const totals = [0, 0, 0];
      for (let day = 3; day <= days; day++) totals.push(totals.at(-1)! + (day % 3 === 0 ? 49 : 0));
      const top = Math.max(...totals);
      const d = polylinePath(
        monotoneSample(totals, SAMPLES).map((value, k) => ({
          x: (k / (SAMPLES - 1)) * 1000,
          y: H - (value / top) * H,
        })),
      );
      const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      const points = Array.from({ length: numbers.length / 2 }, (_, i) => ({
        x: numbers[2 * i]!,
        y: numbers[2 * i + 1]!,
      }));
      expect(points).toHaveLength(SAMPLES);
      for (const [i, point] of points.entries()) {
        // Never under the baseline, never going down (SVG's y grows downward).
        expect(point.y).toBeLessThanOrEqual(H);
        if (i > 0)
          expect(point.y, `${days} days, point ${i}`).toBeLessThanOrEqual(points[i - 1]!.y);
      }
      // The first days saved nothing: the line lies on the baseline until the end of the 2nd,
      // and climbs only within the 3rd, the day of the save.
      const dayEnd = (day: number) => (day / days) * 1000;
      for (const point of points.filter((p) => p.x <= dayEnd(2))) expect(point.y).toBe(H);
      const third = points.filter((p) => p.x > dayEnd(2) && p.x < dayEnd(3));
      expect(third.some((p) => p.y < H)).toBe(true);
      // Between two equal days, flat: the 4th and 5th saved nothing more than the 3rd.
      const level = H - (totals[3]! / top) * H;
      for (const point of points.filter((p) => p.x >= dayEnd(3) && p.x <= dayEnd(5))) {
        expect(point.y).toBeCloseTo(level, 1);
      }
    }
  });
});
