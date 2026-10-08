import { prefetch } from './api';
import type { Locale } from '@stayput/i18n';

/**
 * The first readings of the dashboard about to open, asked before React draws anything: the
 * session, the members, the sources, the synchronization, and the home's figures when the home
 * is the page opened. Each one is the exact address its screen reads (CreatorView, Overview,
 * sync.ts), so the screen takes the answer instead of asking again.
 */
export function prefetchScreen(pathname: string, locale: Locale): void {
  const opened = /^\/dashboard\/(biz_[A-Za-z0-9]+)(\/.*)?$/.exec(pathname);
  if (!opened) return;
  const api = `/api/creator/${opened[1]}`;
  prefetch(`${api}/session`);
  prefetch(`${api}/members`);
  prefetch(`${api}/integrations?lang=${locale}`);
  prefetch(`${api}/sync`);
  if (!opened[2] || opened[2] === '/') prefetch(`${api}/dashboard`);
}
