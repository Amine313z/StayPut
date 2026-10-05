import { describe, expect, it } from 'vitest';
import { badgePercent, badgeText, retentionBadgeSvg } from '../src/badge';

/** Intl's no-break spaces (French writes 92 % with one) as plain ones, to compare. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('the « Verified retention » badge (SPEC Phase 6.11)', () => {
  it('says the figure in each language, rounded to the percent', () => {
    expect(badgePercent('en', 0.9234)).toBe('92%');
    expect(plain(badgePercent('fr', 0.9256))).toBe('93 %');
    expect(badgeText('en', 0.85)).toBe('Verified retention: 85% at 90 days');
    expect(plain(badgeText('fr', 0.85))).toBe('Rétention vérifiée: 85 % à 90 jours');
  });

  it('draws one SVG, 20 px high, its words in its title for screen readers', () => {
    const svg = retentionBadgeSvg('en', 0.85);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20"/);
    expect(svg).toContain('role="img" aria-label="Verified retention: 85% at 90 days"');
    expect(svg).toContain('<title>Verified retention: 85% at 90 days</title>');
    expect(svg).toContain('>85% at 90 days</text>');
    // The figure's half is StayPut's turquoise; nothing runs, nothing is fetched.
    expect(svg).toContain('fill="#5eead4"');
    expect(svg).not.toMatch(/<script|href=|url\((?!#r\))/);
    // A longer figure, a wider badge.
    const width = (s: string) => Number(/width="(\d+)"/.exec(s)![1]);
    expect(width(retentionBadgeSvg('fr', 0.85))).toBeGreaterThan(width(svg));
  });
});
