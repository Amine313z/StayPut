/** Sandbox first (`SPEC.md`, rule 4): the Worker talks to production only when told to. */
export type WhopEnv = 'sandbox' | 'production';

export const WHOP_API_BASE_URL: Readonly<Record<WhopEnv, string>> = {
  production: 'https://api.whop.com/api/v1',
  sandbox: 'https://sandbox-api.whop.com/api/v1',
};

/** Keys that sign the iframe's `x-whop-user-token`: the sandbox has its own. */
export const WHOP_JWKS_URL: Readonly<Record<WhopEnv, string>> = {
  production: 'https://api.whop.com/.well-known/jwks.json',
  sandbox: 'https://sandbox-api.whop.com/.well-known/jwks.json',
};

/**
 * Sent as `Api-Version-Date` on every call, so response shapes only change when we move this
 * date (the documentation's version on 2026-09-30, see docs/whop-api-verification.md).
 */
export const WHOP_API_VERSION_DATE = '2026-09-29';

/**
 * `WHOP_ENV` as configured. Unset means sandbox, the safe side; anything else than the two
 * known values is a configuration mistake worth failing on.
 */
export function parseWhopEnv(value: string | undefined): WhopEnv {
  if (value === undefined || value === '') return 'sandbox';
  if (value === 'sandbox' || value === 'production') return value;
  throw new Error(`WHOP_ENV must be "sandbox" or "production", got "${value}"`);
}
