import type { MemberHome } from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { prefetch, prefetchAnswer } from './api';
import { memberSpaceEnabled } from './features';
import { forgetPreference, readPreference, writePreference } from './storage';

const DASHBOARD = /^\/dashboard\/(biz_[A-Za-z0-9]+)(\/.*)?$/;
const ENTRY = /^\/experiences\/(exp_[A-Za-z0-9]+)(\/.*)?$/;

/** Where this device's last opening of an experience led: its dashboard, for the team. */
export const entryKey = (experienceId: string) => `stayput.entry.${experienceId}`;

/**
 * The first readings of the screen about to open, asked before React draws anything: the
 * session, the members, the sources, the synchronization, and the home's figures when the home
 * is the page opened. Each one is the exact address its screen reads (CreatorView, Overview,
 * sync.ts), so the screen takes the answer instead of asking again.
 */
export function prefetchScreen(pathname: string, locale: Locale): void {
  const entry = ENTRY.exec(pathname);
  if (entry?.[1]) {
    prefetchEntry(entry[1], locale);
    return;
  }
  const opened = DASHBOARD.exec(pathname);
  if (!opened) return;
  const api = `/api/creator/${opened[1]}`;
  prefetch(`${api}/session`);
  prefetch(`${api}/members`);
  prefetch(`${api}/integrations?lang=${locale}`);
  prefetch(`${api}/sync`);
  if (!opened[2] || opened[2] === '/') prefetch(`${api}/dashboard`);
}

/**
 * StayPut opened from the community (Whop's experience view), where the team lands on its
 * dashboard (views/MemberView.tsx): where it leads is asked at once, and the dashboard's
 * readings leave the moment it is known, without waiting for the page to draw. On a device that
 * opened it before, they leave at once, alongside: the answer still decides where the page
 * goes, a member's device never remembers a dashboard, and a team's that is no longer one is
 * told no by the server (and forgets it).
 */
function prefetchEntry(experienceId: string, locale: Locale): void {
  if (memberSpaceEnabled()) return;
  const key = entryKey(experienceId);
  const known = readPreference(key);
  if (known && DASHBOARD.test(known)) prefetchScreen(known, locale);
  void prefetchAnswer(`/api/member/${experienceId}/home`)?.then(
    (answer) => {
      const dashboard = (answer as Partial<MemberHome> | null)?.dashboard;
      if (typeof dashboard === 'string' && DASHBOARD.test(dashboard)) {
        if (dashboard !== known) writePreference(key, dashboard);
        prefetchScreen(dashboard, locale);
      } else if (known) {
        forgetPreference(key);
      }
    },
    // Asked again by the page itself.
    () => {},
  );
}
