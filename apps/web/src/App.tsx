import type { ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { CreatorView } from './views/CreatorView';
import { Overview } from './views/creator/Overview';
import { SectionHome, SectionLayout } from './views/creator/SectionLayout';
import type { SectionId } from './views/creator/sections';

/**
 * A screen loaded the first time it is opened: its code is a file of its own, so the page Whop
 * opens (the dashboard's home, or a member's page) downloads only what it shows. The router
 * waits for the file before leaving the screen on view: never a blank page in between.
 */
function screen(load: () => Promise<ReactNode>): Pick<RouteObject, 'lazy'> {
  return { lazy: async () => ({ element: await load() }) };
}

const actions = () => import('./views/creator/ActionsTab');
const insights = () => import('./views/creator/InsightsTab');
const members = () => import('./views/creator/MembersTab');
const settings = () => import('./views/creator/SettingsTab');
const sources = () => import('./views/creator/SourcesTab');
const space = () => import('./views/creator/SpaceTab');

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
      { index: true, ...screen(() => members().then((m) => <m.MembersTab />)) },
      { path: 'never-contact', ...screen(() => members().then((m) => <m.NeverContactTab />)) },
    ]),
    // Two tabs (brief v4 §9.4): the rules, and the queue with its filters.
    section('actions', 'actions', [
      { index: true, ...screen(() => actions().then((m) => <m.ActionsHome />)) },
      {
        path: 'queue',
        ...screen(() => actions().then((m) => <m.QueueTab />)),
        children: [
          { index: true, ...screen(() => actions().then((m) => <m.ActionsTab view="queue" />)) },
          {
            path: 'scheduled',
            ...screen(() => actions().then((m) => <m.ActionsTab view="scheduled" />)),
          },
          {
            path: 'history',
            ...screen(() => actions().then((m) => <m.ActionsTab view="history" />)),
          },
          { path: 'alumni', ...screen(() => actions().then((m) => <m.AlumniTab />)) },
        ],
      },
      {
        path: 'scheduled',
        ...screen(() => actions().then((m) => <m.QueueFilterAddress filter="scheduled" />)),
      },
      {
        path: 'history',
        ...screen(() => actions().then((m) => <m.QueueFilterAddress filter="history" />)),
      },
      {
        path: 'alumni',
        ...screen(() => actions().then((m) => <m.QueueFilterAddress filter="alumni" />)),
      },
    ]),
    section('insights', 'insights', [
      { index: true, ...screen(() => insights().then((m) => <m.OverviewTab />)) },
      { path: 'cohorts', ...screen(() => insights().then((m) => <m.CohortsTab />)) },
      { path: 'lessons', ...screen(() => insights().then((m) => <m.LessonsTab />)) },
      {
        path: 'reports',
        ...screen(() => import('./views/creator/ReportsTab').then((m) => <m.ReportsTab />)),
      },
    ]),
    section('sources', 'sources', [
      { index: true, ...screen(() => sources().then((m) => <m.WhopTab />)) },
      { path: 'discord', ...screen(() => sources().then((m) => <m.DiscordTab />)) },
      { path: 'telegram', ...screen(() => sources().then((m) => <m.TelegramTab />)) },
      // Its content is in each platform's tab now (fix prompt v4.1, block 7).
      { path: 'activity', ...screen(() => sources().then((m) => <m.ActivityAddress />)) },
    ]),
    section('settings', 'settings', [
      { index: true, ...screen(() => settings().then((m) => <m.GeneralSettingsTab />)) },
      { path: 'risk', ...screen(() => settings().then((m) => <m.RiskSettingsTab />)) },
      {
        path: 'actions',
        ...screen(() => import('./views/creator/ActionSettings').then((m) => <m.ActionSettings />)),
      },
      {
        path: 'space',
        ...screen(() =>
          Promise.all([import('./views/creator/SectionLayout'), settings()]).then(([l, m]) => (
            <l.MemberSpaceOnly section="settings">
              <m.SpaceSettingsTab />
            </l.MemberSpaceOnly>
          )),
        ),
      },
      // StayPut's internal status page (SPEC Phase 8.5): the operator's own community only.
      {
        path: 'status',
        ...screen(() => import('./views/creator/OperatorTab').then((m) => <m.OperatorTab />)),
      },
    ]),
    // The member space: kept, shown only while it is on (features.ts).
    section('space', 'space', [
      { index: true, ...screen(() => space().then((m) => <m.SpaceOverviewTab />)) },
      { path: 'cards', ...screen(() => space().then((m) => <m.SpaceCardsTab />)) },
      { path: 'preview', ...screen(() => space().then((m) => <m.SpacePreviewTab />)) },
    ]),
  ];
}

/**
 * The entries Whop opens (docs/whop-api-verification.md, section 4; WHOP_VIEW_PATHS): the
 * dashboard view (`dashboard_path`), the experience view (`experience_path`) and the Discover
 * view (`discover_path`, the app store's page of StayPut). The dashboard has its own
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
      { index: true, ...screen(() => import('./views/Home').then((m) => <m.Home />)) },
      {
        path: 'experiences/:experienceId/*',
        ...screen(() => import('./views/MemberView').then((m) => <m.MemberView />)),
      },
      { path: 'discover', ...screen(() => import('./views/Discover').then((m) => <m.Discover />)) },
      {
        path: 'connected',
        ...screen(() => import('./views/Connected').then((m) => <m.Connected />)),
      },
      { path: '*', ...screen(() => import('./views/NotFound').then((m) => <m.NotFound />)) },
    ],
  },
];
