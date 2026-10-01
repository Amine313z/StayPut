import type { MemberSession } from '@stayput/core';
import { useParams } from 'react-router';
import { useApi } from '../api';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { useI18n } from '../i18n';

/**
 * The member view (Whop "experience view", /experiences/:experienceId): progress, never
 * surveillance, and never a risk score (SPEC 5.3).
 */
export function MemberView() {
  const { experienceId = '' } = useParams();
  const { t } = useI18n();
  const { state, retry } = useApi<MemberSession>(
    `/api/member/${encodeURIComponent(experienceId)}/session`,
  );

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return <ErrorPanel error={state.error} forbiddenKey="error.forbidden.member" onRetry={retry} />;
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('member.title')}</h1>
      <p className="text-muted">{t('member.welcome')}</p>
      <SignOut via={state.data.via} />
    </div>
  );
}
