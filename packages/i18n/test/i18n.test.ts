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
});
