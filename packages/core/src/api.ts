import type { AccessLevel } from './access';
import type { ActionType, BlockReason } from './actions';
import type { CohortHorizon } from './analyses';
import type { AnnounceTarget } from './announcements';
import type { BadgeCode, GoalCategory, GoalEntry, GoalProposal, Milestone } from './goals';
import type { ExitOffer, ExitReason, OfferSettings } from './offers';
import type { Niche, RiskLevel, RiskReason, RiskWeights } from './risk';
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
}

/** An accepted offer, as the creator reviews it. */
export interface ActionOffer {
  reason: ExitReason | null;
  /** Pause length, or free days. */
  days?: number;
  percentOff?: number;
  months?: number;
  /** The member ticked it: their cancellation is withdrawn. */
  keep: boolean;
  /** Once applied: the promo code and its end, or when the pause ends. */
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

/** GET and PUT /api/creator/:companyId/settings/actions. */
export interface ActionSettingsView {
  mode: 'auto' | 'manual';
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
export type ActionSettingsUpdate = Omit<ActionSettingsView, 'timezone' | 'offers'> & {
  timezone?: string;
  offers?: OfferSettings;
};

/** POST /api/creator/:companyId/timezone: the zone in effect for the company. */
export interface TimezoneAnswer {
  timezone: string;
}

/**
 * GET /api/member/:experienceId/retention: what the member view shows of the member's own
 * subscription (SPEC Phase 4): a payment that needs them, and the cancellation they scheduled,
 * with its survey and offer. Never a score (SPEC 5.3).
 */
export interface MemberRetentionView {
  creatorName: string | null;
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
  /** The answer of a creation that stopped: the step, and the permission Whop lacked (403). */
  problem?: AlumniProblem | null;
}

export type AlumniStep = 'product' | 'variant' | 'experience' | 'attach';

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
 * GET /api/creator/:companyId/people: everyone StayPut knows on the company's Discord servers and
 * Telegram groups, not only who writes there, and each server and group. Names and dates, never
 * what was written.
 */
export interface PeopleView {
  places: PeoplePlace[];
  /** How many people StayPut knows in all; `people` holds 500 at most, the latest to write first. */
  total: number;
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

/** GET /health */
export interface HealthReport {
  status: 'ok' | 'degraded';
  whopEnv: 'sandbox' | 'production';
  /** `timeout`: no answer within 5 s (HEALTH_DB_TIMEOUT_MS in apps/worker). */
  database: 'ok' | 'unreachable' | 'timeout' | 'outdated' | 'not_configured';
}
