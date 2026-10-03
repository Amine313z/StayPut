/**
 * Whop identifiers are a type prefix and an alphanumeric tail (`biz_…`, `user_…`). Checking the
 * prefix before any API or database call keeps a mistyped or hostile route parameter from ever
 * reaching Whop or Postgres.
 */
const ID_PATTERNS = {
  company: /^biz_[A-Za-z0-9]{1,64}$/,
  user: /^user_[A-Za-z0-9]{1,64}$/,
  experience: /^exp_[A-Za-z0-9]{1,64}$/,
  membership: /^mem_[A-Za-z0-9]{1,64}$/,
  product: /^prod_[A-Za-z0-9]{1,64}$/,
  plan: /^plan_[A-Za-z0-9]{1,64}$/,
  payment: /^pay_[A-Za-z0-9]{1,64}$/,
  member: /^mber_[A-Za-z0-9]{1,64}$/,
} as const;

export type WhopIdKind = keyof typeof ID_PATTERNS;

export function isWhopId(kind: WhopIdKind, value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERNS[kind].test(value);
}

export const isCompanyId = (value: unknown): value is string => isWhopId('company', value);
export const isUserId = (value: unknown): value is string => isWhopId('user', value);
export const isExperienceId = (value: unknown): value is string => isWhopId('experience', value);
export const isMemberId = (value: unknown): value is string => isWhopId('member', value);
