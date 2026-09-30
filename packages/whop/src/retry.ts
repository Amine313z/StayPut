export interface RetryPolicy {
  /** Retries after the first attempt. Each one is a subrequest: the free Worker has 50. */
  maxRetries: number;
  baseDelayMs: number;
  /** A longer wait than this is not slept through: the error goes up to the caller. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/** Rate limited (429), timed out (408) or a server-side failure worth trying again. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501);
}

/** `Retry-After` in seconds or as an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** Exponential backoff with full jitter: a random wait in [0, base × 2^attempt], capped. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}
