import { LOCALES, type Locale } from '@stayput/i18n';
import { useI18n } from '../i18n';
import { Segmented } from './Segmented';

/** A language is named in itself, whatever the interface language. */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };

/**
 * The interface language (Settings › General, the only place to change it): switched at once,
 * without reloading; words, numbers, dates and amounts follow. Each option is named in its own
 * language.
 */
export function LanguageSelect({ labelledBy }: { labelledBy: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <Segmented
      labelledBy={labelledBy}
      value={locale}
      onChange={setLocale}
      options={LOCALES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code], lang: code }))}
    />
  );
}
