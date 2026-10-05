/**
 * The « Verified retention » badge (SPEC Phase 6.11): a community's real retention at 90 days,
 * as an SVG it may show on its sales page, linked to a public page that says how it was counted.
 * Pure: the Worker serves it at /badge/:companyId.svg, the dashboard previews the same drawing.
 */

/** The arrivals the badge counts: members who joined in the last 12 months... */
export const BADGE_MONTHS = 12;
/** ...at least this many old enough (90 days) for a figure; none below. */
export const BADGE_MIN_MEMBERS = 10;

export type BadgeLocale = 'en' | 'fr';

const WORDS: Record<BadgeLocale, { label: string; value: (percent: string) => string }> = {
  en: { label: 'Verified retention', value: (p) => `${p} at 90 days` },
  fr: { label: 'Rétention vérifiée', value: (p) => `${p} à 90 jours` },
};

/** The badge's words: what a screen reader and the link's title say. */
export function badgeText(locale: BadgeLocale, retention: number): string {
  const words = WORDS[locale];
  return `${words.label}: ${words.value(badgePercent(locale, retention))}`;
}

/** 0.923 → « 92% » / « 92 % », as each language writes a share. */
export function badgePercent(locale: BadgeLocale, retention: number): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    retention,
  );
}

/** Roughly how wide 11 px Verdana draws `text`: the badge's two halves are sized from it. */
function width(text: string): number {
  let total = 0;
  for (const char of text) {
    total += /[mwMW%]/.test(char) ? 10 : /[ilI.,:’' ]/.test(char) ? 3.6 : /\d/.test(char) ? 7 : 6.7;
  }
  return Math.ceil(total);
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The badge: « Verified retention » on black, the figure on StayPut's turquoise, 20 px high like
 * the badges sales pages already show. Its <title> says it in full.
 */
export function retentionBadgeSvg(locale: BadgeLocale, retention: number): string {
  const words = WORDS[locale];
  const label = words.label;
  const value = words.value(badgePercent(locale, retention));
  const left = width(label) + 20;
  const right = width(value) + 20;
  const total = left + right;
  const title = escape(badgeText(locale, retention));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<clipPath id="r"><rect width="${total}" height="20" rx="4"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${left}" height="20" fill="#0a0f0f"/>`,
    `<rect x="${left}" width="${right}" height="20" fill="#5eead4"/>`,
    `</g>`,
    `<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `<text x="${left / 2}" y="14" fill="#ffffff">${escape(label)}</text>`,
    `<text x="${left + right / 2}" y="14" fill="#04201c" font-weight="bold">${escape(value)}</text>`,
    `</g>`,
    `</svg>`,
  ].join('');
}
