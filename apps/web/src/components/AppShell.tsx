import { LOCALES, isLocale, type Locale } from '@stayput/i18n';
import { Outlet } from 'react-router';
import { useI18n } from '../i18n';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../theme';

const THEME_LABELS = {
  system: 'settings.theme.system',
  light: 'settings.theme.light',
  dark: 'settings.theme.dark',
} as const;

// A language is named in itself, whatever the interface language: « English », « Français ».
const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };

/** Header (name, language, theme) and the current screen. Mobile first: one column. */
export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const { preference, setPreference } = useTheme();
  const selectClass =
    'rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">{t('app.name')}</span>
          <div className="flex items-center gap-2">
            <select
              aria-label={t('settings.language')}
              className={selectClass}
              value={locale}
              onChange={(event) => {
                if (isLocale(event.target.value)) setLocale(event.target.value);
              }}
            >
              {LOCALES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {LANGUAGE_NAMES[code]}
                </option>
              ))}
            </select>
            <select
              aria-label={t('settings.theme')}
              className={selectClass}
              value={preference}
              onChange={(event) => {
                const next = THEME_PREFERENCES.find((p) => p === event.target.value);
                if (next) setPreference(next satisfies ThemePreference);
              }}
            >
              {THEME_PREFERENCES.map((option) => (
                <option key={option} value={option}>
                  {t(THEME_LABELS[option])}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}
