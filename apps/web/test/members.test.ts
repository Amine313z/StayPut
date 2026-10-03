import type { MemberRow } from '@stayput/core';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/demo/world';
import {
  FIRST_DIRECTION,
  isUrgent,
  keepMember,
  matchesSearch,
  memberState,
  monthlyOf,
  sortMembers,
} from '../src/members';

/**
 * The Members page's rules (brief v4 §9.3), without a screen: one word for where each member
 * stands, the red dot for what is urgent only, what each chip keeps, and every column's order.
 */

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();

/** A member who pays $49 a month, active yesterday, unless `over` says otherwise. */
const member = (over: Partial<MemberRow> & Pick<MemberRow, 'id'>): MemberRow => ({
  name: null,
  username: null,
  status: 'joined',
  accessLevel: 'customer',
  joinedAt: at(-100 * DAY),
  lastActionAt: at(-DAY),
  lastActivityAt: at(-DAY),
  doNotContact: false,
  activity: { messages: 0, reactions: 0, posts: 0, lessons: 0 },
  risk: null,
  membership: {
    status: 'active',
    price: 49,
    currency: 'usd',
    billingPeriodDays: 30,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: at(14 * DAY),
  },
  lastPayment: {
    status: 'succeeded',
    amount: 49,
    currency: 'usd',
    at: at(-16 * DAY),
    failureReason: null,
  },
  ...over,
});

const leaving = (inMs: number) => ({
  membership: {
    status: 'active',
    price: 49,
    currency: 'usd',
    billingPeriodDays: 30,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: at(inMs),
  },
});

const failed = {
  lastPayment: {
    status: 'failed',
    amount: 49,
    currency: 'usd',
    at: at(-2 * DAY),
    failureReason: 'Card declined',
  },
};

const scored = (score: number, level: 'high' | 'medium' | 'low', inactiveNewcomer = false) => ({
  risk: { score, level, reasons: [], inactiveNewcomer, computedAt: at(-HOUR) },
});

describe('where a member stands', () => {
  it('says it in one word, the most pressing first', () => {
    // Gone, whatever else; the team is the team.
    expect(memberState(member({ id: 'a', status: 'left', ...leaving(DAY) }), NOW)).toBe('gone');
    expect(memberState(member({ id: 'b', accessLevel: 'admin', ...failed }), NOW)).toBe('team');
    // Leaving before a failed payment, a failed payment before inactivity.
    expect(memberState(member({ id: 'c', ...leaving(5 * DAY), ...failed }), NOW)).toBe('leaving');
    expect(memberState(member({ id: 'd', status: 'joined', ...failed }), NOW)).toBe(
      'paymentFailed',
    );
    expect(memberState(member({ id: 'e', ...failed, lastActivityAt: at(-30 * DAY) }), NOW)).toBe(
      'paymentFailed',
    );
  });

  it('calls a member inactive after 14 days without anything, a newcomer after 3', () => {
    expect(memberState(member({ id: 'a', lastActivityAt: at(-13 * DAY) }), NOW)).toBe('active');
    expect(memberState(member({ id: 'b', lastActivityAt: at(-14 * DAY) }), NOW)).toBe('inactive');
    // No activity recorded, but a visit to the community: that counts.
    expect(
      memberState(member({ id: 'c', lastActivityAt: null, lastActionAt: at(-2 * DAY) }), NOW),
    ).toBe('active');
    const never = { lastActivityAt: null, lastActionAt: null };
    expect(memberState(member({ id: 'd', ...never, joinedAt: at(-2 * DAY) }), NOW)).toBe('active');
    expect(memberState(member({ id: 'e', ...never, joinedAt: at(-4 * DAY) }), NOW)).toBe(
      'inactive',
    );
  });

  it('puts the red dot on a payment not recovered and a departure within 48 hours, only', () => {
    expect(isUrgent(member({ id: 'a', ...failed }), NOW)).toBe(true);
    expect(isUrgent(member({ id: 'b', ...leaving(47 * HOUR) }), NOW)).toBe(true);
    expect(isUrgent(member({ id: 'c', ...leaving(3 * DAY) }), NOW)).toBe(false);
    expect(isUrgent(member({ id: 'd' }), NOW)).toBe(false);
    // Never for the team, never for who already left.
    expect(isUrgent(member({ id: 'e', accessLevel: 'admin', ...failed }), NOW)).toBe(false);
    expect(isUrgent(member({ id: 'f', status: 'left', ...failed }), NOW)).toBe(false);
  });
});

describe('the filter chips', () => {
  const ana = member({ id: 'ana', ...leaving(5 * DAY) });
  const bea = member({ id: 'bea', ...scored(81, 'high') });
  const cyd = member({ id: 'cyd', ...scored(12, 'low', true) });
  const dan = member({ id: 'dan', status: 'left', ...scored(90, 'high') });
  const everyone = [ana, bea, cyd, dan];

  it('keeps who each says, and only members still there but for « Gone »', () => {
    const kept = (filter: Parameters<typeof keepMember>[0]) =>
      everyone.filter((m) => keepMember(filter, m)).map((m) => m.id);
    expect(kept('all')).toEqual(['ana', 'bea', 'cyd', 'dan']);
    expect(kept('leaving')).toEqual(['ana']);
    expect(kept('high')).toEqual(['bea']);
    expect(kept('medium')).toEqual([]);
    expect(kept('low')).toEqual(['cyd']);
    expect(kept('newcomers')).toEqual(['cyd']);
    expect(kept('left')).toEqual(['dan']);
  });
});

describe('what a member pays a month', () => {
  it('brings each period back to a month', () => {
    const plan = (price: number | null, billingPeriodDays: number | null) => ({
      status: 'active',
      price,
      currency: 'usd',
      billingPeriodDays,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    });
    expect(monthlyOf(plan(49, 30))).toBe(49);
    expect(monthlyOf(plan(12, 7))).toBe(52);
    expect(monthlyOf(plan(120, 365))).toBe(10);
    expect(monthlyOf(plan(90, 90))).toBe(30);
    // Free, once, or nothing: no monthly amount.
    expect(monthlyOf(plan(0, 30))).toBeNull();
    expect(monthlyOf(plan(99, null))).toBeNull();
    expect(monthlyOf(null)).toBeNull();
  });
});

describe('the columns’ order', () => {
  const compare = new Intl.Collator('en', { sensitivity: 'base' }).compare;
  const ids = (members: MemberRow[]) => members.map((m) => m.id);

  it('starts each column the most telling way', () => {
    expect(FIRST_DIRECTION).toEqual({
      member: 'asc',
      risk: 'desc',
      status: 'asc',
      mrr: 'desc',
      lastActivity: 'desc',
      renewal: 'asc',
    });
  });

  it('puts what a column cannot say last, whichever way, and keeps ties in the given order', () => {
    const rows = [
      member({ id: 'unscored', name: 'Zoé' }),
      member({ id: 'high', name: 'élodie', ...scored(80, 'high') }),
      member({ id: 'low', name: 'Bob', ...scored(10, 'low') }),
      member({ id: 'tie', name: null, ...scored(80, 'high') }),
    ];
    expect(ids(sortMembers(rows, 'risk', 'desc', NOW, compare))).toEqual([
      'high',
      'tie',
      'low',
      'unscored',
    ]);
    expect(ids(sortMembers(rows, 'risk', 'asc', NOW, compare))).toEqual([
      'low',
      'high',
      'tie',
      'unscored',
    ]);
    // Names in the language's order, accents and case aside; no name last.
    expect(ids(sortMembers(rows, 'member', 'asc', NOW, compare))).toEqual([
      'low',
      'high',
      'unscored',
      'tie',
    ]);
    expect(ids(sortMembers(rows, 'member', 'desc', NOW, compare))).toEqual([
      'unscored',
      'high',
      'low',
      'tie',
    ]);
  });

  it('orders the states, the amounts, the last activity and the renewals', () => {
    const rows = [
      member({ id: 'active', lastActivityAt: at(-HOUR) }),
      member({ id: 'gone', status: 'left' }),
      member({ id: 'leaving', ...leaving(3 * DAY) }),
      member({ id: 'free', membership: null, lastActivityAt: null, lastActionAt: null }),
      member({ id: 'failed', ...failed, lastActivityAt: at(-3 * DAY) }),
    ];
    expect(ids(sortMembers(rows, 'status', 'asc', NOW, compare))).toEqual([
      'leaving',
      'failed',
      'free',
      'active',
      'gone',
    ]);
    expect(ids(sortMembers(rows, 'mrr', 'desc', NOW, compare))).toEqual([
      'active',
      'gone',
      'leaving',
      'failed',
      'free',
    ]);
    expect(ids(sortMembers(rows, 'lastActivity', 'desc', NOW, compare))).toEqual([
      'active',
      'gone',
      'leaving',
      'failed',
      'free',
    ]);
    // Who left renews nothing: last, like who has no membership.
    expect(ids(sortMembers(rows, 'renewal', 'asc', NOW, compare))).toEqual([
      'leaving',
      'active',
      'failed',
      'gone',
      'free',
    ]);
  });
});

describe('the search (fix prompt v4.1, block 3)', () => {
  const demo = createWorld(Date.parse('2026-10-03T14:00:00Z')).members.members;
  const found = (query: string) => demo.filter((m) => matchesSearch(m, query)).map((m) => m.name);

  it('finds Hugo Bernard alone, whatever the case and the accents', () => {
    for (const query of ['hugo', 'HUGO', 'Hugó', '  hugo ', 'Hugo Bernard', 'bernard hugo']) {
      expect(found(query), query).toEqual(['Hugo Bernard']);
    }
    // Accents the other way round: « theo » finds Théo, « ines » Inès.
    expect(found('theo')).toEqual(['Théo Fontaine']);
    expect(found('INES')).toEqual(['Inès Haddad']);
    expect(found('zzz')).toEqual([]);
    // Nothing typed: everyone.
    expect(found('')).toHaveLength(demo.length);
    expect(found('   ')).toHaveLength(demo.length);
  });

  it('reads the Whop username too, with or without its @', () => {
    const hugo = demo.find((m) => m.name === 'Hugo Bernard')!;
    expect(hugo.username).toBeTruthy();
    expect(found(hugo.username!)).toEqual(['Hugo Bernard']);
    expect(found(`@${hugo.username!.toUpperCase()}`)).toEqual(['Hugo Bernard']);
    expect(matchesSearch({ name: null, username: 'kev.trades' }, 'kev')).toBe(true);
    expect(matchesSearch({ name: null, username: null }, 'kev')).toBe(false);
    expect(matchesSearch({ name: null, username: null }, '')).toBe(true);
  });
});
