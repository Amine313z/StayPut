import { describe, expect, it } from 'vitest';
import { actionOutcome, type OutcomeFacts } from '../src/outcomes';

const facts = (over: Partial<OutcomeFacts>): OutcomeFacts => ({
  type: 'high_risk_message',
  status: 'sent',
  saved: null,
  paymentFailing: false,
  activeAfter: false,
  leftAfter: false,
  resumesAt: null,
  ...over,
});

describe('what came of an action (fix prompt v4.1, block 4)', () => {
  it('says the money StayPut saved through it first, whatever else happened', () => {
    const saved = { amount: 49, currency: 'usd' };
    expect(actionOutcome(facts({ type: 'payment_retry', saved }))).toEqual({
      kind: 'recovered',
      amount: 49,
      currency: 'usd',
    });
    // A pause the member came back from and paid for.
    expect(
      actionOutcome(facts({ type: 'pause_offer', saved, resumesAt: '2026-11-02T00:00:00Z' })),
    ).toMatchObject({ kind: 'recovered' });
  });

  it('follows a payment: still failing, or nothing to claim when it came in on its own', () => {
    for (const type of [
      'payment_retry',
      'payment_failed_notice',
      'payment_action_notice',
    ] as const) {
      expect(actionOutcome(facts({ type, paymentFailing: true }))).toEqual({
        kind: 'still_failing',
      });
      expect(actionOutcome(facts({ type, paymentFailing: false, activeAfter: true }))).toBeNull();
    }
  });

  it('says a pause until it ends, and whether a message brought the member back', () => {
    expect(
      actionOutcome(facts({ type: 'pause_offer', resumesAt: '2026-11-02T00:00:00Z' })),
    ).toEqual({ kind: 'paused', until: '2026-11-02T00:00:00Z' });
    for (const type of [
      'high_risk_message',
      'welcome_message',
      'creator_message',
      'promo_offer',
      'alumni_followup',
    ] as const) {
      expect(actionOutcome(facts({ type, activeAfter: true }))).toEqual({ kind: 'came_back' });
      expect(actionOutcome(facts({ type }))).toEqual({ kind: 'no_reply' });
    }
  });

  it('says a member left after it, never « No reply yet » for someone gone', () => {
    expect(actionOutcome(facts({ type: 'promo_offer', leftAfter: true }))).toEqual({
      kind: 'left',
    });
    expect(
      actionOutcome(facts({ type: 'payment_retry', leftAfter: true, paymentFailing: true })),
    ).toEqual({ kind: 'left' });
  });

  it('says nothing for what did not reach the member, or waits for no answer', () => {
    for (const status of ['simulated', 'failed', 'cancelled', 'blocked_by_guardrail'] as const) {
      expect(actionOutcome(facts({ status, activeAfter: true }))).toBeNull();
    }
    for (const type of ['milestone_announcement', 'buddy_intro', 'exit_survey'] as const) {
      expect(actionOutcome(facts({ type, activeAfter: true }))).toBeNull();
    }
  });
});
