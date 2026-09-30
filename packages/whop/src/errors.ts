import type { Whop } from '@whop/sdk';

/**
 * A Whop call that did not succeed: an HTTP error (`status` ≥ 400), a network failure
 * (`status` 0) or a response we cannot read (`type` "invalid_response").
 */
export class WhopApiError extends Error {
  override readonly name = 'WhopApiError';

  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly details: {
      readonly method: string;
      readonly path: string;
      readonly code?: string | null;
      readonly param?: string | null;
      /** How long Whop asked us to wait before retrying (429), when it said so. */
      readonly retryAfterMs?: number | null;
    },
  ) {
    super(`${details.method} ${details.path}: ${status} ${type}: ${message}`);
  }
}

/** Every Whop error body has this shape (`{ error: { type, message, code?, param? } }`). */
type WhopErrorBody = Whop.ForbiddenErrorBody;

export function readErrorBody(text: string): WhopErrorBody['error'] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return null;
    const error = parsed.error;
    if (typeof error !== 'object' || error === null) return null;
    const { type, message, code, param } = error as Record<string, unknown>;
    if (typeof message !== 'string') return null;
    return {
      type: typeof type === 'string' ? type : 'unknown',
      message,
      code: typeof code === 'string' ? code : null,
      param: typeof param === 'string' ? param : null,
    };
  } catch {
    return null;
  }
}
