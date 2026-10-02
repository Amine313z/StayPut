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
   * Members at high risk nobody reached in the last 5 days (the guardrails' spacing), on the
   * « never contact » list aside, the highest revenue first.
   */
  unreached: readonly { memberId: string; monthly: number }[];
}

/** Members a « message them » priority covers at most: one click stays a reasonable act. */
export const PRIORITY_MESSAGE_LIMIT = 25;

/**
 * The action that protects the most revenue. Approving StayPut's proposals wins a tie: they are
 * already prepared, through the guardrails. Nothing to do: null.
 */
export function choosePriority(candidates: PriorityCandidates): PriorityAction | null {
  const options: PriorityAction[] = [];
  if (candidates.mode === 'manual' && candidates.pending.actions > 0) {
    options.push({ kind: 'approve', ...candidates.pending });
  }
  const reach = candidates.unreached.slice(0, PRIORITY_MESSAGE_LIMIT);
  if (reach.length > 0) {
    options.push({
      kind: 'message',
      memberIds: reach.map((m) => m.memberId),
      revenue: round2(reach.reduce((total, m) => total + m.monthly, 0)),
    });
  }
  return options.sort((a, b) => b.revenue - a.revenue)[0] ?? null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
