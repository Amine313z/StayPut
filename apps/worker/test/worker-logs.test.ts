import { describe, expect, it } from 'vitest';
import { mask, readEvents, readLogs, report, routeOf } from '../../../scripts/ops/worker-logs';

/**
 * scripts/ops/worker-logs.ts (Inspect): the Worker's logs as Cloudflare keeps them, read into a
 * report this public repository's logs can show: no community, member, server, address or token
 * in it, only routes, answers, times and the Worker's own warnings.
 */

const AT = Date.parse('2026-10-10T21:00:00Z');

const request = (url: string, status: number | null, outcome: string, wallTimeMs: number) => ({
  timestamp: AT,
  $metadata: { id: 'e1', service: 'stayput-app' },
  $workers: {
    eventType: 'fetch',
    scriptName: 'stayput-app',
    outcome,
    wallTimeMs,
    cpuTimeMs: 3,
    event: {
      request: { url, method: 'GET' },
      ...(status === null ? {} : { response: { status } }),
    },
  },
});

describe('the Worker’s logs, masked', () => {
  it('masks every id, address, long number and token', () => {
    const line = mask(
      'user_4cFeF6wea5ODL of biz_8bMd4tK5uS65zD wrote to founder@example.com from 1555226501069152328 ' +
        'with eyJhbGciOiJFUzI1NiJ9abcdefghijklmnopqrstuvwxyz.eyJzdWIiOiJ1c2VyX0EifQ.sig and ' +
        '71aeb3f1-8eb7-421f-85fc-1f85d8402382',
    );
    expect(line).toBe('user_… of biz_… wrote to <email> from <n> with <token> and <uuid>');
    expect(routeOf('https://x.apps.whop.com/api/creator/biz_8bMd4tK5uS65zD/members?q=Anna')).toBe(
      '/api/creator/biz_…/members',
    );
  });

  it('reads the requests and the warnings, and reports the slow and the unfinished', () => {
    const read = readEvents([
      request('https://w.dev/api/creator/biz_AAAAAAAAAA/session', 200, 'ok', 180),
      request('https://w.dev/api/creator/biz_BBBBBBBBBB/session', 200, 'ok', 240),
      request('https://w.dev/api/creator/biz_AAAAAAAAAA/dashboard', null, 'canceled', 31_000),
      request('https://w.dev/health', 200, 'ok', 90),
      {
        timestamp: AT,
        $metadata: { id: 'e2', level: 'error', message: 'Whop access check failed: user_ABCDEFGH' },
      },
      { timestamp: AT, $metadata: { id: 'e3', level: 'info', message: 'scored 3 members' } },
      {
        timestamp: AT,
        $metadata: { id: 'e4' },
        $workers: { eventType: 'scheduled', outcome: 'ok', wallTimeMs: 400 },
      },
    ]);
    expect(read.invocations).toHaveLength(4);
    expect(read.lines).toEqual([
      { at: AT, level: 'error', message: 'Whop access check failed: user_…' },
    ]);
    const text = report('stayput-app', 48, read);
    expect(text).toContain(
      '| `GET /api/creator/biz_…/session` | 2 | 200×2 | ok×2 | 240 ms | 240 ms |',
    );
    expect(text).toContain(
      '- 2026-10-10 21:00 UTC `GET /api/creator/biz_…/dashboard` → no answer, canceled, 31000 ms',
    );
    expect(text).toContain(
      'error ×1 (last 2026-10-10 21:00 UTC): `Whop access check failed: user_…`',
    );
    expect(text).not.toMatch(/AAAAAAAAAA|BBBBBBBBBB|ABCDEFGH/);
  });

  it('says when nothing came, and why Cloudflare refused, without the token', async () => {
    expect(report('stayput-app', 48, { invocations: [], lines: [] })).toContain('Nothing');
    let sent: { url: string; init: RequestInit } | null = null;
    const refused = await readLogs('acc', 'secret-token', 'stayput-app', 48, new Date(AT), {
      fetch: (url, init) => {
        sent = { url, init };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: 'Authentication error' }],
            }),
            { status: 403 },
          ),
        );
      },
    });
    expect(refused).toEqual({ error: 'Cloudflare answered HTTP 403: 10000 Authentication error' });
    expect(sent!.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc/workers/observability/telemetry/query',
    );
    const body = JSON.parse(sent!.init.body as string) as {
      timeframe: { from: number; to: number };
      parameters: { filters: { value: string }[] };
    };
    expect(body.timeframe).toEqual({ from: AT - 48 * 3_600_000, to: AT });
    expect(body.parameters.filters[0]?.value).toBe('stayput-app');
    const read = await readLogs('acc', 't', 'stayput-app', 1, new Date(AT), {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, result: { events: { events: [] } } })),
        ),
    });
    expect(read).toEqual({ events: [] });
  });
});
