import { describe, expect, it } from 'vitest';
import { PRIORITY_MESSAGE_LIMIT, choosePriority, type PriorityCandidates } from '../src/dashboard';

const none = { actions: 0, members: 0, revenue: 0 };
const calm: PriorityCandidates = {
  mode: 'manual',
  pending: none,
  retryable: { payments: 0, revenue: 0 },
  leaving: [],
  unreached: [],
  unresolved: { failed: { members: 0, revenue: 0 }, leaving: { members: 0, revenue: 0 } },
};

describe('the action of the day (SPEC Phase 6.2, brief v3 §6.2)', () => {
  it('is nothing only when nothing is at stake', () => {
    expect(choosePriority(calm)).toBeNull();
  });

  it('protects the most revenue', () => {
    const unreached = [
      { memberId: 'mber_a', monthly: 99 },
      { memberId: 'mber_b', monthly: 49.5 },
    ];
    expect(
      choosePriority({ ...calm, pending: { actions: 3, members: 2, revenue: 98 }, unreached }),
    ).toEqual({ kind: 'message', memberIds: ['mber_a', 'mber_b'], revenue: 148.5 });
    expect(
      choosePriority({ ...calm, pending: { actions: 3, members: 3, revenue: 200 }, unreached }),
    ).toEqual({ kind: 'approve', actions: 3, members: 3, revenue: 200 });
  });

  it('retries the failed payments, or offers a pause to the members leaving', () => {
    expect(choosePriority({ ...calm, retryable: { payments: 3, revenue: 147 } })).toEqual({
      kind: 'retry',
      payments: 3,
      revenue: 147,
    });
    const leaving = [
      { memberId: 'mber_c', monthly: 149 },
      { memberId: 'mber_d', monthly: 49 },
    ];
    expect(choosePriority({ ...calm, retryable: { payments: 3, revenue: 147 }, leaving })).toEqual({
      kind: 'pause',
      memberIds: ['mber_c', 'mber_d'],
      revenue: 198,
    });
  });

  it('on a tie, takes what is prepared or most certain first', () => {
    const tie = {
      ...calm,
      pending: { actions: 2, members: 2, revenue: 98 },
      retryable: { payments: 2, revenue: 98 },
      leaving: [{ memberId: 'mber_a', monthly: 98 }],
      unreached: [{ memberId: 'mber_b', monthly: 98 }],
    };
    expect(choosePriority(tie)?.kind).toBe('approve');
    // In automatic mode nothing waits for an approval.
    expect(choosePriority({ ...tie, mode: 'auto' })?.kind).toBe('retry');
    expect(choosePriority({ ...tie, mode: 'auto', retryable: calm.retryable })?.kind).toBe('pause');
  });

  it('never says « nothing urgent » while a payment stays failed or a member is leaving', () => {
    const failed = { members: 2, revenue: 98 };
    const leaving = { members: 1, revenue: 49 };
    expect(
      choosePriority({ ...calm, unresolved: { failed, leaving: { members: 0, revenue: 0 } } }),
    ).toEqual({ kind: 'review', filter: 'failed', members: 2, revenue: 98 });
    expect(
      choosePriority({ ...calm, unresolved: { failed: { members: 0, revenue: 0 }, leaving } }),
    ).toEqual({ kind: 'review', filter: 'cancelling', members: 1, revenue: 49 });
  });

  it('asks for one reasonable click: 25 members at most', () => {
    const unreached = Array.from({ length: 40 }, (_, i) => ({
      memberId: `mber_${i}`,
      monthly: 10,
    }));
    expect(choosePriority({ ...calm, mode: 'auto', unreached })).toEqual({
      kind: 'message',
      memberIds: unreached.slice(0, PRIORITY_MESSAGE_LIMIT).map((m) => m.memberId),
      revenue: 250,
    });
    expect(choosePriority({ ...calm, leaving: unreached })).toMatchObject({
      kind: 'pause',
      revenue: 250,
    });
  });
});
