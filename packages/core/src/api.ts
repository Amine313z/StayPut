import type { AccessLevel } from './access';
import type { CohortHorizon } from './analyses';
import type { Niche, RiskLevel, RiskReason, RiskWeights } from './risk';

/**
 * The shapes the Worker's API returns and the frontend reads. Both sides import them from here,
 * so a change to one breaks the build of the other instead of a screen at runtime.
 */

/** Every error response: a stable code the frontend maps to a translated message. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /**
     * With `unauthenticated`, when "Sign in with Whop" outside the iframe is on (sandbox): where
     * to send the browser, with `?next=` the page to come back to.
     */
    login?: string;
  };
}

/**
 * Changing /api requests carry this header: a page of another site cannot set it, so a browser
 * signed in with Whop (sandbox) cannot be made to send them (the Worker checks it).
 */
export const CSRF_HEADER = 'x-stayput-csrf';

/** How the user reached StayPut: Whop's iframe token, or signing in with Whop outside it. */
export type SignInMethod = 'iframe' | 'login';

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  | 'not_found'
  | 'payload_too_large'
  | 'whop_unavailable'
  | 'not_configured'
  | 'internal';

/** GET /api/creator/:companyId/session */
export interface CreatorSession {
  companyId: string;
  userId: string;
  accessLevel: AccessLevel;
  via: SignInMethod;
}

/** GET /api/member/:experienceId/session */
export interface MemberSession {
  experienceId: string;
  userId: string;
  accessLevel: AccessLevel;
  via: SignInMethod;
}

/** GET /api/creator/:companyId/sync: how far StayPut has read the company's Whop data. */
export interface SyncStatus {
  /** Every list was read once: the 90-day history is in (the backfill). */
  backfillDone: boolean;
  /** The last time StayPut read from Whop for this company. */
  lastSyncAt: string | null;
  streams: SyncStreamStatus[];
}

export interface SyncStreamStatus {
  /** `members`, `payments`… or `messages:<channel id>`. */
  stream: string;
  backfillDone: boolean;
  /** A reading under way, to go on at the next run. */
  inProgress: boolean;
  lastPassAt: string | null;
  /** HTTP status and message of the last failure, while it is the latest news. */
  error: string | null;
}

/** POST /api/creator/:companyId/sync: reads what is due now, then the status. */
export interface SyncRun extends SyncStatus {
  /** False when another reading was under way, or one ended less than a minute ago. */
  ran: boolean;
  /** Calls made to Whop. */
  calls: number;
}

/** GET /api/creator/:companyId/members */
export interface MembersPage {
  summary: MembersSummary;
  members: MemberRow[];
  /** More members than the page shows. */
  truncated: boolean;
}

export interface MembersSummary {
  /** Members in the community now (status `joined`), the team aside. */
  members: number;
  /** Memberships that still give access (LIVE_MEMBERSHIP_STATUSES). */
  liveMemberships: number;
  /** Live memberships set to end at the close of the period. */
  scheduledCancellations: number;
  /** Members whose latest payment failed (FAILED_PAYMENT_STATUSES). */
  failedPayments: number;
  /**
   * What the members did over the last 30 days, the team aside: messages (Whop, Discord,
   * Telegram), reactions, forum posts and lessons completed.
   */
  activity30d: number;
  /** The monthly revenue of the memberships still paying; null when there is none. */
  revenue: RevenueSummary | null;
  /** How many members are at each risk level, and when the scores were last computed. */
  risk: RiskSummary;
}

/**
 * Recurring memberships still paying (active, overdue, or set to end), the team aside, brought
 * back to a month: a year counts for a twelfth, a week for 52 twelfths. In the currency that
 * brings the most; the others are left out of both figures.
 */
export interface RevenueSummary {
  /** ISO code, upper case (`USD`). */
  currency: string;
  monthly: number;
  /** Of it, what the members at high risk or about to leave pay. */
  atRisk: number;
  /** Memberships in other currencies exist (and are not counted here). */
  otherCurrencies: boolean;
}

export interface RiskSummary {
  high: number;
  medium: number;
  low: number;
  scheduledDeparture: number;
  /** Members of 3 to 7 days who did nothing yet (the activation radar). */
  inactiveNewcomers: number;
  /** The latest computation; null before the first one. */
  computedAt: string | null;
}

/** A member's risk score (SPEC Phase 3), for the team only: never shown to the member. */
export interface MemberRisk {
  score: number;
  level: RiskLevel;
  /** The two main reasons, the first one weighing most. */
  reasons: RiskReason[];
  inactiveNewcomer: boolean;
  computedAt: string;
}

export interface MemberRow {
  id: string;
  name: string | null;
  status: 'joined' | 'left';
  accessLevel: AccessLevel | null;
  joinedAt: string | null;
  /** Whop's last action of the member anywhere in the community. */
  lastActionAt: string | null;
  /** The last activity StayPut recorded (message, reaction, post, lesson, ticket). */
  lastActivityAt: string | null;
  /** Last 30 days. */
  activity: { messages: number; reactions: number; posts: number; lessons: number };
  /** Null until the first computation, and for the team. */
  risk: MemberRisk | null;
  membership: {
    status: string;
    price: number | null;
    currency: string | null;
    billingPeriodDays: number | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  } | null;
  lastPayment: {
    status: string;
    amount: number;
    currency: string;
    at: string;
    failureReason: string | null;
  } | null;
}

/**
 * GET /api/creator/:companyId/integrations: the activity sources beside Whop (SPEC Phase 2, 5,
 * and the Telegram decision of 2026-10-01).
 */
export interface IntegrationsStatus {
  discord: DiscordStatus;
  telegram: TelegramStatus;
  /** The app's id on Whop: a link is opened through Whop's frame with it (openExternalUrl). */
  whopAppId: string | null;
}

/** A link made for this company, valid for a while (ISO date). */
export interface ExpiringLink {
  url: string;
  expiresAt: string;
}

export interface DiscordStatus {
  /** The Discord module is set up on this StayPut (the bot's token and client secret). */
  available: boolean;
  /** Discord's page that adds the bot to a server for this company; null when unavailable. */
  install: ExpiringLink | null;
  servers: DiscordServerStatus[];
  /** Members whose Discord account StayPut knows: the one linked on their Whop profile. */
  linkedMembers: number;
  /** Discord accounts that wrote in the last 7 days and that no member linked. */
  unlinkedAuthors: number;
}

export interface DiscordServerStatus {
  guildId: string;
  name: string | null;
  connectedAt: string;
  /** The channels StayPut reads. */
  channels: DiscordChannelStatus[];
}

export interface DiscordChannelStatus {
  id: string;
  /** The 90-day history is read. */
  backfillDone: boolean;
  lastReadAt: string | null;
  /** HTTP status and message of the last failure (403: the bot cannot read the channel). */
  error: string | null;
}

/** GET (and PUT) /api/creator/:companyId/discord/:guildId/channels */
export interface DiscordChannelChoice {
  id: string;
  name: string;
  /** The category the channel is filed under on Discord. */
  category: string | null;
  /** StayPut's bot can see the channel and read its history. */
  readable: boolean;
  followed: boolean;
}

/** PUT /api/creator/:companyId/discord/:guildId/channels */
export interface DiscordChannelsUpdate {
  channelIds: string[];
}

export interface TelegramStatus {
  /** The Telegram module is set up on this StayPut (the bot's token). */
  available: boolean;
  /** The link that adds the bot to a group for this company; null when unavailable. */
  addToGroup: ExpiringLink | null;
  /**
   * The bot receives every message of its groups (privacy mode off). Off, it only sees the
   * commands meant for it: nothing would count.
   */
  readsAllMessages: boolean;
  groups: TelegramGroupStatus[];
  /** Members who linked their Telegram account from StayPut. */
  linkedMembers: number;
  /** Telegram accounts that wrote in the last 7 days and that no member linked. */
  unlinkedAuthors: number;
}

export interface TelegramGroupStatus {
  chatId: string;
  title: string | null;
  connectedAt: string;
  /** False once the bot was removed from the group. */
  active: boolean;
  /** The last message the group sent StayPut. */
  lastMessageAt: string | null;
}

/** GET /api/member/:experienceId/telegram: linking one's Telegram account (member view). */
export interface MemberTelegramStatus {
  /** The community connected a Telegram group, and the module is set up. */
  available: boolean;
  linked: boolean;
  /** The link to open in Telegram to link the account; null when not available. */
  link: ExpiringLink | null;
  whopAppId: string | null;
}

/** GET /api/creator/:companyId/insights: the weekly analyses (SPEC Phase 3). */
export interface InsightsReport {
  /** When the analyses last ran; null before the first time. */
  computedAt: string | null;
  cohorts: CohortRow[];
  /** The creator's average departure rate per horizon (30, 60, 90 days). */
  averages: Record<CohortHorizon, number | null>;
  /** Lessons members stall after, the flagged ones first. */
  lessons: LessonRow[];
}

export interface CohortRow {
  /** First day of the month of arrival. */
  month: string;
  members: number;
  /** Departure rate per horizon; null while no member is old enough. */
  rates: Record<CohortHorizon, number | null>;
  alertHorizon: CohortHorizon | null;
}

export interface LessonRow {
  lessonId: string;
  courseId: string;
  title: string | null;
  /** Members who completed the lesson. */
  reached: number;
  /** Of them, those who stalled right after it. */
  stalled: number;
  rate: number;
  courseAverage: number;
  flagged: boolean;
}

/** GET and PUT /api/creator/:companyId/settings/risk: how the score is computed. */
export interface RiskSettingsView {
  niche: Niche;
  /** Summing to 1 (the server normalizes what it receives). */
  weights: RiskWeights;
  recencyThresholdDays: number;
  mediumFrom: number;
  highFrom: number;
}

/** GET /health */
export interface HealthReport {
  status: 'ok' | 'degraded';
  whopEnv: 'sandbox' | 'production';
  /** `timeout`: no answer within 5 s (HEALTH_DB_TIMEOUT_MS in apps/worker). */
  database: 'ok' | 'unreachable' | 'timeout' | 'outdated' | 'not_configured';
}
