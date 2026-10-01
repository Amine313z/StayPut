import type { CreatorSession, MembersPage } from '@stayput/core';
import { useParams } from 'react-router';
import { useApi } from '../api';
import { MembersList } from '../components/MembersList';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { SyncPanel } from '../components/SyncPanel';
import { useI18n } from '../i18n';
import { useSync } from '../sync';

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
      <Dashboard companyId={state.data.companyId} />
    </div>
  );
}

/**
 * What StayPut collected (SPEC Phase 2): where the reading of Whop stands, then the members. The
 * list is read again each time a synchronization brings something new.
 */
function Dashboard({ companyId }: { companyId: string }) {
  const members = useApi<MembersPage>(`/api/creator/${encodeURIComponent(companyId)}/members`);
  const sync = useSync(companyId, members.reload);
  return (
    <>
      <SyncPanel sync={sync} />
      {members.state.status === 'loading' ? (
        <Loading />
      ) : members.state.status === 'error' ? (
        <ErrorPanel
          error={members.state.error}
          forbiddenKey="error.forbidden.creator"
          onRetry={members.retry}
        />
      ) : (
        <MembersList page={members.state.data} />
      )}
    </>
  );
}
