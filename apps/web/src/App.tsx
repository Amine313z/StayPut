import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { Connected } from './views/Connected';
import { CreatorView } from './views/CreatorView';
import { MembersTab } from './views/creator/MembersTab';
import { Overview } from './views/creator/Overview';
import { SourcesTab } from './views/creator/SourcesTab';
import { Home } from './views/Home';
import { MemberView } from './views/MemberView';
import { NotFound } from './views/NotFound';

/**
 * The two entries Whop opens (docs/whop-api-verification.md, section 4): the dashboard view
 * (`dashboard_path`) and the experience view (`experience_path`). The dashboard has sections of
 * its own; any other sub-page (`[restPath]`, e.g. from a notification) opens its overview.
 * /connected is where Discord sends a creator back after adding the bot.
 */
export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      {
        path: 'dashboard/:companyId',
        element: <CreatorView />,
        children: [
          { index: true, element: <Overview /> },
          { path: 'members', element: <MembersTab /> },
          { path: 'sources', element: <SourcesTab /> },
          { path: '*', element: <Overview /> },
        ],
      },
      { path: 'experiences/:experienceId/*', element: <MemberView /> },
      { path: 'connected', element: <Connected /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
