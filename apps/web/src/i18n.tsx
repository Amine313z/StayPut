import {
  createTranslator,
  isLocale,
  matchLocale,
  type Locale,
  type Translator,
} from '@stayput/i18n';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPreference, writePreference } from './storage';

const STORAGE_KEY = 'stayput.locale';

/** The saved choice, else the browser's languages, else English. */
export function detectLocale(): Locale {
  const saved = readPreference(STORAGE_KEY);
  if (isLocale(saved)) return saved;
  const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return matchLocale(languages);
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
