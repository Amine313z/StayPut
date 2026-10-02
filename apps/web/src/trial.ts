import {
  goalProgress,
  goalValue,
  milestonesAt,
  proofJustifies,
  type BadgeCode,
  type GoalInput,
  type MemberSpaceView,
  type ResultAnswer,
  type ResultEntry,
} from '@stayput/core';

/**
 * The team's trial of the member space, in the browser: what StayPut would answer a member
 * (migration 0020, record_result), computed here with the same progress (packages/core), so the
 * creator sees the milestones and badges without anything recorded.
 */

/** The space as a member starts it: no goal, no result, no badge, no free day yet. */
export function trialStart(preview: MemberSpaceView): MemberSpaceView {
  return {
    ...preview,
    known: true,
    goal: null,
    results: [],
    badges: [],
    fresh: [],
    rewards: { offered: preview.rewards.offered, received: [] },
  };
}

/** The goal set: the one under way ends, where the member stands is the start. */
export function trialGoal(view: MemberSpaceView, goal: GoalInput, now: Date): MemberSpaceView {
  const at = now.toISOString();
  return {
    ...view,
    goal: {
      id: `trial-goal-${at}`,
      title: goal.title,
      category: goal.category,
      unit: goal.unit,
      entry: goal.entry,
      start: goal.start,
      target: goal.target,
      current: goal.start,
      progress: 0,
      targetDate: goal.targetDate,
      status: 'active',
      createdAt: at,
      milestones: [],
    },
    results: [],
    fresh: [],
  };
}

/**
 * A result on the goal under way: its milestones and badges, and its screenshot's outcome, as
 * StayPut gives them. `used` holds the screenshots that backed a result in this trial.
 */
export function trialResult(
  view: MemberSpaceView,
  entry: ResultEntry,
  now: Date,
  used: Set<string> = new Set(),
): ResultAnswer | null {
  const goal = view.goal;
  if (!goal || goal.id !== entry.goalId || goal.status !== 'active') return null;
  const value = goalValue(goal.entry === 'add' ? goal.current + entry.value : entry.value);
  if (value === null) return null;
  const at = now.toISOString();
  const progress = goalProgress(goal.start, goal.target, value);
  const reached = new Set(goal.milestones.map((m) => m.percent));
  const milestones = milestonesAt(progress).filter((m) => !reached.has(m));
  const proof = !entry.proof
    ? null
    : !proofJustifies(entry.proof, entry.value)
      ? 'declared'
      : used.has(entry.proof.sha256)
        ? 'duplicate'
        : 'justified';
  if (proof === 'justified' && entry.proof) used.add(entry.proof.sha256);
  const owned = new Set(view.badges.map((b) => b.code));
  const badges = (
    [
      'first_result',
      ...(proof === 'justified' ? ['first_proof'] : []),
      ...milestones.map((m) => `milestone_${m}`),
    ] as BadgeCode[]
  ).filter((code) => !owned.has(code));
  const achieved = progress >= 100;
  // The earned days, as a member gets them in automatic mode: once per milestone.
  const offered = view.rewards.offered;
  const had = new Set(view.rewards.received.map((r) => r.percent));
  const earned = offered
    ? milestones.flatMap((percent) => {
        const days = percent === 50 ? offered.at50 : percent === 100 ? offered.at100 : 0;
        return days > 0 && !had.has(percent) ? [{ percent, days, at }] : [];
      })
    : [];
  return {
    milestones,
    badges,
    achieved,
    proof,
    earnedDays: earned.reduce((sum, r) => sum + r.days, 0),
    space: {
      ...view,
      goal: {
        ...goal,
        current: value,
        progress,
        status: achieved ? 'achieved' : 'active',
        milestones: [
          ...goal.milestones,
          ...milestones.map((percent) => ({ percent, reachedAt: at })),
        ],
      },
      results: [
        {
          id: `trial-result-${view.results.length}-${at}`,
          value,
          recordedAt: at,
          proof: proof === 'justified' ? ('justified' as const) : null,
        },
        ...view.results,
      ].slice(0, 10),
      badges: [...view.badges, ...badges.map((code) => ({ code, awardedAt: at }))],
      fresh: [],
      rewards: { offered, received: [...view.rewards.received, ...earned] },
    },
  };
}
