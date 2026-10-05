/**
 * StayPut's own running (SPEC Phase 8.5): what an error may keep of its message, and how a
 * scheduled job is doing. Pure: the Worker records, the status page shows.
 */

/** What an error keeps of its message at most. */
export const ERROR_MESSAGE_MAX = 300;

/**
 * An error's message as StayPut may keep and show it: no secret, no person (SPEC 8.2). E-mail
 * addresses, a person's Whop ids, long numbers (phone numbers, Discord and Telegram accounts),
 * keys, tokens and the query of an address are replaced by what they were; control characters
 * and runs of spaces go; the message is cut at ERROR_MESSAGE_MAX characters.
 */
export function scrubErrorMessage(message: unknown): string {
  const text =
    message instanceof Error
      ? message.message
      : typeof message === 'string'
        ? message
        : String(message);
  const scrubbed = text
    // Control characters (a stack's line breaks, a terminal's colors) and runs of spaces.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?[query]')
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b(apik|ws|sk|pk|whsec|key)_[A-Za-z0-9_-]+/g, '$1_[redacted]')
    .replace(/\b(user|mber|mem)_[A-Za-z0-9]+/g, '$1_…')
    // Tokens, keys, hashes: a long run of letters and digits with no space.
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
    .replace(/\+\d[\d .-]{6,}\d/g, '[number]')
    .replace(/\d{8,}/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  const kept = scrubbed || 'unknown error';
  return kept.length > ERROR_MESSAGE_MAX ? `${kept.slice(0, ERROR_MESSAGE_MAX - 1)}…` : kept;
}

/** How a scheduled job is doing, as the status page says it. */
export type JobState = 'ok' | 'failing' | 'late' | 'never';

export interface JobRunTimes {
  lastFinishedAt: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

/**
 * A job that never ran, whose last run failed, whose last run is more than two periods (and 5
 * minutes) old — Cloudflare skipped it, or the Worker stopped — or that is fine.
 */
export function jobState(run: JobRunTimes | null, everyMinutes: number, now: Date): JobState {
  if (!run?.lastFinishedAt) return 'never';
  const at = (iso: string | null) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);
  if (at(run.lastFailedAt) > at(run.lastOkAt)) return 'failing';
  const lateAfter = (2 * everyMinutes + 5) * 60_000;
  if (now.getTime() - at(run.lastFinishedAt) > lateAfter) return 'late';
  return 'ok';
}
