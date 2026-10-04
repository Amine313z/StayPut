import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_RISK_SETTINGS,
  DEFAULT_WEIGHTS,
  NICHE_PRESETS,
  NICHES,
  REASON_MIN_POINTS,
  RISK_FACTORS,
  computeRisk,
  isInactiveNewcomer,
  isNiche,
  normalizeWeights,
  DEFAULT_PLATFORM_SIGNALS,
  SIGNAL_BITS,
  allPlatformSignals,
  firedSignals,
  parsePlatformSignals,
  platformSignals,
  scoreDistribution,
  scoreWithSignals,
  type PlatformInputs,
  type PlatformSignals,
  type RiskInputs,
  type RiskSettings,
} from '../src';

/**
 * The risk score of SPEC Phase 3, sub-score by sub-score, and the edge cases the SPEC requires:
 * a new member, a member without courses, modified weights, missing data, a scheduled departure.
 */

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => NOW - n * DAY_MS;
const hoursAgo = (n: number) => NOW - n * 3_600_000;

/** A steady member: joined 60 days ago, active yesterday, as busy this week as before. */
const steady = (over: Partial<RiskInputs> = {}): RiskInputs => ({
  joinedAt: daysAgo(60),
  lastActivityAt: daysAgo(0),
  activity7d: 10,
  activityPrev28d: 40,
  lastProgressAt: daysAgo(0),
  lastLessonTitle: 'Lesson 3',
  payment: 'ok',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  openTicketSince: null,
  reactions14d: 6,
  reactionsPrev14d: 6,
  activeSinceJoin: true,
  ...over,
});

const settings = (over: Partial<RiskSettings> = {}): RiskSettings => ({
  ...DEFAULT_RISK_SETTINGS,
  ...over,
});

describe('computeRisk', () => {
  it('gives a steady member a low score and no reason', () => {
    expect(computeRisk(steady(), settings(), NOW)).toEqual({
      score: 0,
      level: 'low',
      subScores: { recency: 0, frequency: 0, progress: 0, payment: 0, friction: 0 },
      reasons: [],
      inactiveNewcomer: false,
      making: { base: 0, discord: 0, telegram: 0, rule: 0 },
    });
  });

  it('weighs recency against the threshold: 7 of 14 days is half of R', () => {
    const result = computeRisk(steady({ lastActivityAt: daysAgo(7) }), settings(), NOW);
    expect(result.subScores.recency).toBe(0.5);
    expect(result.score).toBe(15);
    expect(result.reasons).toEqual([{ code: 'inactive', days: 7 }]);
    // Past the threshold, R stays at 1.
    expect(
      computeRisk(steady({ lastActivityAt: daysAgo(40) }), settings(), NOW).subScores.recency,
    ).toBe(1);
  });

  it('compares this week with the weekly average of the 4 weeks before', () => {
    const result = computeRisk(steady({ activity7d: 2, activityPrev28d: 40 }), settings(), NOW);
    expect(result.subScores.frequency).toBe(0.8);
    expect(result.reasons).toEqual([{ code: 'activity_drop', percent: 80 }]);
    // More active than before: no risk from frequency.
    expect(computeRisk(steady({ activity7d: 30 }), settings(), NOW).subScores.frequency).toBe(0);
  });

  it('counts the days since the last lesson, up to 21', () => {
    const result = computeRisk(
      steady({ lastProgressAt: daysAgo(21), lastLessonTitle: 'Module 2 — Risk' }),
      settings(),
      NOW,
    );
    expect(result.subScores.progress).toBe(1);
    expect(result.reasons).toEqual([{ code: 'no_progress', days: 21, lesson: 'Module 2 — Risk' }]);
  });

  it('reads the payment: failed 1, waiting for 3D Secure 0.7', () => {
    const failed = computeRisk(steady({ payment: 'failed' }), settings(), NOW);
    expect(failed.subScores.payment).toBe(1);
    expect(failed.reasons).toEqual([{ code: 'payment_failed' }]);
    const action = computeRisk(steady({ payment: 'action_required' }), settings(), NOW);
    expect(action.subScores.payment).toBe(0.7);
    expect(action.score).toBe(11);
    expect(action.level).toBe('low');
    expect(action.reasons).toEqual([{ code: 'payment_action_required' }]);
  });

  it('puts a failed or overdue payment at high risk at least, however active the member', () => {
    // A steady member: 15 points from the weights, raised to the high level.
    expect(computeRisk(steady({ payment: 'failed' }), settings(), NOW)).toMatchObject({
      score: 70,
      level: 'high',
      reasons: [{ code: 'payment_failed' }],
    });
    // Where the creator put the high level; a higher score stays as computed.
    expect(computeRisk(steady({ payment: 'failed' }), settings({ highFrom: 80 }), NOW).score).toBe(
      80,
    );
    const inactive = computeRisk(
      steady({
        payment: 'failed',
        lastActivityAt: daysAgo(20),
        activity7d: 0,
        lastProgressAt: daysAgo(21),
      }),
      settings(),
      NOW,
    );
    expect(inactive.score).toBe(90);
    // Said first, before what weighs most.
    expect(inactive.reasons).toEqual([{ code: 'payment_failed' }, { code: 'inactive', days: 20 }]);
    // Even when the creator gave payment no weight.
    expect(
      computeRisk(
        steady({ payment: 'failed' }),
        settings({ weights: { ...DEFAULT_WEIGHTS, payment: 0 } }),
        NOW,
      ),
    ).toMatchObject({ level: 'high', reasons: [{ code: 'payment_failed' }] });
  });

  it('never says the same thing twice, nor two things that contradict', () => {
    // Inactive for 10 days already says there was nothing this week: the next reason instead.
    const away = computeRisk(
      steady({ lastActivityAt: daysAgo(10), activity7d: 0, lastProgressAt: daysAgo(15) }),
      settings(),
      NOW,
    );
    expect(away.subScores.frequency).toBe(1);
    expect(away.reasons).toEqual([
      { code: 'inactive', days: 10 },
      { code: 'no_progress', days: 15, lesson: 'Lesson 3' },
    ]);
    // Came by 3 days ago (Whop's visit) but did nothing this week: not « no activity for 3 days ».
    const visitor = computeRisk(
      steady({ lastActivityAt: daysAgo(3), activity7d: 0, lastProgressAt: daysAgo(4) }),
      settings(),
      NOW,
    );
    expect(visitor.subScores.recency).toBe(0.214);
    expect(visitor.reasons).toEqual([
      { code: 'activity_drop', percent: 100 },
      { code: 'no_progress', days: 4, lesson: 'Lesson 3' },
    ]);
  });

  it('reads friction: a ticket open over 48 hours, or reactions halved over 14 days', () => {
    const ticket = computeRisk(steady({ openTicketSince: hoursAgo(73) }), settings(), NOW);
    expect(ticket.subScores.friction).toBe(1);
    expect(ticket.reasons).toEqual([{ code: 'ticket_open', days: 3 }]);
    expect(
      computeRisk(steady({ openTicketSince: hoursAgo(47) }), settings(), NOW).subScores.friction,
    ).toBe(0);
    const reactions = computeRisk(
      steady({ reactions14d: 2, reactionsPrev14d: 10 }),
      settings(),
      NOW,
    );
    expect(reactions.subScores.friction).toBe(0.5);
    expect(reactions.reasons).toEqual([{ code: 'reactions_drop', percent: 80 }]);
    // One reaction, then none: too few to say anything.
    expect(
      computeRisk(steady({ reactions14d: 0, reactionsPrev14d: 1 }), settings(), NOW).subScores
        .friction,
    ).toBe(0);
  });

  it('combines the five sub-scores with the weights, and keeps the two main reasons', () => {
    const result = computeRisk(
      steady({
        lastActivityAt: daysAgo(14),
        activity7d: 0,
        lastProgressAt: daysAgo(21),
        payment: 'failed',
        openTicketSince: daysAgo(5),
      }),
      settings(),
      NOW,
    );
    expect(result.score).toBe(100);
    expect(result.level).toBe('high');
    // The failed payment first; the activity drop goes without saying after 14 days away.
    expect(result.reasons.map((r) => r.code)).toEqual(['payment_failed', 'inactive']);
  });

  it('says nothing of a factor that barely counts, or of « 0 days »', () => {
    // Active 20 hours ago: R is 0.06, under 3 points, and under a day anyway.
    const recent = computeRisk(steady({ lastActivityAt: hoursAgo(20) }), settings(), NOW);
    expect(recent.subScores.recency).toBe(0.06);
    expect(recent.reasons).toEqual([]);
    // Activity down 8 % this week: 2 points, not a reason.
    expect(
      computeRisk(steady({ activity7d: 9.2 }), settings(), NOW).reasons.map((r) => r.code),
    ).toEqual([]);
    // A short recency threshold makes 20 hours weigh 4 points, still under a day.
    const trading = computeRisk(
      steady({ lastActivityAt: hoursAgo(20) }),
      settings({ recencyThresholdDays: 7, weights: NICHE_PRESETS.trading.weights }),
      NOW,
    );
    expect(trading.subScores.recency * 35).toBeGreaterThan(REASON_MIN_POINTS);
    expect(trading.reasons).toEqual([]);
  });

  it('places the levels at 40 and 70, or where the creator put them', () => {
    const level = (lastActivity: number, over: Partial<RiskSettings> = {}) =>
      computeRisk(
        steady({ lastActivityAt: daysAgo(lastActivity), activity7d: 0, lastProgressAt: null }),
        settings({ tracksProgress: false, ...over }),
        NOW,
      );
    // R and F only: 30 × R + 25.
    expect(level(7)).toMatchObject({ score: 40, level: 'medium' });
    expect(level(5)).toMatchObject({ score: 36, level: 'low' });
    expect(level(14)).toMatchObject({ score: 55, level: 'medium' });
    expect(level(14, { highFrom: 55 })).toMatchObject({ level: 'high' });
  });

  describe('edge cases (SPEC Phase 3, mandatory tests)', () => {
    it('a new member: measured from the join date, and on the activation radar', () => {
      const newcomer = steady({
        joinedAt: daysAgo(4),
        lastActivityAt: null,
        activity7d: 0,
        activityPrev28d: 0,
        lastProgressAt: null,
        lastLessonTitle: null,
        reactions14d: 0,
        reactionsPrev14d: 0,
        activeSinceJoin: false,
      });
      const result = computeRisk(newcomer, settings(), NOW);
      // No history: no frequency signal; recency and progress run from the join date.
      expect(result.subScores).toEqual({
        recency: 0.286,
        frequency: 0,
        progress: 0.19,
        payment: 0,
        friction: 0,
      });
      expect(result.reasons).toEqual([
        { code: 'never_active', days: 4 },
        { code: 'no_progress', days: 4, lesson: null },
      ]);
      expect(result.inactiveNewcomer).toBe(true);
      // Under 72 hours, still time; active once, off the radar.
      expect(isInactiveNewcomer({ ...newcomer, joinedAt: hoursAgo(71) }, NOW)).toBe(false);
      expect(isInactiveNewcomer({ ...newcomer, activeSinceJoin: true }, NOW)).toBe(false);
      expect(isInactiveNewcomer({ ...newcomer, joinedAt: daysAgo(8) }, NOW)).toBe(false);
    });

    it('a member of a creator without courses or goals: progress is 0', () => {
      const result = computeRisk(
        steady({ lastProgressAt: null, lastLessonTitle: null }),
        settings({ tracksProgress: false }),
        NOW,
      );
      expect(result.subScores.progress).toBe(0);
      expect(result.score).toBe(0);
    });

    it('modified weights: brought back to a sum of 1 before they count', () => {
      const result = computeRisk(
        steady({ payment: 'failed' }),
        settings({
          weights: { recency: 0, frequency: 0, progress: 0, payment: 2, friction: 0 },
        }),
        NOW,
      );
      expect(result.score).toBe(100);
      expect(result.level).toBe('high');
      // All weights at zero: the defaults (7 of 14 days is half of R, 15 points).
      expect(
        computeRisk(
          steady({ lastActivityAt: daysAgo(7) }),
          settings({ weights: { recency: 0, frequency: 0, progress: 0, payment: 0, friction: 0 } }),
          NOW,
        ).score,
      ).toBe(15);
    });

    it('missing data: nothing known gives no risk rather than a guess', () => {
      const unknown: RiskInputs = {
        joinedAt: null,
        lastActivityAt: null,
        activity7d: 0,
        activityPrev28d: 0,
        lastProgressAt: null,
        lastLessonTitle: null,
        payment: 'ok',
        cancelAtPeriodEnd: false,
        cancelAt: null,
        openTicketSince: null,
        reactions14d: 0,
        reactionsPrev14d: 0,
        activeSinceJoin: false,
      };
      expect(computeRisk(unknown, settings(), NOW)).toMatchObject({
        score: 0,
        level: 'low',
        reasons: [],
        inactiveNewcomer: false,
      });
    });

    it('a scheduled departure: score 100 and its own status, whatever the rest', () => {
      const result = computeRisk(
        steady({ cancelAtPeriodEnd: true, cancelAt: Date.parse('2026-10-15T00:00:00Z') }),
        settings(),
        NOW,
      );
      expect(result).toMatchObject({ score: 100, level: 'scheduled_departure' });
      expect(result.reasons).toEqual([
        { code: 'cancel_scheduled', date: '2026-10-15T00:00:00.000Z' },
      ]);
      // Even when the creator gave payment no weight, the departure stays the first reason.
      const unweighted = computeRisk(
        steady({ cancelAtPeriodEnd: true, lastActivityAt: daysAgo(20) }),
        settings({ weights: { ...DEFAULT_WEIGHTS, payment: 0 } }),
        NOW,
      );
      expect(unweighted.reasons).toEqual([
        { code: 'cancel_scheduled', date: null },
        { code: 'inactive', days: 20 },
      ]);
    });
  });
});

describe('normalizeWeights', () => {
  it('brings the weights to a sum of exactly 1, three decimals each', () => {
    const weights = normalizeWeights({
      recency: 1,
      frequency: 1,
      progress: 1,
      payment: 0,
      friction: 0,
    });
    expect(weights).toEqual({
      recency: 0.334,
      frequency: 0.333,
      progress: 0.333,
      payment: 0,
      friction: 0,
    });
    const sum = RISK_FACTORS.reduce((total, f) => total + weights[f], 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('ignores negative and missing values, and falls back on the defaults', () => {
    expect(
      normalizeWeights({
        recency: -1,
        frequency: Number.NaN,
        progress: 0,
        payment: 0,
        friction: 1,
      }),
    ).toEqual({ recency: 0, frequency: 0, progress: 0, payment: 0, friction: 1 });
    expect(
      normalizeWeights({ recency: 0, frequency: 0, progress: 0, payment: 0, friction: 0 }),
    ).toEqual(DEFAULT_WEIGHTS);
  });
});

describe('niche presets', () => {
  it('has the weights of the SPEC for each niche, summing to 1', () => {
    expect(NICHES).toHaveLength(7);
    for (const niche of NICHES) {
      const { weights, recencyThresholdDays } = NICHE_PRESETS[niche];
      const sum = RISK_FACTORS.reduce((total, f) => total + weights[f], 0);
      expect(Math.abs(sum - 1), niche).toBeLessThan(1e-9);
      expect(recencyThresholdDays).toBeGreaterThan(0);
    }
    expect(NICHE_PRESETS.trading).toEqual({
      weights: { recency: 0.35, frequency: 0.3, progress: 0.1, payment: 0.15, friction: 0.1 },
      recencyThresholdDays: 7,
    });
    expect(NICHE_PRESETS.other.weights).toEqual(DEFAULT_WEIGHTS);
    expect(isNiche('fitness')).toBe(true);
    expect(isNiche('poker')).toBe(false);
  });
});

describe("the platforms' signals (brief v4 §9.6)", () => {
  /** A member's Discord: as busy this week as the 4 weeks before. */
  const there = (over: Partial<PlatformInputs> = {}): PlatformInputs => ({
    week: 5,
    before: 20,
    lastAt: daysAgo(1),
    leftAt: null,
    ...over,
  });
  /** Discord's signals with these on, the others at their default points, off. */
  const on = (...ids: (keyof PlatformSignals)[]) => ({
    discord: Object.fromEntries(
      Object.entries(DEFAULT_PLATFORM_SIGNALS).map(([id, s]) => [
        id,
        { ...s, on: ids.includes(id as keyof PlatformSignals) },
      ]),
    ),
  });

  it('tells which signal holds: gone quiet, writes less, left', () => {
    expect(firedSignals(there(), NOW)).toEqual([]);
    expect(firedSignals(there({ week: 0, lastAt: daysAgo(9) }), NOW)).toEqual(['silent']);
    // Nothing before either: nothing to go quiet from.
    expect(firedSignals(there({ week: 0, before: 0, lastAt: null }), NOW)).toEqual([]);
    // Under half the weekly average of 5…
    expect(firedSignals(there({ week: 2 }), NOW)).toEqual(['drop']);
    expect(firedSignals(there({ week: 3 }), NOW)).toEqual([]);
    // …from 2 a week at least: 1 → 0.25 says nothing.
    expect(firedSignals(there({ week: 0.5, before: 4 }), NOW)).toEqual([]);
    // Left within 30 days, and only that: leaving says more than going quiet.
    expect(firedSignals(there({ week: 0, leftAt: daysAgo(3) }), NOW)).toEqual(['left']);
    expect(firedSignals(there({ week: 0, leftAt: daysAgo(31), lastAt: daysAgo(31) }), NOW)).toEqual(
      ['silent'],
    );
  });

  it("adds nothing while off: the score is the five factors'", () => {
    const quiet = steady({ platforms: { discord: there({ week: 0, lastAt: daysAgo(9) }) } });
    const result = computeRisk(quiet, settings(), NOW);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.making).toEqual({ base: 0, discord: SIGNAL_BITS.silent, telegram: 0, rule: 0 });
  });

  it('adds the points of a signal on, and names it among the reasons', () => {
    const quiet = steady({ platforms: { discord: there({ week: 0, lastAt: daysAgo(9) }) } });
    const result = computeRisk(quiet, settings({ platformSignals: on('silent') }), NOW);
    expect(result.score).toBe(10);
    expect(result.reasons).toEqual([{ code: 'platform_silent', platform: 'discord', days: 9 }]);
    // The points as the creator set them, both platforms counted.
    const both = steady({
      platforms: {
        discord: there({ leftAt: daysAgo(2) }),
        telegram: there({ week: 1, before: 16 }),
      },
    });
    const custom = {
      discord: { ...DEFAULT_PLATFORM_SIGNALS, left: { on: true, points: 25 } },
      telegram: { ...DEFAULT_PLATFORM_SIGNALS, drop: { on: true, points: 15 } },
    };
    const scored = computeRisk(both, settings({ platformSignals: custom }), NOW);
    expect(scored.score).toBe(40);
    expect(scored.level).toBe('medium');
    expect(scored.reasons).toEqual([
      { code: 'platform_left', platform: 'discord' },
      { code: 'platform_drop', platform: 'telegram', percent: 75 },
    ]);
  });

  it('keeps the two rules over the signals, and 100 at most', () => {
    const left = { discord: there({ leftAt: daysAgo(2) }) };
    const many = { discord: { ...DEFAULT_PLATFORM_SIGNALS, left: { on: true, points: 30 } } };
    const late = computeRisk(
      steady({ lastActivityAt: daysAgo(60), activity7d: 0, platforms: left }),
      settings({ platformSignals: many }),
      NOW,
    );
    expect(late.making.base).toBe(55);
    expect(late.score).toBe(85);
    const leaving = computeRisk(
      steady({ cancelAtPeriodEnd: true, platforms: left }),
      settings({ platformSignals: many }),
      NOW,
    );
    expect(leaving.score).toBe(100);
    expect(leaving.making.rule).toBe(1);
    const unpaid = computeRisk(
      steady({ payment: 'failed', platforms: left }),
      settings({ platformSignals: many }),
      NOW,
    );
    expect(unpaid.score).toBe(DEFAULT_RISK_SETTINGS.highFrom);
    expect(unpaid.making.rule).toBe(2);
  });

  it('never says « quiet on Discord » beside « no activity »', () => {
    const away = steady({
      lastActivityAt: daysAgo(12),
      activity7d: 0,
      platforms: { discord: there({ week: 0, lastAt: daysAgo(12) }) },
    });
    const result = computeRisk(away, settings({ platformSignals: on('silent') }), NOW);
    expect(result.reasons.map((r) => r.code)).not.toContain('platform_silent');
    expect(result.reasons[0]).toEqual({ code: 'inactive', days: 12 });
  });

  it('reads the settings strictly from the API, loosely from the database', () => {
    expect(parsePlatformSignals(DEFAULT_PLATFORM_SIGNALS)).toEqual(DEFAULT_PLATFORM_SIGNALS);
    expect(parsePlatformSignals({ ...DEFAULT_PLATFORM_SIGNALS, left: { on: true } })).toBeNull();
    expect(
      parsePlatformSignals({ ...DEFAULT_PLATFORM_SIGNALS, drop: { on: true, points: 31 } }),
    ).toBeNull();
    expect(
      parsePlatformSignals({ ...DEFAULT_PLATFORM_SIGNALS, drop: { on: true, points: 2.5 } }),
    ).toBeNull();
    expect(parsePlatformSignals(null)).toBeNull();
    // Saved in part, or not at all: the defaults complete it.
    expect(platformSignals({ silent: { on: true, points: 15 } })).toEqual({
      ...DEFAULT_PLATFORM_SIGNALS,
      silent: { on: true, points: 15 },
    });
    expect(allPlatformSignals(undefined)).toEqual({
      discord: DEFAULT_PLATFORM_SIGNALS,
      telegram: DEFAULT_PLATFORM_SIGNALS,
    });
  });

  it('previews the scores other settings would give, as computeRisk would', () => {
    const settingsOn = allPlatformSignals({ discord: { silent: { on: true, points: 10 } } });
    const making = { base: 35, discord: SIGNAL_BITS.silent, telegram: 0, rule: 0 } as const;
    expect(scoreWithSignals(making, settingsOn, 70)).toBe(45);
    expect(scoreWithSignals({ ...making, rule: 1 }, settingsOn, 70)).toBe(100);
    expect(scoreWithSignals({ ...making, rule: 2 }, settingsOn, 70)).toBe(70);
    const groups = [
      { base: 35, discord: SIGNAL_BITS.silent, telegram: 0, rule: 0, count: 3 },
      { base: 65, discord: SIGNAL_BITS.silent, telegram: 0, rule: 0, count: 2 },
      { base: 5, discord: 0, telegram: 0, rule: 0, count: 4 },
      { base: 50, discord: 0, telegram: 0, rule: 1, count: 1 },
    ];
    const off = scoreDistribution(groups, allPlatformSignals({}), { mediumFrom: 40, highFrom: 70 });
    expect(off.levels).toEqual({ low: 7, medium: 2, high: 0, scheduled_departure: 1 });
    const withSignal = scoreDistribution(groups, settingsOn, { mediumFrom: 40, highFrom: 70 });
    expect(withSignal.levels).toEqual({ low: 4, medium: 3, high: 2, scheduled_departure: 1 });
    expect(withSignal.bins).toEqual([4, 0, 0, 0, 3, 0, 0, 2, 0, 1]);
    expect(withSignal.bins.reduce((a, b) => a + b, 0)).toBe(10);
  });
});
