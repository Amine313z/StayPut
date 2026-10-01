import {
  BADGE_CODES,
  MILESTONES,
  isBadgeCode,
  isGoalCategory,
  isGoalEntry,
  isNiche,
  nicheGoalProposals,
  parseGoalProposals,
  type BadgeCode,
  type EarnedBadge,
  type GoalInput,
  type GoalProposal,
  type GoalProposalsView,
  type GoalResult,
  type MemberGoal,
  type MemberSpaceView,
  type Milestone,
  type ResultAnswer,
  type TemplateLocale,
} from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * The member space (SPEC Phase 5): the member's goal, the results they record, the milestones
 * and badges these bring, and the goals the creator proposes. The SQL functions of migration
 * 0020 decide; this module calls them and shapes their answers for the member view.
 */

/** What stayput.member_space returns. */
interface SpaceRow {
  known: boolean;
  niche: string | null;
  proposals: unknown;
  goal: {
    id: string;
    title: string;
    category: string;
    unit: string;
    entry: string;
    start: number;
    target: number;
    current: number;
    progress: number;
    targetDate: string | null;
    status: string;
    createdAt: string;
    milestones: { percent: number; reachedAt: string }[];
  } | null;
  results: { id: string; value: number; recordedAt: string }[];
  badges: { code: string; awardedAt: string }[];
}

/** The language of the page that asks, for StayPut's own words (English by default). */
export function spaceLocale(value: unknown): TemplateLocale {
  return value === 'fr' ? 'fr' : 'en';
}

const iso = (value: string) => new Date(value).toISOString();

const isMilestone = (value: number): value is Milestone =>
  (MILESTONES as readonly number[]).includes(value);

/** The goals proposed to members: the creator's own list, else their niche's in `locale`. */
function proposalsOf(niche: string | null, custom: unknown, locale: TemplateLocale) {
  return (
    (custom === null ? null : parseGoalProposals(custom)) ??
    nicheGoalProposals(isNiche(niche) ? niche : 'other', locale)
  );
}

function goalOf(row: NonNullable<SpaceRow['goal']>): MemberGoal {
  return {
    id: row.id,
    title: row.title,
    category: isGoalCategory(row.category) ? row.category : 'other',
    unit: row.unit,
    entry: isGoalEntry(row.entry) ? row.entry : 'total',
    start: Number(row.start),
    target: Number(row.target),
    current: Number(row.current),
    progress: Number(row.progress),
    targetDate: row.targetDate,
    status: row.status === 'achieved' ? 'achieved' : 'active',
    createdAt: iso(row.createdAt),
    milestones: row.milestones.flatMap((m) =>
      isMilestone(m.percent) ? [{ percent: m.percent, reachedAt: iso(m.reachedAt) }] : [],
    ),
  };
}

/**
 * The space of a member (or the team's preview of it): `fresh` are the badges this opening
 * brought.
 */
export async function readMemberSpace(
  db: Db,
  companyId: string,
  userId: string,
  options: { locale: TemplateLocale; preview: boolean; fresh?: readonly BadgeCode[] },
): Promise<MemberSpaceView> {
  const [row] = await db.query<{ space: SpaceRow }>(
    'select stayput.member_space($1, $2) as space',
    [companyId, userId],
  );
  const space = row?.space;
  const proposals = proposalsOf(space?.niche ?? null, space?.proposals ?? null, options.locale);
  // The team previews: what a member chooses from, nothing of their own.
  if (!space || options.preview) {
    return {
      preview: options.preview,
      known: false,
      goal: null,
      results: [],
      badges: [],
      proposals,
      fresh: [],
    };
  }
  return {
    preview: false,
    known: space.known,
    goal: space.goal ? goalOf(space.goal) : null,
    results: space.results.map((r): GoalResult => ({
      id: r.id,
      value: Number(r.value),
      recordedAt: iso(r.recordedAt),
    })),
    badges: space.badges
      .flatMap((b): EarnedBadge[] =>
        isBadgeCode(b.code) ? [{ code: b.code, awardedAt: iso(b.awardedAt) }] : [],
      )
      // Earned together (a jump past two milestones), in the catalog's order.
      .sort(
        (a, b) =>
          a.awardedAt.localeCompare(b.awardedAt) ||
          BADGE_CODES.indexOf(a.code) - BADGE_CODES.indexOf(b.code),
      ),
    proposals,
    fresh: [...(options.fresh ?? [])],
  };
}

const badgesOf = (value: unknown): BadgeCode[] =>
  Array.isArray(value) ? value.filter(isBadgeCode) : [];

/**
 * The member opened their space: an activity for the day, and the badges it brings (seven days
 * in a row).
 */
export async function recordOpen(
  db: Db,
  companyId: string,
  userId: string,
  now: Date,
): Promise<BadgeCode[]> {
  const [row] = await db.query<{ opened: { badges?: unknown } | null }>(
    'select stayput.record_open($1, $2, $3::timestamptz) as opened',
    [companyId, userId, now.toISOString()],
  );
  return badgesOf(row?.opened?.badges);
}

/** The member's new goal; false when StayPut does not know the member yet. */
export async function setGoal(
  db: Db,
  companyId: string,
  userId: string,
  goal: GoalInput,
  now: Date,
): Promise<boolean> {
  const [row] = await db.query<{ id: string | null }>(
    'select stayput.set_goal($1, $2, $3::text::jsonb, $4::timestamptz) as id',
    [companyId, userId, JSON.stringify(goal), now.toISOString()],
  );
  return Boolean(row?.id);
}

/** A result on the member's goal under way: what it brought, or null when there is no such goal. */
export async function recordResult(
  db: Db,
  companyId: string,
  userId: string,
  entry: { goalId: string; value: number },
  now: Date,
): Promise<Omit<ResultAnswer, 'space'> | null> {
  const [row] = await db.query<{
    result: { milestones?: unknown; badges?: unknown; achieved?: unknown } | null;
  }>('select stayput.record_result($1, $2, $3::uuid, $4::numeric, $5::timestamptz) as result', [
    companyId,
    userId,
    entry.goalId,
    String(entry.value),
    now.toISOString(),
  ]);
  const result = row?.result;
  if (!result) return null;
  const milestones = Array.isArray(result.milestones)
    ? result.milestones.map(Number).filter(isMilestone)
    : [];
  return { milestones, badges: badgesOf(result.badges), achieved: result.achieved === true };
}

/** The goals proposed to the company's members, read as the creator (under RLS). */
export async function readGoalProposals(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  locale: TemplateLocale,
): Promise<GoalProposalsView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ niche: string; goal_proposals: unknown }>(
      `select c.niche, s.goal_proposals
         from stayput.companies c
         left join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    ),
  );
  if (!row) return null;
  const niche = isNiche(row.niche) ? row.niche : 'other';
  const custom: GoalProposal[] | null =
    row.goal_proposals === null ? null : parseGoalProposals(row.goal_proposals);
  return { niche, custom, defaults: nicheGoalProposals(niche, locale) };
}

/** The creator's own goals for their members; null goes back to the niche's. */
export async function saveGoalProposals(
  db: Db,
  companyId: string,
  proposals: GoalProposal[] | null,
): Promise<void> {
  await db.query('select stayput.save_goal_proposals($1, $2::text::jsonb)', [
    companyId,
    proposals === null ? null : JSON.stringify(proposals),
  ]);
}
