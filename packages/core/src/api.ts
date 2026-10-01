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

/** GET /health */
export interface HealthReport {
  status: 'ok' | 'degraded';
  whopEnv: 'sandbox' | 'production';
  /** `timeout`: no answer within 5 s (HEALTH_DB_TIMEOUT_MS in apps/worker). */
  database: 'ok' | 'unreachable' | 'timeout' | 'outdated' | 'not_configured';
}
