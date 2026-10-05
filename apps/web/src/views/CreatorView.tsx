import type { CreatorSession, IntegrationsStatus, MembersPage } from '@stayput/core';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useOutletContext, useParams, useSearchParams } from 'react-router';
import { DEMO_COMPANY_ID, postJson, useApi, useReloadOnReturn, type Loadable } from '../api';
import { CreatorShell, ShellSkeleton, rememberDemoExit } from '../components/CreatorShell';
import { ErrorPanel } from '../components/Status';
import { DemoMode } from '../demoMode';
import { useI18n } from '../i18n';
import { useSync, type SyncState } from '../sync';
import { shareTimeZone } from '../timezone';
import { StayPutMark } from '../ui/BrandIcons';
import { Page } from '../ui/Motion';
import { sectionOf } from './creator/sections';

/** How many things each tab of a section holds, by the tab's path. */
export type TabCounts = Record<string, number>;

/** What every section of the creator view reads, loaded once for all of them. */
export interface CreatorData {
  companyId: string;
  /** `/dashboard/<company>` (or `/demo`): the sections' links start here. */
  root: string;
  /** `/api/creator/<company>`. */
  api: string;
  /** The imaginary community of /demo: nothing it shows is real, nothing it does is sent. */
  demo: boolean;
  /** The community's name as Whop gives it (null until read): the message previews sign with it. */
  companyName: string | null;
  members: { state: Loadable<MembersPage>; retry: () => void; reload: () => void };
  sync: SyncState;
  integrations: { state: Loadable<IntegrationsStatus>; retry: () => void; reload: () => void };
  /** The test mode as the banner on top shows it; the action settings say when it changes. */
  testMode: { on: boolean; set: (on: boolean) => void };
  /** The operator's own community: Settings › Status, StayPut's internal status page. */
  operator: boolean;
  /** Inside a section: says how many things its tabs hold (SectionLayout). */
  tabCounts?: (counts: TabCounts) => void;
}

export function useCreatorData(): CreatorData {
  return useOutletContext<CreatorData>();
}

/**
 * The creator view (Whop "dashboard view", /dashboard/:companyId): the team only. With `demo`
 * (/demo), the same screens on an imaginary community, answered in the browser (demo/api.ts).
 */
export function CreatorView({ demo = false }: { demo?: boolean }) {
  const params = useParams();
  const [search] = useSearchParams();
  const companyId = demo ? DEMO_COMPANY_ID : (params.companyId ?? '');
  const { state, retry } = useApi<CreatorSession>(
    `/api/creator/${encodeURIComponent(companyId)}/session`,
  );
  // The dashboard the creator came from: « Leave the demo » brings them back to it.
  const from = demo ? search.get('from') : null;
  useEffect(() => {
    if (from) rememberDemoExit(from);
  }, [from]);
  // The language of this app: the community's own choice, the demo always in English.
  const { enterCommunity } = useI18n();
  useEffect(() => enterCommunity(demo ? null : companyId), [enterCommunity, demo, companyId]);

  if (state.status === 'loading') return <ShellSkeleton />;
  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <StayPutMark size={40} className="mx-auto mb-6" />
        <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
      </div>
    );
  }
  return <Dashboard session={state.data} demo={demo} />;
}

/**
 * The dashboard (the redesign): the frame (CreatorShell) around the open section. The members
 * and the sources are read once here and kept while the creator moves between sections; both
 * are read again each time a synchronization brings something new, the sources also each time
 * the creator comes back to the page (after connecting one in another tab).
 */
function Dashboard({ session, demo }: { session: CreatorSession; demo: boolean }) {
  const { locale } = useI18n();
  const { pathname } = useLocation();
  const companyId = session.companyId;
  const api = `/api/creator/${encodeURIComponent(companyId)}`;
  const root = demo ? '/demo' : `/dashboard/${encodeURIComponent(companyId)}`;
  const members = useApi<MembersPage>(`${api}/members`);
  // The language goes along: the bot answers the creator's Telegram groups in it.
  const integrations = useApi<IntegrationsStatus>(`${api}/integrations?lang=${locale}`);
  useReloadOnReturn(integrations.reload);
  // A synchronization may bring members and Discord messages (« Sync now » reads Discord too).
  const sync = useSync(companyId, () => {
    members.reload();
    integrations.reload();
  });
  // The session says whether the test mode is on; the banner's « Turn off » and the action
  // settings change it from there.
  const [testMode, setTestMode] = useState(session.testMode);
  const turnOffTestMode = async () => {
    await postJson(`${api}/test-mode/off`);
    setTestMode(false);
  };
  const data: CreatorData = {
    companyId,
    root,
    api,
    demo,
    companyName: session.companyName,
    members,
    sync,
    integrations,
    testMode: { on: testMode, set: setTestMode },
    operator: !demo && session.operator === true,
  };
  // A company StayPut does not know the zone of yet: the creator's browser tells it.
  const timezoneSet = session.timezoneSet;
  useEffect(() => {
    if (!timezoneSet && !demo) shareTimeZone(api);
  }, [api, timezoneSet, demo]);
  const section = sectionOf(pathname, root);

  return (
    // In the demo, no button leads outside StayPut (demoMode.tsx).
    <DemoMode on={demo}>
      <CreatorShell
        session={session}
        root={root}
        demo={demo}
        testMode={testMode}
        onTurnOffTestMode={turnOffTestMode}
        members={members.state.status === 'ready' ? members.state.data.members : []}
      >
        {/* Each section comes in (MOTION.md); the frame around it never moves. */}
        <Page key={section.id}>
          {/* A container: the sections lay out by the room left beside the menu, not the window's. */}
          <div className="@container min-w-0">
            <Outlet context={data} />
          </div>
        </Page>
      </CreatorShell>
    </DemoMode>
  );
}
