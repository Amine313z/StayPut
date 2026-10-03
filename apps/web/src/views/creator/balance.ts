import type { RevenueDay } from '@stayput/core';

/**
 * The numbers of the Dashboard's balance (brief v4 §8, §13), one source for all of them: the
 * Worker's day-by-day history (`revenueHistory`, the community's calendar) and the month's figure
 * (`saved.thisMonth.direct`). Pure, so a test can hold them together.
 */

/** Amounts are added up in cents: never a $0.01 drift between two figures that must agree. */
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface BalanceDay {
  /** YYYY-MM-DD, in the community's calendar. */
  day: string;
  /** Saved from the first of that day's month up to that day: the month's balance then. */
  saved: number;
  /** What the members at risk paid a month that day; null: no score that day. */
  atRisk: number | null;
}

/**
 * The money saved as Whop shows a balance: added up from the first of each month, so the line
 * starts again on the 1st and ends today on the month's figure. `monthTotal` (the hero's figure)
 * is where today ends: the hero and the chart are one number, never two.
 */
export function balanceWindow(
  history: readonly RevenueDay[],
  days: number,
  monthTotal?: number,
): BalanceDay[] {
  let month = '';
  let total = 0;
  const all = history.map((entry) => {
    const key = entry.day.slice(0, 7);
    if (key !== month) {
      month = key;
      total = 0;
    }
    total += entry.saved;
    return { day: entry.day, saved: round2(total), atRisk: entry.atRisk };
  });
  const window = all.slice(-days);
  const today = window.at(-1);
  if (today && monthTotal !== undefined) today.saved = round2(monthTotal);
  return window;
}

/** What was saved over the last `days` days (the 30-day total of « members saved »). */
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
