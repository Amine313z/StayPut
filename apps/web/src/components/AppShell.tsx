import { Outlet } from 'react-router';
import { useBootReady } from '../boot';
import { useI18n } from '../i18n';
import { StayPutMark } from '../ui/BrandIcons';

/**
 * The pages outside the dashboard (StayPut's home, the member view, the way back from Discord):
 * the mark, then the screen. The mark leads nowhere: inside Whop's frame, StayPut's home is a
 * dead end that says to open StayPut from Whop (2026-10-08). No language or theme choice here:
 * the language is chosen in the dashboard's Settings only, and the member view speaks the
 * community's language.
 */
export function AppShell() {
  const { t } = useI18n();
  useBootReady();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center px-4 py-3">
          <div className="flex items-center gap-2">
            <StayPutMark size={28} />
            <span className="font-display text-base font-semibold tracking-tight text-fg">
              {t('app.name')}
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
