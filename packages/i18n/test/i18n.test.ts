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
    expect(createTranslator('en').t('nav.tabs', { section: 'Members' })).toBe('Members tabs');
    expect(createTranslator('fr').t('nav.tabs', { section: 'Membres' })).toBe('Onglets : Membres');
  });

  it('leaves an unknown placeholder visible rather than guessing', () => {
    expect(createTranslator('en').t('nav.tabs')).toContain('{section}');
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
    // Whop's way (brief v4 §7): the symbol and the cents, always; never « $US », never « $247 ».
    expect(createTranslator('en').currency(247, 'USD')).toBe('$247.00');
    expect(fr.currency(247, 'USD')).toMatch(/^247,00\s\$$/);
    expect(fr.currency(1284.5, 'USD')).toMatch(/^1\s284,50\s\$$/);
    expect(fr.number(0.5)).toBe('0,5');
    expect(createTranslator('en').date(new Date('2026-09-30T12:00:00Z'))).toBe('Sep 30, 2026');
    // A chart's axis: short.
    expect(createTranslator('en').day(new Date('2026-09-30T12:00:00Z'))).toBe('Sep 30');
    expect(fr.day(new Date('2026-09-30T12:00:00Z'))).toBe('30 sept.');
    expect(createTranslator('en').currency(1240, 'USD', { compact: true })).toBe('$1.2K');
    expect(fr.currency(1240, 'EUR', { compact: true })).toMatch(/^1,2\sk\s?€$/);
    expect(createTranslator('en').currency(500, 'USD', { compact: true })).toBe('$500');
  });

  it('formats shares and calendar months', () => {
    expect(createTranslator('en').percent(0.164)).toBe('16%');
    expect(createTranslator('fr').percent(0.5)).toMatch(/^50\s%$/);
    // Read in UTC: the first of a month is that month in every time zone.
    expect(createTranslator('en').month(new Date('2026-09-01'))).toBe('September 2026');
    expect(createTranslator('fr').month(new Date('2026-09-01'))).toBe('septembre 2026');
  });

  it('writes a community’s calendar day as it is, in English and in French', () => {
    // Whatever the reader's time zone: never the day before, never the day after.
    const en = createTranslator('en');
    const fr = createTranslator('fr');
    expect(en.calendarDate('2026-10-01')).toBe('Oct 1, 2026');
    expect(fr.calendarDate('2026-10-01')).toBe('1 oct. 2026');
    expect(en.calendarDay('2026-09-30')).toBe('Sep 30');
    expect(fr.calendarDay('2026-09-30')).toBe('30 sept.');
    expect(en.calendarMonth('2026-09-30')).toBe('September');
    expect(fr.calendarMonth('2026-09-30')).toBe('septembre');
    expect(en.calendarDate('2027-01-01')).toBe('Jan 1, 2027');
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

  it('counts whole days on the calendar, as the dates the app shows', () => {
    // In the reader's own calendar (local dates: the same in every time zone running the tests).
    const evening = new Date(2026, 9, 3, 19, 8);
    const en = createTranslator('en');
    const fr = createTranslator('fr');
    // 41 hours before this evening: 2 October at 02:08, yesterday.
    expect(en.relative(new Date(2026, 9, 2, 2, 8), evening)).toBe('yesterday');
    expect(fr.relative(new Date(2026, 9, 2, 2, 8), evening)).toBe('hier');
    // 26 hours before 01:00: 1 October at 23:00, two days ago on the calendar.
    expect(en.relative(new Date(2026, 9, 1, 23, 0), new Date(2026, 9, 3, 1, 0))).toBe('2 days ago');
    // Under a day, hours; from a week, weeks.
    expect(en.relative(new Date(2026, 9, 2, 20, 8), evening)).toBe('23 hours ago');
    expect(en.relative(new Date(2026, 8, 25, 19, 8), evening)).toBe('last week');
  });
});
