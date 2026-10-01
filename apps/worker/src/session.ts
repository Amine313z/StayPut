import { base64Url } from '@stayput/whop';
import type { CryptoKey } from 'jose';

/**
 * Signed cookies for "Sign in with Whop" outside the iframe (sandbox, DECISIONS.md). A value is
 * `base64url(JSON).base64url(HMAC-SHA256)`; the key is derived from the app's API key (HKDF), so
 * no other secret has to be stored, and changing the key signs everyone out.
 */

/** The signed-in user (12 hours). `__Host-`: Secure, path /, never shared with a subdomain. */
export const SESSION_COOKIE = '__Host-stayput_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Between /auth/login and /auth/callback (10 minutes): PKCE verifier, state, where to return. */
export const LOGIN_COOKIE = '__Host-stayput_login';
export const LOGIN_TTL_SECONDS = 10 * 60;

export interface SessionClaims {
  purpose: 'session';
  userId: string;
  env: string;
  /** Seconds since the epoch. */
  exp: number;
}

export interface LoginClaims {
  purpose: 'login';
  state: string;
  verifier: string;
  next: string;
  env: string;
  exp: number;
}

type Claims = SessionClaims | LoginClaims;

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** The HMAC key, derived once per API key and isolate. */
export function signingKey(apiKey: string): Promise<CryptoKey> {
  let key = keys.get(apiKey);
  if (!key) {
    key = deriveKey(apiKey);
    keys.clear();
    keys.set(apiKey, key);
  }
  return key;
}

async function deriveKey(apiKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(apiKey), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('stayput'),
      info: encoder.encode('cookie-signing-v1'),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function sign(claims: Claims, key: CryptoKey): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * The claims of a value this Worker signed, for this purpose and environment, not expired;
 * null for anything else (tampered, foreign, stale).
 */
export async function verify<P extends Claims['purpose']>(
  value: string | undefined,
  key: CryptoKey,
  expected: { purpose: P; env: string; nowSeconds: number },
): Promise<Extract<Claims, { purpose: P }> | null> {
  const [payload, signature, extra] = value?.split('.') ?? [];
  if (!payload || !signature || extra !== undefined) return null;
  const valid = await crypto.subtle
    .verify('HMAC', key, fromBase64Url(signature), encoder.encode(payload))
    .catch(() => false);
  if (!valid) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (
    !isRecord(claims) ||
    claims.purpose !== expected.purpose ||
    claims.env !== expected.env ||
    typeof claims.exp !== 'number' ||
    claims.exp <= expected.nowSeconds
  ) {
    return null;
  }
  // Purpose, environment and expiry checked above; the rest was signed by this Worker.
  return claims as unknown as Extract<Claims, { purpose: P }>;
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A cookie of the request, by name. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** A `__Host-` cookie: only over HTTPS, for the whole site, unreadable by scripts. */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Where to go after signing in: a path of this site only (never `//other.site` or a full URL),
 * the home page otherwise.
 */
export function safeNext(next: string | undefined): string {
  if (!next || next.length > 300) return '/';
  return /^\/(?![/\\])[^\s\\]*$/.test(next) ? next : '/';
}
