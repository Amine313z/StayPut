import { describe, expect, it } from 'vitest';
import { niceTicks, smoothPath } from '../src/ui/charts/AreaChart';
import { chartWindow } from '../src/views/creator/Overview';

describe('the area chart', () => {
  it('steps its value axis in round amounts, from 0 to above the largest', () => {
    expect(niceTicks(1_000)).toEqual([0, 250, 500, 750, 1_000]);
    expect(niceTicks(1_240)).toEqual([0, 500, 1_000, 1_500]);
    expect(niceTicks(163)).toEqual([0, 50, 100, 150, 200]);
    // Nothing to show yet: still an axis.
    expect(niceTicks(0)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

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

  it('adds up the money saved over the period shown, and keeps the days without a score', () => {
    const history = [
      { day: '2026-09-28', saved: 10, atRisk: null },
      { day: '2026-09-29', saved: 0, atRisk: 300 },
      { day: '2026-09-30', saved: 49, atRisk: 250 },
      { day: '2026-10-01', saved: 20, atRisk: 200 },
    ];
    expect(chartWindow(history, 3)).toEqual({
      window: history.slice(1),
      saved: [0, 49, 69],
      atRisk: [300, 250, 200],
    });
    expect(chartWindow(history, 90).saved).toEqual([10, 10, 59, 79]);
    expect(chartWindow(history, 90).atRisk[0]).toBeNull();
  });
});
