/**
 * What Whop's access check (`GET /users/{id}/access/{resource}`) says about a user:
 * `admin` is any team member of the account (moderators included), `customer` holds a valid
 * membership, `no_access` neither.
 */
export type AccessLevel = 'admin' | 'customer' | 'no_access';

export const ACCESS_LEVELS: readonly AccessLevel[] = ['admin', 'customer', 'no_access'];

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/** The creator view (dashboard) is for the account's team only. */
export function canOpenCreatorView(level: AccessLevel): boolean {
  return level === 'admin';
}

/** The member view needs valid access to the experience; the team can open it too. */
export function canOpenMemberView(level: AccessLevel): boolean {
  return level === 'admin' || level === 'customer';
}
