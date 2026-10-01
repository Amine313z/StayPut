import type { AccessLevel } from '@stayput/core';
import { WhopOAuthError, pkceChallenge, type WhopClient, type WhopOAuth } from '@stayput/whop';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccessCache } from '../src/access';
import { CSRF_HEADER, createApp, type AppDeps } from '../src/app';
import type { Env } from '../src/env';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../src/session';

const SANDBOX: Env = { WHOP_ENV: 'sandbox', WHOP_APP_ID: 'app_stayput', WHOP_API_KEY: 'apik_one' };

let publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
beforeAll(async () => {
  ({ publicKey } = await generateKeyPair('ES256'));
});

/** Whop's OAuth: accepts the code "good" with the verifier of the last challenge it was sent. */
function fakeOAuth(userId = 'user_alice') {
  let challenge = '';
  const revoked: string[] = [];
  const oauth: WhopOAuth = {
    env: 'sandbox',
    authorizeUrl: (options) => {
      challenge = options.challenge;
      const query = new URLSearchParams({ ...options, redirect_uri: options.redirectUri });
      return `https://whop.test/oauth/authorize?${query.toString()}`;
    },
    exchangeCode: async ({ code, verifier }) => {
      if (code !== 'good' || (await pkceChallenge(verifier)) !== challenge) {
        throw new WhopOAuthError('invalid_grant', 'bad code or verifier');
      }
      return { accessToken: 'at', refreshToken: 'rt' };
    },
    user: () => Promise.resolve({ userId, username: 'alice', name: null }),
    revoke: (token) => {
      revoked.push(token);
      return Promise.resolve();
    },
  };
  return { oauth, revoked };
}

function setup(access: Record<string, AccessLevel> = {}) {
  const clock = { now: new Date('2026-10-01T12:00:00Z') };
  const fake = fakeOAuth();
  const whop = {
    env: 'sandbox',
    checkAccess: (userId: string, resourceId: string) => {
      const level = access[`${userId}:${resourceId}`] ?? 'no_access';
      return Promise.resolve({ hasAccess: level !== 'no_access', accessLevel: level });
    },
  } as unknown as WhopClient;
  const deps: AppDeps = {
    now: () => clock.now,
    openDb: () => null,
    whopClient: (config) => (config.apiKey ? whop : null),
    userTokenKeys: () => publicKey,
    oauth: () => fake.oauth,
    discord: () => null,
    telegram: () => null,
    accessCache: new AccessCache(),
  };
  const app = createApp(deps);
  const request = (url: string, init: RequestInit = {}, env: Env = SANDBOX) =>
    app.request(url, init, env);
  return { request, clock, revoked: fake.revoked };
}

/** `name=value` of a Set-Cookie header, by cookie name. */
function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

const valueOf = (line: string | undefined) => line?.split(';')[0]?.split('=').slice(1).join('=');

/** Starts a sign-in, then comes back from Whop with `code`; returns both responses. */
async function signIn(
  ctx: ReturnType<typeof setup>,
  {
    next = '/dashboard/biz_A1',
    code = 'good',
    state,
  }: { next?: string; code?: string; state?: string } = {},
) {
  const login = await ctx.request(`/auth/login?next=${encodeURIComponent(next)}`);
  const authorize = new URL(login.headers.get('location') ?? '');
  const query = new URLSearchParams({
    code,
    state: state ?? authorize.searchParams.get('state') ?? '',
  });
  const callback = await ctx.request(`/auth/callback?${query.toString()}`, {
    headers: { cookie: `${LOGIN_COOKIE}=${valueOf(setCookie(login, LOGIN_COOKIE))}` },
  });
  return { login, authorize, callback, session: valueOf(setCookie(callback, SESSION_COOKIE)) };
}

const withSession = (session: string | undefined): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE}=${session ?? ''}` },
});

describe('signing in with Whop outside the iframe (sandbox)', () => {
  it('sends the browser to Whop with a PKCE challenge, and remembers it in a signed cookie', async () => {
    const { login, authorize } = await signIn(setup());
    expect(login.status).toBe(302);
    expect(authorize.origin + authorize.pathname).toBe('https://whop.test/oauth/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost/auth/callback');
    expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(setCookie(login, LOGIN_COOKIE)).toMatch(
      /^__Host-stayput_login=[\w-]+\.[\w-]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  it('comes back signed in, on the page it started from, keeping no Whop token', async () => {
    const ctx = setup({ 'user_alice:biz_A1': 'admin' });
    const { callback, session } = await signIn(ctx);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard/biz_A1');
    expect(setCookie(callback, SESSION_COOKIE)).toMatch(
      /; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(setCookie(callback, LOGIN_COOKIE)).toMatch(
      /^__Host-stayput_login=; Path=\/; Max-Age=0;/,
    );
    expect(ctx.revoked).toEqual(['rt']);

    const res = await ctx.request('/api/creator/biz_A1/session', withSession(session));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      companyId: 'biz_A1',
      userId: 'user_alice',
      accessLevel: 'admin',
      via: 'login',
    });
  });

  it('still checks access with Whop: signing in is not an access grant', async () => {
    const ctx = setup({ 'user_alice:biz_A1': 'customer' });
    const { session } = await signIn(ctx);
    expect((await ctx.request('/api/creator/biz_A1/session', withSession(session))).status).toBe(
      403,
    );
  });

  it('returns to the page with ?login=failed when anything is off', async () => {
    const ctx = setup();
    const mismatch = await signIn(ctx, { state: 'forged' });
    expect(mismatch.callback.headers.get('location')).toBe('/dashboard/biz_A1?login=failed');
    expect(mismatch.session).toBeUndefined();

    const refused = await signIn(ctx, { code: 'bad' });
    expect(refused.callback.headers.get('location')).toBe('/dashboard/biz_A1?login=failed');
    expect(refused.session).toBeUndefined();

    const denied = await ctx.request('/auth/callback?error=access_denied');
    expect(denied.headers.get('location')).toBe('/?login=failed');
  });

  it('never sends the browser off the site afterwards', async () => {
    for (const next of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'x']) {
      const { callback } = await signIn(setup(), { next });
      expect(callback.headers.get('location'), next).toBe('/');
    }
  });

  it('refuses a session cookie that is forged, expired, signed with another key, or used in production', async () => {
    const ctx = setup({ 'user_alice:biz_A1': 'admin' });
    const { session = '' } = await signIn(ctx);
    const [payload = '', signature = ''] = session.split('.');
    const unauthenticated = async (cookieValue: string, env: Env = SANDBOX) => {
      const res = await ctx.request('/api/creator/biz_A1/session', withSession(cookieValue), env);
      expect(res.status).toBe(401);
      return ((await res.json()) as { error: { login?: string } }).error.login;
    };

    const forged = Buffer.from(
      JSON.stringify({ purpose: 'session', userId: 'user_mallory', env: 'sandbox', exp: 2e9 }),
    ).toString('base64url');
    expect(await unauthenticated(`${forged}.${signature}`)).toBe('/auth/login');
    expect(await unauthenticated(`${payload}.${signature}x`)).toBe('/auth/login');
    // Not even base64url: refused the same way, not an error.
    expect(await unauthenticated(`${payload}.a`)).toBe('/auth/login');
    expect(await unauthenticated(payload)).toBe('/auth/login');

    const rotated = { ...SANDBOX, WHOP_API_KEY: 'apik_two' };
    expect(await unauthenticated(session, rotated)).toBe('/auth/login');
    expect(await unauthenticated(session, { ...SANDBOX, WHOP_ENV: 'production' })).toBeUndefined();

    ctx.clock.now = new Date('2026-10-02T00:00:01Z');
    expect(await unauthenticated(session)).toBe('/auth/login');
  });

  it("lets Whop's iframe token decide when there is one", async () => {
    const ctx = setup({ 'user_alice:biz_A1': 'admin' });
    const { session } = await signIn(ctx);
    const res = await ctx.request('/api/creator/biz_A1/session', {
      headers: { cookie: `${SESSION_COOKIE}=${session ?? ''}`, 'x-whop-user-token': 'not.a.jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('asks a signed-in browser for the CSRF header before any change', async () => {
    const ctx = setup({ 'user_alice:biz_A1': 'admin' });
    const { session } = await signIn(ctx);
    const post = (headers: Record<string, string>) =>
      ctx.request('/api/creator/biz_A1/session', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE}=${session ?? ''}`, ...headers },
      });
    const refused = await post({});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden' } });
    // With the header, the request goes on (to a route that only answers GET here).
    expect((await post({ [CSRF_HEADER]: '1' })).status).toBe(404);
  });

  it('signs out', async () => {
    const res = await setup().request('/auth/logout');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(setCookie(res, SESSION_COOKIE)).toMatch(/^__Host-stayput_session=; Path=\/; Max-Age=0;/);
  });

  it('is off in production, where StayPut only opens inside Whop', async () => {
    const production = { ...SANDBOX, WHOP_ENV: 'production' };
    const ctx = setup();
    expect((await ctx.request('/auth/login', {}, production)).status).toBe(404);
    expect((await ctx.request('/auth/callback?code=good', {}, production)).status).toBe(404);
    const res = await ctx.request('/api/creator/biz_A1/session', {}, production);
    expect(await res.json()).toEqual({
      error: { code: 'unauthenticated', message: 'missing or invalid Whop user token' },
    });
  });

  it('is served by the Worker, not by the static files (wrangler.toml)', () => {
    const toml = readFileSync(path.resolve(import.meta.dirname, '../wrangler.toml'), 'utf8');
    expect(/^run_worker_first\s*=\s*\[(.*)\]$/m.exec(toml)?.[1]).toContain('"/auth/*"');
  });
});
