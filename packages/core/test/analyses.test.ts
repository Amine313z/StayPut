import { describe, expect, it } from 'vitest';
import { analyzeCohorts, findBlockingLessons, type CohortCounts, type LessonCounts } from '../src';

/** The weekly analyses of SPEC Phase 3: cohort alerts and blocking lessons. */

const cohort = (
  month: string,
  members: number,
  left30: number,
  over: Partial<CohortCounts> = {},
): CohortCounts => ({
  month,
  members,
  eligible: { 30: members, 60: members, 90: members },
  left: { 30: left30, 60: left30, 90: left30 },
  ...over,
});

describe('analyzeCohorts', () => {
  it('flags a cohort that leaves at least 1.5 times more than the average', () => {
    const report = analyzeCohorts([
      cohort('2026-06-01', 20, 2),
      cohort('2026-07-01', 20, 2),
      cohort('2026-08-01', 20, 8),
    ]);
    expect(report.averages[30]).toBeCloseTo(12 / 60);
    expect(report.cohorts.map((c) => [c.month, c.rates[30], c.alertHorizon])).toEqual([
      ['2026-06-01', 0.1, null],
      ['2026-07-01', 0.1, null],
      ['2026-08-01', 0.4, 30],
    ]);
  });

  it('needs 10 members in the cohort, and members old enough for the horizon', () => {
    const report = analyzeCohorts([
      cohort('2026-06-01', 30, 3),
      cohort('2026-07-01', 9, 9),
      cohort('2026-09-01', 15, 0, {
        eligible: { 30: 0, 60: 0, 90: 0 },
        left: { 30: 0, 60: 0, 90: 0 },
      }),
    ]);
    const [, small, young] = report.cohorts;
    expect(small?.alertHorizon).toBeNull();
    expect(young?.rates).toEqual({ 30: null, 60: null, 90: null });
    expect(young?.alertHorizon).toBeNull();
  });

  it('raises nothing when nobody leaves, and stays empty without cohorts', () => {
    expect(analyzeCohorts([cohort('2026-06-01', 20, 0)]).cohorts[0]?.alertHorizon).toBeNull();
    expect(analyzeCohorts([])).toEqual({ cohorts: [], averages: { 30: null, 60: null, 90: null } });
  });

  it('reports a later horizon when the first ones look normal', () => {
    const late = cohort('2026-05-01', 20, 1, { left: { 30: 1, 60: 2, 90: 12 } });
    const report = analyzeCohorts([
      cohort('2026-03-01', 20, 1, { left: { 30: 1, 60: 2, 90: 3 } }),
      cohort('2026-04-01', 20, 1, { left: { 30: 1, 60: 2, 90: 3 } }),
      late,
    ]);
    expect(report.cohorts[2]?.alertHorizon).toBe(90);
  });
});

const lesson = (id: string, reached: number, stalled: number, course = 'cors_A'): LessonCounts => ({
  lessonId: id,
  courseId: course,
  title: `Lesson ${id}`,
  reached,
  stalled,
});

describe('findBlockingLessons', () => {
  it('flags a lesson whose stall rate is over twice its course average', () => {
    const lessons = findBlockingLessons([
      lesson('1', 40, 2),
      lesson('2', 30, 2),
      lesson('3', 25, 12),
      lesson('4', 10, 1),
    ]);
    const average = (0.05 + 2 / 30 + 0.48 + 0.1) / 4;
    expect(lessons[2]).toMatchObject({ lessonId: '3', rate: 0.48, flagged: true });
    expect(lessons[2]?.courseAverage).toBeCloseTo(average);
    expect(lessons.filter((l) => l.flagged).map((l) => l.lessonId)).toEqual(['3']);
  });

  it('needs 10 members who reached the lesson, and compares within its course only', () => {
    const lessons = findBlockingLessons([
      lesson('1', 50, 1),
      lesson('2', 9, 9),
      lesson('a', 20, 10, 'cors_B'),
      lesson('b', 20, 10, 'cors_B'),
    ]);
    expect(lessons.map((l) => l.flagged)).toEqual([false, false, false, false]);
    expect(lessons[2]?.courseAverage).toBe(0.5);
  });

  it('needs 3 members who stalled: one is chance, not a signal', () => {
    // 1 of 23 is over twice an average of near zero, yet says nothing.
    const lessons = findBlockingLessons([
      lesson('1', 23, 1),
      lesson('2', 20, 0),
      lesson('3', 18, 0),
      lesson('4', 15, 0),
      lesson('a', 20, 6, 'cors_B'),
      lesson('b', 20, 1, 'cors_B'),
      lesson('c', 20, 0, 'cors_B'),
    ]);
    expect(lessons[0]?.rate).toBeGreaterThan(2 * (lessons[0]?.courseAverage ?? 1));
    expect(lessons.filter((l) => l.flagged).map((l) => l.lessonId)).toEqual(['a']);
  });

  it('copes with a lesson nobody reached and with more stalls than members', () => {
    const lessons = findBlockingLessons([lesson('1', 0, 0), lesson('2', 10, 12)]);
    expect(lessons[0]).toMatchObject({ rate: 0, flagged: false });
    expect(lessons[1]).toMatchObject({ rate: 1, courseAverage: 1, flagged: false });
  });
});
