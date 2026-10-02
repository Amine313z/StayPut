import {
  BADGE_CODES,
  MILESTONES,
  isProofLevel,
  parseAnnounceTarget,
  isBadgeCode,
  isGoalCategory,
  isGoalEntry,
  isNiche,
  nicheGoalProposals,
  parseGoalProposals,
  proofJustifies,
  type AnnounceDestination,
  type BadgeCode,
  type BuddiesView,
  type BuddyPartner,
  type CardRequest,
  type EarnedBadge,
  type EarnedDaysSettings,
  type GoalInput,
  type GoalProposal,
  type GoalProposalsView,
  type GoalResult,
  type MemberBuddies,
  type MemberGoal,
  type MemberRescues,
  type MemberSpaceView,
  type Milestone,
  type ProofLevel,
  type RescueChallenge,
  type RescuesView,
  type ResultAnswer,
  type ResultEntry,
  type ShareRequest,
  type SpaceOverview,
  type TemplateLocale,
  type TestimonialCard,
  type TestimonialDisplay,
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
  results: { id: string; value: number; recordedAt: string; proof: string | null }[];
  badges: { code: string; awardedAt: string }[];
}

/** The language of the page that asks, for StayPut's own words (English by default). */
export function spaceLocale(value: unknown): TemplateLocale {
  return value === 'fr' ? 'fr' : 'en';
}

const iso = (value: string) => new Date(value).toISOString();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  options: {
    locale: TemplateLocale;
    preview: boolean;
    fresh?: readonly BadgeCode[];
    /** StayPut's own address, for the public pages of the cards. */
    origin?: string;
    /** The app's id, to open those pages through Whop. */
    whopAppId?: string | null;
  },
): Promise<MemberSpaceView> {
  const [row] = await db.query<{ space: SpaceRow }>(
    'select stayput.member_space($1, $2) as space',
    [companyId, userId],
  );
  const space = row?.space;
  const proposals = proposalsOf(space?.niche ?? null, space?.proposals ?? null, options.locale);
  const rewards = await readRewards(db, companyId, userId);
  const announce = await readAnnounce(db, companyId, userId);
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
      // The team sees what members are offered, never anyone's days.
      rewards: { offered: rewards.offered, received: [] },
      announce,
      cards: [],
      whopAppId: options.whopAppId ?? null,
      buddies: null,
      rescues: null,
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
      proof: r.proof === 'justified' || r.proof === 'connected' ? r.proof : null,
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
    rewards,
    announce,
    cards: await readCards(db, companyId, userId, options.origin ?? ''),
    whopAppId: options.whopAppId ?? null,
    buddies: await readBuddies(db, companyId, userId),
    rescues: await readRescues(db, companyId, userId),
  };
}

/** What stayput.member_cards and make_testimonial give of a card. */
interface CardRow {
  proofId?: string;
  id?: string;
  resultId?: string | null;
  level: string;
  display: Record<string, unknown>;
}

function cardOf(row: CardRow, origin: string): TestimonialCard | null {
  const proofId = row.proofId ?? row.id;
  const display = displayOf(row.display);
  if (!proofId || !display || !isProofLevel(row.level)) return null;
  return {
    proofId,
    resultId: row.resultId ?? null,
    level: row.level,
    url: `${origin}/v/${proofId}`,
    display,
  };
}

/** A card's public part as the database keeps it, read back with its types. */
export function displayOf(value: Record<string, unknown>): TestimonialDisplay | null {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const goal = text(value.goal);
  const unit = text(value.unit);
  const recordedAt = text(value.recordedAt);
  const publishedAt = text(value.publishedAt);
  if (!goal || !unit || !recordedAt || !publishedAt) return null;
  return {
    community: text(value.community),
    locale: value.locale === 'fr' ? 'fr' : 'en',
    goal,
    unit,
    entry: isGoalEntry(value.entry) ? value.entry : 'total',
    start: Number(value.start),
    target: Number(value.target),
    value: Number(value.value),
    progress: Number(value.progress),
    recordedAt: iso(recordedAt),
    day:
      typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.day)
        ? value.day
        : iso(recordedAt).slice(0, 10),
    publishedAt: iso(publishedAt),
    name: text(value.name),
    affiliateUrl: text(value.affiliateUrl),
  };
}

async function readCards(
  db: Db,
  companyId: string,
  userId: string,
  origin: string,
): Promise<TestimonialCard[]> {
  const [row] = await db.query<{ cards: CardRow[] | null }>(
    'select stayput.member_cards($1, $2) as cards',
    [companyId, userId],
  );
  return (row?.cards ?? []).flatMap((card) => cardOf(card, origin) ?? []);
}

/** The member makes the card of one of their results: its public page goes online. */
export async function makeCard(
  db: Db,
  companyId: string,
  userId: string,
  request: CardRequest,
  now: Date,
  origin: string,
): Promise<TestimonialCard | null> {
  const [row] = await db.query<{ card: CardRow | null }>(
    'select stayput.make_testimonial($1, $2, $3::uuid, $4, $5, $6::timestamptz) as card',
    [
      companyId,
      userId,
      request.resultId,
      request.showName,
      request.affiliateUrl,
      now.toISOString(),
    ],
  );
  const card = row?.card;
  return card ? cardOf({ ...card, resultId: request.resultId }, origin) : null;
}

/** The member takes a card's page down. */
export async function unpublishCard(
  db: Db,
  companyId: string,
  userId: string,
  proofId: string,
): Promise<boolean> {
  const [row] = await db.query<{ removed: boolean }>(
    'select stayput.unpublish_testimonial($1, $2, $3::uuid) as removed',
    [companyId, userId, proofId],
  );
  return row?.removed === true;
}

/** A proof's public page: what its member agreed to show, or null. */
export async function readPublicProof(
  db: Db,
  proofId: string,
): Promise<{ level: ProofLevel; display: TestimonialDisplay } | null> {
  const [row] = await db.query<{
    proof: { level: string; display: Record<string, unknown> } | null;
  }>('select stayput.public_proof($1::uuid) as proof', [proofId]);
  const proof = row?.proof;
  const display = proof ? displayOf(proof.display) : null;
  return proof && display && isProofLevel(proof.level) ? { level: proof.level, display } : null;
}

/** Where a shared milestone goes and in which words; null when the creator chose nowhere. */
async function readAnnounce(
  db: Db,
  companyId: string,
  userId: string,
): Promise<MemberSpaceView['announce']> {
  const [row] = await db.query<{
    announce: { locale: string; firstName: string | null; place: string } | null;
  }>('select stayput.member_announce($1, $2) as announce', [companyId, userId]);
  const announce = row?.announce;
  if (!announce) return null;
  return {
    locale: announce.locale === 'fr' ? 'fr' : 'en',
    firstName: announce.firstName,
    place: announce.place,
  };
}

/**
 * The member asks for their milestone to be announced (migration 0023): the action's id, or
 * `duplicate` when it was shared already, or null when it cannot be (nowhere to announce, not
 * their goal, a milestone not reached).
 */
export async function shareMilestone(
  db: Db,
  companyId: string,
  userId: string,
  share: ShareRequest,
  now: Date,
): Promise<{ id: string } | 'duplicate' | null> {
  const [row] = await db.query<{ shared: { id?: string; duplicate?: boolean } | null }>(
    'select stayput.share_milestone($1, $2, $3::uuid, $4, $5::timestamptz) as shared',
    [companyId, userId, share.goalId, share.percent, now.toISOString()],
  );
  const shared = row?.shared;
  if (!shared) return null;
  if (shared.duplicate) return 'duplicate';
  return typeof shared.id === 'string' ? { id: shared.id } : null;
}

/** A milestone to share, as the member sent it. */
export function parseShareRequest(value: unknown): ShareRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.goalId !== 'string' || !UUID.test(item.goalId)) return null;
  const percent = Number(item.percent);
  return isMilestone(percent) ? { goalId: item.goalId, percent } : null;
}

/** Where the creator chose to announce the milestones, read as the creator (under RLS). */
export async function readAnnounceTo(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<AnnounceDestination | null | undefined> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ announce_to: Record<string, unknown> | null }>(
      'select s.announce_to from stayput.company_settings s where s.company_id = $1',
      [companyId],
    ),
  );
  // undefined: no settings for this company at all.
  if (!row) return undefined;
  const target = parseAnnounceTarget(row.announce_to);
  if (!target || !row.announce_to) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return { ...target, name: text(row.announce_to.name), place: text(row.announce_to.place) };
}

export async function saveAnnounceTo(
  db: Db,
  companyId: string,
  destination: AnnounceDestination | null,
): Promise<void> {
  await db.query('select stayput.save_announce_to($1, $2::text::jsonb)', [
    companyId,
    destination ? JSON.stringify(destination) : null,
  ]);
}

/** The earned days the creator offers (null: none), and those the member received. */
async function readRewards(
  db: Db,
  companyId: string,
  userId: string,
): Promise<MemberSpaceView['rewards']> {
  const [row] = await db.query<{
    rewards: {
      offered: { at50: number; at100: number } | null;
      received: { percent: number; days: number; at: string }[];
    } | null;
  }>('select stayput.member_rewards($1, $2) as rewards', [companyId, userId]);
  const offered = row?.rewards?.offered ?? null;
  return {
    offered: offered ? { at50: Number(offered.at50), at100: Number(offered.at100) } : null,
    received: (row?.rewards?.received ?? []).flatMap((r) =>
      isMilestone(r.percent) ? [{ percent: r.percent, days: Number(r.days), at: iso(r.at) }] : [],
    ),
  };
}

/**
 * The free days the milestones just reached bring the member (migration 0022), as actions to
 * schedule: each with its days. None when the creator offers none, or the member had them.
 */
export async function planEarnedDays(
  db: Db,
  companyId: string,
  userId: string,
  goalId: string,
  milestones: readonly Milestone[],
  now: Date,
): Promise<{ id: string; days: number }[]> {
  const percents = milestones.filter((m) => m === 50 || m === 100);
  if (percents.length === 0) return [];
  const [row] = await db.query<{ actions: { id: string; days: number }[] | null }>(
    `select stayput.plan_earned_days($1, $2, $3::uuid,
                                     string_to_array($4, ',')::integer[], $5::timestamptz)
              as actions`,
    [companyId, userId, goalId, percents.join(','), now.toISOString()],
  );
  return (row?.actions ?? []).map((a) => ({ id: a.id, days: Number(a.days) }));
}

/** The earned days as the creator set them, read as the creator (under RLS). */
export async function readEarnedDays(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<EarnedDaysSettings | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ enabled: boolean | null; at50: number; at100: number }>(
      `select (s.options ->> 'earned_days')::boolean as enabled, s.earned_days_50 as at50,
              s.earned_days_100 as at100
         from stayput.company_settings s
        where s.company_id = $1`,
      [companyId],
    ),
  );
  return row ? { enabled: row.enabled === true, at50: row.at50, at100: row.at100 } : null;
}

/** The earned days the creator sent: on or off, and 0 to 14 days at each milestone. */
export function parseEarnedDays(value: unknown): EarnedDaysSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const days = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 14 ? n : null;
  const at50 = days(item.at50);
  const at100 = days(item.at100);
  if (typeof item.enabled !== 'boolean' || at50 === null || at100 === null) return null;
  return { enabled: item.enabled, at50, at100 };
}

export async function saveEarnedDays(
  db: Db,
  companyId: string,
  settings: EarnedDaysSettings,
): Promise<void> {
  await db.query('select stayput.save_earned_days($1, $2, $3, $4)', [
    companyId,
    settings.enabled,
    settings.at50,
    settings.at100,
  ]);
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

/**
 * A result on the member's goal under way, with its screenshot when one was sent: the proof
 * goes to the database only when the number recorded is on it (else the result stands as
 * declared). What it brought, or null when there is no such goal.
 */
export async function recordResult(
  db: Db,
  companyId: string,
  userId: string,
  entry: ResultEntry,
  now: Date,
): Promise<Omit<ResultAnswer, 'space' | 'earnedDays'> | null> {
  const proof = entry.proof && proofJustifies(entry.proof, entry.value) ? entry.proof : null;
  const [row] = await db.query<{
    result: { milestones?: unknown; badges?: unknown; achieved?: unknown; proof?: unknown } | null;
  }>(
    `select stayput.record_result($1, $2, $3::uuid, $4::numeric, $5::timestamptz,
                                  $6::text::jsonb) as result`,
    [
      companyId,
      userId,
      entry.goalId,
      String(entry.value),
      now.toISOString(),
      proof ? JSON.stringify(proof) : null,
    ],
  );
  const result = row?.result;
  if (!result) return null;
  const milestones = Array.isArray(result.milestones)
    ? result.milestones.map(Number).filter(isMilestone)
    : [];
  return {
    milestones,
    badges: badgesOf(result.badges),
    achieved: result.achieved === true,
    proof: !entry.proof
      ? null
      : result.proof === 'justified' || result.proof === 'duplicate'
        ? result.proof
        : 'declared',
  };
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

/** What stayput.member_buddies returns. */
interface BuddiesRow {
  optedOut: boolean;
  partners: {
    pairId: string;
    role: string;
    name: string | null;
    joinedAt: string | null;
    pairedAt: string;
    sameCategory: string | null;
  }[];
}

function buddiesOf(row: BuddiesRow): MemberBuddies {
  return {
    optedOut: row.optedOut === true,
    partners: row.partners.map((p): BuddyPartner => ({
      pairId: p.pairId,
      role: p.role === 'veteran' ? 'veteran' : 'newcomer',
      name: p.name,
      joinedAt: p.joinedAt ? iso(p.joinedAt) : null,
      pairedAt: iso(p.pairedAt),
      sameCategory: isGoalCategory(p.sameCategory) ? p.sameCategory : null,
    })),
  };
}

/** The member's buddies (SPEC Phase 5, point 8); null for someone StayPut does not know. */
export async function readBuddies(
  db: Db,
  companyId: string,
  userId: string,
): Promise<MemberBuddies | null> {
  const [row] = await db.query<{ buddies: BuddiesRow | null }>(
    'select stayput.member_buddies($1, $2) as buddies',
    [companyId, userId],
  );
  return row?.buddies ? buddiesOf(row.buddies) : null;
}

/** POST …/space/buddies: `{ optOut: boolean }`. */
export function parseBuddyOptOut(value: unknown): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const optOut = (value as Record<string, unknown>).optOut;
  return typeof optOut === 'boolean' ? optOut : null;
}

/** The member asks not to be paired (their pairs end), or may be again. */
export async function setBuddyOptOut(
  db: Db,
  companyId: string,
  userId: string,
  optOut: boolean,
  now: Date,
): Promise<MemberBuddies | null> {
  const [row] = await db.query<{ known: boolean }>(
    'select stayput.set_buddy_optout($1, $2, $3, $4::timestamptz) as known',
    [companyId, userId, optOut, now.toISOString()],
  );
  return row?.known ? readBuddies(db, companyId, userId) : null;
}

/**
 * The buddies as the creator sees them, under RLS: on or off, the pairs under way, the newcomers
 * waiting for a buddy, the veterans who can take one, the mentors. Null for a company StayPut
 * has no settings of.
 */
export async function readBuddiesView(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<BuddiesView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{
      enabled: boolean | null;
      active: number;
      waiting: number;
      veterans: number;
      mentors: number;
    }>(
      `select (s.options ->> 'buddies')::boolean as enabled,
              (select count(*) from stayput.buddy_pairs p
                where p.company_id = s.company_id and p.status = 'active')::int as active,
              (select count(*) from stayput.members m
                where m.company_id = s.company_id and m.status = 'joined'
                  and m.access_level is distinct from 'admin'
                  and not m.do_not_contact and m.buddy_optout_at is null
                  and m.joined_at > $2::timestamptz - interval '7 days'
                  and not exists (select 1 from stayput.buddy_pairs p
                                   where p.company_id = m.company_id
                                     and p.newcomer_member_id = m.id
                                     and p.status in ('active', 'completed')))::int as waiting,
              (select count(*) from stayput.members m
                 join stayput.member_risk r
                   on r.company_id = m.company_id and r.member_id = m.id and r.level = 'low'
                where m.company_id = s.company_id and m.status = 'joined'
                  and m.access_level is distinct from 'admin'
                  and not m.do_not_contact and m.buddy_optout_at is null
                  and m.joined_at <= $2::timestamptz - interval '30 days')::int as veterans,
              (select count(*) from stayput.member_badges b
                where b.company_id = s.company_id and b.badge_code = 'mentor')::int as mentors
         from stayput.company_settings s
        where s.company_id = $1`,
      [companyId, now.toISOString()],
    ),
  );
  return row
    ? {
        enabled: row.enabled === true,
        activePairs: row.active,
        waitingNewcomers: row.waiting,
        veterans: row.veterans,
        mentors: row.mentors,
      }
    : null;
}

/** PUT /api/creator/:companyId/buddies: `{ enabled: boolean }`. */
export function parseBuddiesUpdate(value: unknown): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const enabled = (value as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

export async function saveBuddies(db: Db, companyId: string, enabled: boolean): Promise<void> {
  await db.query('select stayput.save_buddies($1, $2)', [companyId, enabled]);
}

/** What stayput.member_rescues returns. */
interface RescuesRow {
  challenges: {
    id: string;
    platform: string;
    place: string | null;
    url: string | null;
    lastMessageAt: string | null;
    createdAt: string;
    helpers: number;
    joined: boolean;
  }[];
  rescued: number;
}

/** The links a challenge may open: a Discord message, a Telegram supergroup's message. */
const MESSAGE_LINK = /^https:\/\/(discord\.com\/channels\/\d+\/\d+\/\d+|t\.me\/c\/\d+\/\d+)$/;

function rescuesOf(row: RescuesRow): MemberRescues {
  return {
    challenges: row.challenges.flatMap((c): RescueChallenge[] => {
      const platform =
        c.platform === 'discord' || c.platform === 'telegram' || c.platform === 'whop'
          ? c.platform
          : null;
      if (!platform || !c.lastMessageAt) return [];
      return [
        {
          id: c.id,
          platform,
          place: c.place,
          url: c.url && MESSAGE_LINK.test(c.url) ? c.url : null,
          lastMessageAt: iso(c.lastMessageAt),
          createdAt: iso(c.createdAt),
          helpers: Number(c.helpers),
          joined: c.joined === true,
        },
      ];
    }),
    rescued: Number(row.rescued),
  };
}

/**
 * The rescue challenges a member sees (SPEC Phase 5, point 9); null while the creator has them
 * off, or for someone StayPut does not know.
 */
export async function readRescues(
  db: Db,
  companyId: string,
  userId: string,
): Promise<MemberRescues | null> {
  const [row] = await db.query<{ rescues: RescuesRow | null }>(
    'select stayput.member_rescues($1, $2) as rescues',
    [companyId, userId],
  );
  return row?.rescues ? rescuesOf(row.rescues) : null;
}

/** The member takes a challenge up; null when it is not theirs to take (or no longer open). */
export async function joinRescue(
  db: Db,
  companyId: string,
  userId: string,
  challengeId: string,
  now: Date,
): Promise<MemberRescues | null> {
  const [row] = await db.query<{ joined: boolean }>(
    'select stayput.join_rescue($1, $2, $3::uuid, $4::timestamptz) as joined',
    [companyId, userId, challengeId, now.toISOString()],
  );
  return row?.joined ? readRescues(db, companyId, userId) : null;
}

/** The hourly round of a company's challenges: ended, resolved (badges), new. */
export async function planRescues(db: Db, companyId: string, now: Date): Promise<number> {
  const [row] = await db.query<{ made: number }>(
    'select stayput.plan_rescues($1, $2::timestamptz) as made',
    [companyId, now.toISOString()],
  );
  return row?.made ?? 0;
}

/** The challenges as the creator sees them, under RLS; null without settings. */
export async function readRescuesView(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<RescuesView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ enabled: boolean | null; open: number; rescued: number; rescuers: number }>(
      `select (s.options ->> 'rescue_challenges')::boolean as enabled,
              (select count(*) from stayput.rescue_challenges r
                where r.company_id = s.company_id and r.status = 'open')::int as open,
              (select count(*) from stayput.rescue_challenges r
                where r.company_id = s.company_id and r.status = 'resolved'
                  and r.resolved_at > $2::timestamptz - interval '30 days')::int as rescued,
              (select count(*) from stayput.member_badges b
                where b.company_id = s.company_id and b.badge_code = 'rescuer')::int as rescuers
         from stayput.company_settings s
        where s.company_id = $1`,
      [companyId, now.toISOString()],
    ),
  );
  return row
    ? {
        enabled: row.enabled === true,
        open: row.open,
        rescuedLast30: row.rescued,
        rescuers: row.rescuers,
      }
    : null;
}

/** The cards the dashboard draws: the newest ones online (the count says how many in all). */
export const OVERVIEW_CARDS = 6;

/**
 * The member space for the team, every part in one place (SPEC Phase 5): goals, results and
 * badges over 30 days, the cards online (public pages already), the buddies and the challenges.
 * Read as the creator, under RLS: someone not of the team reads nothing (null).
 */
export async function readSpaceOverview(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
  options: { origin: string; whopAppId: string | null },
): Promise<SpaceOverview | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{
      buddies: boolean | null;
      rescues: boolean | null;
      goals_active: number;
      goals_achieved: number;
      results_30: number;
      justified_30: number;
      members_30: number;
      opens_30: number;
      badges_30: number;
      cards_online: number;
      cards: CardRow[] | null;
      pairs: number;
      open: number;
      rescued: number;
    }>(
      `with since as (select $2::timestamptz - interval '30 days' as at)
       select (s.options ->> 'buddies')::boolean as buddies,
              (s.options ->> 'rescue_challenges')::boolean as rescues,
              (select count(*) from stayput.goals g
                 join stayput.members m on m.company_id = g.company_id and m.id = g.member_id
                where g.company_id = c.id and g.status = 'active'
                  and m.status = 'joined')::int as goals_active,
              (select count(*) from stayput.goals g
                where g.company_id = c.id and g.status = 'achieved')::int as goals_achieved,
              (select count(*) from stayput.results r
                where r.company_id = c.id and r.recorded_at > (select at from since)
                  and r.recorded_at <= $2::timestamptz)::int as results_30,
              (select count(*) from stayput.results r
                 join stayput.proofs p on p.company_id = r.company_id and p.result_id = r.id
                where r.company_id = c.id and p.level = 'justified'
                  and r.recorded_at > (select at from since)
                  and r.recorded_at <= $2::timestamptz)::int as justified_30,
              (select count(distinct r.member_id) from stayput.results r
                where r.company_id = c.id and r.recorded_at > (select at from since)
                  and r.recorded_at <= $2::timestamptz)::int as members_30,
              (select count(distinct e.member_id) from stayput.activity_events e
                where e.company_id = c.id and e.type in ('stayput_open', 'goal_update')
                  and e.occurred_at > (select at from since)
                  and e.occurred_at <= $2::timestamptz)::int as opens_30,
              (select count(*) from stayput.member_badges b
                where b.company_id = c.id and b.awarded_at > (select at from since)
                  and b.awarded_at <= $2::timestamptz)::int as badges_30,
              (select count(*) from stayput.proofs p
                where p.company_id = c.id
                  and (p.public_display ->> 'published')::boolean is true)::int as cards_online,
              (select jsonb_agg(jsonb_build_object('proofId', x.id, 'resultId', x.result_id,
                                                   'level', x.level, 'display', x.public_display)
                                order by x.published desc, x.id)
                 from (select p.id, p.result_id, p.level, p.public_display,
                              p.public_display ->> 'publishedAt' as published
                         from stayput.proofs p
                        where p.company_id = c.id
                          and (p.public_display ->> 'published')::boolean is true
                        order by published desc, p.id
                        limit $3) x) as cards,
              (select count(*) from stayput.buddy_pairs b
                where b.company_id = c.id and b.status = 'active')::int as pairs,
              (select count(*) from stayput.rescue_challenges r
                where r.company_id = c.id and r.status = 'open')::int as open,
              (select count(*) from stayput.rescue_challenges r
                where r.company_id = c.id and r.status = 'resolved'
                  and r.resolved_at > (select at from since))::int as rescued
         from stayput.companies c
         left join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId, now.toISOString(), OVERVIEW_CARDS],
    ),
  );
  if (!row) return null;
  return {
    goals: { active: row.goals_active, achieved: row.goals_achieved },
    results: {
      last30: row.results_30,
      justified30: row.justified_30,
      members30: row.members_30,
    },
    opens30: row.opens_30,
    badges30: row.badges_30,
    cards: {
      online: row.cards_online,
      latest: (row.cards ?? []).flatMap((card) => cardOf(card, options.origin) ?? []),
    },
    buddies: { enabled: row.buddies === true, activePairs: row.pairs },
    rescues: { enabled: row.rescues === true, open: row.open, rescuedLast30: row.rescued },
    whopAppId: options.whopAppId,
  };
}

/** PUT /api/creator/:companyId/rescues: `{ enabled: boolean }`. */
export function parseRescuesUpdate(value: unknown): boolean | null {
  return parseBuddiesUpdate(value);
}

export async function saveRescues(db: Db, companyId: string, enabled: boolean): Promise<void> {
  await db.query('select stayput.save_rescues($1, $2)', [companyId, enabled]);
}
