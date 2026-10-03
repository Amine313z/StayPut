import { describe, expect, it } from 'vitest';
import { monotoneSample, smoothPath } from '../src/ui/charts/curve';

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
});
