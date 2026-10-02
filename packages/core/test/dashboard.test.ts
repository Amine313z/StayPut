import { describe, expect, it } from 'vitest';
import { PRIORITY_MESSAGE_LIMIT, choosePriority } from '../src/dashboard';

const none = { actions: 0, members: 0, revenue: 0 };

describe('the action of the day (SPEC Phase 6.2)', () => {
  it('is nothing when nothing is at stake', () => {
    expect(choosePriority({ mode: 'manual', pending: none, unreached: [] })).toBeNull();
  });

  it('protects the most revenue', () => {
    const unreached = [
      { memberId: 'mber_a', monthly: 99 },
      { memberId: 'mber_b', monthly: 49.5 },
    ];
    expect(
      choosePriority({
        mode: 'manual',
        pending: { actions: 3, members: 2, revenue: 98 },
        unreached,
      }),
    ).toEqual({ kind: 'message', memberIds: ['mber_a', 'mber_b'], revenue: 148.5 });
    expect(
      choosePriority({
        mode: 'manual',
        pending: { actions: 3, members: 3, revenue: 200 },
        unreached,
      }),
    ).toEqual({ kind: 'approve', actions: 3, members: 3, revenue: 200 });
  });

  it('prefers approving StayPut’s proposals on a tie, and never in automatic mode', () => {
    const pending = { actions: 2, members: 2, revenue: 0 };
    const unreached = [{ memberId: 'mber_a', monthly: 0 }];
    expect(choosePriority({ mode: 'manual', pending, unreached })?.kind).toBe('approve');
    // In automatic mode nothing waits for an approval.
    expect(choosePriority({ mode: 'auto', pending, unreached })?.kind).toBe('message');
  });

  it('asks for one reasonable click: 25 members at most', () => {
    const unreached = Array.from({ length: 40 }, (_, i) => ({
      memberId: `mber_${i}`,
      monthly: 10,
    }));
    const priority = choosePriority({ mode: 'auto', pending: none, unreached });
    expect(priority).toEqual({
      kind: 'message',
      memberIds: unreached.slice(0, PRIORITY_MESSAGE_LIMIT).map((m) => m.memberId),
      revenue: 250,
    });
  });
});
