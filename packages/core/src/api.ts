import type { AccessLevel } from './access';

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
  /** Members in the community now (status `joined`). */
  members: number;
  /** Memberships that still give access (LIVE_MEMBERSHIP_STATUSES). */
  liveMemberships: number;
  /** Live memberships set to end at the close of the period. */
  scheduledCancellations: number;
  /** Members whose latest payment failed (FAILED_PAYMENT_STATUSES). */
  failedPayments: number;
  /** Activity recorded over the last 30 days: messages, reactions, posts, lessons, tickets. */
  activity30d: number;
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

/** GET /health */
export interface HealthReport {
  status: 'ok' | 'degraded';
  whopEnv: 'sandbox' | 'production';
  /** `timeout`: no answer within 5 s (HEALTH_DB_TIMEOUT_MS in apps/worker). */
  database: 'ok' | 'unreachable' | 'timeout' | 'outdated' | 'not_configured';
}
