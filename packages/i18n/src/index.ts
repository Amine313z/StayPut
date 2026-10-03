import { en, type MessageKey, type Messages } from './locales/en';
import { fr } from './locales/fr';

export type { MessageKey, Messages };

export type Locale = 'en' | 'fr';

/** English by default, French second (SPEC, rule 5). */
export const LOCALES: readonly Locale[] = ['en', 'fr'];
export const DEFAULT_LOCALE: Locale = 'en';

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, fr };

export type Params = Readonly<Record<string, string | number>>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The first supported language of a preference list (`navigator.languages`: "fr-CA", "en"…). */
export function matchLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const language = preference.toLowerCase().split('-')[0];
    if (isLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}

/** Keys whose value is a plural form: `members.count` for `members.count.one` / `.other`. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.other` ? Base : never;
}[MessageKey];

// Function properties rather than methods: components destructure them (`const { t } = …`).
export interface Translator {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  /** The plural form for `count` (passed as `{count}`, formatted for the locale). */
  plural: (key: PluralKey, count: number, params?: Params) => string;
  number: (value: number) => string;
  /**
   * An amount in its currency, always with its symbol and its cents, as Whop writes a balance
   * (brief v4 §7): « $247.00 », « 247,00 $ », the symbol alone (never « $US »). `compact`
   * shortens it for a chart's axis only (« $1.2K », « 1,2 k€ »).
   */
  currency: (amount: number, currency: string, options?: { compact?: boolean }) => string;
  /** A share from 0 to 1, as a whole percentage: « 42% », « 42 % ». */
  percent: (ratio: number) => string;
  date: (value: Date) => string;
  /** A day without its year, for a chart's axis: « Oct 12 », « 12 oct. ». */
  day: (value: Date) => string;
  /** A calendar month, « September 2026 » (read in UTC: `2026-09-01` is September anywhere). */
  month: (value: Date) => string;
  /** A moment: the date and the time, in the browser's time zone. */
  dateTime: (value: Date) => string;
  /** How long ago (or in how long): « 5 minutes ago », « il y a 2 heures », « hier ». */
  relative: (value: Date, now?: Date) => string;
}

// From the largest unit down: the first one that fits gives « 3 days ago » rather than « 72 h ».
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function createTranslator(locale: Locale): Translator {
  const messages = MESSAGES[locale];
  const plurals = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);
  const percents = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const days = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const months = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const moments = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const relatives = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const fill = (text: string, params?: Params) =>
    params
      ? text.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in params ? String(params[name]) : match,
        )
      : text;

  return {
    locale,
    t: (key, params) => fill(messages[key], params),
    plural: (key, count, params) => {
      const form = `${key}.${plurals.select(count)}`;
      const text =
        form in messages ? messages[form as MessageKey] : messages[`${key}.other` as MessageKey];
      return fill(text, { ...params, count: numbers.format(count) });
    },
    number: (value) => numbers.format(value),
    currency: (amount, currency, options) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        ...(options?.compact
          ? { notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }
          : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      }).format(amount),
    percent: (ratio) => percents.format(ratio),
    date: (value) => dates.format(value),
    day: (value) => days.format(value),
    month: (value) => months.format(value),
    dateTime: (value) => moments.format(value),
    relative: (value, now = new Date()) => {
      const elapsed = value.getTime() - now.getTime();
      for (const [unit, ms] of UNITS) {
        if (Math.abs(elapsed) >= ms) return relatives.format(Math.round(elapsed / ms), unit);
      }
      return relatives.format(0, 'minute');
    },
  };
}
