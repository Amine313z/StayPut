import {
  DEFAULT_LOCALE,
  createTranslator,
  isLocale,
  type Locale,
  type Translator,
} from '@stayput/i18n';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { readPreference, writePreference } from './storage';

/** A community's choice of language, kept in this browser for that community's app alone. */
const STORAGE_PREFIX = 'stayput.locale.';

/**
 * The language a community's app opens in: the one chosen in its Settings › General, else
 * English, the app's official language. A choice is kept for that creator's own app only, never
 * for the demo, which always opens in English (brief v4 §3); the browser's languages are never
 * read.
 */
export function savedLocale(companyId: string | null): Locale {
  const saved = companyId ? readPreference(`${STORAGE_PREFIX}${companyId}`) : null;
  return isLocale(saved) ? saved : DEFAULT_LOCALE;
}

/** The community of an address (`/dashboard/<id>/…`), read before the router runs; else none. */
export function companyOf(pathname: string): string | null {
  const id = /^\/dashboard\/([^/]+)/.exec(pathname)?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** The language of the page being opened: its community's choice, else English (the demo too). */
export function detectLocale(pathname = window.location.pathname): Locale {
  return savedLocale(companyOf(pathname));
}

interface I18nContextValue extends Translator {
  setLocale: (locale: Locale) => void;
  /**
   * The app now open: a community's (its language comes back, and a new choice is kept for it),
   * or the demo's (`null`: English, nothing kept).
   */
  enterCommunity: (companyId: string | null) => void;
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
  const community = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const enterCommunity = useCallback((companyId: string | null) => {
    community.current = companyId;
    if (companyId === null) {
      setLocale(DEFAULT_LOCALE);
      return;
    }
    const saved = readPreference(`${STORAGE_PREFIX}${companyId}`);
    if (isLocale(saved)) setLocale(saved);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      ...createTranslator(locale),
      setLocale: (next) => {
        if (community.current) writePreference(`${STORAGE_PREFIX}${community.current}`, next);
        setLocale(next);
      },
      enterCommunity,
    }),
    [locale, enterCommunity],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Every text of the interface comes from here: `t('key')`, never a string in the markup. */
export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}
