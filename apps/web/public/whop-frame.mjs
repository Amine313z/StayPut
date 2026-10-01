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
 * Served by StayPut itself (/whop-frame.mjs), so that one command downloads and starts it. It
 * must never stop on its own: a browser that gives up a request, a connection StayPut closes, an
 * unexpected error are each written in the window, and the next request goes through.
 */
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET = 'https://stayput.chezbenz18.workers.dev';
export const DEFAULT_PORT = 3000;
export const TOKEN_PARAM = 'whop-dev-user-token';
export const TOKEN_HEADER = 'x-whop-user-token';

/** Requests that change nothing: tried again once when a reused connection was closed. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const CLOSED = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT']);
/** Headers that belong to one connection, never forwarded from one side to the other. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
];

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
 * The proxy: `target` is StayPut's address. Returns the request handler (for one server per
 * local address), a server with it, and a way to read the token it holds.
 */
export function createFrameProxy({ target = DEFAULT_TARGET, port = DEFAULT_PORT, log = () => {} }) {
  const upstream = new URL(target);
  const client = upstream.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 32 });
  const local = `http://localhost:${port}`;
  let token = null;
  let refused = null;

  const handler = (req, res) => {
    // The browser may give a request up (a tab changed): nothing to do but stop.
    req.on('error', () => {});
    res.on('error', () => {});
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
    for (const name of HOP_BY_HOP) delete headers[name];
    // Only Whop sets this header: never one the browser sent.
    delete headers[TOKEN_HEADER];
    if (token) headers[TOKEN_HEADER] = token;
    const path = url.pathname + url.search;

    const send = (attempt) => {
      const forward = client.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: req.method,
          path,
          headers,
          agent,
        },
        (answer) => {
          if (answer.statusCode === 401 && token && refused !== token) {
            refused = token;
            log('StayPut ne reconnaît plus votre connexion Whop : cliquez sur Reload dans Whop.');
          }
          if (res.destroyed) {
            answer.resume();
            return;
          }
          const out = { ...answer.headers };
          for (const name of HOP_BY_HOP) delete out[name];
          // A redirect to StayPut stays on this computer, inside Whop's frame.
          if (typeof out.location === 'string' && out.location.startsWith(upstream.origin)) {
            out.location = local + out.location.slice(upstream.origin.length);
          }
          delete out['x-frame-options'];
          res.writeHead(answer.statusCode ?? 502, out);
          pipeline(answer, res, (error) => {
            if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              log(
                `Réponse interrompue (${req.method} ${url.pathname}) : ${error.code ?? error.message}`,
              );
            }
          });
        },
      );
      forward.on('error', (error) => {
        if (res.destroyed) return;
        if (attempt === 0 && IDEMPOTENT.has(req.method ?? '') && CLOSED.has(error.code)) {
          send(1);
          return;
        }
        log(
          `StayPut ne répond pas (${req.method} ${url.pathname}) : ${error.code ?? error.message}`,
        );
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(
          JSON.stringify({
            error: {
              code: 'network',
              message: 'StayPut ne répond pas. Réessayez dans un instant.',
            },
          }),
        );
      });
      res.on('close', () => {
        if (!res.writableFinished) forward.destroy();
      });
      if (IDEMPOTENT.has(req.method ?? '')) {
        req.resume();
        forward.end();
      } else {
        pipeline(req, forward, () => {});
      }
    };
    send(0);
  };

  const server = http.createServer(handler);
  return { handler, server, token: () => token };
}

/** One local address: resolves when listening, rejects with the error that kept it from it. */
function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => /^https?:\/\//.test(a)) ?? DEFAULT_TARGET;
  const at = args.indexOf('--port');
  const port = Number(at >= 0 ? args[at + 1] : process.env.PORT || DEFAULT_PORT);
  const log = (line) => console.info(` · ${line}`);
  // An unexpected error is written down, never the end of the proxy.
  process.on('uncaughtException', (error) => log(`Erreur inattendue : ${error.message}`));
  process.on('unhandledRejection', (error) => log(`Erreur inattendue : ${String(error)}`));

  const { handler, server } = createFrameProxy({ target, port, log });
  // Browsers reach « localhost » at 127.0.0.1 or ::1: both, on this computer only (the token
  // never leaves it). Idle connections stay open long, so the browser rarely meets a closed one.
  const v6 = http.createServer(handler);
  for (const s of [server, v6]) {
    s.keepAliveTimeout = 120_000;
    s.headersTimeout = 125_000;
  }
  const taken = () => {
    console.error(
      `Le port ${port} est déjà pris par un autre programme. Fermez-le, ou lancez avec ` +
        `--port ${port + 1} et choisissez ${port + 1} dans le mode localhost de Whop.`,
    );
    process.exit(1);
  };
  try {
    await listenOn(server, port, '127.0.0.1');
  } catch (error) {
    if (error.code === 'EADDRINUSE') taken();
    console.error(error.message);
    process.exit(1);
  }
  try {
    await listenOn(v6, port, '::1');
  } catch (error) {
    // Another program on ::1 would answer the browser instead of this proxy.
    if (error.code === 'EADDRINUSE') taken();
    // No IPv6 on this computer: 127.0.0.1 is enough.
  }
  console.info('');
  console.info(` StayPut pour le sandbox Whop : http://localhost:${port} → ${target}`);
  console.info(
    ' Laissez cette fenêtre ouverte. Dans Whop, ouvrez StayPut, cliquez sur </> en haut',
  );
  console.info(` à droite de l'écran, activez le mode localhost (port ${port}).`);
  console.info(' Pour arrêter : Ctrl+C.');
  console.info('');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
