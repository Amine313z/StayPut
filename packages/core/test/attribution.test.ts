import { describe, expect, it } from 'vitest';
import {
  attributeSaves,
  savedTotals,
  type AttributedAction,
  type AttributedPayment,
  type AttributionFacts,
} from '../src/attribution';
import { DAY_MS } from '../src/risk';

const T = Date.parse('2026-09-01T10:00:00Z');
const day = (n: number) => T + n * DAY_MS;

function action(overrides: Partial<AttributedAction> & Pick<AttributedAction, 'id' | 'type'>) {
  return {
    memberId: 'mber_lea',
    sentAt: day(0),
    membershipId: 'mem_lea',
    paymentId: null,
    acceptedAt: null,
    kept: false,
    promoCodeId: null,
    ...overrides,
  } satisfies AttributedAction;
}

function payment(overrides: Partial<AttributedPayment> & Pick<AttributedPayment, 'id'>) {
  return {
    memberId: 'mber_lea',
    membershipId: 'mem_lea',
    status: 'succeeded',
    amount: 49,
    currency: 'EUR',
    paidAt: day(3),
    promoCodeId: null,
    ...overrides,
  } satisfies AttributedPayment;
}

function facts(overrides: Partial<AttributionFacts>): AttributionFacts {
  return {
    actions: [],
    payments: [],
    firstActivityAfter: {},
    periodDays: {},
    counted: new Set(),
    ...overrides,
  };
}

describe('the money StayPut saved (SPEC Phase 6.4)', () => {
  it('claims nothing without an action that went out', () => {
    expect(attributeSaves(facts({ payments: [payment({ id: 'pay_1' })] }))).toEqual([]);
  });

  it('claims a failed payment that comes in within 14 days after StayPut acted on it', () => {
    const notice = action({
      id: 'act_notice',
      type: 'payment_failed_notice',
      paymentId: 'pay_failed',
    });
    const saves = attributeSaves(
      facts({
        actions: [notice],
        payments: [
          payment({ id: 'pay_failed', status: 'failed', paidAt: null }),
          payment({ id: 'pay_ok', paidAt: day(3) }),
        ],
      }),
    );
    expect(saves).toEqual([
      {
        type: 'payment_recovered',
        category: 'direct',
        memberId: 'mber_lea',
        actionId: 'act_notice',
        paymentId: 'pay_ok',
        amount: 49,
        currency: 'EUR',
        savedAt: day(3),
        proof: ['act_notice', 'pay_failed', 'pay_ok'],
      },
    ]);
    // The same payment, retried until it went through: its own id proves it.
    const retried = attributeSaves(
      facts({
        actions: [action({ id: 'act_retry', type: 'payment_retry', paymentId: 'pay_1' })],
        payments: [payment({ id: 'pay_1', paidAt: day(2) })],
      }),
    );
    expect(retried[0]?.proof).toEqual(['act_retry', 'pay_1']);
    // Fifteen days later is too late.
    expect(
      attributeSaves(
        facts({
          actions: [notice],
          payments: [payment({ id: 'pay_late', paidAt: day(15) })],
        }),
      ),
    ).toEqual([]);
  });

  it('counts a payment once, whatever acted on it, and never one already counted', () => {
    const both = facts({
      actions: [
        action({ id: 'act_notice', type: 'payment_failed_notice', paymentId: 'pay_1' }),
        action({ id: 'act_retry', type: 'payment_retry', paymentId: 'pay_1', sentAt: day(1) }),
      ],
      payments: [payment({ id: 'pay_1', paidAt: day(2) })],
    });
    expect(attributeSaves(both).map((s) => s.paymentId)).toEqual(['pay_1']);
    expect(attributeSaves({ ...both, counted: new Set(['pay_1']) })).toEqual([]);
  });

  it('never counts a refunded or disputed payment, nor one for nothing', () => {
    const retry = action({ id: 'act_retry', type: 'payment_retry', paymentId: 'pay_1' });
    for (const status of ['refunded', 'partially_refunded', 'dispute_warning', 'failed']) {
      expect(
        attributeSaves(facts({ actions: [retry], payments: [payment({ id: 'pay_1', status })] })),
      ).toEqual([]);
    }
    expect(
      attributeSaves(facts({ actions: [retry], payments: [payment({ id: 'pay_1', amount: 0 })] })),
    ).toEqual([]);
  });

  it('claims the renewal after StayPut undid a cancellation within 7 days of the offer', () => {
    const offer = action({
      id: 'act_offer',
      type: 'extend_offer',
      acceptedAt: day(0),
      sentAt: day(1),
      kept: true,
    });
    const renewal = payment({ id: 'pay_renewal', paidAt: day(20), amount: 59 });
    expect(attributeSaves(facts({ actions: [offer], payments: [renewal] }))).toMatchObject([
      { type: 'cancellation_reverted', category: 'direct', paymentId: 'pay_renewal', amount: 59 },
    ]);
    // Undone eight days after the member accepted: not StayPut's doing any more.
    const late = { ...offer, sentAt: day(8) };
    expect(attributeSaves(facts({ actions: [late], payments: [renewal] }))).toEqual([]);
    // Without the member's consent to keep it, the cancellation stood.
    expect(
      attributeSaves(facts({ actions: [{ ...offer, kept: false }], payments: [renewal] })),
    ).toEqual([]);
  });

  it('claims the first payment of a membership StayPut paused, once it pays again', () => {
    const pause = action({ id: 'act_pause', type: 'pause_offer', acceptedAt: day(0), kept: false });
    const saves = attributeSaves(
      facts({
        actions: [pause],
        payments: [
          payment({ id: 'pay_before', paidAt: day(-20) }),
          payment({ id: 'pay_after', paidAt: day(31) }),
          payment({ id: 'pay_next', paidAt: day(61) }),
        ],
      }),
    );
    expect(saves).toMatchObject([{ type: 'pause_resumed', paymentId: 'pay_after' }]);
  });

  it('claims a former member coming back with a code StayPut gave', () => {
    const followup = action({
      id: 'act_followup',
      type: 'alumni_followup',
      membershipId: null,
      promoCodeId: 'promo_back',
    });
    const saves = attributeSaves(
      facts({
        actions: [followup],
        payments: [
          payment({ id: 'pay_other', paidAt: day(2), membershipId: 'mem_new' }),
          payment({
            id: 'pay_back',
            paidAt: day(5),
            membershipId: 'mem_new',
            promoCodeId: 'promo_back',
          }),
        ],
      }),
    );
    expect(saves).toMatchObject([{ type: 'winback', category: 'direct', paymentId: 'pay_back' }]);
  });

  it('shows apart the renewal of a member at risk active again after StayPut’s message', () => {
    const message = action({ id: 'act_msg', type: 'high_risk_message', membershipId: null });
    const renewal = payment({ id: 'pay_renewal', paidAt: day(20) });
    const base = facts({
      actions: [message],
      payments: [renewal],
      firstActivityAfter: { act_msg: day(5) },
      periodDays: { mem_lea: 30 },
    });
    expect(attributeSaves(base)).toMatchObject([
      { type: 'renewal_after_message', category: 'influenced', paymentId: 'pay_renewal' },
    ]);
    // Active again only after 14 days: the message did not bring them back.
    expect(attributeSaves({ ...base, firstActivityAfter: { act_msg: day(15) } })).toEqual([]);
    // Never active again: a renewal alone proves nothing.
    expect(attributeSaves({ ...base, firstActivityAfter: {} })).toEqual([]);
    // A renewal beyond the period after the message (30 + 7 days) is not this renewal.
    expect(
      attributeSaves({ ...base, payments: [payment({ id: 'pay_much_later', paidAt: day(38) })] }),
    ).toEqual([]);
  });

  it('lets a direct reason win over an influenced one for the same payment', () => {
    const saves = attributeSaves(
      facts({
        actions: [
          action({ id: 'act_msg', type: 'high_risk_message', membershipId: null }),
          action({ id: 'act_retry', type: 'payment_retry', paymentId: 'pay_1', sentAt: day(1) }),
        ],
        payments: [payment({ id: 'pay_1', paidAt: day(6) })],
        firstActivityAfter: { act_msg: day(2) },
      }),
    );
    expect(saves).toMatchObject([{ type: 'payment_recovered', actionId: 'act_retry' }]);
  });
});

describe('what saves add up to', () => {
  it('sums a window in the main currency, direct and influenced apart', () => {
    const saves = [
      { category: 'direct' as const, amount: 49, currency: 'EUR', savedAt: day(2) },
      { category: 'direct' as const, amount: 29.5, currency: 'EUR', savedAt: day(10) },
      { category: 'influenced' as const, amount: 49, currency: 'EUR', savedAt: day(12) },
      { category: 'direct' as const, amount: 20, currency: 'USD', savedAt: day(12) },
      { category: 'direct' as const, amount: 99, currency: 'EUR', savedAt: day(40) },
    ];
    expect(savedTotals(saves, day(0), day(30))).toEqual({
      currency: 'EUR',
      direct: 78.5,
      influenced: 49,
      otherCurrencies: true,
      count: 3,
    });
    expect(savedTotals([], day(0), day(30))).toEqual({
      currency: null,
      direct: 0,
      influenced: 0,
      otherCurrencies: false,
      count: 0,
    });
  });
});
