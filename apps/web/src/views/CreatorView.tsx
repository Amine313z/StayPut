import type { CreatorSession } from '@stayput/core';
import { useParams } from 'react-router';
import { useApi } from '../api';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { useI18n } from '../i18n';

/** The creator view (Whop "dashboard view", /dashboard/:companyId): the team only. */
export function CreatorView() {
  const { companyId = '' } = useParams();
  const { t } = useI18n();
  const { state, retry } = useApi<CreatorSession>(
    `/api/creator/${encodeURIComponent(companyId)}/session`,
  );

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('creator.title')}</h1>
        <p className="mt-2 text-muted">
          {t('creator.connected', { companyId: state.data.companyId })}
        </p>
        <div className="mt-2">
          <SignOut via={state.data.via} />
        </div>
      </div>
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h2 className="font-semibold">{t('creator.setup.title')}</h2>
        <p className="mt-2 text-muted">{t('creator.setup.body')}</p>
      </section>
    </div>
  );
}
