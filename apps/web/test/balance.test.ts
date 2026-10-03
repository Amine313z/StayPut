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

describe('the balance (brief v4 §8, §13, fix prompt v4.1 block 2)', () => {
  const days = history('2026-08-28', '2026-10-03', {
    '2026-09-01': 99,
    '2026-09-28': 10,
    '2026-09-30': 49,
    '2026-10-01': 49,
    '2026-10-02': 149,
    '2026-10-03': 49,
  });
  // 29 September, the day before the 4-day period below, was scored.
  days[32]!.atRisk = 300;

  it('adds the period up from $0.00, each day on its own day, and ends on what it saved', () => {
    const { days: shown, atRiskBefore, monthStart } = balanceWindow(days, 4);
    expect(shown).toEqual([
      { day: '2026-09-30', inPeriod: 49, inMonth: 158, atRisk: null },
      { day: '2026-10-01', inPeriod: 98, inMonth: 49, atRisk: null },
      { day: '2026-10-02', inPeriod: 247, inMonth: 198, atRisk: null },
      { day: '2026-10-03', inPeriod: 296, inMonth: 247, atRisk: null },
    ]);
    // The month starts on its 1st, marked there; the day before the period was scored at 300.
    expect(monthStart).toBe(1);
    expect(atRiskBefore).toBe(300);
    // Today, the month's figure is the hero's itself: one number, never two.
    expect(balanceWindow(days, 4, 250).days.at(-1)).toMatchObject({ inPeriod: 296, inMonth: 250 });
    // A period inside the month: no mark (the month started before it).
    expect(balanceWindow(days, 2).monthStart).toBeNull();
    // Wider than the history: every day it has, from its first, nothing before it.
    const all = balanceWindow(days, 90);
    expect(all.days).toHaveLength(days.length);
    expect(all.atRiskBefore).toBeNull();
    expect(all.days[0]).toMatchObject({ day: '2026-08-28', inPeriod: 0, inMonth: 0 });
    // Added up in cents: no $0.30000000000000004.
    const cents = history('2026-10-01', '2026-10-02', { '2026-10-01': 0.1, '2026-10-02': 0.2 });
    expect(balanceWindow(cents, 2).days.at(-1)).toMatchObject({ inPeriod: 0.3, inMonth: 0.3 });
    expect(balanceWindow([], 30)).toEqual({ days: [], atRiskBefore: null, monthStart: null });
  });

  it('never goes down, and ends on the sum of the period’s saves, for 7, 30 and 90 days', () => {
    // A save every few days over five months, cents included.
    const random = (() => {
      let seed = 7;
      return () => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
    })();
    const saves: Record<string, number> = {};
    for (const { day } of history('2026-05-01', '2026-10-03')) {
      if (random() < 0.3) saves[day] = Math.round(random() * 20_000) / 100;
    }
    const long = history('2026-05-01', '2026-10-03', saves);
    for (const period of [7, 30, 90]) {
      const { days: shown } = balanceWindow(long, period, 123.45);
      expect(shown).toHaveLength(period);
      for (const [i, day] of shown.entries()) {
        if (i > 0) expect(day.inPeriod, day.day).toBeGreaterThanOrEqual(shown[i - 1]!.inPeriod);
      }
      expect(shown[0]!.inPeriod).toBe(saves[shown[0]!.day] ?? 0);
      expect(shown.at(-1)!.inPeriod).toBe(savedOver(long, period));
      const range = new Set(shown.map((d) => d.day));
      const sum = Object.entries(saves)
        .filter(([day]) => range.has(day))
        .reduce((total, [, amount]) => total + amount, 0);
      expect(shown.at(-1)!.inPeriod).toBe(Math.round(sum * 100) / 100);
    }
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
