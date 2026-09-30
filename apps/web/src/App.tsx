import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { CreatorView } from './views/CreatorView';
import { Home } from './views/Home';
import { MemberView } from './views/MemberView';
import { NotFound } from './views/NotFound';

/**
 * The two entries Whop opens (docs/whop-api-verification.md, section 4): the dashboard view
 * (`dashboard_path`) and the experience view (`experience_path`). `*` keeps room for their
 * sub-pages (`[restPath]`, e.g. from a notification).
 */
export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      { path: 'dashboard/:companyId/*', element: <CreatorView /> },
      { path: 'experiences/:experienceId/*', element: <MemberView /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
