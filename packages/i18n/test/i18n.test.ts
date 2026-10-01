import { describe, expect, it } from 'vitest';
import { MESSAGES, createTranslator, isLocale, matchLocale, type MessageKey } from '../src';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  it('French has exactly the English keys', () => {
    expect(Object.keys(MESSAGES.fr).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it('keeps the same {placeholders} in every language', () => {
    for (const key of Object.keys(MESSAGES.en) as MessageKey[]) {
      expect(placeholders(MESSAGES.fr[key]), key).toEqual(placeholders(MESSAGES.en[key]));
    }
  });

  it('has no empty text and no leftover spaces', () => {
    for (const [locale, messages] of Object.entries(MESSAGES)) {
      for (const [key, text] of Object.entries(messages)) {
        expect(text.trim(), `${locale} ${key}`).toBe(text);
        expect(text.length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('pairs every plural .one with an .other', () => {
    for (const key of Object.keys(MESSAGES.en)) {
      if (key.endsWith('.one')) expect(MESSAGES.en).toHaveProperty(`${key.slice(0, -4)}.other`);
    }
  });
});

describe('matchLocale', () => {
  it('takes the first supported language of the preferences', () => {
    expect(matchLocale(['fr-CA', 'en-US'])).toBe('fr');
    expect(matchLocale(['de-DE', 'en-GB'])).toBe('en');
    expect(matchLocale(['FR'])).toBe('fr');
  });

  it('falls back to English', () => {
    expect(matchLocale(['de', 'es'])).toBe('en');
    expect(matchLocale([])).toBe('en');
    expect(isLocale('es')).toBe(false);
  });
});

describe('createTranslator', () => {
  it('fills the placeholders', () => {
    expect(createTranslator('en').t('creator.connected', { companyId: 'biz_1' })).toBe(
      'Connected as a team member of biz_1.',
    );
    expect(createTranslator('fr').t('creator.connected', { companyId: 'biz_1' })).toBe(
      "Connecté en tant que membre de l'équipe de biz_1.",
    );
  });

  it('leaves an unknown placeholder visible rather than guessing', () => {
    expect(createTranslator('en').t('creator.connected')).toContain('{companyId}');
  });

  it('picks the plural form of the language', () => {
    const en = createTranslator('en');
    expect(en.plural('members.count', 1)).toBe('1 member');
    expect(en.plural('members.count', 1200)).toBe('1,200 members');
    const fr = createTranslator('fr');
    // French treats 0 and 1 as singular.
    expect(fr.plural('members.count', 0)).toBe('0 membre');
    expect(fr.plural('members.count', 2)).toBe('2 membres');
  });

  it('formats numbers, amounts and dates for the locale', () => {
    const fr = createTranslator('fr');
    expect(fr.currency(1234.5, 'EUR')).toMatch(/^1\s234,50\s€$/);
    expect(createTranslator('en').currency(1234.5, 'USD')).toBe('$1,234.50');
    expect(fr.number(0.5)).toBe('0,5');
    expect(createTranslator('en').date(new Date('2026-09-30T12:00:00Z'))).toBe('Sep 30, 2026');
  });

  it('formats shares and calendar months', () => {
    expect(createTranslator('en').percent(0.164)).toBe('16%');
    expect(createTranslator('fr').percent(0.5)).toMatch(/^50\s%$/);
    // Read in UTC: the first of a month is that month in every time zone.
    expect(createTranslator('en').month(new Date('2026-09-01'))).toBe('September 2026');
    expect(createTranslator('fr').month(new Date('2026-09-01'))).toBe('septembre 2026');
  });

  it('says how long ago, in the largest unit that fits', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const en = createTranslator('en');
    expect(en.relative(ago(20_000), now)).toBe('this minute');
    expect(en.relative(ago(5 * 60_000), now)).toBe('5 minutes ago');
    expect(en.relative(ago(3 * 3_600_000), now)).toBe('3 hours ago');
    expect(en.relative(ago(86_400_000), now)).toBe('yesterday');
    const fr = createTranslator('fr');
    expect(fr.relative(ago(2 * 3_600_000), now)).toBe('il y a 2 heures');
    expect(fr.relative(ago(3 * 86_400_000), now)).toBe('il y a 3 jours');
  });
});
