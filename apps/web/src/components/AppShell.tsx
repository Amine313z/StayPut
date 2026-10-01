import { LOCALES, isLocale, type Locale } from '@stayput/i18n';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';
import { useI18n } from '../i18n';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../theme';
import { StayPutMark } from '../ui/BrandIcons';

const THEME_LABELS = {
  system: 'settings.theme.system',
  light: 'settings.theme.light',
  dark: 'settings.theme.dark',
} as const;

const THEME_ICONS: Record<ThemePreference, ReactNode> = {
  system: <Monitor aria-hidden="true" className="size-4" />,
  light: <Sun aria-hidden="true" className="size-4" />,
  dark: <Moon aria-hidden="true" className="size-4" />,
};

// A language is named in itself, whatever the interface language: « English », « Français ».
const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };

const SELECT_CLASS =
  'appearance-none rounded-lg border border-line bg-surface py-1.5 ps-8 pe-3 text-sm text-fg ' +
  'shadow-card hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent';

/** A native select with an icon: keyboard, screen readers and phones handle it themselves. */
function IconSelect({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="relative inline-flex items-center">
      <span className="pointer-events-none absolute start-2.5 text-muted">{icon}</span>
      {children}
    </span>
  );
}

/** Header (mark, language, theme) and the current screen. Mobile first: one column. */
export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const { preference, setPreference } = useTheme();

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <StayPutMark className="size-7" />
            <span className="text-base font-semibold tracking-tight">{t('app.name')}</span>
          </Link>
          <div className="flex items-center gap-2">
            <IconSelect icon={<Languages aria-hidden="true" className="size-4" />}>
              <select
                aria-label={t('settings.language')}
                className={SELECT_CLASS}
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
            </IconSelect>
            <IconSelect icon={THEME_ICONS[preference]}>
              <select
                aria-label={t('settings.theme')}
                className={SELECT_CLASS}
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
            </IconSelect>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
