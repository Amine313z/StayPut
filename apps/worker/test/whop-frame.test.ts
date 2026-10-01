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
  createFrameProxy: (options: {
    target: string;
    port: number;
    log?: (line: string) => void;
  }) => FrameProxy;
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

    const lines: string[] = [];
    const gone = createFrameProxy({
      target: 'http://127.0.0.1:9',
      port: 0,
      log: (line) => lines.push(line),
    });
    const down = await listen(gone.server);
    const answer = await fetch(`http://127.0.0.1:${down}/api/actions`);
    // In the API's own shape: the page says « no connection » rather than a bare error.
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({
      error: { code: 'network', message: 'StayPut ne répond pas. Réessayez dans un instant.' },
    });
    expect(lines).toEqual([
      expect.stringMatching(/^StayPut ne répond pas \(GET \/api\/actions\) : ECONNREFUSED$/),
    ]);
  });

  it('keeps going when the browser gives up a request, and tries a closed connection again', async () => {
    const { createFrameProxy } = await load();
    // A StayPut slow to answer /slow, that drops the first connection of /flaky, and refuses
    // every token.
    let flaky = 0;
    const port0 = await listen(
      http.createServer((req, res) => {
        if (req.url === '/slow') {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ pad: 'x'.repeat(200_000) }));
          }, 200);
          return;
        }
        if (req.url === '/flaky' && flaky++ === 0) {
          req.socket.destroy();
          return;
        }
        if (req.url === '/who') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":{"code":"unauthenticated","message":"no"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`ok ${req.method ?? ''}`);
      }),
    );
    const lines: string[] = [];
    const { server } = createFrameProxy({
      target: `http://127.0.0.1:${port0}`,
      port: 0,
      log: (line) => lines.push(line),
    });
    const port = await listen(server);
    const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

    // The page changes tab: its request is given up halfway.
    const gaveUp = new AbortController();
    const slow = at('/slow', { signal: gaveUp.signal });
    setTimeout(() => gaveUp.abort(), 50);
    await expect(slow).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The next requests go through.
    expect(await (await at('/next')).text()).toBe('ok GET');
    // A connection StayPut dropped: a reading is tried again, a change is not.
    expect(await (await at('/flaky')).text()).toBe('ok GET');
    flaky = 0;
    expect((await at('/flaky', { method: 'POST', body: 'x' })).status).toBe(502);

    // Whop's token refused: said once, with what to do.
    await at(`/who?whop-dev-user-token=${TOKEN}`);
    await at('/who');
    expect(lines.filter((line) => line.includes('Reload'))).toEqual([
      'StayPut ne reconnaît plus votre connexion Whop : cliquez sur Reload dans Whop.',
    ]);
  });
});
