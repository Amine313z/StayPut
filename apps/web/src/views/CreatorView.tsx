import type { CreatorSession, IntegrationsStatus, MembersPage } from '@stayput/core';
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { useApi, useReloadOnReturn, type Loadable } from '../api';
import { SignOut } from '../components/SignOut';
import { ErrorPanel, Loading } from '../components/Status';
import { useI18n } from '../i18n';
import { useSync, type SyncState } from '../sync';
import { shareTimeZone } from '../timezone';
import { SECTIONS, sectionHref, sectionOf } from './creator/sections';

/** How many things each tab of a section holds, by the tab's path. */
export type TabCounts = Record<string, number>;

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
  /** Inside a section: says how many things its tabs hold (SectionLayout). */
  tabCounts?: (counts: TabCounts) => void;
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
 * The dashboard (SPEC Phase 2, then Phase 6), as the founder laid it out on 2 October: the
 * sections in a side menu (a row on a phone), each with its tabs on top. The members and the
 * sources are read once here and kept while the creator moves between sections; both are read
 * again each time a synchronization brings something new, the sources also each time the
 * creator comes back to the page (after connecting one in another tab).
 */
function Dashboard({ session }: { session: CreatorSession }) {
  const { locale } = useI18n();
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
  // A company StayPut does not know the zone of yet: the creator's browser tells it.
  const timezoneSet = session.timezoneSet;
  useEffect(() => {
    if (!timezoneSet) shareTimeZone(api);
  }, [api, timezoneSet]);

  return (
    <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start lg:gap-10">
      <SideMenu session={session} root={root} />
      {/* A container: the sections lay out by the room left beside the menu, not the window's. */}
      <div className="@container min-w-0">
        <Outlet context={data} />
      </div>
    </div>
  );
}

/**
 * The sections, one under the other beside the page (a row to scroll on a phone), with the
 * community the creator is in and, outside Whop, the way to sign out.
 */
function SideMenu({ session, root }: { session: CreatorSession; root: string }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const current = sectionOf(pathname, root);
  return (
    <aside className="mb-6 lg:sticky lg:top-24 lg:mb-0">
      <div className="mb-4 flex items-start justify-between gap-3 lg:block">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            {t('nav.community')}
          </p>
          <p className="truncate font-semibold" title={session.companyName ?? session.companyId}>
            {session.companyName ?? session.companyId}
          </p>
          <p className="text-xs text-muted">{t('nav.team')}</p>
        </div>
        <div className="lg:mt-3">
          <SignOut via={session.via} />
        </div>
      </div>
      <nav aria-label={t('creator.sections')}>
        <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          {SECTIONS.map((section) => {
            const active = section.id === current.id;
            return (
              <li key={section.id} className="shrink-0">
                <Link
                  to={sectionHref(root, section)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    active
                      ? 'bg-accent-soft text-accent'
                      : 'text-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  <section.Icon aria-hidden="true" className="size-4 shrink-0" />
                  {t(section.label)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
