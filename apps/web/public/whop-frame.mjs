#!/usr/bin/env node
/**
 * StayPut inside Whop's sandbox. The sandbox shows no app view (« App Base URL not set »: its
 * frames go through Whop's production relay, which does not know sandbox apps). Whop's « localhost
 * mode », the </> button at the top right of the frame, loads the app from the viewer's computer
 * instead, at http://localhost:3000, with their Whop token in the address
 * (`?whop-dev-user-token=…`), as Whop's own development proxy expects (@whop-apps/dev-proxy).
 *
 * This is that proxy, for the deployed StayPut: it keeps the latest token and forwards every
 * request to StayPut with it, in the header Whop's relay sets in production
 * (`x-whop-user-token`). StayPut checks the token as usual. No dependency: Node 18 or later.
 *
 *   node whop-frame.mjs [https://stayput.chezbenz18.workers.dev] [--port 3000]
 *
 * Served by StayPut itself (/whop-frame.mjs), so that one command downloads and starts it.
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET = 'https://stayput.chezbenz18.workers.dev';
export const DEFAULT_PORT = 3000;
export const TOKEN_PARAM = 'whop-dev-user-token';
export const TOKEN_HEADER = 'x-whop-user-token';

/** The user a Whop token names (`sub`), to say who is viewing; never the token itself. */
export function userOf(token) {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const sub = JSON.parse(json).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/**
 * The proxy: `target` is StayPut's address. Returns the server (not listening yet) and a way to
 * read the token it holds.
 */
export function createFrameProxy({ target = DEFAULT_TARGET, port = DEFAULT_PORT, log = () => {} }) {
  const upstream = new URL(target);
  const client = upstream.protocol === 'https:' ? https : http;
  const local = `http://localhost:${port}`;
  let token = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', local);
    const fresh = url.searchParams.get(TOKEN_PARAM);
    if (fresh) {
      if (fresh !== token) {
        const user = userOf(fresh);
        log(user ? `Whop connecté : ${user}` : 'Whop connecté.');
      }
      token = fresh;
      url.searchParams.delete(TOKEN_PARAM);
    }
    const headers = { ...req.headers, host: upstream.host };
    // Only Whop sets this header: never one the browser sent.
    delete headers[TOKEN_HEADER];
    if (token) headers[TOKEN_HEADER] = token;
    const forward = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (answer) => {
        const out = { ...answer.headers };
        // A redirect to StayPut stays on this computer, inside Whop's frame.
        if (typeof out.location === 'string' && out.location.startsWith(upstream.origin)) {
          out.location = local + out.location.slice(upstream.origin.length);
        }
        delete out['x-frame-options'];
        res.writeHead(answer.statusCode ?? 502, out);
        answer.pipe(res);
      },
    );
    forward.on('error', (error) => {
      log(`StayPut ne répond pas : ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('StayPut ne répond pas. Réessayez dans un instant.');
    });
    req.pipe(forward);
  });
  return { server, token: () => token };
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => /^https?:\/\//.test(a)) ?? DEFAULT_TARGET;
  const at = args.indexOf('--port');
  const port = Number(at >= 0 ? args[at + 1] : process.env.PORT || DEFAULT_PORT);
  const { server } = createFrameProxy({
    target,
    port,
    log: (line) => console.info(` · ${line}`),
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Le port ${port} est déjà pris par un autre programme. Fermez-le, ou lancez avec ` +
          `--port ${port + 1} et choisissez ${port + 1} dans le mode localhost de Whop.`,
      );
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });
  // This computer only: the token never leaves it.
  server.listen(port, '127.0.0.1', () => {
    console.info('');
    console.info(` StayPut pour le sandbox Whop : http://localhost:${port} → ${target}`);
    console.info(
      ' Laissez cette fenêtre ouverte. Dans Whop, ouvrez StayPut, cliquez sur </> en haut',
    );
    console.info(` à droite de l'écran, activez le mode localhost (port ${port}).`);
    console.info(' Pour arrêter : Ctrl+C.');
    console.info('');
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
