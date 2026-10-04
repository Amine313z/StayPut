/**
 * The risk score (SPEC Phase 3): how likely a member is to leave, from 0 to 100, as five
 * sub-scores between 0 and 1 weighted by the creator's settings. Pure functions: the database
 * gathers each member's figures (risk_features), these decide; times are milliseconds since the
 * epoch, so that no date is parsed for thousands of members.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'scheduled_departure';

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'scheduled_departure'];

export interface RiskWeights {
  recency: number;
  frequency: number;
  progress: number;
  payment: number;
  friction: number;
}

export type SubScores = RiskWeights;

export const RISK_FACTORS: readonly (keyof RiskWeights)[] = [
  'recency',
  'frequency',
  'progress',
  'payment',
  'friction',
];

export const DEFAULT_WEIGHTS: RiskWeights = {
  recency: 0.3,
  frequency: 0.25,
  progress: 0.2,
  payment: 0.15,
  friction: 0.1,
};

export const DEFAULT_RECENCY_THRESHOLD_DAYS = 14;
export const DEFAULT_MEDIUM_FROM = 40;
export const DEFAULT_HIGH_FROM = 70;

export type Niche =
  | 'trading'
  | 'fitness'
  | 'online_business'
  | 'coaching'
  | 'ecommerce'
  | 'personal_development'
  | 'other';

export const NICHES: readonly Niche[] = [
  'trading',
  'fitness',
  'online_business',
  'coaching',
  'ecommerce',
  'personal_development',
  'other',
];

export function isNiche(value: unknown): value is Niche {
  return typeof value === 'string' && (NICHES as readonly string[]).includes(value);
}

/** The settings a niche starts with (SPEC Phase 3), applied at onboarding, changeable. */
export const NICHE_PRESETS: Readonly<
  Record<Niche, { weights: RiskWeights; recencyThresholdDays: number }>
> = {
  trading: {
    weights: { recency: 0.35, frequency: 0.3, progress: 0.1, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 7,
  },
  fitness: {
    weights: { recency: 0.25, frequency: 0.2, progress: 0.3, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 10,
  },
  online_business: {
    weights: { recency: 0.3, frequency: 0.2, progress: 0.25, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 14,
  },
  coaching: {
    weights: { recency: 0.25, frequency: 0.2, progress: 0.25, payment: 0.15, friction: 0.15 },
    recencyThresholdDays: 14,
  },
  ecommerce: {
    weights: { recency: 0.3, frequency: 0.2, progress: 0.25, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 14,
  },
  personal_development: {
    weights: { recency: 0.25, frequency: 0.25, progress: 0.25, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 14,
  },
  other: { weights: DEFAULT_WEIGHTS, recencyThresholdDays: 14 },
};

/**
 * Weights as the database keeps them: none negative, three decimals, summing to exactly 1 (the
 * largest absorbs the rounding). All zero gives the default weights back.
 */
export function normalizeWeights(weights: RiskWeights): RiskWeights {
  const clean = RISK_FACTORS.map((f) => {
    const value = weights[f];
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = clean.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  const rounded = clean.map((value) => Math.round((value / total) * 1000) / 1000);
  const largest = rounded.indexOf(Math.max(...rounded));
  const rest = rounded.reduce((sum, value, i) => (i === largest ? sum : sum + value), 0);
  rounded[largest] = Math.round((1 - rest) * 1000) / 1000;
  return Object.fromEntries(RISK_FACTORS.map((f, i) => [f, rounded[i]])) as unknown as RiskWeights;
}

export type PaymentState = 'ok' | 'failed' | 'action_required';

/** What the database knows of a member for the score. Times: milliseconds since the epoch. */
export interface RiskInputs {
  joinedAt: number | null;
  /** The last thing the member did: StayPut's events or Whop's last action, the latest. */
  lastActivityAt: number | null;
  /** Messages, reactions, posts, lessons and StayPut actions over the last 7 days. */
  activity7d: number;
  /** The same over the 28 days before those 7. */
  activityPrev28d: number;
  /** The last lesson completed or goal update. */
  lastProgressAt: number | null;
  /** The title of the last lesson completed, for the reason. */
  lastLessonTitle: string | null;
  payment: PaymentState;
  /** A live membership is set to end at the close of its period. */
  cancelAtPeriodEnd: boolean;
  /** When that cancellation takes effect. */
  cancelAt: number | null;
  /** Since when the oldest support ticket still open has waited for an answer. */
  openTicketSince: number | null;
  reactions14d: number;
  reactionsPrev14d: number;
  /** Anything recorded since the member joined (messages, reactions, lessons…). */
  activeSinceJoin: boolean;
  /** Their messages on Discord and Telegram, for the platforms' signals (none: nothing holds). */
  platforms?: Partial<Record<SignalPlatform, PlatformInputs>>;
}

export interface RiskSettings {
  weights: RiskWeights;
  recencyThresholdDays: number;
  mediumFrom: number;
  highFrom: number;
  /** The creator has courses or goals: progress counts (P is 0 otherwise). */
  tracksProgress: boolean;
  /** Each platform's signals as saved (any shape: the defaults complete it, platformSignals). */
  platformSignals?: unknown;
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  weights: DEFAULT_WEIGHTS,
  recencyThresholdDays: DEFAULT_RECENCY_THRESHOLD_DAYS,
  mediumFrom: DEFAULT_MEDIUM_FROM,
  highFrom: DEFAULT_HIGH_FROM,
  tracksProgress: true,
};

/**
 * Why a member is at risk, as a code and its figures: the dashboard words it in the creator's
 * language (« Aucune activité depuis 12 jours »).
 */
export type RiskReason =
  | { code: 'inactive'; days: number }
  | { code: 'never_active'; days: number }
  | { code: 'activity_drop'; percent: number }
  | { code: 'no_progress'; days: number; lesson: string | null }
  | { code: 'payment_failed' }
  | { code: 'payment_action_required' }
  | { code: 'cancel_scheduled'; date: string | null }
  | { code: 'ticket_open'; days: number }
  | { code: 'reactions_drop'; percent: number }
  | { code: 'platform_silent'; platform: SignalPlatform; days: number }
  | { code: 'platform_drop'; platform: SignalPlatform; percent: number }
  | { code: 'platform_left'; platform: SignalPlatform };

export interface RiskResult {
  score: number;
  level: RiskLevel;
  subScores: SubScores;
  /** The two main reasons, the first one weighing most. */
  reasons: RiskReason[];
  /** Joined 3 to 7 days ago and has done nothing since (the activation radar). */
  inactiveNewcomer: boolean;
  /** What the score was made of beyond its five factors (member_risk.signals). */
  making: ScoreMaking;
}

/**
 * A score's making beyond its five factors, kept beside it: the dashboards preview from it the
 * score other signal settings would give, without computing anything again (scoreWithSignals).
 */
export interface ScoreMaking {
  /** The score of the five factors, before any signal's points and the two rules. */
  base: number;
  /** The signals that hold for the member there, as bits (SIGNAL_BITS), on or off. */
  discord: number;
  telegram: number;
  /** 1: a departure is scheduled (100); 2: a payment failed (high at least); 0: neither. */
  rule: 0 | 1 | 2;
}

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** P reaches 1 after this many days without a lesson or a goal update. */
export const PROGRESS_THRESHOLD_DAYS = 21;
/** A support ticket open for longer counts as friction. */
export const TICKET_FRICTION_HOURS = 48;
/** Reactions down by more than this share over 14 days count as friction… */
export const REACTION_DROP = 0.5;
/** …when there were at least this many reactions the 14 days before (a 1 → 0 says nothing). */
export const REACTION_BASELINE_MIN = 2;
/** A factor adding fewer points than this to the score is not worth a reason. */
export const REASON_MIN_POINTS = 3;
/** The activation radar: members who joined less than 7 days ago… */
export const NEWCOMER_DAYS = 7;
/** …and did nothing in the 72 hours after. */
export const NEWCOMER_GRACE_HOURS = 72;

/** Discord or Telegram: where a platform's signals come from. */
export type SignalPlatform = 'discord' | 'telegram';

export const SIGNAL_PLATFORMS: readonly SignalPlatform[] = ['discord', 'telegram'];

/**
 * What a platform says of a member (brief v4 §9.6, Integrations › Discord and › Telegram): gone
 * quiet there (they wrote there in the 4 weeks before this one, nothing this week), writes less
 * (still writes, but under half their weekly average of those 4 weeks, 2 a week at least), left
 * (the server or the group, within 30 days; StayPut sees it on the server's member list and in
 * the group's service messages). Each adds the points the creator gives it to the score of the
 * five factors, 30 at most; off until the creator turns it on.
 */
export type PlatformSignalId = 'silent' | 'drop' | 'left';

export const PLATFORM_SIGNALS: readonly PlatformSignalId[] = ['silent', 'drop', 'left'];

export interface PlatformSignal {
  on: boolean;
  /** Points added to the score while the signal holds, 0 to SIGNAL_POINTS_MAX. */
  points: number;
}

export type PlatformSignals = Record<PlatformSignalId, PlatformSignal>;

export const SIGNAL_POINTS_MAX = 30;

export const DEFAULT_PLATFORM_SIGNALS: PlatformSignals = {
  silent: { on: false, points: 10 },
  drop: { on: false, points: 5 },
  left: { on: false, points: 20 },
};

/** Each signal's bit in a score's making (ScoreMaking). */
export const SIGNAL_BITS: Readonly<Record<PlatformSignalId, number>> = {
  silent: 1,
  drop: 2,
  left: 4,
};

/** « Writes less »: from this weekly average of the 4 weeks before (a 1 → 0 says nothing)… */
export const SIGNAL_DROP_MIN_WEEKLY = 2;
/** …this week under this share of it. */
export const SIGNAL_DROP_SHARE = 0.5;
/** « Left »: for this many days after leaving. */
export const SIGNAL_LEFT_DAYS = 30;

/** A member's messages on a platform, as risk_features gives them. */
export interface PlatformInputs {
  /** Over the last 7 days of the company's calendar. */
  week: number;
  /** Over the 28 days before. */
  before: number;
  /** The last one of those 5 weeks. */
  lastAt: number | null;
  /** They left the platform's servers or groups of the community they were in, the last then. */
  leftAt: number | null;
}

/** One signal as saved, or null when it is not one. */
function signalOf(value: unknown): PlatformSignal | null {
  if (typeof value !== 'object' || value === null) return null;
  const { on, points } = value as Record<string, unknown>;
  if (typeof on !== 'boolean' || typeof points !== 'number' || !Number.isInteger(points)) {
    return null;
  }
  if (points < 0 || points > SIGNAL_POINTS_MAX) return null;
  return { on, points };
}

/**
 * A platform's signals exactly as the API takes them (all three, each `{on, points}` with whole
 * points from 0 to 30), or null.
 */
export function parsePlatformSignals(value: unknown): PlatformSignals | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const parsed = PLATFORM_SIGNALS.map((id) => [id, signalOf(record[id])] as const);
  if (parsed.some(([, signal]) => signal === null)) return null;
  return Object.fromEntries(parsed) as unknown as PlatformSignals;
}

/** A platform's signals as saved (any shape), each completed with the defaults. */
export function platformSignals(saved: unknown): PlatformSignals {
  const record =
    typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {};
  return Object.fromEntries(
    PLATFORM_SIGNALS.map((id) => [id, signalOf(record[id]) ?? { ...DEFAULT_PLATFORM_SIGNALS[id] }]),
  ) as unknown as PlatformSignals;
}

/** Both platforms' signals as saved (company_settings.platform_signals), with the defaults. */
export function allPlatformSignals(saved: unknown): Record<SignalPlatform, PlatformSignals> {
  const record =
    typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {};
  return { discord: platformSignals(record.discord), telegram: platformSignals(record.telegram) };
}

/**
 * The signals that hold for a member on a platform, on or off. Leaving says more than going
 * quiet: a member who left counts as having left only.
 */
export function firedSignals(inputs: PlatformInputs, now: number): PlatformSignalId[] {
  if (inputs.leftAt !== null && now - inputs.leftAt <= SIGNAL_LEFT_DAYS * DAY_MS) return ['left'];
  if (inputs.week === 0) return inputs.before > 0 ? ['silent'] : [];
  const weekly = inputs.before / 4;
  return weekly >= SIGNAL_DROP_MIN_WEEKLY && inputs.week < weekly * SIGNAL_DROP_SHARE
    ? ['drop']
    : [];
}

function signalBits(ids: readonly PlatformSignalId[]): number {
  return ids.reduce((bits, id) => bits | SIGNAL_BITS[id], 0);
}

/** A signal's reason, in a member's two main reasons when its points weigh enough. */
function signalReason(
  id: PlatformSignalId,
  platform: SignalPlatform,
  inputs: PlatformInputs,
  now: number,
): RiskReason {
  switch (id) {
    case 'left':
      return { code: 'platform_left', platform };
    case 'silent':
      return {
        code: 'platform_silent',
        platform,
        days: inputs.lastAt === null ? 7 : Math.max(7, days(now - inputs.lastAt)),
      };
    case 'drop':
      return {
        code: 'platform_drop',
        platform,
        percent: Math.round((1 - inputs.week / (inputs.before / 4)) * 100),
      };
  }
}

/** The signals on that hold for a member, each with its reason and the share it adds. */
function weighedSignals(
  platforms: RiskInputs['platforms'],
  signals: Readonly<Record<SignalPlatform, PlatformSignals>>,
  now: number,
): { weight: number; reason: RiskReason }[] {
  const weighed: { weight: number; reason: RiskReason }[] = [];
  for (const platform of SIGNAL_PLATFORMS) {
    const there = platforms?.[platform];
    if (!there) continue;
    for (const id of firedSignals(there, now)) {
      const signal = signals[platform][id];
      if (signal.on && signal.points > 0) {
        weighed.push({
          weight: signal.points / 100,
          reason: signalReason(id, platform, there, now),
        });
      }
    }
  }
  return weighed;
}

/**
 * The reasons of the signals on that hold for a member, the heaviest first, as computeRisk names
 * them beside the five factors' (the demo words its members' new reasons with it).
 */
export function signalReasons(
  platforms: RiskInputs['platforms'],
  signals: Readonly<Record<SignalPlatform, PlatformSignals>>,
  now: number,
): RiskReason[] {
  return weighedSignals(platforms, signals, now)
    .map((s, order) => ({ ...s, order }))
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .map((s) => s.reason);
}

/**
 * The score a member's making gives with these signals: the base, plus the points of the signals
 * on that hold for them (100 at most); a scheduled departure is 100, a failed payment high at
 * least (the two rules of computeRisk).
 */
export function scoreWithSignals(
  making: Pick<ScoreMaking, 'base' | 'discord' | 'telegram' | 'rule'>,
  signals: Readonly<Record<SignalPlatform, PlatformSignals>>,
  highFrom: number,
): number {
  if (making.rule === 1) return 100;
  let score = making.base;
  for (const platform of SIGNAL_PLATFORMS) {
    const bits = making[platform];
    for (const id of PLATFORM_SIGNALS) {
      const signal = signals[platform][id];
      if (signal.on && (bits & SIGNAL_BITS[id]) !== 0) score += signal.points;
    }
  }
  score = Math.min(100, score);
  return making.rule === 2 ? Math.max(score, highFrom) : score;
}

/** Members whose scores were made alike, and how many they are (the dashboards' preview). */
export interface ScoreGroup {
  base: number;
  discord: number;
  telegram: number;
  rule: number;
  count: number;
}

export interface ScoreDistribution {
  /** How many members score 0–9, 10–19, … 90–100. */
  bins: number[];
  levels: Record<RiskLevel, number>;
}

/** The scores' distribution these signals would give, from the members' makings. */
export function scoreDistribution(
  groups: readonly ScoreGroup[],
  signals: Readonly<Record<SignalPlatform, PlatformSignals>>,
  thresholds: { mediumFrom: number; highFrom: number },
): ScoreDistribution {
  const bins = Array.from({ length: 10 }, () => 0);
  const levels: Record<RiskLevel, number> = {
    low: 0,
    medium: 0,
    high: 0,
    scheduled_departure: 0,
  };
  for (const group of groups) {
    const rule = group.rule === 1 ? 1 : group.rule === 2 ? 2 : 0;
    const score = scoreWithSignals({ ...group, rule }, signals, thresholds.highFrom);
    bins[Math.min(9, Math.floor(score / 10))]! += group.count;
    const level: RiskLevel =
      rule === 1
        ? 'scheduled_departure'
        : score >= thresholds.highFrom
          ? 'high'
          : score >= thresholds.mediumFrom
            ? 'medium'
            : 'low';
    levels[level] += group.count;
  }
  return { bins, levels };
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const days = (ms: number) => Math.max(0, Math.floor(ms / DAY_MS));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The member's score, its level and its two main reasons. */
export function computeRisk(inputs: RiskInputs, settings: RiskSettings, now: number): RiskResult {
  const weights = normalizeWeights(settings.weights);
  const threshold = Math.max(1, settings.recencyThresholdDays);

  // Recency: since the last activity, or since joining for someone who never did anything.
  const since = inputs.lastActivityAt ?? inputs.joinedAt;
  const recency = since === null ? 0 : clamp((now - since) / DAY_MS / threshold);

  // Frequency: this week against the weekly average of the 4 weeks before. No average, no
  // signal: recency and the activation radar cover those members.
  const weeklyAverage = inputs.activityPrev28d / 4;
  const frequency = weeklyAverage > 0 ? clamp(1 - inputs.activity7d / weeklyAverage) : 0;

  // Progress: only for a creator with courses or goals.
  const progressSince = inputs.lastProgressAt ?? inputs.joinedAt;
  const progress =
    settings.tracksProgress && progressSince !== null
      ? clamp((now - progressSince) / DAY_MS / PROGRESS_THRESHOLD_DAYS)
      : 0;

  const payment =
    inputs.payment === 'failed' || inputs.cancelAtPeriodEnd
      ? 1
      : inputs.payment === 'action_required'
        ? 0.7
        : 0;

  const ticketOpen =
    inputs.openTicketSince !== null &&
    now - inputs.openTicketSince > TICKET_FRICTION_HOURS * HOUR_MS;
  const reactionsDropped =
    inputs.reactionsPrev14d >= REACTION_BASELINE_MIN &&
    inputs.reactions14d < (1 - REACTION_DROP) * inputs.reactionsPrev14d;
  const friction = ticketOpen ? 1 : reactionsDropped ? 0.5 : 0;

  const subScores: SubScores = {
    recency: round3(recency),
    frequency: round3(frequency),
    progress: round3(progress),
    payment: round3(payment),
    friction: round3(friction),
  };
  const total = RISK_FACTORS.reduce((sum, f) => sum + weights[f] * subScores[f], 0);
  const computed = Math.round(clamp(total) * 100);
  // The platforms' signals (brief v4 §9.6): those that hold for the member, and the points of
  // the ones the creator turned on.
  const making: ScoreMaking = { base: computed, discord: 0, telegram: 0, rule: 0 };
  const signals = allPlatformSignals(settings.platformSignals);
  for (const platform of SIGNAL_PLATFORMS) {
    const there = inputs.platforms?.[platform];
    if (there) making[platform] = signalBits(firedSignals(there, now));
  }
  const signalReasons = weighedSignals(inputs.platforms, signals, now);
  // Two rules come before the weights. A scheduled cancellation is 100 and its own status. A
  // failed or overdue payment is a high risk at least, however active the member: a card that
  // does not go through cuts the access (founder's decision, 2026-10-01).
  const scheduled = inputs.cancelAtPeriodEnd;
  const unpaid = inputs.payment === 'failed';
  making.rule = scheduled ? 1 : unpaid ? 2 : 0;
  const score = scoreWithSignals(making, signals, settings.highFrom);
  const level: RiskLevel = scheduled
    ? 'scheduled_departure'
    : score >= settings.highFrom
      ? 'high'
      : score >= settings.mediumFrom
        ? 'medium'
        : 'low';

  // The reasons: those two facts first, then what weighs most in the score.
  const facts: RiskReason[] = [];
  if (scheduled) facts.push(reasonFor('payment', inputs, now, weeklyAverage));
  if (unpaid) facts.push({ code: 'payment_failed' });
  // The factors and the signals on, by what they add to the score (a factor first on a tie).
  const ranked: {
    factor: keyof RiskWeights | null;
    reason: RiskReason | null;
    weight: number;
    order: number;
  }[] = [
    ...RISK_FACTORS.map((f, order) => ({
      factor: f,
      reason: null,
      weight: weights[f] * subScores[f],
      order,
    })),
    ...signalReasons.map((s, i) => ({
      factor: null,
      reason: s.reason,
      weight: s.weight,
      order: RISK_FACTORS.length + i,
    })),
  ]
    .filter((r) => r.weight * 100 >= REASON_MIN_POINTS)
    .filter((r) => facts.length === 0 || r.factor !== 'payment')
    .sort((a, b) => b.weight - a.weight || a.order - b.order);
  // « No activity for 0 days » says nothing: a reason counted in days needs one day at least.
  const candidates = ranked
    .map((r) => r.reason ?? reasonFor(r.factor!, inputs, now, weeklyAverage))
    .filter((r) => !('days' in r) || r.days >= 1);
  const reasons = [...facts, ...consistent(candidates)].slice(0, 2);

  return {
    score,
    level,
    subScores,
    reasons,
    inactiveNewcomer: isInactiveNewcomer(inputs, now),
    making,
  };
}

/**
 * Two reasons must not say the same thing twice, nor contradict each other. Inactive for a week
 * or more already says there was no activity this week. And a member with no activity this week
 * whose last sign of life is more recent only came by (the recency counts Whop's visits): « no
 * activity this week » is the truer of the two.
 */
function consistent(reasons: RiskReason[]): RiskReason[] {
  const inactiveDays = reasons.find((r) => r.code === 'inactive')?.days;
  const silentWeek = reasons.some((r) => r.code === 'activity_drop' && r.percent >= 100);
  return reasons.filter((r) => {
    if (r.code === 'activity_drop') return inactiveDays === undefined || inactiveDays < 7;
    if (r.code === 'inactive') return !silentWeek || r.days >= 7;
    // Inactive everywhere already says they went quiet on Discord or Telegram.
    if (r.code === 'platform_silent') return inactiveDays === undefined;
    return true;
  });
}

function reasonFor(
  factor: keyof RiskWeights,
  inputs: RiskInputs,
  now: number,
  weeklyAverage: number,
): RiskReason {
  switch (factor) {
    case 'recency':
      return inputs.lastActivityAt === null
        ? { code: 'never_active', days: days(now - (inputs.joinedAt ?? now)) }
        : { code: 'inactive', days: days(now - inputs.lastActivityAt) };
    case 'frequency':
      return {
        code: 'activity_drop',
        percent: Math.round(clamp(1 - inputs.activity7d / weeklyAverage) * 100),
      };
    case 'progress':
      return {
        code: 'no_progress',
        days: days(now - (inputs.lastProgressAt ?? inputs.joinedAt ?? now)),
        lesson: inputs.lastProgressAt === null ? null : inputs.lastLessonTitle,
      };
    case 'payment':
      if (inputs.cancelAtPeriodEnd) {
        return {
          code: 'cancel_scheduled',
          date: inputs.cancelAt === null ? null : new Date(inputs.cancelAt).toISOString(),
        };
      }
      return inputs.payment === 'failed'
        ? { code: 'payment_failed' }
        : { code: 'payment_action_required' };
    case 'friction':
      if (
        inputs.openTicketSince !== null &&
        now - inputs.openTicketSince > TICKET_FRICTION_HOURS * HOUR_MS
      ) {
        return { code: 'ticket_open', days: days(now - inputs.openTicketSince) };
      }
      return {
        code: 'reactions_drop',
        percent: Math.round((1 - inputs.reactions14d / inputs.reactionsPrev14d) * 100),
      };
  }
}

/**
 * The activation radar (SPEC Phase 3): a member who joined less than 7 days ago and did nothing
 * in the 72 hours since gets the welcome action (Phase 4).
 */
export function isInactiveNewcomer(inputs: RiskInputs, now: number): boolean {
  if (inputs.joinedAt === null || inputs.activeSinceJoin) return false;
  const age = now - inputs.joinedAt;
  return age >= NEWCOMER_GRACE_HOURS * HOUR_MS && age < NEWCOMER_DAYS * DAY_MS;
}
