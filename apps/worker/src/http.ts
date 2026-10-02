import type { ApiErrorBody, ApiErrorCode } from '@stayput/core';

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  whop_unavailable: 503,
  not_configured: 503,
  internal: 500,
};

/** Every API error has this shape; the frontend maps `code` to a translated message. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  extra: Pick<ApiErrorBody['error'], 'login'> = {},
): Response {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return Response.json(body, { status: STATUS[code] });
}

/** Headers of every response the Worker itself produces (API, webhooks, health). */
export const API_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
