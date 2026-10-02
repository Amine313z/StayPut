/**
 * The announcements of the members' milestones (SPEC Phase 5, point 4): a public message in the
 * community's chat, when the creator chose where and the member asked for it, in the community's
 * language. Only the member's first name, the goal they chose and the milestone: never their
 * numbers (an income is nobody else's business).
 */

import type { TemplateLocale } from './templates';

/** Where an announcement goes: a Whop chat channel, a Discord channel, a Telegram group. */
export type AnnouncePlatform = 'whop' | 'discord' | 'telegram';

export const ANNOUNCE_PLATFORMS: readonly AnnouncePlatform[] = ['whop', 'discord', 'telegram'];

export function isAnnouncePlatform(value: unknown): value is AnnouncePlatform {
  return typeof value === 'string' && (ANNOUNCE_PLATFORMS as readonly string[]).includes(value);
}

/** The ids each platform gives its channels. */
const IDS: Readonly<Record<AnnouncePlatform, RegExp>> = {
  whop: /^[A-Za-z0-9_]{1,64}$/,
  discord: /^[0-9]{5,25}$/,
  telegram: /^-?[0-9]{1,20}$/,
};

export interface AnnounceTarget {
  platform: AnnouncePlatform;
  id: string;
}

/** A destination as the creator sent it; null when it is not one. */
export function parseAnnounceTarget(value: unknown): AnnounceTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  if (!isAnnouncePlatform(item.platform) || typeof item.id !== 'string') return null;
  return IDS[item.platform].test(item.id) ? { platform: item.platform, id: item.id } : null;
}

/** The text of an announcement, in the community's language. */
export function announcementText(
  locale: TemplateLocale,
  values: { firstName: string | null; goal: string; percent: number },
): string {
  const percent = Math.round(values.percent);
  if (locale === 'fr') {
    const name = values.firstName ?? 'Un membre';
    return percent >= 100
      ? `🏆 ${name} a atteint son objectif : « ${values.goal} » ! Bravo !`
      : `🎉 ${name} a atteint ${percent}\u00a0% de son objectif : « ${values.goal} » !`;
  }
  const name = values.firstName ?? 'A member';
  return percent >= 100
    ? `🏆 ${name} reached their goal: “${values.goal}”! Congratulations!`
    : `🎉 ${name} reached ${percent}% of their goal: “${values.goal}”!`;
}
