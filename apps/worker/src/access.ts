import type { AccessLevel } from '@stayput/core';

/**
 * Whop's answer to "what access does this user have to this resource", remembered for a few
 * minutes by this Worker instance: the dashboard makes several calls per screen, each one would
 * otherwise cost a request to Whop (and one of the 50 subrequests of a free invocation).
 * A refusal is kept for a shorter time, so a new admin gets in quickly.
 */
export class AccessCache {
  private readonly entries = new Map<string, { level: AccessLevel; expiresAt: number }>();

  constructor(
    private readonly grantedMs = 5 * 60_000,
    private readonly deniedMs = 30_000,
    private readonly maxEntries = 1_000,
  ) {}

  get(userId: string, resourceId: string, now: number): AccessLevel | null {
    const key = `${userId}:${resourceId}`;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.level;
  }

  set(userId: string, resourceId: string, level: AccessLevel, now: number): void {
    const key = `${userId}:${resourceId}`;
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      // Maps keep insertion order: the first key is the oldest entry.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const ttl = level === 'no_access' ? this.deniedMs : this.grantedMs;
    this.entries.set(key, { level, expiresAt: now + ttl });
  }
}
