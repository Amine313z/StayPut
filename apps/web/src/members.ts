import type { MemberRow } from '@stayput/core';
import { isFailedPayment } from '@stayput/core';
import { fold } from './text';

/**
 * The Members page (brief v4 §9.3) as pure functions: what state a member is in (one word each,
 * the same everywhere: Leaving · Payment failed · Inactive · Active), what each filter keeps,
 * what a search finds, and every column's order.
 */

/** The search waits this long after the last key before it goes into the address. */
export const SEARCH_DELAY_MS = 250;

/**
 * Whether a member is one a search asks for (fix prompt v4.1, block 3): each word typed is in
 * their name or their Whop username, case and accents aside (« hugo », « HUGO » and « Hugó » find
 * Hugo Bernard); « @hugo » looks the same. Nothing typed: everyone.
 */
export function matchesSearch(
  member: Pick<MemberRow, 'name' | 'username'>,
  query: string,
): boolean {
  const words = fold(query)
    .split(/\s+/)
    .map((word) => word.replace(/^@/, ''))
    .filter(Boolean);
  if (words.length === 0) return true;
  const known = fold([member.name, member.username].filter(Boolean).join(' '));
  return words.every((word) => known.includes(word));
}

const DAY = 86_400_000;

/** No activity for this long: inactive (the risk score's default recency threshold). */
export const INACTIVE_DAYS = 14;

/** A newcomer who has done nothing yet is not « inactive » before this many days. */
const NEWCOMER_GRACE_DAYS = 3;

/** A departure this close is urgent: the red dot (brief v4 §6: within 48 hours). */
export const URGENT_MS = 48 * 3_600_000;

export type MemberState = 'leaving' | 'paymentFailed' | 'inactive' | 'active' | 'team' | 'gone';

/** The most pressing first: the order of the status column. */
export const STATE_ORDER: readonly MemberState[] = [
  'leaving',
  'paymentFailed',
  'inactive',
  'active',
  'team',
  'gone',
];

/** A membership's price brought back to a month (the Worker's monthlyPrice). */
export function monthlyOf(membership: MemberRow['membership']): number | null {
  if (!membership?.price || !membership.billingPeriodDays) return null;
  const days = membership.billingPeriodDays;
  if (days >= 28 && days <= 31) return membership.price;
  if (days === 7) return (membership.price * 52) / 12;
  if (days >= 365 && days <= 366) return membership.price / 12;
  return (membership.price * 30) / days;
}

/** A cancellation is scheduled: they leave at the end of their period. */
export function isLeaving(member: MemberRow): boolean {
  const membership = member.membership;
  return (
    member.risk?.level === 'scheduled_departure' ||
    (membership !== null && (membership.cancelAtPeriodEnd || membership.status === 'canceling'))
  );
}

/** Their last payment failed and was not recovered since. */
export function hasFailedPayment(member: MemberRow): boolean {
  return member.lastPayment !== null && isFailedPayment(member.lastPayment.status);
}

/** When they were last active anywhere, in ms; null when never. */
export function lastActive(member: MemberRow): number | null {
  const at = member.lastActivityAt ?? member.lastActionAt;
  return at ? Date.parse(at) : null;
}

/**
 * One word for where a member stands: gone, the team, leaving (a cancellation scheduled), a
 * payment failed, inactive (nothing for 14 days, or nothing at all 3 days after joining), active.
 */
export function memberState(member: MemberRow, now: number): MemberState {
  if (member.status === 'left') return 'gone';
  if (member.accessLevel === 'admin') return 'team';
  if (isLeaving(member)) return 'leaving';
  if (hasFailedPayment(member)) return 'paymentFailed';
  const last = lastActive(member);
  if (last === null) {
    const joined = member.joinedAt ? Date.parse(member.joinedAt) : null;
    return joined !== null && now - joined < NEWCOMER_GRACE_DAYS * DAY ? 'active' : 'inactive';
  }
  return now - last >= INACTIVE_DAYS * DAY ? 'inactive' : 'active';
}

/** When the membership ends or renews, in ms; null without one. */
export function periodEnd(member: MemberRow): number | null {
  const end = member.membership?.currentPeriodEnd;
  return end ? Date.parse(end) : null;
}

/**
 * The red dot (brief v4 §6): a payment failed and not recovered, or a departure within 48
 * hours. Never the team, never someone who already left.
 */
export function isUrgent(member: MemberRow, now: number): boolean {
  const state = memberState(member, now);
  if (state === 'gone' || state === 'team') return false;
  const end = periodEnd(member);
  return hasFailedPayment(member) || (isLeaving(member) && end !== null && end - now <= URGENT_MS);
}

/** The filter chips (brief v4 §9.3): All, Leaving, High, Medium, Low, New inactive, Gone. */
export const MEMBER_FILTERS = [
  'all',
  'leaving',
  'high',
  'medium',
  'low',
  'newcomers',
  'left',
] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number];

export function keepMember(filter: MemberFilter, member: MemberRow): boolean {
  switch (filter) {
    case 'leaving':
      return member.status === 'joined' && isLeaving(member);
    case 'high':
    case 'medium':
    case 'low':
      return member.status === 'joined' && member.risk?.level === filter;
    case 'newcomers':
      return member.status === 'joined' && member.risk?.inactiveNewcomer === true;
    case 'left':
      return member.status === 'left';
    case 'all':
      return true;
  }
}

/** Every column sorts (brief v4 §9.3). */
export const MEMBER_SORTS = ['member', 'risk', 'status', 'mrr', 'lastActivity', 'renewal'] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];
export type SortDirection = 'asc' | 'desc';

/** The way a column first sorts: the most telling first (the riskiest, the most recent…). */
export const FIRST_DIRECTION: Readonly<Record<MemberSort, SortDirection>> = {
  member: 'asc',
  risk: 'desc',
  status: 'asc',
  mrr: 'desc',
  lastActivity: 'desc',
  renewal: 'asc',
};

/**
 * The members in a column's order. What a column cannot say (no score, no membership) always
 * comes last, whichever way it sorts; equal ones keep the Worker's order (the most at risk
 * first).
 */
export function sortMembers(
  members: readonly MemberRow[],
  sort: MemberSort,
  direction: SortDirection,
  now: number,
  compareNames: (a: string, b: string) => number,
): MemberRow[] {
  const value = (member: MemberRow): number | string | null => {
    switch (sort) {
      case 'member':
        return member.name;
      case 'risk':
        return member.risk?.score ?? null;
      case 'status':
        return STATE_ORDER.indexOf(memberState(member, now));
      case 'mrr':
        return monthlyOf(member.membership);
      case 'lastActivity':
        return lastActive(member);
      case 'renewal':
        return member.status === 'left' ? null : periodEnd(member);
    }
  };
  const sign = direction === 'asc' ? 1 : -1;
  return members
    .map((member, index) => ({ member, index, value: value(member) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const order =
        typeof a.value === 'string' && typeof b.value === 'string'
          ? compareNames(a.value, b.value)
          : Number(a.value) - Number(b.value);
      return order === 0 ? a.index - b.index : sign * order;
    })
    .map(({ member }) => member);
}
