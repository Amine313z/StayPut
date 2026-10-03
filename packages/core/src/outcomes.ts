import type { ActionType } from './actions';
import type { ActionOutcome, ActionStatus } from './api';

/**
 * What came of an action StayPut took (fix prompt v4.1, block 4: every item of the History says
 * it, the proof of value), from facts the Worker reads in the database and the demo in its
 * community: one rule for both, never a guess.
 */
export interface OutcomeFacts {
  type: ActionType;
  status: ActionStatus;
  /** The money StayPut saved through this action (stayput.saves), if any. */
  saved: { amount: number; currency: string } | null;
  /** The member's latest payment failed, and nothing came in since. */
  paymentFailing: boolean;
  /** The member did something in the community after the action reached them. */
  activeAfter: boolean;
  /** The member left the community after it. */
  leftAfter: boolean;
  /** A pause it applied: when it ends. */
  resumesAt: string | null;
}

/** About a payment: what counts is whether the money came in. */
const PAYMENT_ACTIONS: ReadonlySet<ActionType> = new Set([
  'payment_retry',
  'payment_failed_notice',
  'payment_action_notice',
]);

/**
 * Nothing to wait for from the member: an announcement, an introduction; and the departure
 * survey, whose answer is the offer that follows it (that one says what came of it).
 */
const WITHOUT_OUTCOME: ReadonlySet<ActionType> = new Set([
  'milestone_announcement',
  'buddy_intro',
  'mentor_intro',
  'exit_survey',
]);

/**
 * In this order: money saved through it (« Recovered $49.00 »); nothing for what waits for no
 * answer; the member left since (« Left »); a payment still failing (« Still failing »); a pause
 * applied (« Paused », until it ends); otherwise whether the member came back after it (« Came
 * back ») or not yet (« No reply yet »). Only for an action that reached the member: a simulated,
 * blocked, cancelled or failed one already says what came of it. A payment that came in without
 * a save (not StayPut's to claim) says nothing.
 */
export function actionOutcome(facts: OutcomeFacts): ActionOutcome | null {
  if (facts.status !== 'sent') return null;
  if (facts.saved) {
    return { kind: 'recovered', amount: facts.saved.amount, currency: facts.saved.currency };
  }
  if (WITHOUT_OUTCOME.has(facts.type)) return null;
  if (facts.leftAfter) return { kind: 'left' };
  if (PAYMENT_ACTIONS.has(facts.type))
    return facts.paymentFailing ? { kind: 'still_failing' } : null;
  if (facts.type === 'pause_offer') return { kind: 'paused', until: facts.resumesAt };
  return facts.activeAfter ? { kind: 'came_back' } : { kind: 'no_reply' };
}
