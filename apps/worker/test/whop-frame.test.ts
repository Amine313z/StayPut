import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * apps/web/public/whop-frame.mjs: StayPut inside Whop's sandbox frame, through Whop's « localhost
 * mode ». The proxy keeps the token Whop puts in the address and forwards every request to
 * StayPut with it in the header Whop's relay sets in production; a redirect stays on the proxy.
 */

interface FrameProxy {
  server: http.Server;
  token: () => string | null;
}
interface FrameModule {
  createFrameProxy: (options: { target: string; port: number }) => FrameProxy;
  userOf: (token: string) => string | null;
}

// A plain script for the founder's computer, not part of the Worker's sources.
const SCRIPT = new URL('../../web/public/whop-frame.mjs', import.meta.url).href;
const load = () => import(SCRIPT) as Promise<FrameModule>;

/** What the fake StayPut received. */
interface Seen {
  method: string;
  path: string;
  host: string | undefined;
  token: string | undefined;
  body: string;
}

const open: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => {
    open.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

/** A StayPut that records each request, and redirects /go to its own /there. */
async function fakeStayPut() {
  const seen: Seen[] = [];
  const port = await listen(
    http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          host: req.headers.host,
          token: req.headers['x-whop-user-token'] as string | undefined,
          body,
        });
        if (req.url === '/go') {
          res.writeHead(302, { location: `http://127.0.0.1:${port}/there?x=1` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'DENY' });
        res.end('ok');
      });
    }),
  );
  return { seen, origin: `http://127.0.0.1:${port}` };
}

/** A token as Whop makes them (only its `sub` is read here). */
const TOKEN = [
  Buffer.from('{"alg":"ES256"}').toString('base64url'),
  Buffer.from('{"sub":"user_Founder1","aud":"app_X"}').toString('base64url'),
  'signature',
].join('.');

describe('StayPut in the sandbox frame (whop-frame.mjs)', () => {
  it('forwards with the token Whop gave, kept for the requests that follow', async () => {
    const { createFrameProxy, userOf } = await load();
    const stayput = await fakeStayPut();
    const { server, token } = createFrameProxy({ target: stayput.origin, port: 0 });
    const port = await listen(server);
    const at = (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });

    // Whop's frame opens the dashboard with the token in the address…
    const page = await at(`/dashboard/biz_A1?whop-dev-user-token=${TOKEN}&lang=fr`);
    expect(page.status).toBe(200);
    // …which StayPut may be framed by, wherever its pages say otherwise.
    expect(page.headers.get('x-frame-options')).toBeNull();
    // Then the page asks the API, without it.
    await at('/api/creator/biz_A1/session');
    await at('/api/creator/biz_A1/actions/approve', { method: 'POST', body: '{"ids":["a"]}' });
    expect(stayput.seen).toEqual([
      {
        method: 'GET',
        path: '/dashboard/biz_A1?lang=fr',
        host: new URL(stayput.origin).host,
        token: TOKEN,
        body: '',
      },
      {
        method: 'GET',
        path: '/api/creator/biz_A1/session',
        host: new URL(stayput.origin).host,
        token: TOKEN,
        body: '',
      },
      {
        method: 'POST',
        path: '/api/creator/biz_A1/actions/approve',
        host: new URL(stayput.origin).host,
        token: TOKEN,
        body: '{"ids":["a"]}',
      },
    ]);
    expect(token()).toBe(TOKEN);
    expect(userOf(TOKEN)).toBe('user_Founder1');
    expect(userOf('not a token')).toBeNull();

    // A redirect to StayPut stays on the proxy, inside the frame.
    const moved = await at('/go');
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe(`http://localhost:0/there?x=1`);
  });

  it('never lets the browser choose the token, and says when StayPut does not answer', async () => {
    const { createFrameProxy } = await load();
    const stayput = await fakeStayPut();
    const { server } = createFrameProxy({ target: stayput.origin, port: 0 });
    const port = await listen(server);
    await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: { 'x-whop-user-token': 'forged' },
    });
    expect(stayput.seen[0]?.token).toBeUndefined();

    const gone = createFrameProxy({ target: 'http://127.0.0.1:9', port: 0 });
    const down = await listen(gone.server);
    const answer = await fetch(`http://127.0.0.1:${down}/`);
    expect(answer.status).toBe(502);
    expect(await answer.text()).toMatch(/StayPut ne répond pas/);
  });
});
