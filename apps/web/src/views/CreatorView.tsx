import type { CreatorSession, IntegrationsStatus, MembersPage } from '@stayput/core';
import { ChartColumn, LayoutDashboard, Plug, SlidersHorizontal, Users, Zap } from 'lucide-react';
import { Outlet, useOutletContext, useParams } from 'react-router';
import { useApi, useReloadOnReturn, type Loadable } from '../api';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { useI18n } from '../i18n';
import { useSync, type SyncState } from '../sync';
import { NavTabs } from '../ui/Tabs';

/** What every section of the creator view reads, loaded once for all of them. */
export interface CreatorData {
  companyId: string;
  /** `/dashboard/<company>`: the sections' links start here. */
  root: string;
  /** `/api/creator/<company>`. */
  api: string;
  members: { state: Loadable<MembersPage>; retry: () => void; reload: () => void };
  sync: SyncState;
  integrations: { state: Loadable<IntegrationsStatus>; retry: () => void; reload: () => void };
}

export function useCreatorData(): CreatorData {
  return useOutletContext<CreatorData>();
}

/** The creator view (Whop "dashboard view", /dashboard/:companyId): the team only. */
export function CreatorView() {
  const { companyId = '' } = useParams();
  const { state, retry } = useApi<CreatorSession>(
    `/api/creator/${encodeURIComponent(companyId)}/session`,
  );

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <Dashboard session={state.data} />;
}

/**
 * The sections of the dashboard (SPEC Phase 2, then Phase 6): an overview, the members, the
 * analyses, the activity sources and the settings. The members and the sources are read once
 * here and kept while the creator moves between sections; both are read again each time a
 * synchronization brings something new, the sources also each time the creator comes back to
 * the page (after connecting one in another tab).
 */
function Dashboard({ session }: { session: CreatorSession }) {
  const { t, locale } = useI18n();
  const companyId = session.companyId;
  const api = `/api/creator/${encodeURIComponent(companyId)}`;
  const root = `/dashboard/${encodeURIComponent(companyId)}`;
  const members = useApi<MembersPage>(`${api}/members`);
  // The language goes along: the bot answers the creator's Telegram groups in it.
  const integrations = useApi<IntegrationsStatus>(`${api}/integrations?lang=${locale}`);
  useReloadOnReturn(integrations.reload);
  // A synchronization may bring members and Discord messages (« Sync now » reads Discord too).
  const sync = useSync(companyId, () => {
    members.reload();
    integrations.reload();
  });
  const data: CreatorData = { companyId, root, api, members, sync, integrations };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('creator.title')}
          </h1>
          <p className="mt-1 text-sm text-muted">{t('creator.connected', { companyId })}</p>
        </div>
        <SignOut via={session.via} />
      </div>
      <NavTabs
        label={t('creator.sections')}
        items={[
          {
            to: root,
            end: true,
            label: t('creator.tab.overview'),
            icon: <LayoutDashboard aria-hidden="true" className="size-4" />,
          },
          {
            to: `${root}/members`,
            label: t('creator.tab.members'),
            icon: <Users aria-hidden="true" className="size-4" />,
          },
          {
            to: `${root}/actions`,
            label: t('creator.tab.actions'),
            icon: <Zap aria-hidden="true" className="size-4" />,
          },
          {
            to: `${root}/insights`,
            label: t('creator.tab.insights'),
            icon: <ChartColumn aria-hidden="true" className="size-4" />,
          },
          {
            to: `${root}/sources`,
            label: t('creator.tab.sources'),
            icon: <Plug aria-hidden="true" className="size-4" />,
          },
          {
            to: `${root}/settings`,
            label: t('creator.tab.settings'),
            icon: <SlidersHorizontal aria-hidden="true" className="size-4" />,
          },
        ]}
      />
      <Outlet context={data} />
    </div>
  );
}
