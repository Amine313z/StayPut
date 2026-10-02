/**
 * The home of the dashboard (SPEC Phase 6.2): which one action of the day protects the most
 * revenue. Pure: the Worker reads the candidates, this chooses.
 */

import type { PriorityAction } from './api';

export interface PriorityCandidates {
  mode: 'auto' | 'manual';
  /** Actions StayPut proposes and waits for the creator to approve (manual mode). */
  pending: { actions: number; members: number; revenue: number };
  /**
   * Failed payments StayPut may have Whop charge again now (stayput.payments_to_retry): retryable,
   * no retry of Whop's own, fewer than two of StayPut's, none already under way.
   */
  retryable: { payments: number; revenue: number };
  /**
   * Members whose cancellation is scheduled, with no offer open, the « never contact » list
   * aside, the highest revenue first.
   */
  leaving: readonly { memberId: string; monthly: number }[];
  /**
   * Members at high risk nobody reached in the last 5 days (the guardrails' spacing), on the
   * « never contact » list aside, the highest revenue first.
   */
  unreached: readonly { memberId: string; monthly: number }[];
  /**
   * Every member whose last payment failed, and every member leaving, whatever is under way:
   * while there is one, the day is never « nothing urgent ».
   */
  unresolved: {
    failed: { members: number; revenue: number };
    leaving: { members: number; revenue: number };
  };
}

/** Members a « message them » or « pause » priority covers at most: one click stays reasonable. */
export const PRIORITY_MESSAGE_LIMIT = 25;

/**
 * The action that protects the most revenue. On a tie, what is already prepared or most certain
 * wins: StayPut's proposals, then a retry, then a pause, then a message. When nothing can be done
 * but a payment stays failed or a member is leaving, they are to look at; else null.
 */
export function choosePriority(candidates: PriorityCandidates): PriorityAction | null {
  const options: PriorityAction[] = [];
  if (candidates.mode === 'manual' && candidates.pending.actions > 0) {
    options.push({ kind: 'approve', ...candidates.pending });
  }
  if (candidates.retryable.payments > 0) {
    options.push({ kind: 'retry', ...candidates.retryable });
  }
  const leaving = candidates.leaving.slice(0, PRIORITY_MESSAGE_LIMIT);
  if (leaving.length > 0) {
    options.push({
      kind: 'pause',
      memberIds: leaving.map((m) => m.memberId),
      revenue: round2(leaving.reduce((total, m) => total + m.monthly, 0)),
    });
  }
  const reach = candidates.unreached.slice(0, PRIORITY_MESSAGE_LIMIT);
  if (reach.length > 0) {
    options.push({
      kind: 'message',
      memberIds: reach.map((m) => m.memberId),
      revenue: round2(reach.reduce((total, m) => total + m.monthly, 0)),
    });
  }
  const best = options.sort((a, b) => b.revenue - a.revenue)[0];
  if (best) return best;
  const { failed, leaving: gone } = candidates.unresolved;
  if (failed.members > 0) return { kind: 'review', filter: 'failed', ...failed };
  if (gone.members > 0) return { kind: 'review', filter: 'cancelling', ...gone };
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
