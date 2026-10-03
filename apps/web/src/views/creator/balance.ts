import type { RevenueDay } from '@stayput/core';

/**
 * The numbers of the Dashboard's balance (brief v4 §8, §13, fix prompt v4.1 block 2), one source
 * for all of them: the Worker's day-by-day history (`revenueHistory`, the community's calendar)
 * and the month's figure (`saved.thisMonth.direct`). Pure, so a test can hold them together.
 */

/** Amounts are added up in cents: never a $0.01 drift between two figures that must agree. */
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface BalanceDay {
  /** YYYY-MM-DD, in the community's calendar. */
  day: string;
  /** Saved from the period's first day up to the end of this one: it only ever grows. */
  inPeriod: number;
  /** Saved from the 1st of this day's month up to the end of this one: that month's balance then. */
  inMonth: number;
  /** What the members at risk paid a month that day; null: no score that day. */
  atRisk: number | null;
}

export interface BalanceWindow {
  days: BalanceDay[];
  /** What the members at risk paid the day before the period, where its line starts; null: unknown. */
  atRiskBefore: number | null;
  /** The current month's 1st among `days`, where the chart marks it; null: before the period. */
  monthStart: number | null;
}

/**
 * The last `days` days of the history, as the chart draws them. The money saved adds up from the
 * period's first day, so the line starts at $0.00 and never goes down, and ends today on what the
 * period saved; each day also carries its month's balance, which `monthTotal` (the hero's figure)
 * ends today: the hero and the chart are one number, never two.
 */
export function balanceWindow(
  history: readonly RevenueDay[],
  days: number,
  monthTotal?: number,
): BalanceWindow {
  let month = '';
  let total = 0;
  const all = history.map((entry) => {
    const key = entry.day.slice(0, 7);
    if (key !== month) {
      month = key;
      total = 0;
    }
    total += entry.saved;
    return { ...entry, inMonth: round2(total) };
  });
  const from = Math.max(0, all.length - days);
  let period = 0;
  const shown = all.slice(from).map((entry): BalanceDay => {
    period += entry.saved;
    return {
      day: entry.day,
      inPeriod: round2(period),
      inMonth: entry.inMonth,
      atRisk: entry.atRisk,
    };
  });
  const today = shown.at(-1);
  if (today && monthTotal !== undefined) today.inMonth = round2(monthTotal);
  const first = today ? shown.findIndex((d) => d.day === `${today.day.slice(0, 7)}-01`) : -1;
  return {
    days: shown,
    atRiskBefore: from > 0 ? all[from - 1]!.atRisk : null,
    monthStart: first >= 0 ? first : null,
  };
}

/** What was saved over the last `days` days: where the period's line ends today. */
export function savedOver(history: readonly RevenueDay[], days: number): number {
  return round2(history.slice(-days).reduce((total, entry) => total + entry.saved, 0));
}

export interface MonthCompare {
  /** The month so far (the hero's figure). */
  thisMonth: number;
  /** The same days of last month: from its 1st to today's day of the month. */
  lastMonth: number;
  delta: number;
  /** The days of last month compared, YYYY-MM-DD. */
  from: string;
  to: string;
}

/**
 * The month so far against the same days of last month (« +$84.00 vs last month »): the 1st to
 * today's date in both, so the beginning of a month is never compared with a whole month. Null
 * when the history does not reach back to last month's 1st.
 */
export function monthOverMonth(
  history: readonly RevenueDay[],
  monthTotal: number,
): MonthCompare | null {
  const today = history.at(-1);
  if (!today) return null;
  const [year, month, date] = today.day.split('-').map(Number) as [number, number, number];
  const before = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const key = `${before.year}-${String(before.month).padStart(2, '0')}`;
  if (!history.some((entry) => entry.day === `${key}-01`)) return null;
  // A month shorter than today's date stops at its last day (March 31 against February 28).
  const last = Math.min(date, new Date(Date.UTC(before.year, before.month, 0)).getUTCDate());
  const lastMonth = round2(
    history
      .filter((entry) => entry.day.startsWith(key) && Number(entry.day.slice(8)) <= last)
      .reduce((total, entry) => total + entry.saved, 0),
  );
  const thisMonth = round2(monthTotal);
  return {
    thisMonth,
    lastMonth,
    delta: round2(thisMonth - lastMonth),
    from: `${key}-01`,
    to: `${key}-${String(last).padStart(2, '0')}`,
  };
}
