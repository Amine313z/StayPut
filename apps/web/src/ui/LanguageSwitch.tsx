import { LOCALES, type Locale } from '@stayput/i18n';
import { useI18n } from '../i18n';

/** A language is named in itself, whatever the interface language. */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };
const SHORT: Record<Locale, string> = { en: 'EN', fr: 'FR' };

/**
 * The interface language, switched at once (no reload): words, numbers, dates and money follow.
 * Two pressed-or-not buttons, each named in its own language.
 */
export function LanguageSwitch() {
  const { t, locale, setLocale } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('settings.language')}
      className="inline-flex rounded-lg border border-line bg-surface p-0.5"
    >
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-label={LANGUAGE_NAMES[code]}
          aria-pressed={locale === code}
          onClick={() => setLocale(code)}
          className={`tabular rounded-md px-2 py-1 text-xs font-semibold transition-colors duration-150 ease-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            locale === code ? 'bg-accent-soft text-accent' : 'text-subtle hover:text-fg'
          }`}
        >
          {SHORT[code]}
        </button>
      ))}
    </div>
  );
}
