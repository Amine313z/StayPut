import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessCache } from '../src/access';
import { createApp } from '../src/app';

/**
 * The static files answer every path the Worker does not claim first (wrangler.toml:
 * `run_worker_first`, then `not_found_handling = "single-page-application"`): a route of the
 * Worker left out of the list serves the React app instead. The badge's verification page did,
 * until 5 October.
 */

const toml = readFileSync(path.resolve(import.meta.dirname, '../wrangler.toml'), 'utf8');
const claimed = JSON.parse(
  `[${/^run_worker_first\s*=\s*\[(.*)\]$/m.exec(toml)?.[1] ?? ''}]`,
) as string[];

function claims(pattern: string, pathname: string): boolean {
  return pattern.endsWith('/*') ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;
}

/**
 * The creator routes that write no line in the community's journal (SPEC 3, `audit_log`), and
 * why: every other one that is not a reading must (the `audited` middleware of app.ts).
 */
const NOT_IN_THE_JOURNAL: Readonly<Record<string, string>> = {
  'POST /api/creator/:companyId/sync': 'reads Whop again: nothing changes',
  'POST /api/creator/:companyId/platform-activity/refresh': 'reads Discord again: nothing changes',
  'POST /api/creator/:companyId/getting-started/reviewed':
    'the setup pill notes that the members at risk were opened',
  'POST /api/creator/:companyId/getting-started/welcomed':
    'the setup pill notes that the welcome was gone through',
  'POST /api/creator/:companyId/timezone':
    'the browser’s time zone, kept only while the community has none (the settings change it)',
  'POST /api/creator/:companyId/data/delete':
    'the journal is deleted with everything else, as the privacy policy says; the Worker’s log keeps who asked',
};

function worker() {
  return createApp({
    now: () => new Date(),
    openDb: () => null,
    whopClient: () => null,
    userTokenKeys: () => {
      throw new Error('not read here');
    },
    oauth: () => null,
    discord: () => null,
    telegram: () => null,
    accessCache: new AccessCache(),
  });
}

describe('the Worker’s routes', () => {
  it('write a line in the journal for every change the team makes, and every data export', () => {
    // Each middleware and handler of a route is a route entry of its own: `audited` is marked.
    const audited = new Map<string, boolean>();
    for (const route of worker().routes) {
      if (!route.path.startsWith('/api/creator/') || route.method === 'ALL') continue;
      const key = `${route.method} ${route.path}`;
      audited.set(key, audited.get(key) === true || 'auditAction' in route.handler);
    }
    const changes = [...audited.keys()].filter((key) => !key.startsWith('GET '));
    expect(changes.length).toBeGreaterThan(25);
    expect(changes.filter((key) => !audited.get(key) && !(key in NOT_IN_THE_JOURNAL))).toEqual([]);
    // Each exception is a route that exists and writes nothing.
    expect(Object.keys(NOT_IN_THE_JOURNAL).filter((key) => audited.get(key) !== false)).toEqual([]);
    expect(audited.get('GET /api/creator/:companyId/export')).toBe(true);
    expect(audited.get('GET /api/creator/:companyId/members/:memberId/export')).toBe(true);
  });

  it('are each claimed before the static files', () => {
    const app = worker();
    const paths = [
      ...new Set(
        app.routes
          .filter((route) => route.path !== '*' && route.path !== '/*')
          // A parameter (`:id`, `:change{a|b}`) stands for one segment.
          .map((route) => route.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x')),
      ),
    ];
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((p) => !claimed.some((pattern) => claims(pattern, p)))).toEqual([]);
  });
});
