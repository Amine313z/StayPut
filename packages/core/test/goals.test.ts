import { describe, expect, it } from 'vitest';
import {
  BADGE_CODES,
  GOAL_CATEGORIES,
  MAX_GOAL_PROPOSALS,
  NICHE_GOALS,
  goalProgress,
  goalValue,
  isBadgeCode,
  milestonesAt,
  isCalendarDate,
  nicheGoalProposals,
  parseGoalInput,
  parseGoalProposals,
  parseResultEntry,
} from '../src/goals';
import { NICHES } from '../src/risk';

const NOW = new Date('2026-10-01T09:00:00Z');

describe('the goals a niche proposes (SPEC Phase 5)', () => {
  it('proposes three goals to every niche, in both languages', () => {
    for (const niche of NICHES) {
      expect(NICHE_GOALS[niche]).toHaveLength(3);
      for (const locale of ['en', 'fr'] as const) {
        const proposals = nicheGoalProposals(niche, locale);
        expect(parseGoalProposals(proposals)).toEqual(proposals);
        for (const proposal of proposals) {
          expect(GOAL_CATEGORIES).toContain(proposal.category);
        }
      }
    }
    expect(nicheGoalProposals('fitness', 'fr')[0]).toEqual({
      title: 'Atteindre mon poids cible',
      unit: 'kg',
      category: 'body',
      entry: 'total',
    });
    expect(nicheGoalProposals('coaching', 'en')[0]).toEqual({
      title: 'Sign new clients',
      unit: 'clients',
      category: 'clients',
      entry: 'add',
    });
  });
});

describe('what a creator proposes', () => {
  it('keeps up to six goals, cleaned, and refuses a list with one wrong', () => {
    expect(
      parseGoalProposals([
        { title: '  Signer   mes 5 premiers clients ', unit: 'clients', entry: 'add' },
        { title: 'Perdre du poids', unit: 'kg', category: 'body', entry: 'total' },
      ]),
    ).toEqual([
      { title: 'Signer mes 5 premiers clients', unit: 'clients', category: 'other', entry: 'add' },
      { title: 'Perdre du poids', unit: 'kg', category: 'body', entry: 'total' },
    ]);
    expect(parseGoalProposals([])).toEqual([]);
    const one = { title: 'A', unit: 'u', category: 'other', entry: 'add' };
    expect(parseGoalProposals(Array.from({ length: MAX_GOAL_PROPOSALS }, () => one))).toHaveLength(
      MAX_GOAL_PROPOSALS,
    );
    expect(
      parseGoalProposals(Array.from({ length: MAX_GOAL_PROPOSALS + 1 }, () => one)),
    ).toBeNull();
    expect(parseGoalProposals([one, { ...one, entry: 'sum' }])).toBeNull();
    expect(parseGoalProposals([{ ...one, title: '   ' }])).toBeNull();
    expect(parseGoalProposals([{ ...one, unit: 'x'.repeat(21) }])).toBeNull();
    expect(parseGoalProposals([{ ...one, title: 'x'.repeat(81) }])).toBeNull();
    expect(parseGoalProposals([null])).toBeNull();
    expect(parseGoalProposals({ title: 'A' })).toBeNull();
  });
});

describe('the goal a member sets', () => {
  const goal = {
    title: 'Atteindre mon poids cible',
    unit: 'kg',
    category: 'body',
    entry: 'total',
    start: 92.456,
    target: 85,
    targetDate: '2026-12-31',
  };

  it('keeps a start, a different target and a date, to the cent', () => {
    expect(parseGoalInput(goal, NOW)).toEqual({ ...goal, start: 92.46 });
    // Going down is a goal too; so is a custom category-less one.
    expect(parseGoalInput({ ...goal, category: undefined }, NOW)?.category).toBe('other');
  });

  it('refuses a goal without a way to go, numbers or a real date', () => {
    expect(parseGoalInput({ ...goal, target: 92.46 }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, target: '85' }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, start: Number.NaN }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, target: 1e12 }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, targetDate: '2026-02-30' }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, targetDate: '31/12/2026' }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, entry: undefined }, NOW)).toBeNull();
    expect(parseGoalInput(null, NOW)).toBeNull();
  });

  it('takes a date from yesterday (the member’s today anywhere) to five years ahead', () => {
    expect(parseGoalInput({ ...goal, targetDate: '2026-09-30' }, NOW)).not.toBeNull();
    expect(parseGoalInput({ ...goal, targetDate: '2026-09-29' }, NOW)).toBeNull();
    expect(parseGoalInput({ ...goal, targetDate: '2031-10-01' }, NOW)).not.toBeNull();
    expect(parseGoalInput({ ...goal, targetDate: '2031-10-02' }, NOW)).toBeNull();
  });
});

describe('the result a member records', () => {
  const goalId = '0b9d4c8e-3f2a-4c1d-9e8f-7a6b5c4d3e2f';

  it('keeps a number to the cent, on a goal', () => {
    expect(parseResultEntry({ goalId, value: 12.345 })).toEqual({ goalId, value: 12.35 });
    expect(parseResultEntry({ goalId, value: -2 })).toEqual({ goalId, value: -2 });
    expect(parseResultEntry({ goalId: 'goal', value: 1 })).toBeNull();
    expect(parseResultEntry({ goalId, value: '1' })).toBeNull();
    expect(parseResultEntry({ goalId, value: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseResultEntry('1')).toBeNull();
  });

  it('never keeps a negative zero', () => {
    expect(Object.is(goalValue(-0.001), 0)).toBe(true);
    expect(goalValue(100_000_000_000)).toBe(100_000_000_000);
    expect(goalValue(100_000_000_001)).toBeNull();
  });
});

describe('badges and dates', () => {
  it('knows the catalog of stayput.badges', () => {
    expect(BADGE_CODES).toHaveLength(9);
    expect(isBadgeCode('milestone_50')).toBe(true);
    expect(isBadgeCode('milestone_60')).toBe(false);
  });

  it('knows a calendar day', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2027-1-01')).toBe(false);
    expect(isCalendarDate(20270101)).toBe(false);
  });
});

describe('the progress of a goal', () => {
  it('goes from the start to the target, whichever way', () => {
    expect(goalProgress(0, 10, 5)).toBe(50);
    expect(goalProgress(92, 85, 90.25)).toBe(25);
    expect(goalProgress(92, 85, 84.2)).toBe(100);
    expect(goalProgress(92, 85, 93)).toBe(0);
    expect(goalProgress(0, 3, 1)).toBe(33);
    expect(goalProgress(0.1, 0.3, 0.15)).toBe(25);
    expect(goalProgress(5, 5, 5)).toBe(0);
  });

  it('reaches a milestone exactly on it, never a hair before', () => {
    expect(goalProgress(0, 1000, 249.99)).toBe(24);
    expect(goalProgress(0, 1000, 250)).toBe(25);
    expect(milestonesAt(24)).toEqual([]);
    expect(milestonesAt(75)).toEqual([25, 50, 75]);
    expect(milestonesAt(100)).toEqual([25, 50, 75, 100]);
  });
});
