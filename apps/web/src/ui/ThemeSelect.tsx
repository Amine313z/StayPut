import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../theme';

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

/**
 * The theme: dark (StayPut's own), light, or the device's. A native select with an icon: the
 * keyboard, screen readers and phones handle it themselves.
 */
export function ThemeSelect({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();
  return (
    <span className="relative inline-flex items-center">
      <span className="pointer-events-none absolute start-2.5 text-subtle">
        {THEME_ICONS[preference]}
      </span>
      <select
        aria-label={t('settings.theme')}
        className={`appearance-none rounded-lg border border-line bg-surface py-1.5 ps-8 text-sm text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          compact ? 'w-9 pe-0 text-transparent' : 'pe-3'
        }`}
        value={preference}
        onChange={(event) => {
          const next = THEME_PREFERENCES.find((p) => p === event.target.value);
          if (next) setPreference(next);
        }}
      >
        {THEME_PREFERENCES.map((option) => (
          <option key={option} value={option} className="text-fg">
            {t(THEME_LABELS[option])}
          </option>
        ))}
      </select>
    </span>
  );
}
