import type { MemberSpaceView } from '@stayput/core';
import { describe, expect, it } from 'vitest';
import { trialCard, trialGoal, trialResult, trialStart } from '../src/trial';

/**
 * The team's trial of the member space, computed in the browser: it must answer as StayPut would
 * (apps/worker/test/member-space.test.ts says what StayPut answers).
 */

const NOW = new Date('2026-10-01T08:00:00Z');
const preview: MemberSpaceView = {
  preview: true,
  known: false,
  goal: null,
  results: [],
  badges: [],
  proposals: [],
  fresh: [],
  rewards: { offered: { at50: 3, at100: 7 }, received: [] },
  announce: null,
  cards: [],
  whopAppId: 'app_stayput',
  buddies: null,
  rescues: null,
};

describe('the trial', () => {
  it('counts milestones and badges as StayPut does, and each screenshot once', () => {
    const used = new Set<string>();
    let view = trialGoal(
      trialStart(preview),
      {
        title: 'Revenue',
        unit: '$',
        category: 'income',
        entry: 'total',
        start: 0,
        target: 5000,
        targetDate: '2026-12-31',
      },
      NOW,
    );
    const goalId = view.goal!.id;
    const proof = { sha256: 'a'.repeat(64), numbers: [3250, 12] };
    const first = trialResult(view, { goalId, value: 3250, proof }, NOW, used)!;
    expect(first).toMatchObject({
      milestones: [25, 50],
      badges: ['first_result', 'first_proof', 'milestone_25', 'milestone_50'],
      proof: 'justified',
      // The creator's 3 days at 50 %, as a member gets them in automatic mode.
      earnedDays: 3,
    });
    view = first.space;
    expect(view.results[0]).toMatchObject({ value: 3250, proof: 'justified' });
    expect(trialResult(view, { goalId, value: 12, proof }, NOW, used)).toMatchObject({
      badges: [],
      proof: 'duplicate',
    });
    const other = { sha256: 'b'.repeat(64), numbers: [1] };
    expect(trialResult(view, { goalId, value: 4000, proof: other }, NOW, used)).toMatchObject({
      milestones: [75],
      proof: 'declared',
    });
    // Reached: no more results on it.
    const done = trialResult(view, { goalId, value: 5000 }, NOW, used)!;
    expect(done).toMatchObject({
      achieved: true,
      milestones: [75, 100],
      proof: null,
      earnedDays: 7,
    });
    expect(done.space.rewards.received.map((r) => [r.percent, r.days])).toEqual([
      [50, 3],
      [100, 7],
    ]);
    expect(trialResult(done.space, { goalId, value: 5100 }, NOW, used)).toBeNull();
  });

  it('draws the card of a result as StayPut would, without publishing it', () => {
    const start = trialStart({ ...preview, cards: [] });
    const view = trialGoal(
      start,
      {
        title: 'Revenue',
        unit: '$',
        category: 'income',
        entry: 'total',
        start: 1000,
        target: 5000,
        targetDate: '2026-12-31',
      },
      NOW,
    );
    const goalId = view.goal!.id;
    const proof = { sha256: 'c'.repeat(64), numbers: [3000] };
    const { space } = trialResult(view, { goalId, value: 3000, proof }, NOW, new Set())!;
    const resultId = space.results[0]!.id;
    const options = {
      now: NOW,
      origin: 'https://stayput.test',
      proofId: '11111111-2222-4333-8444-555555555555',
      locale: 'en' as const,
      name: 'Your name',
    };
    expect(
      trialCard(space, { resultId, showName: false, affiliateUrl: null }, options),
    ).toMatchObject({
      proofId: options.proofId,
      resultId,
      level: 'justified',
      url: 'https://stayput.test/v/11111111-2222-4333-8444-555555555555',
      display: {
        community: null,
        goal: 'Revenue',
        unit: '$',
        start: 1000,
        target: 5000,
        value: 3000,
        // As StayPut counts it: half of the way from 1,000 to 5,000.
        progress: 50,
        name: null,
        affiliateUrl: null,
      },
    });
    const named = trialCard(
      space,
      { resultId, showName: true, affiliateUrl: 'https://whop.com/club/?a=jo' },
      options,
    );
    expect(named?.display).toMatchObject({
      name: 'Your name',
      affiliateUrl: 'https://whop.com/club/?a=jo',
    });
    expect(named?.display.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A result the space does not show makes no card.
    expect(
      trialCard(space, { resultId: 'nope', showName: false, affiliateUrl: null }, options),
    ).toBeNull();
    // The trial starts again from no card.
    expect(trialStart(space).cards).toEqual([]);
  });
});
