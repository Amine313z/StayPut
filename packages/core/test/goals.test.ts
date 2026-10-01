import { describe, expect, it } from 'vitest';
import {
  BADGE_CODES,
  GOAL_CATEGORIES,
  MAX_PROOF_NUMBERS,
  MAX_GOAL_PROPOSALS,
  NICHE_GOALS,
  extractNumbers,
  goalProgress,
  goalValue,
  isBadgeCode,
  milestonesAt,
  isCalendarDate,
  nicheGoalProposals,
  parseGoalInput,
  parseGoalProposals,
  parseLocaleNumber,
  parseProof,
  parseResultEntry,
  proofJustifies,
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

describe('a number as people type it', () => {
  it('reads both ways of writing it', () => {
    expect(parseLocaleNumber('3 000,5', 'fr')).toBe(3000.5);
    expect(parseLocaleNumber('3,000.5', 'en')).toBe(3000.5);
    expect(parseLocaleNumber('3000.5', 'fr')).toBe(3000.5);
    expect(parseLocaleNumber('1.234,56', 'en')).toBe(1234.56);
    expect(parseLocaleNumber('3,000', 'en')).toBe(3000);
    expect(parseLocaleNumber('3,000', 'fr')).toBe(3);
    expect(parseLocaleNumber('2,5', 'en')).toBe(2.5);
    expect(parseLocaleNumber('−4', 'fr')).toBe(-4);
    expect(parseLocaleNumber('12\u202f500', 'fr')).toBe(12500);
  });

  it('refuses what is not one', () => {
    expect(parseLocaleNumber('', 'fr')).toBeNull();
    expect(parseLocaleNumber('12 kg', 'fr')).toBeNull();
    expect(parseLocaleNumber('1,2,3', 'fr')).toBeNull();
    expect(parseLocaleNumber('1e5', 'en')).toBeNull();
    expect(parseLocaleNumber('999999999999', 'en')).toBeNull();
  });
});

describe('the numbers of a screenshot (SPEC Phase 5, point 3)', () => {
  it('reads the amounts of a French dashboard, not its dates and times', () => {
    const text = [
      'Tableau de bord — 01/10/2026 23:45',
      "Chiffre d'affaires 3 250,00 €",
      'Ventes 12   Panier moyen 270,83 €',
      'Évolution +12,5 % depuis le 2026-09-01',
    ].join('\n');
    expect(extractNumbers(text)).toEqual([3250, 12, 270.83, 12.5]);
  });

  it('reads an English one, and a trade’s loss', () => {
    expect(extractNumbers('Net P&L: -1,250.50 USD\nWin rate 64.2%\nTrades: 37')).toEqual([
      -1250.5, 64.2, 37,
    ]);
    // A minus inside a word is no sign.
    expect(extractNumbers('COVID-19 relief')).toEqual([19]);
  });

  it('gives both readings of an ambiguous number, the member taps the right one', () => {
    expect(extractNumbers('Total 3,250')).toEqual([3250, 3.25]);
    expect(extractNumbers('Weight 85.250 kg')).toEqual([85250, 85.25]);
  });

  it('keeps numbers apart that only a space separates', () => {
    expect(extractNumbers('12 34')).toEqual([12, 34]);
    expect(extractNumbers('1 234 567,89 €')).toEqual([1234567.89]);
    expect(extractNumbers("CHF 12'500.00")).toEqual([12500]);
    expect(extractNumbers('1.234.567')).toEqual([1234567]);
  });

  it('keeps each number once, thirty at most', () => {
    expect(extractNumbers('5 kg, 5 kg, 5 kg')).toEqual([5]);
    const many = Array.from({ length: 40 }, (_, i) => `item ${i + 1}`).join('\n');
    expect(extractNumbers(many)).toHaveLength(MAX_PROOF_NUMBERS);
    expect(extractNumbers('nothing here')).toEqual([]);
  });
});

describe('a proof', () => {
  const sha256 = 'a'.repeat(64);

  it('is a fingerprint and the numbers read, each once', () => {
    expect(parseProof({ sha256, numbers: [3250, 12, 3250, 270.833] })).toEqual({
      sha256,
      numbers: [3250, 12, 270.83],
    });
    expect(parseProof({ sha256: 'A'.repeat(64), numbers: [] })).toBeNull();
    expect(parseProof({ sha256, numbers: ['12'] })).toBeNull();
    expect(parseProof({ sha256, numbers: Array.from({ length: 31 }, (_, i) => i) })).toBeNull();
    expect(parseProof('proof')).toBeNull();
  });

  it('comes with a result, or the result is refused', () => {
    const goalId = '0b9d4c8e-3f2a-4c1d-9e8f-7a6b5c4d3e2f';
    expect(parseResultEntry({ goalId, value: 3250, proof: { sha256, numbers: [3250] } })).toEqual({
      goalId,
      value: 3250,
      proof: { sha256, numbers: [3250] },
    });
    expect(parseResultEntry({ goalId, value: 3250, proof: null })).toEqual({ goalId, value: 3250 });
    expect(
      parseResultEntry({ goalId, value: 3250, proof: { sha256: 'x', numbers: [] } }),
    ).toBeNull();
  });

  it('backs a number that is on the screenshot, to the cent', () => {
    const proof = { sha256, numbers: [3250, 270.83] };
    expect(proofJustifies(proof, 3250)).toBe(true);
    expect(proofJustifies(proof, 270.83)).toBe(true);
    expect(proofJustifies(proof, 3200)).toBe(false);
  });
});
