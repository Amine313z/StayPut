import { isUserId } from '@stayput/core';
import { createRemoteJWKSet, jwtVerify, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import { WHOP_JWKS_URL, type WhopEnv } from './env';

/**
 * Inside Whop, the app is served through Whop's proxy, which adds this header to every request
 * the iframe makes to its own origin: an ES256 JWT signed by Whop, `sub` = the viewer's user id,
 * `aud` = our app id (docs/whop-api-verification.md, section 3).
 */
export const USER_TOKEN_HEADER = 'x-whop-user-token';
export const USER_TOKEN_ISSUER = 'urn:whopcom:exp-proxy';

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/**
 * Whop's public keys for `env`, fetched once per Worker instance and cached by jose (12 h, and
 * at most one refetch every 30 s when a token names an unknown key).
 */
export function whopUserTokenKeys(env: WhopEnv): JWTVerifyGetKey {
  const url = WHOP_JWKS_URL[env];
  let keys = remoteKeySets.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 12 * 60 * 60 * 1000,
      cooldownDuration: 30_000,
    });
    remoteKeySets.set(url, keys);
  }
  return keys;
}

export interface VerifyUserTokenOptions {
  /** Our app id (`app_…`): the token's audience. */
  appId: string;
  /** Whop's key set, or a fixed key in tests. */
  keys: JWTVerifyGetKey | CryptoKey;
  /** The moment to check expiry against (tests); now otherwise. */
  now?: Date;
}

/**
 * The Whop user behind the token, or null when it is missing, forged, expired, issued for
 * another app or signed with an unexpected algorithm. Never throws: a bad token is a 401.
 */
export async function verifyUserToken(
  token: string | null | undefined,
  { appId, keys, now }: VerifyUserTokenOptions,
): Promise<{ userId: string } | null> {
  if (!token || !appId) return null;
  try {
    const verifyOptions = {
      issuer: USER_TOKEN_ISSUER,
      audience: appId,
      algorithms: ['ES256'],
      ...(now ? { currentDate: now } : {}),
    };
    // jose has one overload per key kind; the branch keeps each call on its own overload.
    const { payload } =
      typeof keys === 'function'
        ? await jwtVerify(token, keys, verifyOptions)
        : await jwtVerify(token, keys, verifyOptions);
    // One audience, and it is ours (jose accepts ours among several; Whop sends one).
    if (Array.isArray(payload.aud)) return null;
    if (!isUserId(payload.sub)) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}
