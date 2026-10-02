/**
 * The testimonial card and its public page (SPEC Phase 5, points 6 and 7): one of the member's
 * results, its level of proof and its date, with only what they agreed to show.
 */

import type { GoalEntry } from './goals';
import type { TemplateLocale } from './templates';

/** What a card and its public page show, frozen when the member made the card. */
export interface TestimonialDisplay {
  community: string | null;
  locale: TemplateLocale;
  goal: string;
  unit: string;
  entry: GoalEntry;
  start: number;
  target: number;
  value: number;
  progress: number;
  recordedAt: string;
  /** The result's day (YYYY-MM-DD) in the community's time zone: the date the card shows. */
  day: string;
  publishedAt: string;
  /** Shown only when the member ticked it. */
  name: string | null;
  /** The member's own affiliate link to the community, when they gave it. */
  affiliateUrl: string | null;
}

export type ProofLevel = 'declared' | 'justified' | 'connected';

export function isProofLevel(value: unknown): value is ProofLevel {
  return value === 'declared' || value === 'justified' || value === 'connected';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProofId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The member's affiliate link to the community (SPEC 5.6: Whop gives no way to read it, the
 * member pastes it): a Whop address only, so that a public page never sends anyone elsewhere.
 * Null for none; undefined when it is not one.
 */
export function parseAffiliateUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 300) return undefined;
  const text = value.trim();
  // https, a host (no user name or password before it), then a path.
  const match = /^https:\/\/([a-z0-9.-]+)(?::\d{1,5})?(\/[^\s"'<>]*)?$/i.exec(text);
  const host = match?.[1]?.toLowerCase();
  if (!host) return undefined;
  return host === 'whop.com' || host.endsWith('.whop.com') ? text : undefined;
}

/** A card the member asks for: which result, their name or not, their link or not. */
export interface CardRequest {
  resultId: string;
  showName: boolean;
  affiliateUrl: string | null;
}

export function parseCardRequest(value: unknown): CardRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.resultId !== 'string' || !UUID.test(item.resultId)) return null;
  if (typeof item.showName !== 'boolean') return null;
  const affiliateUrl = parseAffiliateUrl(item.affiliateUrl);
  if (affiliateUrl === undefined) return null;
  return { resultId: item.resultId, showName: item.showName, affiliateUrl };
}
