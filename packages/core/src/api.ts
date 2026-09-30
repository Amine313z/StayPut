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
  };
}

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
}

/** GET /api/member/:experienceId/session */
export interface MemberSession {
  experienceId: string;
  userId: string;
  accessLevel: AccessLevel;
}

/** GET /health */
export interface HealthReport {
  status: 'ok' | 'degraded';
  whopEnv: 'sandbox' | 'production';
  database: 'ok' | 'unreachable' | 'outdated' | 'not_configured';
}
