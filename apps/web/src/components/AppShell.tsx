import { Link, Outlet } from 'react-router';
import { useI18n } from '../i18n';
import { StayPutMark } from '../ui/BrandIcons';

/**
 * The pages outside the dashboard (StayPut's home, the member view, the way back from Discord):
 * the mark, then the screen. No language or theme choice here: the language is chosen in the
 * dashboard's Settings only, and the member view speaks the community's language.
 */
export function AppShell() {
  const { t } = useI18n();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center px-4 py-3">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <StayPutMark size={28} />
            <span className="font-display text-base font-semibold tracking-tight text-fg">
              {t('app.name')}
            </span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
