import type { AccessLevel } from './access';
import type { ActionType, BlockReason } from './actions';
import type { CohortHorizon } from './analyses';
import type { AnnounceTarget } from './announcements';
import type { BadgeLocale } from './badge';
import type { ProofLevel, TestimonialDisplay } from './testimonials';
import type { BadgeCode, GoalCategory, GoalEntry, GoalProposal, Milestone } from './goals';
import type {
  CreatorOfferKind,
  CreatorOfferTerms,
  ExitOffer,
  ExitReason,
  OfferSettings,
} from './offers';
import type {
  Niche,
  PlatformSignals,
  RiskLevel,
  RiskReason,
  RiskWeights,
  SignalPlatform,
} from './risk';
import type { MessageAction, MessageTemplate, TemplateLocale } from './templates';

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
  /** The request clashes with the current state (an offer already open for this member). */
  | 'conflict'
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
  /** Whether the company has its time zone; the dashboard sends the browser's when not. */
  timezoneSet: boolean;
  /** The community's name, once read from Whop (null until then). */
  companyName: string | null;
  /** Whop gave the community a logo: served at /api/creator/:companyId/logo. */
  companyLogo: boolean;
  /** StayPut computes everything and sends nothing: the banner on top of every screen. */
  testMode: boolean;
  /**
   * The operator's own community (OPERATOR_COMPANY_ID): its team sees StayPut's internal status
   * page (SPEC Phase 8.5).
   */
  operator: boolean;
}

/** GET /api/member/:experienceId/session */
export interface MemberSession {
  experienceId: string;
  userId: string;
  accessLevel: AccessLevel;
  via: SignInMethod;
}

/**
 * GET /api/member/:experienceId/home: where StayPut's place in the community leads. Members have
 * no StayPut space (2026-10-08): the team goes to its dashboard, a member reads that there is
 * nothing to do, in the community's language.
 */
export interface MemberHome {
  /** The dashboard's address, for the team only. */
  dashboard: string | null;
  locale: 'en' | 'fr';
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

/**
 * GET /api/creator/:companyId/dashboard: the home of the dashboard (SPEC Phase 6.2), the money
 * first. Money figures are in `currency`, the one the community is paid in most; the members of
 * the team never count.
 */
export interface DashboardView {
  currency: string | null;
  /** Money StayPut saved (attribution, SPEC Phase 6.4), by month in the community's time zone. */
  saved: {
    thisMonth: { direct: number; influenced: number; saves: number };
    lastMonth: { direct: number };
    /** Saves in other currencies exist (and are not counted here). */
    otherCurrencies: boolean;
  };
  /** What the memberships still paying bring each month; null when none pays. */
  monthlyRevenue: number | null;
  /** What the members at high risk or leaving pay each month, and how many they are. */
  atRisk: { revenue: number; members: number; departures: number; high: number };
  /** Of the members here 30 days ago, the share still here; null when nobody was. */
  retention30: { rate: number | null; kept: number; base: number };
  members: { total: number; newLast7Days: number };
  /** What the members did over 30 days: messages, reactions, posts, lessons. */
  memberActivity30d: number;
  /**
   * What StayPut did over 30 days (simulated ones included in test mode): messages sent, payments
   * retried, offers given, pauses offered (departure surveys and the creator's), members saved.
   */
  stayputActions30d: {
    total: number;
    messages: number;
    paymentRetries: number;
    offers: number;
    pauses: number;
    /**
     * Members saved (direct saves in `currency`) over the chart's last 30 days, each once: their
     * plans are the chart's 30-day total (brief v4 §13).
     */
    saved: number;
  };
  mode: 'auto' | 'manual';
  /** Test mode: everything is computed, nothing is sent. */
  testMode: boolean;
  /** Members at each level, day by day over the last 30 days (the daily score history). */
  riskHistory: RiskDay[];
  /**
   * The money saved and the money at risk, day by day (the chart): from the 1st of the month 89
   * days ago to today, so 90 days at least and each month whole, its balance adding up from its
   * 1st (brief v4 §8).
   */
  revenueHistory: RevenueDay[];
  /** The « Getting started » steps; the card is gone once all four are done. */
  gettingStarted: GettingStarted;
  /** The first-run welcome was seen (brief v4 §10): it opens by itself only before. */
  welcomed: boolean;
  /** The one action that protects the most revenue today; null when nothing is urgent. */
  priority: PriorityAction | null;
}

/** A day of the dashboard's chart, in `currency`. */
export interface RevenueDay {
  /** YYYY-MM-DD, in the community's time zone. */
  day: string;
  /** Saved that day (direct saves, SPEC 6.4). */
  saved: number;
  /** What the members at high risk or leaving that day pay a month; null: no score that day. */
  atRisk: number | null;
}

/** What the creator did once, from the dashboard's « Getting started » card. */
export interface GettingStarted {
  /** A Discord server is connected. */
  discord: boolean;
  /** The automatic mode is on, or the creator approved or made an action. */
  automation: boolean;
  /** The creator opened their members at risk. */
  reviewed: boolean;
  /** The creator saved their guardrails (Settings › Automations). */
  guardrails: boolean;
}

export interface RiskDay {
  /** YYYY-MM-DD, in the community's time zone. */
  day: string;
  departure: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * The action of the day: approve what StayPut proposes (manual mode), retry the failed payments
 * now, offer a pause to the members leaving, or message the members at high risk nobody reached
 * in 5 days. While a payment stays failed or a member is leaving and none of these can be done,
 * `review` leads to them: never « nothing urgent » then (brief v3 §6.2). `revenue`: the money at
 * stake, what those payments or members bring each month (never a promise of what is saved).
 */
export type PriorityAction =
  | { kind: 'approve'; actions: number; members: number; revenue: number }
  | { kind: 'retry'; payments: number; revenue: number }
  | { kind: 'pause'; memberIds: string[]; revenue: number }
  | { kind: 'message'; memberIds: string[]; revenue: number }
  | { kind: 'review'; filter: 'failed' | 'cancelling'; members: number; revenue: number };

/** GET /api/creator/:companyId/feed: what just happened, the newest first. */
export interface FeedView {
  items: FeedItem[];
}

export interface FeedItem {
  /** Stable across reads: the list animates only what is new. */
  id: string;
  at: string;
  /** What StayPut did, or what a member did. */
  by: 'stayput' | 'member';
  event:
    | 'message_sent'
    | 'message_simulated'
    | 'payment_retry'
    | 'offer_applied'
    | 'saved'
    | 'joined'
    | 'payment_succeeded'
    | 'payment_failed'
    | 'cancellation_scheduled'
    | 'activity';
  memberId: string | null;
  memberName: string | null;
  /** A save or a payment. */
  amount?: number;
  currency?: string;
  /** An activity: where (whop, discord, telegram) and what (message, lesson, post, result). */
  source?: 'whop' | 'discord' | 'telegram';
  activity?: 'message' | 'lesson' | 'post' | 'result';
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
  /** The member's Whop username (without the @), when Whop gave it: the search finds it too. */
  username: string | null;
  status: 'joined' | 'left';
  accessLevel: AccessLevel | null;
  joinedAt: string | null;
  /** Whop's last action of the member anywhere in the community. */
  lastActionAt: string | null;
  /** The last activity StayPut recorded (message, reaction, post, lesson, ticket). */
  lastActivityAt: string | null;
  /** On the « never contact » list: StayPut takes no action of any kind for this member. */
  doNotContact: boolean;
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
    /**
     * Paused until then: a pause StayPut applied (its action's `resumes_at`), or Whop's own. Null
     * or absent when not paused; a membership Whop says is `paused` without a date is paused too.
     */
    pausedUntil?: string | null;
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
 * GET /api/creator/:companyId/members/:memberId: what a member's drawer shows beside their row
 * (brief v4 §9.3): their score day by day, their memberships and payments, what they did where.
 */
export interface MemberDetail {
  memberId: string;
  /** The score of each of the last 30 days (the day's last), oldest first; none before a score. */
  scores: { day: string; score: number }[];
  /** Their memberships, the one that counts first. */
  memberships: MemberDetailMembership[];
  /** Their payments, the latest first (MEMBER_PAYMENTS_LIMIT at most). */
  payments: MemberDetailPayment[];
  /** What they did over 30 days, place by place: Whop, then Discord and Telegram if connected. */
  platforms: MemberPlatformActivity[];
  /**
   * A pause proposed to them, waiting for their yes in the support chat: the creator applies it
   * from the drawer until it expires (0046). Null when none is waiting.
   */
  pauseOffer: { id: string; days: number; expiresAt: string } | null;
}

export interface MemberDetailMembership {
  id: string;
  status: string;
  price: number | null;
  currency: string | null;
  billingPeriodDays: number | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  startedAt: string | null;
}

export interface MemberDetailPayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  at: string;
  failureReason: string | null;
}

export interface MemberPlatformActivity {
  platform: 'whop' | 'discord' | 'telegram';
  /** Over 30 days. Whop: messages, reactions, posts and lessons; elsewhere: messages. */
  events: number;
  /** Their last activity there, however old. */
  lastAt: string | null;
  /** StayPut knows their account there (always on Whop): what they write there counts. */
  linked: boolean;
}

/** Payments a member's drawer shows at most, the latest first. */
export const MEMBER_PAYMENTS_LIMIT = 12;

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

/**
 * GET /api/creator/:companyId/insights/overview: Analytics › Overview (brief v4 §9.5). What the
 * 90-day forecast needs (SPEC 6.5–6.6, computed by `forecastRevenue`), why members leave (the
 * departure survey, SPEC 6.8) and what they did, day by day.
 */
export interface InsightsOverview {
  /** The currency most of the community pays in; null without a paying member. */
  currency: string | null;
  /** What the paying members bring in a month, in `currency`, by risk level. */
  revenue: Record<RiskLevel, number>;
  /** Each level's probability of staying a month. */
  stay: Record<RiskLevel, number>;
  /** The levels whose probability is the community's own (60 days of history, 10 members). */
  calibrated: RiskLevel[];
  /** The share of the members at risk reached that acting saves. */
  saveRate: number;
  /** The community's own rate (10 members at risk reached), not StayPut's 30 %. */
  saveRateObserved: boolean;
  /** The departure survey's answers of the last 90 days, by reason, the most frequent first. */
  reasons: { reason: ExitReason; count: number }[];
  /** The last 30 days in the community's calendar, the oldest first. */
  activity: ActivityDay[];
}

/** A day of the members' activity: what they did (messages, reactions, posts, lessons). */
export interface ActivityDay {
  day: string;
  actions: number;
  /** The members who did something that day. */
  members: number;
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

/** Where an action stands (SPEC Phase 4); `simulated`: run in test mode, nothing sent. */
export type ActionStatus =
  | 'proposed'
  | 'approved'
  | 'scheduled'
  | 'sent'
  | 'simulated'
  | 'failed'
  | 'cancelled'
  | 'blocked_by_guardrail';

/** The three lists of the Actions section. */
export type ActionView = 'queue' | 'scheduled' | 'history';

export const ACTION_VIEWS: readonly ActionView[] = ['queue', 'scheduled', 'history'];

export interface ActionRow {
  id: string;
  type: ActionType;
  status: ActionStatus;
  /** What started it: `payment_failed`, `score_high`, `activation_radar`… */
  trigger: string;
  member: { id: string; name: string | null };
  sendAt: string | null;
  sentAt: string | null;
  createdAt: string;
  blockedReason: BlockReason | null;
  /** The message: what it will say (a preview), or what it said or would have said. */
  message: MessageTemplate | null;
  /** Why it was cancelled, or its last error. */
  note: string | null;
  /** An offer a member accepted in the departure survey: what, why, and what came of it. */
  offer: ActionOffer | null;
  /** An Alumni follow-up: the day after the departure it belongs to (7, 30 or 60). */
  alumniStep?: number;
  /** Earned days: the milestone reached, in percent. */
  milestone?: number;
  /** What came of it, once it reached the member (History only; core `actionOutcome`). */
  outcome?: ActionOutcome | null;
}

/**
 * What came of an action that reached a member (fix prompt v4.1, block 4): the proof of value,
 * as a badge in the History. `recovered`: money StayPut saved through it (stayput.saves);
 * `still_failing`: the payment it was about still fails; `paused`: the pause it applied, until
 * then; `came_back`: the member did something in the community after it; `no_reply`: nothing
 * yet; `left`: the member left after it.
 */
export type ActionOutcome =
  | { kind: 'recovered'; amount: number; currency: string }
  | { kind: 'still_failing' }
  | { kind: 'paused'; until: string | null }
  | { kind: 'came_back' }
  | { kind: 'no_reply' }
  | { kind: 'left' };

/** An accepted offer, as the creator reviews it. */
export interface ActionOffer {
  reason: ExitReason | null;
  /** Pause length, or free days. */
  days?: number;
  percentOff?: number;
  months?: number;
  /** The member ticked it: their cancellation is withdrawn. */
  keep: boolean;
  /** Once applied: the discount on the membership (or, before that, a code and its end), or when the pause ends. */
  promoApplied?: boolean;
  promoCode?: string;
  expiresAt?: string;
  resumesAt?: string;
}

/** GET /api/creator/:companyId/actions?view=…: one list, and how many each list holds. */
export interface ActionsPage {
  view: ActionView;
  counts: Record<ActionView, number>;
  actions: ActionRow[];
  mode: 'auto' | 'manual';
  dryRun: boolean;
  killSwitch: boolean;
}

/**
 * The rules of Automations › Rules (brief v4 §9.4), as the engine plans them (plan_actions,
 * migration 0032): Whop charges a failed payment again; the member is asked to update their card
 * (or to confirm a 3D Secure check); the departure survey; a check-in message when a score turns
 * high; the welcome of a newcomer who has not started.
 */
export const RULE_IDS = [
  'payment_retry',
  'payment_notice',
  'exit_survey',
  'check_in',
  'welcome',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export function isRuleId(value: unknown): value is RuleId {
  return typeof value === 'string' && (RULE_IDS as readonly string[]).includes(value);
}

/** GET and PUT /api/creator/:companyId/settings/actions. */
export interface ActionSettingsView {
  mode: 'auto' | 'manual';
  /** The rules the creator turned off (PUT /rules/:rule changes them, never this PUT). */
  rulesOff: RuleId[];
  /** The language of the messages members receive. */
  locale: TemplateLocale;
  dryRun: boolean;
  killSwitch: boolean;
  /** The creator's time zone (an IANA name): the hours below are its local hours. */
  timezone: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  defaultSendHour: number;
  maxMessagesPer5Days: number;
  maxMessagesPerMonth: number;
  maxPaymentRetries: number;
  monthlyPromoCap: number;
  maxFreeDaysPerQuarter: number;
  /** The creator's own wording; StayPut's default for what is left out. */
  templates: Partial<Record<TemplateLocale, Partial<Record<MessageAction, MessageTemplate>>>>;
  /** What the departure survey offers members, reason by reason. */
  offers: OfferSettings;
}

/**
 * The PUT body: the settings, with the time zone only when the creator changed it (the zone
 * their browser reported may have arrived since the form was read), and the offers when sent.
 */
export type ActionSettingsUpdate = Omit<ActionSettingsView, 'timezone' | 'offers' | 'rulesOff'> & {
  timezone?: string;
  offers?: OfferSettings;
};

/**
 * GET /api/member/:experienceId/retention: what the member view shows of the member's own
 * subscription (SPEC Phase 4): a payment that needs them, and the cancellation they scheduled,
 * with its survey and offer. Never a score (SPEC 5.3).
 */
export interface MemberRetentionView {
  creatorName: string | null;
  /**
   * The language the community speaks to its members (its messages' language, Settings ›
   * Automations): the member view speaks it, whatever the member's browser.
   */
  locale: TemplateLocale;
  /** To open the payment page through Whop inside its iframe. */
  whopAppId: string | null;
  /** The Alumni offer's link (SPEC 5.9), for a member who leaves: stay in touch for free. */
  alumniUrl: string | null;
  /**
   * For the team, who preview what a member sees: the creator's offers, to try each reason with,
   * and whether test mode keeps the survey from members for now. Nothing is recorded or applied.
   * Null for a member.
   */
  preview: { offers: OfferSettings; testMode: boolean } | null;
  payment: {
    /** A 3D Secure check to pass, or a payment that failed. */
    kind: 'action_required' | 'failed';
    amount: number;
    currency: string;
    /** Where the member validates the payment or updates their payment method. */
    url: string | null;
  } | null;
  departure: {
    endsAt: string | null;
    reason: ExitReason | null;
    /** The offer for the reason given; null when none can be made (a guardrail). */
    offer: ExitOffer | null;
    outcome: 'pending' | 'accepted' | 'declined';
    result: OfferResult | null;
  } | null;
  /** A former member in the Alumni space (SPEC 5.9): their return code, and the way back. */
  alumni: AlumniReturn | null;
  /** An offer the creator made from the dashboard (a pause, a code), to accept here. */
  creatorOffer: CreatorOfferView | null;
}

/** An offer the creator made a member (« Pause », « Offer »), as the member sees it. */
export interface CreatorOfferView {
  id: string;
  kind: CreatorOfferKind;
  terms: CreatorOfferTerms;
  expiresAt: string;
  outcome: 'open' | 'accepted' | 'declined' | 'expired';
  /** What came of it once accepted. */
  result: OfferResult | null;
}

/** POST /api/creator/:companyId/members/message: the messages queued (a click approves them). */
export interface CreatorMessagesResult {
  queued: number;
}

/** POST /api/creator/:companyId/payments/retry: the failed payments being retried now. */
export interface CreatorRetryResult {
  queued: number;
}

/**
 * POST /api/creator/:companyId/members/offers: offers made at once (the action of the day); a
 * member who cannot get one (« never contact », an offer open, no membership) is `refused`.
 */
export interface CreatorOffersResult {
  made: number;
  refused: number;
}

/** POST /api/creator/:companyId/members/:memberId/offer */
/**
 * POST /api/creator/:companyId/members/:memberId/note: what became of the creator's own message,
 * as Whop answered it, never before. `sent`: Whop took it; `scheduled`: it leaves at `sendAt`, the
 * end of the quiet hours; `simulated`: test mode, nothing left; `retrying`: Whop did not take it,
 * StayPut tries again at `sendAt`; `failed`: it will not leave, for `reason`.
 */
export interface CreatorNoteSent {
  actionId: string;
  /** `sending`: Whop had not answered when the creator's wait ended; it goes on. */
  status: 'sent' | 'scheduled' | 'sending' | 'simulated' | 'retrying' | 'failed';
  sendAt: string;
  /** `permission`: StayPut may not write in the community's support chat yet (Whop said 403). */
  reason?: 'permission' | 'refused';
}

export interface CreatorOfferMade {
  offerId: string;
  kind: CreatorOfferKind;
  terms: CreatorOfferTerms;
  /** A discount is given (applied when its message leaves); a pause waits for the member's yes. */
  applied: boolean;
}

/** A pause the member said yes to, applied by the creator: the action that applies it. */
export interface CreatorOfferApplied {
  actionId: string;
}

/** What a former member sees in StayPut's view of the Alumni space. */
export interface AlumniReturn {
  /** Their return code while it holds: its discount, for how many months, until when. */
  code: { code: string; percentOff: number; months: number; expiresAt: string } | null;
  /** The checkout of the plan they left, where the code is entered. */
  returnUrl: string | null;
}

/** What came of an accepted offer. */
export interface OfferResult {
  /** waiting: the creator approves it first (manual mode), or it runs within the minute. */
  status: 'waiting' | 'applied' | 'failed' | 'cancelled';
  /** The membership was kept: the cancellation is withdrawn. */
  kept?: boolean;
  /** The discount is on the membership: it comes off the next payments, no code to type. */
  promoApplied?: boolean;
  /** A code to type at a checkout: an offer made before discounts went on the membership. */
  promoCode?: string;
  expiresAt?: string;
  resumesAt?: string;
}

/** POST …/retention/survey */
export interface ExitSurveyAnswer {
  reason: ExitReason;
}

/** POST …/retention/offer: `keep` is the member's consent to keep their membership. */
export interface ExitOfferDecision {
  accept: boolean;
  keep?: boolean;
}

/**
 * GET /api/member/:experienceId/space: the member space (SPEC Phase 5), the member's goal, their
 * latest results and their badges, and the goals the creator proposes. Progress only, never a
 * score (SPEC 5.3).
 */
export interface MemberSpaceView {
  /** A team member previews the space: the proposals, nothing recorded. */
  preview: boolean;
  /** StayPut knows this member (their membership was read from Whop); else nothing is kept yet. */
  known: boolean;
  /** The goal under way, or the last one reached; null: none chosen yet. */
  goal: MemberGoal | null;
  /** The goal's latest results, the newest first. */
  results: GoalResult[];
  badges: EarnedBadge[];
  /** The goals the creator proposes (their niche's until they write their own). */
  proposals: GoalProposal[];
  /** The badges this opening of the space brought (coming back seven days in a row). */
  fresh: BadgeCode[];
  /**
   * The earned days (SPEC Phase 5, point 5): what the creator offers at 50 and 100 % (null:
   * none), and the days the member received, once per milestone.
   */
  rewards: {
    offered: { at50: number; at100: number } | null;
    received: { percent: Milestone; days: number; at: string }[];
  };
  /**
   * Sharing a milestone in the community's chat (SPEC Phase 5, point 4): where it goes and in
   * which words (the community's language, the member's first name); null when the creator
   * chose nowhere.
   */
  announce: { locale: TemplateLocale; firstName: string | null; place: string } | null;
  /** The member's testimonial cards online (SPEC Phase 5, points 6 and 7), the newest first. */
  cards: TestimonialCard[];
  /** To open a card's public page through Whop inside its iframe. */
  whopAppId: string | null;
  /** The member's buddies (SPEC Phase 5, point 8); null for the team's preview. */
  buddies: MemberBuddies | null;
  /**
   * The rescue challenges (SPEC Phase 5, point 9); null for the team's preview, or while the
   * creator has them off.
   */
  rescues: MemberRescues | null;
}

/**
 * A rescue challenge, as members see it: anonymized, the place where the stalled member last
 * wrote, and a link to that message when the platform gives one.
 */
export interface RescueChallenge {
  id: string;
  platform: 'whop' | 'discord' | 'telegram';
  /** The server or group, when known. */
  place: string | null;
  url: string | null;
  lastMessageAt: string;
  createdAt: string;
  /** Members who took it up. */
  helpers: number;
  /** This member took it up. */
  joined: boolean;
}

export interface MemberRescues {
  challenges: RescueChallenge[];
  /** Members this one helped bring back. */
  rescued: number;
}

/**
 * GET /api/creator/:companyId/rescues: the rescue challenges on or off, the open ones, the
 * members back over 30 days, and the members who earned the Rescuer badge.
 */
export interface RescuesView {
  enabled: boolean;
  open: number;
  rescuedLast30: number;
  rescuers: number;
}

/** PUT /api/creator/:companyId/rescues */
export interface RescuesUpdate {
  enabled: boolean;
}

/** Someone paired with the member: what they are to the member, and what they share. */
export interface BuddyPartner {
  pairId: string;
  /** `veteran`: the member who helps them start; `newcomer`: the one they help. */
  role: 'newcomer' | 'veteran';
  name: string | null;
  /** When the other one joined the community. */
  joinedAt: string | null;
  pairedAt: string;
  /** The other one's goal category, when it is the member's too. */
  sameCategory: GoalCategory | null;
}

export interface MemberBuddies {
  /** The member asked not to be paired. */
  optedOut: boolean;
  /** Their pairs under way: one veteran for a newcomer, up to 3 newcomers for a veteran. */
  partners: BuddyPartner[];
}

/** POST …/space/buddies: the member asks not to be paired, or may be again. */
export interface BuddyOptOutRequest {
  optOut: boolean;
}

/**
 * GET /api/creator/:companyId/buddies: the buddies on or off (SPEC Phase 5, point 8), and where
 * they stand: the pairs under way, the newcomers waiting for one, the veterans who can take
 * one, the members who earned the Mentor badge.
 */
export interface BuddiesView {
  enabled: boolean;
  activePairs: number;
  waitingNewcomers: number;
  veterans: number;
  mentors: number;
}

/** PUT /api/creator/:companyId/buddies */
export interface BuddiesUpdate {
  enabled: boolean;
}

/** A testimonial card online: its public page, and what it shows. */
export interface TestimonialCard {
  proofId: string;
  resultId: string | null;
  level: ProofLevel;
  /** The public page /v/:proofId. */
  url: string;
  display: TestimonialDisplay;
}

/**
 * GET /api/creator/:companyId/space: the member space as the team sees it in the dashboard (SPEC
 * Phase 5), every part of it in one place: what members do with it over 30 days, the testimonial
 * cards they put online, the buddies and the rescue challenges. Counts only, and the cards that
 * are public pages already: nothing a member did not show.
 */
export interface SpaceOverview {
  /** Members with a goal under way, and the goals reached since the start. */
  goals: { active: number; achieved: number };
  /** Results noted over 30 days, those a screenshot backs, and the members who noted them. */
  results: { last30: number; justified30: number; members30: number };
  /** Members active in their space over 30 days: they opened it, set a goal or noted a result. */
  opens30: number;
  /** Badges won over 30 days. */
  badges30: number;
  /** The cards online: how many, and the newest. */
  cards: { online: number; latest: TestimonialCard[] };
  buddies: { enabled: boolean; activePairs: number };
  rescues: { enabled: boolean; open: number; rescuedLast30: number };
  /** StayPut's Whop app: a card's page opens through Whop from inside its frame. */
  whopAppId: string | null;
}

/**
 * GET …/space/affiliate: the member's own affiliate link to the community, read from Whop (SPEC
 * 5.6), to offer on their card; null when Whop gives none.
 */
export interface AffiliateLinkView {
  url: string | null;
}

/** POST …/space/share: the member asks for their milestone to be announced. */
export interface ShareRequest {
  goalId: string;
  percent: Milestone;
}

/**
 * What came of it: `sent`, posted; `waiting`, the creator approves it first (manual mode);
 * `simulated`, test mode; `blocked`, a guardrail stopped it; `failed`, the chat refused it;
 * `duplicate`, this milestone was shared already.
 */
export interface ShareAnswer {
  status: 'sent' | 'waiting' | 'simulated' | 'blocked' | 'failed' | 'duplicate';
}

/** A place an announcement can go, as the creator picks it. */
export interface AnnounceDestination extends AnnounceTarget {
  /** The channel's or the group's name. */
  name: string | null;
  /** Where it is: the Discord server, the Telegram group's kind, Whop. */
  place: string | null;
}

/** GET and PUT /api/creator/:companyId/announcements */
export interface AnnouncementsView {
  destination: AnnounceDestination | null;
  /** Where StayPut can post now: Discord channels it may write in, Telegram groups, Whop chats. */
  choices: AnnounceDestination[];
  /** Whop's chats could not be listed (most often, a permission missing). */
  whopUnavailable: boolean;
}

/** PUT /api/creator/:companyId/announcements: null turns the announcements off. */
export interface AnnouncementsUpdate {
  destination: AnnounceTarget | null;
}

export interface MemberGoal {
  id: string;
  title: string;
  category: GoalCategory;
  unit: string;
  entry: GoalEntry;
  start: number;
  target: number;
  /** The latest result, or the start before the first one. */
  current: number;
  /** From 0 to 100: how far from the start to the target. */
  progress: number;
  targetDate: string | null;
  status: 'active' | 'achieved';
  createdAt: string;
  milestones: { percent: Milestone; reachedAt: string }[];
}

export interface GoalResult {
  id: string;
  /** Where the member stood after this result (an `add` goal adds up its entries). */
  value: number;
  recordedAt: string;
  /** A screenshot backs it (`justified`); null: declared, the member's word. */
  proof: 'justified' | 'connected' | null;
}

export interface EarnedBadge {
  code: BadgeCode;
  awardedAt: string;
}

/** POST …/space/result: what the result brought, to celebrate it. */
export interface ResultAnswer {
  space: MemberSpaceView;
  milestones: Milestone[];
  badges: BadgeCode[];
  /** The goal is reached with this result. */
  achieved: boolean;
  /**
   * The screenshot sent with it: `justified`, the number is on it; `declared`, it is not (the
   * result stands as the member's word); `duplicate`, it backed another result already. Null:
   * none was sent.
   */
  proof: 'justified' | 'declared' | 'duplicate' | null;
  /** Free days added to the member's access by this result now (earned days, automatic mode). */
  earnedDays: number;
}

/** GET and PUT /api/creator/:companyId/earned-days: free days for the milestones reached. */
export interface EarnedDaysSettings {
  enabled: boolean;
  /** Days at 50 % and at 100 %, 0 to 14 (0: none for that milestone). */
  at50: number;
  at100: number;
}

/** GET and PUT /api/creator/:companyId/goals: the goals proposed to members. */
export interface GoalProposalsView {
  niche: Niche;
  /** The creator's own list; null: their niche's. */
  custom: GoalProposal[] | null;
  /** Their niche's, in the dashboard's language. */
  defaults: GoalProposal[];
}

/** PUT /api/creator/:companyId/goals: null goes back to the niche's goals. */
export interface GoalProposalsUpdate {
  proposals: GoalProposal[] | null;
}

/** Discord or Telegram: where StayPut sees members write beside Whop. */
export type AccountPlatform = 'discord' | 'telegram';

/**
 * Where Integrations reads activity, each with its dashboard: Whop (its chats and forums, 0049),
 * Discord and Telegram.
 */
export type ActivityPlatform = AccountPlatform | 'whop';

/** A Discord or Telegram account no member has yet: its messages wait 30 days for one. */
export interface UnlinkedAccount {
  platform: AccountPlatform;
  accountId: string;
  /** Discord's display name, Telegram's first and last names; null while StayPut lacks them. */
  name: string | null;
  username: string | null;
  /** Its messages waiting for a member. */
  messages: number;
  lastAt: string;
  /** Up to 3 members it may be; `strong`: same username, or same full name. */
  suggestions: { memberId: string; name: string | null; strong: boolean }[];
}

/** An account tied to a member, and who tied it. */
export interface LinkedAccount {
  platform: AccountPlatform;
  accountId: string;
  name: string | null;
  username: string | null;
  member: { id: string; name: string | null };
  /** whop: on the member's Whop profile; member: linked from StayPut; name: StayPut, by name. */
  via: 'whop' | 'member' | 'name' | 'creator' | null;
}

/** An account the creator set aside: their own or their team's, or a guest's. */
export interface DismissedAccount {
  platform: AccountPlatform;
  accountId: string;
  name: string | null;
  username: string | null;
  as: 'team' | 'guest';
  at: string;
}

/**
 * GET /api/creator/:companyId/platform-activity: what StayPut saw on Discord and Telegram over
 * the last 30 days, in the creator's time zone. Counts and names, never what was written.
 */
export interface PlatformActivityView {
  /** The first and last days counted (yyyy-mm-dd). */
  from: string;
  to: string;
  platforms: PlatformActivity[];
  /** The servers and groups, the busiest first. */
  places: {
    platform: AccountPlatform;
    id: string | null;
    name: string | null;
    messages: number;
    lastAt: string;
  }[];
  /** The members who wrote the most (the team aside). */
  topMembers: {
    id: string;
    name: string | null;
    discord: number;
    telegram: number;
    lastAt: string;
  }[];
}

export interface PlatformActivity {
  platform: AccountPlatform;
  messages: number;
  /**
   * The messages by who wrote them: the members' part is what their own 30 days add up to (each
   * member's drawer), the rest the team's, guests' and accounts' not tied yet.
   */
  messagesBy?: { members: number; team: number; guests: number; unlinked: number };
  /** Who wrote, counted once each: members, the team, guests, accounts not tied yet. */
  authors: number;
  members: number;
  team: number;
  guests: number;
  unlinked: number;
  lastAt: string | null;
  /** Messages per day, from the first day to the last (30). */
  daily: number[];
}

/**
 * GET /api/creator/:companyId/alumni: the Alumni offer (SPEC 5.9), where former members stay in
 * touch for free, and who entered it, left it, or came back to a paid offer.
 */
export interface AlumniView {
  offer: {
    name: string;
    /** The free variant's direct link: how a former member enters. Null until Whop gave it. */
    url: string | null;
    createdAt: string;
    /** Every step done on Whop: the offer is ready. */
    completedAt: string | null;
  } | null;
  entered: number;
  left: number;
  returned: number;
  /**
   * Of the former members who ever entered the Alumni, the share who pay again, from 0 to 1
   * (`alumniReturnRate`); null while nobody entered it.
   */
  returnRate: number | null;
  /**
   * What those who came back paid since they entered the Alumni (refunds left out), in its main
   * currency; null while nothing came in.
   */
  recovered: { amount: number; currency: string; otherCurrencies: boolean } | null;
  /** The answer of a creation that stopped: the step, and the permission Whop lacked (403). */
  problem?: AlumniProblem | null;
}

export type AlumniStep = 'product' | 'variant';

export interface AlumniProblem {
  step: AlumniStep;
  /** The permission to grant, when Whop refused the step (403); null for another failure. */
  permission: string | null;
}

/** POST /api/creator/:companyId/alumni: create the offer, or finish creating it. */
export interface AlumniCreation {
  name: string;
}

/**
 * GET /api/creator/:companyId/platforms/:platform: Integrations › Discord or › Telegram (brief v4
 * §9.6), in the company's calendar. Who wrote, where and when; never what.
 */
export interface PlatformDashboard {
  platform: ActivityPlatform;
  /** The 30 days counted (yyyy-mm-dd). */
  from: string;
  to: string;
  hero: {
    /** Members who wrote there over the last 7 days. */
    activeMembers7d: number;
    /** Members who wrote there over 90 days, but not these 7 days. */
    silentMembers7d: number;
    /** Everyone's messages over 30 days: members, the team, guests, accounts not tied yet. */
    messages30d: number;
    /** Of them, the members'. */
    memberMessages30d: number;
  };
  /** Each of the 30 days, the first first. */
  daily: PlatformDay[];
  /** When messages were written over 30 days: only the hours with some. */
  heatmap: HeatCell[];
  /** The channels (Discord), the groups and their topics (Telegram), the busiest first. */
  places: PlatformPlace[];
  /** The 10 members who wrote the most over 7, 14 and 30 days. */
  active: Record<ActivityWindow, PlatformMember[]>;
  /**
   * The members who wrote there over 90 days but not over the last 7, 14 or 30 days: how many,
   * and 10 of them, the riskiest first (`messages`: theirs over 90 days).
   */
  silent: Record<ActivityWindow, { total: number; members: PlatformMember[] }>;
  signals: PlatformSignalsView;
}

export type ActivityWindow = 'd7' | 'd14' | 'd30';

export interface PlatformDay {
  day: string;
  /** Everyone's messages that day. */
  messages: number;
  /** The members'. */
  members: number;
  /** The members' at high risk or leaving today. */
  atRisk: number;
}

export interface HeatCell {
  /** 1 Monday to 7 Sunday. */
  dow: number;
  /** 0 to 23, in the company's time zone. */
  hour: number;
  messages: number;
  /** Members who wrote then. */
  members: number;
}

export interface PlatformPlace {
  /**
   * A Discord channel's id; a Telegram group's, then its topic's after a colon; a Whop chat's, or
   * a Whop forum's experience.
   */
  id: string;
  /** `general`: a forum group's messages outside its topics; `chat`, `forum`: Whop's. */
  kind: 'channel' | 'group' | 'general' | 'topic' | 'chat' | 'forum';
  /** Null while StayPut does not know it (a topic created before the bot came). */
  name: string | null;
  /** The Discord server, the topic's group. */
  parent: string | null;
  messages: number;
  members: number;
  lastAt: string | null;
  /** Its 3 most active members. */
  top: { id: string; name: string | null; messages: number }[];
}

export interface PlatformMember {
  id: string;
  name: string | null;
  messages: number;
  lastAt: string;
  score: number | null;
  level: RiskLevel | null;
}

/** The signals of a platform (brief v4 §9.6), and what the preview needs. */
export interface PlatformSignalsView {
  /** Both platforms' signals, as saved or StayPut's defaults. */
  settings: Record<SignalPlatform, PlatformSignals>;
  mediumFrom: number;
  highFrom: number;
  /** The members' scores as made: [base, discord bits, telegram bits, rule, how many]. */
  groups: [number, number, number, number, number][];
}

/** GET …/platforms/:platform/days/:day: a day of the chart, picked. */
export interface PlatformDayView {
  day: string;
  messages: number;
  places: PlatformPlace[];
  /** The members who wrote that day, the most first (20 at most). */
  active: PlatformMember[];
}

/** GET …/platforms/:platform/slots/:dow/:hour: a cell of the heatmap, picked, over 30 days. */
export interface PlatformSlotView {
  dow: number;
  hour: number;
  messages: number;
  /** Messages of others than the members listed: the team, guests, accounts not tied yet. */
  others: number;
  members: PlatformMember[];
}

/**
 * GET /api/creator/:companyId/people: everyone StayPut knows on the company's Discord servers and
 * Telegram groups, not only who writes there, and each server and group. Names and dates, never
 * what was written.
 */
export interface PeopleView {
  places: PeoplePlace[];
  /** How many people StayPut knows in all. */
  total: number;
  /** How many on each platform; `people` holds 500 at most of each, the latest to write first. */
  totals: Record<AccountPlatform, number>;
  people: PlatformPerson[];
}

export interface PeoplePlace {
  platform: AccountPlatform;
  id: string;
  name: string | null;
  /** How many people the server or group has, as Discord or Telegram counts them. */
  total: number | null;
  /** How many of them StayPut knows by name. */
  known: number;
  /**
   * How StayPut knows them. Discord: the server's member list was read (`listed`), not yet
   * (`pending`), or refused (`blocked`: the bot's application has the Server Members Intent off).
   * Telegram (`joins`): who joined since the bot is there, the administrators, who wrote.
   */
  list: 'listed' | 'pending' | 'blocked' | 'joins';
}

export interface PlatformPerson {
  platform: AccountPlatform;
  accountId: string;
  name: string | null;
  username: string | null;
  /** A member of the community, the team, a guest, or an account not tied to anyone yet. */
  status: 'member' | 'team' | 'guest' | 'unlinked';
  member: { id: string; name: string | null } | null;
  /** On one of the company's servers or groups now; null when StayPut cannot tell. */
  here: boolean | null;
  joinedAt: string | null;
  leftAt: string | null;
  /** Messages over the last 30 days. */
  messages: number;
  lastMessageAt: string | null;
}

/** GET /api/creator/:companyId/accounts, and the answer of each change. */
export interface AccountsView {
  unlinked: UnlinkedAccount[];
  linked: LinkedAccount[];
  dismissed: DismissedAccount[];
}

/**
 * A Monday report (SPEC Phase 6.9): the week before, in the community's calendar (Monday 00:00
 * to Monday 00:00 there), then the week's priority. Kept as made: a later save or departure in
 * that week does not change a report already sent.
 */
export interface WeeklyReport {
  /** The Monday the week began, in the community's time zone: `YYYY-MM-DD`. */
  weekStart: string;
  /** The currency of the amounts, the community's main one; null without any payment. */
  currency: string | null;
  /** The members StayPut saved that week (direct saves, each member once), and the money. */
  saved: { members: number; direct: number; influenced: number };
  /** The members who left that week (their membership ended). */
  lost: number;
  /** The departure survey's answers that week, the most frequent first. */
  reasons: { reason: ExitReason; count: number }[];
  /** The one action of the week, as the dashboard chose it when the report was made. */
  priority: PriorityAction | null;
}

/** A Monday report as kept: when Whop took it, or whether StayPut gave up sending it. */
export interface SentWeeklyReport extends WeeklyReport {
  /** When the notification reached Whop; null while it did not. */
  sentAt: string | null;
  /** Whop refused it 3 times: it stays here, unsent. */
  failed: boolean;
}

/** GET /api/creator/:companyId/reports: the Monday reports, the newest first (12 weeks). */
export interface WeeklyReportsView {
  /** The report goes to the team every Monday; on until the creator turns it off. */
  enabled: boolean;
  /** When the next one goes: Monday 8:00 in the community's time zone. */
  nextAt: string;
  timezone: string;
  reports: SentWeeklyReport[];
}

/**
 * GET and PUT /api/creator/:companyId/benchmarks (SPEC Phase 6.10): the community's retention next
 * to its niche's, for a community that shares its own, anonymously.
 */
export interface BenchmarksView {
  /** The community shares its figures (anonymously) and sees its niche's. */
  optedIn: boolean;
  niche: Niche;
  /** The communities a niche's figure needs before it shows. */
  minimum: number;
  /**
   * Members who joined in the last 6 months still there after 30, 60 and 90 days: the
   * community's share (null while too few are old enough) and its niche's (null while fewer than
   * `minimum` communities share theirs, or while this one does not).
   */
  horizons: { days: CohortHorizon; mine: number | null; niche: number | null }[];
  /** When the niche's figures were last made; null before. */
  computedAt: string | null;
}

/**
 * GET and PUT /api/creator/:companyId/badge (SPEC Phase 6.11): the « Verified retention » badge,
 * on or off, its figure, and where it lives once on.
 */
export interface BadgeView {
  enabled: boolean;
  /**
   * Members who joined in the last 12 months still there after 90 days (BADGE_MONTHS); null
   * while fewer than BADGE_MIN_MEMBERS are old enough, and the badge then shows nowhere.
   */
  retention: number | null;
  /** The members the figure counts: those who joined at least 90 days ago. */
  members: number;
  /** The badge's language: the community's. */
  locale: BadgeLocale;
  /** Absolute addresses, to paste on a sales page: the image and its verification page. */
  badgeUrl: string;
  verifyUrl: string;
}

/** GET /api/creator/:companyId/team (SPEC Phase 6.12): the Whop team, and who opened StayPut. */
export interface TeamView {
  members: TeamMember[];
}

export interface TeamMember {
  userId: string;
  /** As Whop lists the team among the members; null for one StayPut knows only by id. */
  name: string | null;
  username: string | null;
  /** When they last opened StayPut; null: never yet. */
  openedAt: string | null;
}

/**
 * GET /api/creator/:companyId/export (SPEC Phase 6.12): everything StayPut keeps about the
 * community, table by table, as stored.
 */
export interface DataExport {
  exportedAt: string;
  company: Record<string, unknown>;
  team: TeamMember[];
  tables: Record<string, { rows: Record<string, unknown>[]; truncated: boolean }>;
}

/**
 * GET /api/creator/:companyId/members/:memberId/export (SPEC Phase 8.3): everything StayPut
 * keeps about one member, table by table, as stored.
 */
export interface MemberDataExport {
  exportedAt: string;
  member: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * GET /api/creator/:companyId/operator/status (SPEC Phase 8.5): StayPut's internal status page,
 * for the team of the operator's own community only (OPERATOR_COMPANY_ID). Every message is
 * scrubbed (scrubErrorMessage): no secret, no person.
 */
export interface OperatorStatus {
  checkedAt: string;
  whopEnv: 'sandbox' | 'production';
  database: HealthReport['database'];
  /** The schema the Worker expects; `database: 'outdated'` when the database is behind it. */
  migration: string;
  jobs: OperatorJob[];
  webhooks: {
    /** Whop's deliveries of the last 24 hours, by status. */
    lastDay: Partial<Record<'received' | 'processed' | 'failed' | 'ignored', number>>;
    lastReceivedAt: string | null;
    failedCount: number;
    /** The 50 latest failed deliveries: what they were, never what they contained. */
    failed: OperatorDelivery[];
  };
  companies: { active: number; accessLost: number; uninstalled: number };
  /** Readings Whop (or Discord, Telegram) refused, the latest first. */
  syncErrors: {
    companyId: string;
    companyName: string | null;
    stream: string;
    error: string;
    at: string | null;
  }[];
  /** Actions that failed in the last 7 days, by community and type. */
  failedActions: {
    companyId: string;
    companyName: string | null;
    type: string;
    count: number;
    lastAt: string;
    lastError: string | null;
  }[];
  /** The error log: each error once, the latest first (100 at most). */
  errors: OperatorError[];
}

export interface OperatorJob {
  job: string;
  /** How often its trigger runs it. */
  everyMinutes: number;
  state: 'ok' | 'failing' | 'late' | 'never';
  lastFinishedAt: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runs: number;
  failures: number;
}

export interface OperatorDelivery {
  id: string;
  type: string;
  companyId: string | null;
  companyName: string | null;
  attempts: number;
  /** Whether the replays of every ten minutes still try it (fewer than 5 attempts). */
  retrying: boolean;
  lastError: string | null;
  receivedAt: string;
}

export interface OperatorError {
  source: string;
  companyId: string | null;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

/** POST /api/creator/:companyId/operator/webhooks/replay: the failed deliveries, again. */
export interface WebhookReplay {
  /** How many ended in each status. */
  counts: Partial<Record<'processed' | 'failed' | 'ignored' | 'missing', number>>;
}

/** GET /health */
export interface HealthReport {
  status: 'ok' | 'degraded';
  whopEnv: 'sandbox' | 'production';
  /** `timeout`: no answer within 5 s (HEALTH_DB_TIMEOUT_MS in apps/worker). */
  database: 'ok' | 'unreachable' | 'timeout' | 'outdated' | 'not_configured';
  /**
   * What the screens wait for: Cloudflare's data center the request came in at (`CDG`, `IAD`…,
   * null when unknown; with the Worker placed next to the database it runs elsewhere, as the
   * response's `cf-placement` header says), and how long the database probe took.
   */
  colo: string | null;
  databaseMs: number | null;
}
