import {
  goalProgress,
  goalValue,
  milestonesAt,
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

/** The space as a member starts it: no goal, no result, no badge. */
export function trialStart(preview: MemberSpaceView): MemberSpaceView {
  return { ...preview, known: true, goal: null, results: [], badges: [], fresh: [] };
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

/** A result on the goal under way: its milestones and badges, as StayPut gives them. */
export function trialResult(
  view: MemberSpaceView,
  entry: ResultEntry,
  now: Date,
): ResultAnswer | null {
  const goal = view.goal;
  if (!goal || goal.id !== entry.goalId || goal.status !== 'active') return null;
  const value = goalValue(goal.entry === 'add' ? goal.current + entry.value : entry.value);
  if (value === null) return null;
  const at = now.toISOString();
  const progress = goalProgress(goal.start, goal.target, value);
  const reached = new Set(goal.milestones.map((m) => m.percent));
  const milestones = milestonesAt(progress).filter((m) => !reached.has(m));
  const owned = new Set(view.badges.map((b) => b.code));
  const badges = (
    ['first_result', ...milestones.map((m) => `milestone_${m}`)] as BadgeCode[]
  ).filter((code) => !owned.has(code));
  const achieved = progress >= 100;
  return {
    milestones,
    badges,
    achieved,
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
        { id: `trial-result-${view.results.length}-${at}`, value, recordedAt: at },
        ...view.results,
      ].slice(0, 10),
      badges: [...view.badges, ...badges.map((code) => ({ code, awardedAt: at }))],
      fresh: [],
    },
  };
}
