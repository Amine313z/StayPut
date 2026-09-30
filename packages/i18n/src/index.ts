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
  currency: (amount: number, currency: string) => string;
  date: (value: Date) => string;
}

export function createTranslator(locale: Locale): Translator {
  const messages = MESSAGES[locale];
  const plurals = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

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
    currency: (amount, currency) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount),
    date: (value) => dates.format(value),
  };
}
