/**
 * The deployed Worker attacked from outside (the security audit's live checks): what no
 * creator's or member's browser sends, each refused as it must be — no token, forged tokens (no
 * signature, a stranger's key, a shared secret), a forged session cookie, forged and replayed
 * webhooks, bodies too large with or without their length, a stranger's origin — the headers
 * every answer carries, and the files that must never be served. One line per check: its
 * verdict and the status code, never a body, a token or a secret, so that the public run logs
 * show nothing of anyone. It changes nothing: every request is refused before anything is kept.
 *
 *   STAYPUT_URL=https://… [WHOP_APP_ID=app_…] [WHOP_WEBHOOK_SECRET=…] npx tsx scripts/ops/probe.ts
 *
 * The Inspect workflow runs it on the sandbox and on production.
 */
import { webcrypto } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { USER_TOKEN_ISSUER, signWebhook } from '@stayput/whop';
import { secretValue } from '../deploy/prepare';

const base = (process.env.STAYPUT_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) throw new Error('STAYPUT_URL is not set');

/** The app the Worker serves: its id is in every token Whop signs (not a secret). */
function appId(): string {
  const given = process.env.WHOP_APP_ID?.trim();
  if (given) return given;
  const toml = readFileSync(
    path.resolve(import.meta.dirname, '../../apps/worker/wrangler.toml'),
    'utf8',
  );
  return /^WHOP_APP_ID\s*=\s*"(app_[A-Za-z0-9]+)"/m.exec(toml)?.[1] ?? 'app_ProbeCheck';
}

const APP_ID = appId();
const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET
  ? secretValue('WHOP_WEBHOOK_SECRET', process.env.WHOP_WEBHOOK_SECRET)
  : null;
/** A community and an experience that exist nowhere. */
const API = '/api/creator/biz_ProbeCheck1';
const MEMBER_API = '/api/member/exp_ProbeCheck1';
const STRANGER = 'https://evil.example';

interface Verdict {
  check: string;
  /** null: for information, never a failure. */
  ok: boolean | null;
  seen: string;
}
const verdicts: Verdict[] = [];
const note = (check: string, ok: boolean | null, seen: string) =>
  verdicts.push({ check, ok, seen });

async function call(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    ...init,
  });
}

/** The check passes when the answer's status is one of `allowed` (and `also` agrees). */
async function expectStatus(
  check: string,
  pathname: string,
  init: RequestInit,
  allowed: number[],
  also: (response: Response) => boolean = () => true,
): Promise<Response | null> {
  try {
    const response = await call(pathname, init);
    const ok = allowed.includes(response.status) && also(response);
    await response.body?.cancel();
    note(check, ok, String(response.status));
    return response;
  } catch (error) {
    note(check, false, error instanceof Error ? error.name : 'no answer');
    return null;
  }
}

// Tokens ----------------------------------------------------------------------------------------

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');

function claims() {
  const now = Math.floor(Date.now() / 1000);
  return { sub: 'user_ProbeCheck1', aud: APP_ID, iss: USER_TOKEN_ISSUER, iat: now, exp: now + 300 };
}

function unsignedToken(): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(claims()))}.`;
}

/** Whop's form, signed by a key that is not Whop's. */
async function strangerToken(): Promise<string> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims()))}`;
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/** Signed with a shared secret, as a server that trusts the header's `alg` would accept. */
async function sharedSecretToken(): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims()))}`;
  const signature = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/** A body sent chunk by chunk, without its length. */
function chunked(bytes: number): ReadableStream<Uint8Array> {
  let left = bytes;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(16 * 1024, left);
      left -= size;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
  });
}
const streamed = (body: ReadableStream<Uint8Array>, init: RequestInit = {}) =>
  ({ ...init, body, duplex: 'half' }) as RequestInit;

// 1. Who may call the API -----------------------------------------------------------------------

const token = (value: string) => ({ headers: { 'x-whop-user-token': value } });
const first = await expectStatus('API without a token', `${API}/session`, {}, [401]);
await expectStatus('API, a malformed token', `${API}/session`, token('not.a.token'), [401]);
await expectStatus(
  'API, an unsigned token (alg none)',
  `${API}/session`,
  token(unsignedToken()),
  [401],
);
await expectStatus(
  'API, a token signed by a key not Whop’s',
  `${API}/session`,
  token(await strangerToken()),
  [401],
);
await expectStatus(
  'API, a token signed with a shared secret (HS256)',
  `${API}/session`,
  token(await sharedSecretToken()),
  [401],
);
await expectStatus(
  'API, a forged session cookie',
  `${API}/session`,
  { headers: { cookie: `__Host-stayput_session=${b64url('{"userId":"user_ProbeCheck1"}')}.x` } },
  [401],
);
await expectStatus(
  'A change without a token',
  `${API}/badge`,
  { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' },
  [401],
);
await expectStatus('The data export without a token', `${API}/export`, {}, [401]);
await expectStatus('The operator’s page without a token', `${API}/operator/status`, {}, [401]);
await expectStatus('The member API without a token', `${MEMBER_API}/session`, {}, [401]);

// 2. Bodies too large: refused before they are read whole, before anyone is known -------------

await expectStatus(
  'API body of 100 KB, length untold',
  `${API}/badge`,
  streamed(chunked(100 * 1024), { method: 'PUT' }),
  [413],
);
await expectStatus(
  'API body of 100 KB, length told',
  `${API}/badge`,
  { method: 'PUT', body: 'a'.repeat(100 * 1024) },
  [413],
);

// 3. Whop's and Telegram's webhooks -------------------------------------------------------------

const event = JSON.stringify({ type: 'probe.check', data: {} });
const nowSeconds = Math.floor(Date.now() / 1000);
const webhook = (headers: Record<string, string>, body = event): RequestInit => ({
  method: 'POST',
  body,
  headers: { 'content-type': 'application/json', ...headers },
});
await expectStatus('Whop webhook, unsigned', '/webhooks/whop', webhook({}), [401]);
await expectStatus(
  'Whop webhook, a forged signature',
  '/webhooks/whop',
  webhook({
    'webhook-id': 'msg_ProbeForged',
    'webhook-timestamp': String(nowSeconds),
    'webhook-signature': `v1,${Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64')}`,
  }),
  [401],
);
if (WEBHOOK_SECRET) {
  const stale = nowSeconds - 10 * 60;
  await expectStatus(
    'Whop webhook rightly signed, replayed 10 minutes later',
    '/webhooks/whop',
    webhook({
      'webhook-id': 'msg_ProbeReplay',
      'webhook-timestamp': String(stale),
      'webhook-signature': await signWebhook(event, WEBHOOK_SECRET, 'msg_ProbeReplay', stale),
    }),
    [401],
  );
} else {
  note('Whop webhook rightly signed, replayed 10 minutes later', null, 'not tried: no secret');
}
await expectStatus(
  'Whop webhook of 300 KB, length untold',
  '/webhooks/whop',
  streamed(chunked(300 * 1024), { method: 'POST' }),
  [413],
);
await expectStatus(
  'Telegram webhook without its secret',
  '/webhooks/telegram',
  webhook({}, '{}'),
  [401, 404],
);

// 4. Sign-in flows, their state forged ----------------------------------------------------------

const location = (response: Response) => response.headers.get('location') ?? '';
await expectStatus(
  'Discord install, a forged state',
  '/auth/discord/callback?state=forged&code=probe',
  {},
  [302],
  (response) => location(response).includes('status=failed'),
);
await expectStatus(
  'Sign-in with Whop, no sign-in under way',
  '/auth/callback?state=forged&code=probe',
  {},
  // The sandbox sends back with « failed »; production has no sign-in outside Whop.
  [302, 404],
  (response) => response.status === 404 || location(response).includes('login=failed'),
);

// 5. Headers and origins ------------------------------------------------------------------------

if (first) {
  const h = first.headers;
  note(
    'API answers: no-store, nosniff, JSON',
    (h.get('cache-control') ?? '').includes('no-store') &&
      h.get('x-content-type-options') === 'nosniff' &&
      (h.get('content-type') ?? '').includes('application/json'),
    'headers',
  );
}
const site = await expectStatus('The site', '/', {}, [200]);
if (site) {
  const csp = site.headers.get('content-security-policy') ?? '';
  note(
    'The site: a content security policy, nosniff, a referrer policy',
    csp.includes("default-src 'self'") &&
      site.headers.get('x-content-type-options') === 'nosniff' &&
      site.headers.has('referrer-policy'),
    'headers',
  );
  note(
    'The site: who may frame it (frame-ancestors)',
    null,
    csp.includes('frame-ancestors') ? 'set' : 'not set',
  );
  note(
    'HTTPS only (Strict-Transport-Security)',
    null,
    site.headers.has('strict-transport-security') ? 'set' : 'not set',
  );
}
const noStranger = (response: Response) => {
  const allowed = response.headers.get('access-control-allow-origin');
  return allowed === null || (allowed !== '*' && allowed !== STRANGER);
};
await expectStatus(
  'Another site’s preflight (CORS)',
  `${API}/badge`,
  {
    method: 'OPTIONS',
    headers: {
      origin: STRANGER,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'x-whop-user-token,content-type',
    },
  },
  [200, 204, 401, 404, 405],
  noStranger,
);
await expectStatus(
  'Another site reading the API (CORS)',
  `${API}/session`,
  { headers: { origin: STRANGER } },
  [401],
  noStranger,
);

// 6. What is never served -----------------------------------------------------------------------

/** No file of the repository, nor a secret, behind these paths (the app's page may answer). */
for (const file of ['/.env', '/.dev.vars', '/.git/config', '/wrangler.toml', '/package.json']) {
  try {
    const response = await call(file);
    const text = (await response.text()).slice(0, 200_000);
    const leaked = /WHOP_|apik_|\[core\]|compatibility_date|"devDependencies"/.test(text);
    note(`Never served: ${file}`, !leaked, String(response.status));
  } catch (error) {
    note(`Never served: ${file}`, false, error instanceof Error ? error.name : 'no answer');
  }
}
try {
  const response = await call('/health');
  const text = await response.text();
  note(
    '/health says nothing secret',
    response.status === 200 && !/apik_|ws_|postgres|password|secret|token/i.test(text),
    String(response.status),
  );
} catch (error) {
  note('/health says nothing secret', false, error instanceof Error ? error.name : 'no answer');
}
await expectStatus(
  'A badge, a path climbing out',
  '/badge/..%2F..%2Fetc%2Fpasswd.svg',
  {},
  [400, 404],
);

// 7. Many calls at once (information: no rate limit on workers.dev) ----------------------------

const statuses = await Promise.all(
  Array.from({ length: 20 }, () =>
    call(`${API}/session`)
      .then(async (response) => {
        await response.body?.cancel();
        return response.status;
      })
      .catch(() => 0),
  ),
);
note(
  '20 calls at once without a token',
  statuses.every((status) => status === 401 || status === 429),
  `${statuses.filter((s) => s === 429).length} slowed (429)`,
);

// The report ------------------------------------------------------------------------------------

const mark = (ok: boolean | null) => (ok === null ? 'ℹ️' : ok ? '✅' : '❌');
const lines = [
  `### Security checks from outside: ${base}`,
  '',
  '| | Check | Seen |',
  '| --- | --- | --- |',
  ...verdicts.map((v) => `| ${mark(v.ok)} | ${v.check} | ${v.seen} |`),
  '',
];
console.info(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
const failed = verdicts.filter((v) => v.ok === false).length;
console.info(`${verdicts.length} checks, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
