import type { MemberHome } from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useApi } from '../api';
import { BootHold } from '../boot';
import { ErrorPanel, Loading } from '../components/Status';
import { memberSpaceEnabled } from '../features';
import { I18nProvider, useI18n } from '../i18n';

/** The member space (off in V1): its code loads only when it is on. */
const SpaceView = lazy(() => import('./MemberSpaceView').then((m) => ({ default: m.SpaceView })));

/**
 * The member view (Whop "experience view", /experiences/:experienceId). Members have no StayPut
 * space (founder, 2026-10-08): StayPut writes to them in the community's support chat, and a
 * member who opens StayPut all the same finds nothing to do, said plainly. With the member space
 * on (features.ts), it is their space: never surveillance and never a risk score (SPEC 5.3), in
 * the community's language for its members (never the browser's).
 */
export function MemberView() {
  return memberSpaceEnabled() ? (
    <Suspense fallback={<BootHold fallback={<Loading />} />}>
      <SpaceView />
    </Suspense>
  ) : (
    <NothingHere />
  );
}

/**
 * No space: the team, who open StayPut in their community, land on their dashboard; a member
 * reads that there is nothing to do here, in the community's language, nothing to answer. The
 * answer was asked as the page opened (prefetch.ts), and StayPut's loading screen stays until
 * it comes: the team never sees this page on their way to the dashboard.
 */
function NothingHere() {
  const { experienceId = '' } = useParams();
  const { state, retry } = useApi<MemberHome>(
    `/api/member/${encodeURIComponent(experienceId)}/home`,
  );
  if (state.status === 'loading') return <BootHold fallback={<Loading />} />;
  if (state.status === 'error') {
    return <ErrorPanel error={state.error} forbiddenKey="error.forbidden.member" onRetry={retry} />;
  }
  if (state.data.dashboard) return <Navigate to={state.data.dashboard} replace />;
  return (
    <SpokenIn locale={state.data.locale}>
      <Nothing />
    </SpokenIn>
  );
}

function Nothing() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="title-section">{t('member.none.title')}</p>
      <p className="mt-2 text-sm text-muted">{t('member.none.body')}</p>
    </div>
  );
}

/** The member view in the community's language (English until it is known). */
export function SpokenIn({ locale, children }: { locale: Locale | null; children: ReactNode }) {
  if (!locale) return <>{children}</>;
  return (
    <I18nProvider key={locale} initialLocale={locale}>
      {children}
    </I18nProvider>
  );
}
