import type { RevenueDay } from '@stayput/core';
import { describe, expect, it } from 'vitest';
import { balanceWindow, monthOverMonth, savedOver } from '../src/views/creator/balance';

/** Days of a history, each saved amount on its date; at risk unknown unless given. */
function history(from: string, to: string, saved: Record<string, number> = {}): RevenueDay[] {
  const days: RevenueDay[] = [];
  for (let at = Date.parse(`${from}T12:00:00Z`); ; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    days.push({ day, saved: saved[day] ?? 0, atRisk: null });
    if (day === to) return days;
  }
}

describe('the balance (brief v4 §8, §13)', () => {
  it('adds the money saved up from the 1st of each month, and ends today on the hero', () => {
    const days = history('2026-09-28', '2026-10-03', {
      '2026-09-28': 10,
      '2026-09-30': 49,
      '2026-10-01': 49,
      '2026-10-02': 149,
      '2026-10-03': 49,
    });
    days[1]!.atRisk = 300;
    expect(balanceWindow(days, 4)).toEqual([
      { day: '2026-09-30', saved: 59, atRisk: null },
      { day: '2026-10-01', saved: 49, atRisk: null },
      { day: '2026-10-02', saved: 198, atRisk: null },
      { day: '2026-10-03', saved: 247, atRisk: null },
    ]);
    // Wider than the history: every day it has, the days without a score kept as such.
    expect(balanceWindow(days, 90).map((d) => d.saved)).toEqual([10, 10, 59, 49, 198, 247]);
    expect(balanceWindow(days, 90)[1]!.atRisk).toBe(300);
    // Today is the month's figure itself, the one the hero shows: one number, never two.
    expect(balanceWindow(days, 4, 296).at(-1)!.saved).toBe(296);
    // Added up in cents: no $0.30000000000000004.
    const cents = history('2026-10-01', '2026-10-02', { '2026-10-01': 0.1, '2026-10-02': 0.2 });
    expect(balanceWindow(cents, 2).at(-1)!.saved).toBe(0.3);
    expect(balanceWindow([], 30)).toEqual([]);
  });

  it('adds up the money saved over the days shown', () => {
    const days = history('2026-09-01', '2026-10-03', {
      '2026-09-03': 149,
      '2026-09-04': 49,
      '2026-10-03': 49.5,
    });
    // The last 30 days: 4 September to 3 October.
    expect(savedOver(days, 30)).toBe(98.5);
    expect(savedOver(days, 7)).toBe(49.5);
    expect(savedOver(days, 365)).toBe(247.5);
  });

  it('compares the month so far with the same days of last month', () => {
    const days = history('2026-08-25', '2026-10-03', {
      '2026-09-01': 49,
      '2026-09-03': 100,
      // After the 3rd: not the same days.
      '2026-09-04': 149,
      '2026-10-01': 49,
      '2026-10-02': 149,
      '2026-10-03': 49,
    });
    expect(monthOverMonth(days, 247)).toEqual({
      thisMonth: 247,
      lastMonth: 149,
      delta: 98,
      from: '2026-09-01',
      to: '2026-09-03',
    });
    // Behind last month: a negative difference, never hidden.
    expect(monthOverMonth(days, 49)?.delta).toBe(-100);
  });

  it('stops at the end of a shorter month, and goes back across a new year', () => {
    const march = history('2026-02-01', '2026-03-31', { '2026-02-28': 49, '2026-03-31': 149 });
    expect(monthOverMonth(march, 149)).toMatchObject({
      lastMonth: 49,
      from: '2026-02-01',
      to: '2026-02-28',
    });
    const january = history('2025-12-01', '2026-01-15', { '2025-12-15': 49, '2025-12-16': 99 });
    expect(monthOverMonth(january, 0)).toMatchObject({
      lastMonth: 49,
      delta: -49,
      from: '2025-12-01',
      to: '2025-12-15',
    });
  });

  it('compares nothing when the history does not reach last month’s 1st', () => {
    expect(monthOverMonth(history('2026-09-02', '2026-10-03'), 247)).toBeNull();
    expect(monthOverMonth([], 247)).toBeNull();
  });
});
