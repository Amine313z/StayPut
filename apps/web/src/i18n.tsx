import {
  DEFAULT_LOCALE,
  createTranslator,
  isLocale,
  type Locale,
  type Translator,
} from '@stayput/i18n';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPreference, writePreference } from './storage';

const STORAGE_KEY = 'stayput.locale';

/**
 * The language chosen in Settings › General, else English: the app's official language. The
 * browser's languages are never read (the redesign brief, 2 October).
 */
export function detectLocale(): Locale {
  const saved = readPreference(STORAGE_KEY);
  return isLocale(saved) ? saved : DEFAULT_LOCALE;
}

interface I18nContextValue extends Translator {
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? detectLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      ...createTranslator(locale),
      setLocale: (next) => {
        writePreference(STORAGE_KEY, next);
        setLocale(next);
      },
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Every text of the interface comes from here: `t('key')`, never a string in the markup. */
export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}
