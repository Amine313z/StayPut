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
}

export interface RiskSettings {
  weights: RiskWeights;
  recencyThresholdDays: number;
  mediumFrom: number;
  highFrom: number;
  /** The creator has courses or goals: progress counts (P is 0 otherwise). */
  tracksProgress: boolean;
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
  | { code: 'reactions_drop'; percent: number };

export interface RiskResult {
  score: number;
  level: RiskLevel;
  subScores: SubScores;
  /** The two main reasons, the first one weighing most. */
  reasons: RiskReason[];
  /** Joined 3 to 7 days ago and has done nothing since (the activation radar). */
  inactiveNewcomer: boolean;
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
  const scheduled = inputs.cancelAtPeriodEnd;
  const score = scheduled ? 100 : Math.round(clamp(total) * 100);
  const level: RiskLevel = scheduled
    ? 'scheduled_departure'
    : score >= settings.highFrom
      ? 'high'
      : score >= settings.mediumFrom
        ? 'medium'
        : 'low';

  // The reasons: what weighs most in the score, a scheduled departure first.
  const ranked = RISK_FACTORS.map((f) => ({ factor: f, weight: weights[f] * subScores[f] }))
    .filter((r) => r.weight * 100 >= REASON_MIN_POINTS)
    .sort(
      (a, b) =>
        b.weight - a.weight || RISK_FACTORS.indexOf(a.factor) - RISK_FACTORS.indexOf(b.factor),
    );
  if (scheduled) {
    const paymentAt = ranked.findIndex((r) => r.factor === 'payment');
    const [entry] = paymentAt >= 0 ? ranked.splice(paymentAt, 1) : [];
    ranked.unshift(entry ?? { factor: 'payment', weight: 1 });
  }
  // « No activity for 0 days » says nothing: a reason counted in days needs one day at least.
  const reasons = ranked
    .map((r) => reasonFor(r.factor, inputs, now, weeklyAverage))
    .filter((r) => !('days' in r) || r.days >= 1)
    .slice(0, 2);

  return {
    score,
    level,
    subScores,
    reasons,
    inactiveNewcomer: isInactiveNewcomer(inputs, now),
  };
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
