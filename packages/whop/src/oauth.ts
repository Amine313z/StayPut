import { isUserId } from '@stayput/core';
import { WHOP_OAUTH_BASE_URL, type WhopEnv } from './env';

/**
 * "Sign in with Whop" outside Whop's iframe (OAuth 2.1 + PKCE, public client: no client secret,
 * the code verifier proves the exchange). StayPut only needs to know who signed in: the tokens
 * are used once, for the user info, then revoked.
 */

/** Why signing in failed, in OAuth's own terms (`invalid_grant`, `access_denied`…). */
export class WhopOAuthError extends Error {
  override readonly name = 'WhopOAuthError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OAuthUser {
  userId: string;
  username: string | null;
  name: string | null;
}

export interface WhopOAuth {
  readonly env: WhopEnv;
  /** Where to send the browser; keep `verifier` and `state` until the callback. */
  authorizeUrl(options: { redirectUri: string; state: string; challenge: string }): string;
  /** The callback's `code` against tokens. */
  exchangeCode(options: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<{ accessToken: string; refreshToken: string | null }>;
  /** Who the access token belongs to. */
  user(accessToken: string): Promise<OAuthUser>;
  /** Ends the grant: StayPut keeps no Whop token after sign-in. */
  revoke(token: string): Promise<void>;
}

/** The scopes asked for: who the user is, and their name for the screen. */
export const OAUTH_SCOPE = 'openid profile';

export function createWhopOAuth(options: {
  env: WhopEnv;
  clientId: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): WhopOAuth {
  const base = WHOP_OAUTH_BASE_URL[options.env];
  // Called through a wrapper: Workers reject a detached `fetch` ("Illegal invocation").
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

  async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await send(`${base}/${path}`, init);
    } catch (cause) {
      throw new WhopOAuthError('network_error', cause instanceof Error ? cause.message : 'fetch');
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
      const description = typeof body.error_description === 'string' ? body.error_description : '';
      throw new WhopOAuthError(code, `${path}: ${code} ${description}`.trim());
    }
    return body;
  }

  const json = (body: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    env: options.env,

    authorizeUrl({ redirectUri, state, challenge }) {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_SCOPE,
        state,
        // OpenID Connect's replay guard; StayPut reads the user info, not the ID token.
        nonce: base64Url(crypto.getRandomValues(new Uint8Array(16))),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `${base}/authorize?${query.toString()}`;
    },

    async exchangeCode({ code, redirectUri, verifier }) {
      const body = await call(
        'token',
        json({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: options.clientId,
          code_verifier: verifier,
        }),
      );
      if (typeof body.access_token !== 'string' || body.access_token === '') {
        throw new WhopOAuthError('invalid_response', 'token: no access token');
      }
      return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      };
    },

    async user(accessToken) {
      const body = await call('userinfo', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (!isUserId(body.sub)) throw new WhopOAuthError('invalid_response', 'userinfo: no user');
      const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
      return {
        userId: body.sub,
        username: text(body.preferred_username),
        name: text(body.name),
      };
    },

    async revoke(token) {
      await call('revoke', json({ token, client_id: options.clientId }));
    },
  };
}

/** A PKCE pair (RFC 7636, S256): the verifier stays with StayPut, the challenge goes to Whop. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
