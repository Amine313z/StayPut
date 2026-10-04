import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { Connected } from './views/Connected';
import { CreatorView } from './views/CreatorView';
import { ActionSettings } from './views/creator/ActionSettings';
import {
  ActionsHome,
  ActionsTab,
  AlumniTab,
  QueueFilterAddress,
  QueueTab,
} from './views/creator/ActionsTab';
import { CohortsTab, LessonsTab, OverviewTab } from './views/creator/InsightsTab';
import { ReportsTab } from './views/creator/ReportsTab';
import { MembersTab, NeverContactTab } from './views/creator/MembersTab';
import { Overview } from './views/creator/Overview';
import { MemberSpaceOnly, SectionHome, SectionLayout } from './views/creator/SectionLayout';
import { GeneralSettingsTab, RiskSettingsTab, SpaceSettingsTab } from './views/creator/SettingsTab';
import { SpaceCardsTab, SpaceOverviewTab, SpacePreviewTab } from './views/creator/SpaceTab';
import { ActivityAddress, DiscordTab, TelegramTab, WhopTab } from './views/creator/SourcesTab';
import { Home } from './views/Home';
import { MemberView } from './views/MemberView';
import { NotFound } from './views/NotFound';
import type { SectionId } from './views/creator/sections';

/** A section of the dashboard: its tabs, and its first tab for any other address in it. */
function section(id: SectionId, path: string | undefined, tabs: RouteObject[]): RouteObject {
  return {
    ...(path === undefined ? {} : { path }),
    element: <SectionLayout id={id} />,
    children: [...tabs, { path: '*', element: <SectionHome id={id} /> }],
  };
}

/** The sections of the dashboard and their tabs: the same for a real community and the demo. */
function creatorSections(): RouteObject[] {
  return [
    section('dashboard', undefined, [{ index: true, element: <Overview /> }]),
    section('members', 'members', [
      { index: true, element: <MembersTab /> },
      { path: 'never-contact', element: <NeverContactTab /> },
    ]),
    // Two tabs (brief v4 §9.4): the rules, and the queue with its filters.
    section('actions', 'actions', [
      { index: true, element: <ActionsHome /> },
      {
        path: 'queue',
        element: <QueueTab />,
        children: [
          { index: true, element: <ActionsTab view="queue" /> },
          { path: 'scheduled', element: <ActionsTab view="scheduled" /> },
          { path: 'history', element: <ActionsTab view="history" /> },
          { path: 'alumni', element: <AlumniTab /> },
        ],
      },
      { path: 'scheduled', element: <QueueFilterAddress filter="scheduled" /> },
      { path: 'history', element: <QueueFilterAddress filter="history" /> },
      { path: 'alumni', element: <QueueFilterAddress filter="alumni" /> },
    ]),
    section('insights', 'insights', [
      { index: true, element: <OverviewTab /> },
      { path: 'cohorts', element: <CohortsTab /> },
      { path: 'lessons', element: <LessonsTab /> },
      { path: 'reports', element: <ReportsTab /> },
    ]),
    section('sources', 'sources', [
      { index: true, element: <WhopTab /> },
      { path: 'discord', element: <DiscordTab /> },
      { path: 'telegram', element: <TelegramTab /> },
      // Its content is in each platform's tab now (fix prompt v4.1, block 7).
      { path: 'activity', element: <ActivityAddress /> },
    ]),
    section('settings', 'settings', [
      { index: true, element: <GeneralSettingsTab /> },
      { path: 'risk', element: <RiskSettingsTab /> },
      { path: 'actions', element: <ActionSettings /> },
      {
        path: 'space',
        element: (
          <MemberSpaceOnly section="settings">
            <SpaceSettingsTab />
          </MemberSpaceOnly>
        ),
      },
    ]),
    // The member space: kept, shown only while it is on (features.ts).
    section('space', 'space', [
      { index: true, element: <SpaceOverviewTab /> },
      { path: 'cards', element: <SpaceCardsTab /> },
      { path: 'preview', element: <SpacePreviewTab /> },
    ]),
  ];
}

/**
 * The two entries Whop opens (docs/whop-api-verification.md, section 4): the dashboard view
 * (`dashboard_path`) and the experience view (`experience_path`). The dashboard has its own
 * frame (components/CreatorShell.tsx) and sections, each with its tabs (views/creator/
 * sections.ts); any other sub-page (`[restPath]`, e.g. from a notification) opens its overview.
 * /demo is the same dashboard on an imaginary community, for anyone (nothing real, nothing
 * sent). /connected is where Discord sends a creator back after adding the bot.
 */
export const routes: RouteObject[] = [
  { path: 'dashboard/:companyId', element: <CreatorView />, children: creatorSections() },
  { path: 'demo', element: <CreatorView demo />, children: creatorSections() },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      { path: 'experiences/:experienceId/*', element: <MemberView /> },
      { path: 'connected', element: <Connected /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
