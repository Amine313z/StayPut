/**
 * The weekly analyses (SPEC Phase 3): cohorts that leave faster than the others, and lessons
 * after which members stall. The database counts (cohort_features, lesson_features); these
 * decide what deserves the creator's attention.
 */

/** Days after joining at which a cohort's departures are counted. */
export const COHORT_HORIZONS = [30, 60, 90] as const;
export type CohortHorizon = (typeof COHORT_HORIZONS)[number];

/** A cohort leaving at least this many times more than the creator's average is flagged… */
export const COHORT_ALERT_RATIO = 1.5;
/** …when it has at least this many members. */
export const COHORT_MIN_MEMBERS = 10;

/** One month of arrivals, counted by the database. */
export interface CohortCounts {
  /** First day of the month of arrival (`2026-09-01`). */
  month: string;
  members: number;
  /**
   * For each horizon: the members who joined long enough ago to be counted, and those of them
   * who left within that many days of joining.
   */
  eligible: Record<CohortHorizon, number>;
  left: Record<CohortHorizon, number>;
}

export interface CohortAnalysis extends CohortCounts {
  /** Departure rate per horizon; null while no member of the cohort is old enough. */
  rates: Record<CohortHorizon, number | null>;
  /** The first horizon at which the cohort leaves 1.5 times more than the average, if any. */
  alertHorizon: CohortHorizon | null;
}

export interface CohortReport {
  cohorts: CohortAnalysis[];
  /** The creator's average departure rate per horizon, all cohorts together. */
  averages: Record<CohortHorizon, number | null>;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function analyzeCohorts(cohorts: readonly CohortCounts[]): CohortReport {
  const averages = Object.fromEntries(
    COHORT_HORIZONS.map((h) => [
      h,
      ratio(
        cohorts.reduce((sum, c) => sum + c.left[h], 0),
        cohorts.reduce((sum, c) => sum + c.eligible[h], 0),
      ),
    ]),
  ) as Record<CohortHorizon, number | null>;
  return {
    averages,
    cohorts: cohorts.map((cohort) => {
      const rates = Object.fromEntries(
        COHORT_HORIZONS.map((h) => [h, ratio(cohort.left[h], cohort.eligible[h])]),
      ) as Record<CohortHorizon, number | null>;
      const alertHorizon =
        cohort.members < COHORT_MIN_MEMBERS
          ? null
          : (COHORT_HORIZONS.find((h) => {
              const rate = rates[h];
              const average = averages[h];
              return (
                rate !== null &&
                average !== null &&
                average > 0 &&
                cohort.eligible[h] >= COHORT_MIN_MEMBERS &&
                rate >= COHORT_ALERT_RATIO * average
              );
            }) ?? null);
      return { ...cohort, rates, alertHorizon };
    }),
  };
}

/** A lesson whose stall rate is more than this many times its course's average is flagged… */
export const LESSON_FLAG_RATIO = 2;
/** …when at least this many members completed it. */
export const LESSON_MIN_MEMBERS = 10;
/** A member whose last activity is older than this has stalled. */
export const LESSON_STALL_DAYS = 14;

/** One lesson, counted by the database. */
export interface LessonCounts {
  lessonId: string;
  courseId: string;
  title: string | null;
  /** Members who completed this lesson. */
  reached: number;
  /** Of them, those for whom it is the last lesson completed, inactive 14 days or gone. */
  stalled: number;
}

export interface LessonAnalysis extends LessonCounts {
  rate: number;
  courseAverage: number;
  flagged: boolean;
}

/** The share of members who stall after each lesson, against the average of its course. */
export function findBlockingLessons(lessons: readonly LessonCounts[]): LessonAnalysis[] {
  const rates = lessons.map((l) => ratio(Math.min(l.stalled, l.reached), l.reached) ?? 0);
  const byCourse = new Map<string, number[]>();
  lessons.forEach((lesson, i) => {
    if (lesson.reached <= 0) return;
    byCourse.set(lesson.courseId, [...(byCourse.get(lesson.courseId) ?? []), rates[i] ?? 0]);
  });
  return lessons.map((lesson, i) => {
    const course = byCourse.get(lesson.courseId) ?? [];
    const courseAverage =
      course.length > 0 ? course.reduce((sum, rate) => sum + rate, 0) / course.length : 0;
    const rate = rates[i] ?? 0;
    return {
      ...lesson,
      rate,
      courseAverage,
      flagged:
        lesson.reached >= LESSON_MIN_MEMBERS &&
        courseAverage > 0 &&
        rate > LESSON_FLAG_RATIO * courseAverage,
    };
  });
}
