/**
 * The app's views as Whop's Hosting settings name them (whop.com → Developer → the app →
 * Hosting): Whop opens `base_url` + the path, its `[…]` part replaced by the community, the
 * experience or nothing. StayPut's router serves each one (apps/web/src/App.tsx), and the
 * deployment checks that Whop holds exactly these (scripts/deploy/check-app.ts).
 */
export const WHOP_VIEW_PATHS = {
  /** The member's view, in the community's sidebar. */
  experience_path: '/experiences/[experienceId]',
  /** The creator's view, in their Whop dashboard. */
  dashboard_path: '/dashboard/[companyId]',
  /** What a creator browsing Whop's app store sees of StayPut, before installing it. */
  discover_path: '/discover',
} as const;

export type WhopViewField = keyof typeof WHOP_VIEW_PATHS;
