import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { USER_TOKEN_ISSUER, verifyUserToken, whopUserTokenKeys } from '../src';

const APP_ID = 'app_stayput';
let whopKey: { privateKey: CryptoKey; publicKey: CryptoKey };
let otherKey: { privateKey: CryptoKey; publicKey: CryptoKey };

beforeAll(async () => {
  whopKey = await generateKeyPair('ES256');
  otherKey = await generateKeyPair('ES256');
});

function token(
  claims: Record<string, unknown> = {},
  { key = whopKey.privateKey, expiresIn = '5m', kid = 'k1' } = {},
) {
  return new SignJWT({ sub: 'user_abc123', aud: APP_ID, iss: USER_TOKEN_ISSUER, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

describe('verifyUserToken', () => {
  it('returns the Whop user of a token Whop signed for our app', async () => {
    const result = await verifyUserToken(await token(), {
      appId: APP_ID,
      keys: whopKey.publicKey,
    });
    expect(result).toEqual({ userId: 'user_abc123' });
  });

  it('works with a key set, as with the remote JWKS', async () => {
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(whopKey.publicKey)), kid: 'k1', alg: 'ES256' }],
    });
    expect(await verifyUserToken(await token(), { appId: APP_ID, keys: jwks })).toEqual({
      userId: 'user_abc123',
    });
  });

  it.each([
    ['no token', () => Promise.resolve(null)],
    ['a token for another app', () => token({ aud: 'app_other' })],
    ['several audiences', () => token({ aud: [APP_ID, 'app_other'] })],
    ['another issuer', () => token({ iss: 'urn:evil' })],
    ['a subject that is not a user', () => token({ sub: 'biz_123' })],
    ['a forged signature', () => token({}, { key: otherKey.privateKey })],
    ['an expired token', () => token({}, { expiresIn: '-1m' })],
    ['garbage', () => Promise.resolve('not.a.jwt')],
  ])('returns null for %s', async (_case, make) => {
    expect(await verifyUserToken(await make(), { appId: APP_ID, keys: whopKey.publicKey })).toBe(
      null,
    );
  });

  it('refuses an unsigned token (alg "none")', async () => {
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '');
    const payload = btoa(
      JSON.stringify({
        sub: 'user_abc123',
        aud: APP_ID,
        iss: USER_TOKEN_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).replace(/=+$/, '');
    expect(
      await verifyUserToken(`${header}.${payload}.`, { appId: APP_ID, keys: whopKey.publicKey }),
    ).toBeNull();
  });

  it('refuses everything when the app id is not configured', async () => {
    expect(await verifyUserToken(await token(), { appId: '', keys: whopKey.publicKey })).toBeNull();
  });
});

describe('whopUserTokenKeys', () => {
  it('keeps one key set per environment', () => {
    expect(whopUserTokenKeys('sandbox')).toBe(whopUserTokenKeys('sandbox'));
    expect(whopUserTokenKeys('sandbox')).not.toBe(whopUserTokenKeys('production'));
  });
});
