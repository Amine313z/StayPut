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

describe('the Worker’s routes', () => {
  it('are each claimed before the static files', () => {
    const app = createApp({
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
