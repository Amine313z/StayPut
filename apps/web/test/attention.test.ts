import type { MemberRisk, MemberRow } from '@stayput/core';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/demo/world';
import { mostUrgent } from '../src/views/creator/Overview';

const NOW = Date.parse('2026-10-03T10:00:00.000Z');
const DAY = 86_400_000;

/** A member at risk who pays `price` every `period` days, unless `over` says otherwise. */
function member(
  name: string,
  risk: Pick<MemberRisk, 'score' | 'level'> | null,
  over: {
    price?: number;
    period?: number;
    leavesIn?: number;
    failed?: boolean;
    status?: MemberRow['status'];
  } = {},
): MemberRow {
  const price = over.price ?? 49;
  return {
    id: `m_${name}`,
    name,
    status: over.status ?? 'joined',
    accessLevel: 'customer',
    joinedAt: '2026-05-01T10:00:00.000Z',
    lastActionAt: null,
    lastActivityAt: null,
    doNotContact: false,
    activity: { messages: 0, reactions: 0, posts: 0, lessons: 0 },
    risk: risk && { ...risk, reasons: [], inactiveNewcomer: false, computedAt: '2026-10-03' },
    membership: {
      status: 'active',
      price,
      currency: 'usd',
      billingPeriodDays: over.period ?? 30,
      cancelAtPeriodEnd: over.leavesIn !== undefined,
      currentPeriodEnd: new Date(NOW + (over.leavesIn ?? 20) * DAY).toISOString(),
    },
    lastPayment: {
      status: over.failed ? 'failed' : 'succeeded',
      amount: price,
      currency: 'usd',
      at: '2026-09-20T10:00:00.000Z',
      failureReason: over.failed ? 'Card declined' : null,
    },
  };
}

const order = (members: MemberRow[]) => mostUrgent(members, NOW).map((u) => u.member.name);

describe('« Needs attention », the most urgent first (brief v4 §13)', () => {
  it('puts a departure within 7 days above a failed payment, whatever the scores', () => {
    const leaving = { score: 100, level: 'scheduled_departure' } as const;
    expect(
      order([
        member('Failed 79', { score: 79, level: 'high' }, { failed: true }),
        member('Leaves Oct 9', leaving, { leavesIn: 6, price: 149 }),
      ]),
    ).toEqual(['Leaves Oct 9', 'Failed 79']);
  });

  it('then the failed payments, then the highest scores, then what they pay a month', () => {
    const leaving = { score: 100, level: 'scheduled_departure' } as const;
    const high = (score: number) => ({ score, level: 'high' }) as const;
    expect(
      order([
        member('High 84 at $49', high(84)),
        member('Leaves in 17 days, yearly', leaving, { leavesIn: 17, price: 470, period: 365 }),
        member('Failed 79', high(79), { failed: true }),
        member('Leaves in 11 days', leaving, { leavesIn: 11 }),
        member('High 84 at $149', high(84), { price: 149 }),
        member('Failed 88', high(88), { failed: true, price: 149 }),
        member('Leaves in 6 days', leaving, { leavesIn: 6, price: 149 }),
        member('Medium', { score: 50, level: 'medium' }),
        member('Left', high(95), { status: 'left' }),
      ]),
    ).toEqual([
      'Leaves in 6 days',
      'Failed 88',
      'Failed 79',
      // Both at 100: $49 a month before $470 a year ($39.17 a month).
      'Leaves in 11 days',
      'Leaves in 17 days, yearly',
      'High 84 at $149',
      'High 84 at $49',
    ]);
  });

  it('marks as urgent a departure within 48 hours and a failed payment, nothing else', () => {
    const leaving = { score: 100, level: 'scheduled_departure' } as const;
    const urgent = mostUrgent(
      [
        member('Tomorrow', leaving, { leavesIn: 1 }),
        member('In 6 days', leaving, { leavesIn: 6 }),
        member('Failed', { score: 70, level: 'high' }, { failed: true }),
      ],
      NOW,
    ).map((u) => [u.member.name, u.urgent]);
    expect(urgent).toEqual([
      ['Tomorrow', true],
      ['In 6 days', false],
      ['Failed', true],
    ]);
  });

  it('before the first scores, keeps to Whop’s facts: leaving or a payment failed', () => {
    expect(
      order([
        member('Fine', null),
        member('Failed', null, { failed: true }),
        member('Leaving', null, { leavesIn: 3 }),
      ]),
    ).toEqual(['Leaving', 'Failed']);
  });

  it('shows the demo’s five in that order', () => {
    const world = createWorld(NOW);
    expect(order(world.members.members).slice(0, 5)).toEqual([
      'Hugo Bernard',
      'Sarah Cohen',
      'Maxime Vidal',
      'Elena Novak',
      'Margaux Picard',
    ]);
  });
});
