import {
  RISK_FACTORS,
  analyzeCohorts,
  computeRisk,
  findBlockingLessons,
  type CohortCounts,
  type LessonCounts,
  type PaymentState,
  type RiskInputs,
  type RiskSettings,
} from '@stayput/core';
import type { Db } from './db';

/**
 * Detection (SPEC Phase 3) on the Worker's side: Postgres gathers the figures as one JSON
 * document (risk_features, analysis_features), the pure functions of packages/core decide, and
 * Postgres keeps the result (save_risk_scores, save_analyses). One parse and one serialization
 * per batch: the free plan gives an invocation 10 ms of CPU.
 */

/** Members scored per run at most (about 2 ms of CPU for the parse and the computation). */
export const RISK_BATCH = 1500;
/** Fewer during a request (opening the dashboard, « Sync now »): the cron does the rest. */
export const REQUEST_RISK_BATCH = 500;

/** One member as risk_features writes it (see the migration 0008 for the order). */
type FeatureRow = [
  id: string,
  joinedAt: number | null,
  lastActivityAt: number | null,
  activity7d: number,
  activityPrev28d: number,
  lastProgressAt: number | null,
  lastLessonTitle: string | null,
  payment: PaymentState,
  cancelAtPeriodEnd: boolean,
  cancelAt: number | null,
  openTicketSince: number | null,
  reactions14d: number,
  reactionsPrev14d: number,
  activeSinceJoin: boolean,
];

function toInputs(row: FeatureRow): RiskInputs {
  return {
    joinedAt: row[1],
    lastActivityAt: row[2],
    activity7d: row[3],
    activityPrev28d: row[4],
    lastProgressAt: row[5],
    lastLessonTitle: row[6],
    payment: row[7],
    cancelAtPeriodEnd: row[8],
    cancelAt: row[9],
    openTicketSince: row[10],
    reactions14d: row[11],
    reactionsPrev14d: row[12],
    activeSinceJoin: row[13],
  };
}

/** Scores the company's members whose score is due, `limit` at most. Returns how many. */
export async function scoreCompany(
  db: Db,
  companyId: string,
  now: Date,
  limit = RISK_BATCH,
): Promise<number> {
  const at = now.toISOString();
  const [row] = await db.query<{ data: string }>(
    'select stayput.risk_features($1, $2::timestamptz, $3)::text as data',
    [companyId, at, limit],
  );
  const data = JSON.parse(row?.data ?? '{}') as {
    settings?: RiskSettings | null;
    members?: FeatureRow[];
  };
  const settings = data.settings;
  const members = data.members ?? [];
  if (!settings || members.length === 0) return 0;
  const time = now.getTime();
  const scores = members.map((member) => {
    const result = computeRisk(toInputs(member), settings, time);
    return [
      member[0],
      result.score,
      result.level,
      RISK_FACTORS.map((factor) => result.subScores[factor]),
      result.reasons,
      result.inactiveNewcomer,
    ];
  });
  const [saved] = await db.query<{ saved: number }>(
    'select stayput.save_risk_scores($1, $2::text::jsonb, $3::timestamptz) as saved',
    [companyId, JSON.stringify(scores), at],
  );
  return saved?.saved ?? 0;
}

/** The weekly analyses of a company: cohorts that leave faster, lessons members stall after. */
export async function analyzeCompany(db: Db, companyId: string, now: Date): Promise<void> {
  const at = now.toISOString();
  const [row] = await db.query<{ data: string }>(
    'select stayput.analysis_features($1, $2::timestamptz)::text as data',
    [companyId, at],
  );
  const data = JSON.parse(row?.data ?? '{}') as {
    cohorts?: CohortCounts[];
    lessons?: LessonCounts[];
  };
  const cohorts = analyzeCohorts(data.cohorts ?? []).cohorts;
  const lessons = findBlockingLessons(data.lessons ?? []);
  await db.query(
    'select stayput.save_analyses($1, $2::text::jsonb, $3::text::jsonb, $4::timestamptz)',
    [companyId, JSON.stringify(cohorts), JSON.stringify(lessons), at],
  );
}

/** Scores what is due for a company, then runs its weekly analyses if they are due too. */
export async function refreshDetection(
  db: Db,
  companyId: string,
  now: Date,
  limit = RISK_BATCH,
): Promise<{ scored: number; analyzed: boolean }> {
  const scored = await scoreCompany(db, companyId, now, limit);
  const [due] = await db.query<{ due: boolean }>(
    'select stayput.analyses_due($1, $2::timestamptz) as due',
    [companyId, now.toISOString()],
  );
  if (due?.due) await analyzeCompany(db, companyId, now);
  return { scored, analyzed: due?.due ?? false };
}

export interface DetectionRun {
  companyId: string;
  scored: number;
  analyzed: boolean;
}

/** The hourly run: the companies that waited longest, within `budget` members. */
export async function scoreDueCompanies(
  db: Db,
  now: Date,
  budget = RISK_BATCH,
  companies = 20,
): Promise<DetectionRun[]> {
  const due = await db.query<{ id: string }>(
    'select stayput.companies_to_score($1::timestamptz, $2) as id',
    [now.toISOString(), companies],
  );
  const runs: DetectionRun[] = [];
  let left = budget;
  for (const { id } of due) {
    if (left <= 0) break;
    const run = await refreshDetection(db, id, now, left);
    left -= run.scored;
    runs.push({ companyId: id, ...run });
  }
  return runs;
}
