import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MIN,
  DEFAULT_SAVE_RATE,
  DEFAULT_STAY,
  calibrateStay,
  forecastRevenue,
  observedSaveRate,
} from '../src';

const none = { low: 0, medium: 0, high: 0, scheduled_departure: 0 };

describe('the 90-day revenue forecast (SPEC 6.5, brief v4 §9.5)', () => {
  it('keeps each level a month with its probability, day by day', () => {
    const forecast = forecastRevenue({
      revenue: { ...none, low: 1000, high: 100 },
      stay: DEFAULT_STAY,
      saveRate: DEFAULT_SAVE_RATE,
      reached: 0,
    });
    expect(forecast.doNothing).toHaveLength(91);
    expect(forecast.doNothing[0]).toBeCloseTo(1100);
    expect(forecast.doNothing[30]).toBeCloseTo(950 + 50);
    expect(forecast.doNothing[90]).toBeCloseTo(1000 * 0.95 ** 3 + 100 * 0.5 ** 3);
    // Nobody reached: acting changes nothing.
    expect(forecast.act).toEqual(forecast.doNothing);
    expect(forecast.gain).toBe(0);
  });

  it('saves a share of the members at risk reached, who then stay like the others', () => {
    const forecast = forecastRevenue({
      revenue: { ...none, high: 100, scheduled_departure: 50 },
      stay: DEFAULT_STAY,
      saveRate: 0.3,
      reached: 1,
    });
    // A month on: 30 % stay at 0.95 a month, the others at 0.50.
    expect(forecast.act[30]).toBeCloseTo(150 * (0.3 * 0.95 + 0.7 * 0.5));
    expect(forecast.doNothing[30]).toBeCloseTo(75);
    for (let day = 0; day <= 90; day++) {
      expect(forecast.act[day]).toBeGreaterThanOrEqual(forecast.doNothing[day]!);
    }
    expect(forecast.gain).toBeGreaterThan(0);
    expect(forecast.gain).toBeCloseTo(forecast.total.act - forecast.total.doNothing, 2);
  });

  it('acts in proportion to the members reached, the « and if » slider', () => {
    const at = (reached: number) =>
      forecastRevenue({
        revenue: { ...none, low: 500, high: 200 },
        stay: DEFAULT_STAY,
        saveRate: 0.3,
        reached,
      }).gain;
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBeGreaterThan(0);
    expect(at(1)).toBeCloseTo(2 * at(0.5), 1);
    // Out of bounds: kept within 0 and 1.
    expect(at(2)).toBe(at(1));
    expect(at(-1)).toBe(0);
  });

  it('adds up the period: three months for a member who always stays, nothing for one who goes', () => {
    const always = forecastRevenue({
      revenue: { ...none, low: 100 },
      stay: { ...DEFAULT_STAY, low: 1 },
      saveRate: 0.3,
      reached: 1,
    });
    expect(always.total.doNothing).toBe(300);
    const gone = forecastRevenue({
      revenue: { ...none, high: 100 },
      stay: { ...DEFAULT_STAY, high: 0 },
      saveRate: 0,
      reached: 1,
    });
    expect(gone.total.doNothing).toBe(0);
    expect(gone.doNothing[0]).toBe(100);
    expect(gone.doNothing[1]).toBe(0);
    // Between the two: the integral of the curve, about the average of its month marks.
    const half = forecastRevenue({
      revenue: { ...none, high: 100 },
      stay: DEFAULT_STAY,
      saveRate: 0,
      reached: 0,
    });
    expect(half.total.doNothing).toBeGreaterThan(100 * (0.5 + 0.25 + 0.125));
    expect(half.total.doNothing).toBeLessThan(100 * (1 + 0.5 + 0.25));
  });
});

describe('the community’s own figures (SPEC 6.5: from 60 days of history)', () => {
  it('keeps StayPut’s probabilities before 60 days, or under 10 members at a level', () => {
    const samples = [
      { level: 'high' as const, sampled: 40, stayed: 12 },
      { level: 'low' as const, sampled: 9, stayed: 9 },
    ];
    expect(calibrateStay(samples, 59)).toEqual({ stay: DEFAULT_STAY, calibrated: [] });
    const { stay, calibrated } = calibrateStay(samples, 60);
    expect(calibrated).toEqual(['high']);
    expect(stay.high).toBe(0.3);
    expect(stay.low).toBe(DEFAULT_STAY.low);
  });

  it('adds the two months of history up, level by level', () => {
    const { stay, calibrated } = calibrateStay(
      [
        { level: 'medium', sampled: 6, stayed: 5 },
        { level: 'medium', sampled: 6, stayed: 4 },
      ],
      90,
    );
    expect(calibrated).toEqual(['medium']);
    expect(stay.medium).toBe(0.75);
  });

  it('measures the save rate once StayPut reached enough members at risk', () => {
    expect(observedSaveRate(CALIBRATION_MIN - 1, 9)).toEqual({
      rate: DEFAULT_SAVE_RATE,
      observed: false,
    });
    expect(observedSaveRate(20, 5)).toEqual({ rate: 0.25, observed: true });
    // Never more saved than reached.
    expect(observedSaveRate(10, 15)).toEqual({ rate: 1, observed: true });
  });
});
