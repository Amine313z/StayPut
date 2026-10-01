import { describe, expect, it } from 'vitest';
import { WhopOAuthError, base64Url, createWhopOAuth, pkceChallenge, pkcePair } from '../src';

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Whop's OAuth endpoints, answering the queued responses in order. */
function fakeOAuth(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const oauth = createWhopOAuth({
    env: 'sandbox',
    clientId: 'app_stayput',
    fetch: (input, init) => {
      calls.push({
        url: new URL(input),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('unexpected request'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  });
  return { oauth, calls };
}

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636 (appendix B)', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh 43-character verifier each time, with its challenge', async () => {
    const a = await pkcePair();
    const b = await pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(await pkceChallenge(a.verifier));
    expect(base64Url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('createWhopOAuth', () => {
  it("sends the browser to the environment's own authorize endpoint", () => {
    const { oauth } = fakeOAuth();
    const url = new URL(
      oauth.authorizeUrl({
        redirectUri: 'https://x.dev/auth/callback',
        state: 's1',
        challenge: 'c1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://sandbox-api.whop.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app_stayput',
      redirect_uri: 'https://x.dev/auth/callback',
      scope: 'openid profile',
      state: 's1',
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) as unknown,
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the verifier, then reads who signed in', async () => {
    const { oauth, calls } = fakeOAuth(
      json({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 }),
      json({ sub: 'user_alice', preferred_username: 'alice', name: '' }),
      json({}),
    );
    const tokens = await oauth.exchangeCode({
      code: 'code1',
      redirectUri: 'https://x.dev/auth/callback',
      verifier: 'v1',
    });
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    expect(await oauth.user('at')).toEqual({ userId: 'user_alice', username: 'alice', name: null });
    await oauth.revoke('rt');

    expect(calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
      'POST https://sandbox-api.whop.com/oauth/token',
      'GET https://sandbox-api.whop.com/oauth/userinfo',
      'POST https://sandbox-api.whop.com/oauth/revoke',
    ]);
    expect(calls[0]?.body).toEqual({
      grant_type: 'authorization_code',
      code: 'code1',
      redirect_uri: 'https://x.dev/auth/callback',
      client_id: 'app_stayput',
      code_verifier: 'v1',
    });
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer at');
    expect(calls[2]?.body).toEqual({ token: 'rt', client_id: 'app_stayput' });
  });

  it("reports OAuth's own error codes, an unusable answer, and an unreachable Whop", async () => {
    const failure = async (promise: Promise<unknown>) => {
      const error = await promise.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WhopOAuthError);
      return (error as WhopOAuthError).code;
    };
    const exchange = (oauth: ReturnType<typeof fakeOAuth>['oauth']) =>
      oauth.exchangeCode({ code: 'c', redirectUri: 'r', verifier: 'v' });

    const expired = fakeOAuth(
      json({ error: 'invalid_grant', error_description: 'Authorization code is invalid' }, 400),
    );
    expect(await failure(exchange(expired.oauth))).toBe('invalid_grant');
    expect(await failure(exchange(fakeOAuth(json({ token_type: 'bearer' })).oauth))).toBe(
      'invalid_response',
    );
    expect(await failure(exchange(fakeOAuth(new TypeError('fetch failed')).oauth))).toBe(
      'network_error',
    );
    expect(await failure(fakeOAuth(json({ sub: 'alice' })).oauth.user('at'))).toBe(
      'invalid_response',
    );
    expect(await failure(fakeOAuth(new Response('oops', { status: 502 })).oauth.user('at'))).toBe(
      'http_502',
    );
  });

  it('uses the production host in production', () => {
    const oauth = createWhopOAuth({ env: 'production', clientId: 'app_live' });
    expect(oauth.authorizeUrl({ redirectUri: 'r', state: 's', challenge: 'c' })).toMatch(
      /^https:\/\/api\.whop\.com\/oauth\/authorize\?/,
    );
  });
});
