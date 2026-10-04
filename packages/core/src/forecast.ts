/**
 * The 90-day revenue forecast (SPEC Phase 6.5 and 6.6, brief v4 §9.5): what the paying members
 * are likely to bring over the next 90 days if nothing is done, and if StayPut acts on the members
 * at risk. Each month, a member stays with a probability set by their risk level: StayPut's
 * starting values (low 0.95, medium 0.80, high 0.50), then the community's own once it has 60
 * days of history. Acting saves a share of the members at risk it reaches (30 %, then the
 * community's own rate): a member saved stays, from then on, like a member at low risk. An
 * estimate, never a promise.
 */

import { RISK_LEVELS, type RiskLevel } from './risk';

/**
 * SPEC 6.5's starting values. A departure the member scheduled counts as a high risk: its score
 * is in the high range (100), and the community's own history corrects it from 60 days.
 */
export const DEFAULT_STAY: Readonly<Record<RiskLevel, number>> = {
  low: 0.95,
  medium: 0.8,
  high: 0.5,
  scheduled_departure: 0.5,
};

/** SPEC 6.5: the share of the members at risk reached that acting saves, before the community's. */
export const DEFAULT_SAVE_RATE = 0.3;

/** How far the forecast looks, in days. */
export const FORECAST_DAYS = 90;

/** The members acting is for: the dashboard's « at risk ». */
export const AT_RISK_LEVELS: readonly RiskLevel[] = ['high', 'scheduled_departure'];

/** Days of history before StayPut uses the community's own probabilities (SPEC 6.5). */
export const CALIBRATION_DAYS = 60;

/** Members a figure rests on before StayPut trusts it (as the cohorts' alerts, SPEC Phase 3). */
export const CALIBRATION_MIN = 10;

const MONTH = 30;

export interface ForecastInput {
  /** What the paying members bring in a month, by risk level. */
  revenue: Readonly<Record<RiskLevel, number>>;
  /** Each level's probability of staying a month. */
  stay: Readonly<Record<RiskLevel, number>>;
  /** The share of the members at risk reached that acting saves. */
  saveRate: number;
  /** The share of the members at risk StayPut reaches (the « and if » slider), 0 to 1. */
  reached: number;
}

export interface Forecast {
  /** The monthly revenue expected each day from today (0) to the last, if nothing is done. */
  doNothing: number[];
  /** The same, if StayPut acts. Never under `doNothing`. */
  act: number[];
  /** The revenue expected over the whole period. */
  total: { doNothing: number; act: number };
  /** What acting adds over the period. */
  gain: number;
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** What a month's revenue staying with probability `stay` brings over `days`, in months. */
function months(stay: number, days: number): number {
  const p = clamp(stay);
  const span = days / MONTH;
  if (p === 1) return span;
  if (p === 0) return 0;
  // ∫ p^(t/30) dt / 30 from 0 to `days`.
  return (Math.pow(p, span) - 1) / Math.log(p);
}

/** The forecast, day by day, from what each risk level brings in a month. */
export function forecastRevenue(input: ForecastInput, days = FORECAST_DAYS): Forecast {
  const saved = clamp(input.saveRate) * clamp(input.reached);
  const healthy = clamp(input.stay.low);
  const doNothing: number[] = [];
  const act: number[] = [];
  for (let day = 0; day <= days; day++) {
    let alone = 0;
    let acting = 0;
    for (const level of RISK_LEVELS) {
      const revenue = Math.max(0, input.revenue[level] ?? 0);
      const kept = revenue * Math.pow(clamp(input.stay[level]), day / MONTH);
      alone += kept;
      acting += AT_RISK_LEVELS.includes(level)
        ? saved * revenue * Math.pow(healthy, day / MONTH) + (1 - saved) * kept
        : kept;
    }
    doNothing.push(alone);
    act.push(Math.max(alone, acting));
  }
  let totalAlone = 0;
  let totalActing = 0;
  for (const level of RISK_LEVELS) {
    const revenue = Math.max(0, input.revenue[level] ?? 0);
    const alone = revenue * months(input.stay[level], days);
    totalAlone += alone;
    totalActing += AT_RISK_LEVELS.includes(level)
      ? saved * revenue * months(healthy, days) + (1 - saved) * alone
      : alone;
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  const total = { doNothing: round(totalAlone), act: round(Math.max(totalAlone, totalActing)) };
  return { doNothing, act, total, gain: round(total.act - total.doNothing) };
}

/** How many members were at a level when a month began, and how many were still there after. */
export interface StaySample {
  level: RiskLevel;
  sampled: number;
  stayed: number;
}

/**
 * Each level's probability of staying a month: the community's own where it has the history (60
 * days) and enough members at that level (10), StayPut's starting value elsewhere.
 */
export function calibrateStay(
  samples: readonly StaySample[],
  historyDays: number,
): { stay: Record<RiskLevel, number>; calibrated: RiskLevel[] } {
  const stay = { ...DEFAULT_STAY };
  const calibrated: RiskLevel[] = [];
  if (historyDays < CALIBRATION_DAYS) return { stay, calibrated };
  for (const level of RISK_LEVELS) {
    const sampled = samples
      .filter((s) => s.level === level)
      .reduce((total, s) => total + Math.max(0, s.sampled), 0);
    const stayed = samples
      .filter((s) => s.level === level)
      .reduce((total, s) => total + Math.max(0, s.stayed), 0);
    if (sampled < CALIBRATION_MIN) continue;
    stay[level] = Math.round((Math.min(stayed, sampled) / sampled) * 1000) / 1000;
    calibrated.push(level);
  }
  return { stay, calibrated };
}

/**
 * The share of the members at risk StayPut reached that it saved: the community's own once it
 * reached 10, 30 % before.
 */
export function observedSaveRate(
  reached: number,
  saved: number,
): { rate: number; observed: boolean } {
  if (reached < CALIBRATION_MIN) return { rate: DEFAULT_SAVE_RATE, observed: false };
  return {
    rate: Math.round((Math.min(Math.max(0, saved), reached) / reached) * 1000) / 1000,
    observed: true,
  };
}
