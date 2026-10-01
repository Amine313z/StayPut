import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  BLOCK_REASONS,
  DEFAULT_GUARDRAILS,
  EMPTY_HISTORY,
  MESSAGE_KINDS,
  checkGuardrails,
  goldenHour,
  isActionType,
  isQuietHour,
  localHour,
  nextLocalHour,
  outOfQuietHours,
  type GuardrailSettings,
  type MemberHistory,
  type ProposedAction,
} from '../src/actions';
import { DAY_MS } from '../src/risk';

// 1 October 2026, 10:00 in Paris (UTC+2).
const NOW = Date.parse('2026-10-01T08:00:00Z');
const PARIS: GuardrailSettings = { ...DEFAULT_GUARDRAILS, timezone: 'Europe/Paris' };

function check(
  action: Partial<ProposedAction> & Pick<ProposedAction, 'type'>,
  member: Partial<MemberHistory> = {},
  options: {
    settings?: Partial<GuardrailSettings>;
    globalKillSwitch?: boolean;
    promos?: number;
  } = {},
) {
  return checkGuardrails(
    { sendAt: NOW, ...action },
    {
      settings: { ...PARIS, ...options.settings },
      globalKillSwitch: options.globalKillSwitch ?? false,
      member: { ...EMPTY_HISTORY, ...member },
      company: { promosLast30: options.promos ?? 0 },
    },
  );
}

const days = (n: number) => NOW + n * DAY_MS;

describe('the action types', () => {
  it('knows each type and what it sends', () => {
    expect(ACTION_TYPES.every(isActionType)).toBe(true);
    expect(isActionType('spam_everyone')).toBe(false);
    expect(isActionType(3)).toBe(false);
    expect(Object.keys(MESSAGE_KINDS).sort()).toEqual([...ACTION_TYPES].sort());
    expect(BLOCK_REASONS).toContain('message_spacing');
  });
});

describe('checkGuardrails', () => {
  it('lets an action go, at its time, flagged when the creator tests', () => {
    expect(check({ type: 'high_risk_message' })).toEqual({
      allowed: true,
      sendAt: NOW,
      dryRun: false,
    });
    expect(check({ type: 'payment_retry' }, {}, { settings: { dryRun: true } })).toEqual({
      allowed: true,
      sendAt: NOW,
      dryRun: true,
    });
  });

  it('stops everything for the stops and the « never contact » list, the app-wide one first', () => {
    for (const type of ACTION_TYPES) {
      expect(check({ type }, { doNotContact: true }, { globalKillSwitch: true })).toEqual({
        allowed: false,
        reason: 'global_kill_switch',
      });
      expect(check({ type }, { doNotContact: true }, { settings: { killSwitch: true } })).toEqual({
        allowed: false,
        reason: 'kill_switch',
      });
      expect(check({ type }, { doNotContact: true })).toEqual({
        allowed: false,
        reason: 'do_not_contact',
      });
    }
  });

  it('asks Whop to retry a failed payment twice at most', () => {
    expect(check({ type: 'payment_retry' }, { paymentRetries: 1 }).allowed).toBe(true);
    expect(check({ type: 'payment_retry' }, { paymentRetries: 2 })).toEqual({
      allowed: false,
      reason: 'payment_retry_cap',
    });
    expect(
      check(
        { type: 'payment_retry' },
        { paymentRetries: 1 },
        { settings: { maxPaymentRetries: 1 } },
      ).allowed,
    ).toBe(false);
    // Never more than 2, whatever is stored.
    expect(
      check(
        { type: 'payment_retry' },
        { paymentRetries: 2 },
        { settings: { maxPaymentRetries: 5 } },
      ).allowed,
    ).toBe(false);
  });

  it('gives one active promo code per member, and caps the codes of a month', () => {
    expect(check({ type: 'promo_offer' }).allowed).toBe(true);
    expect(check({ type: 'promo_offer' }, { activePromo: true })).toEqual({
      allowed: false,
      reason: 'promo_already_active',
    });
    expect(check({ type: 'promo_offer' }, {}, { promos: 10 })).toEqual({
      allowed: false,
      reason: 'monthly_promo_cap',
    });
    expect(
      check({ type: 'promo_offer' }, {}, { promos: 10, settings: { monthlyPromoCap: 11 } }).allowed,
    ).toBe(true);
  });

  it('caps the free days at 14 a member over 90 days', () => {
    expect(check({ type: 'extend_offer', freeDays: 4 }, { freeDaysLast90: 10 }).allowed).toBe(true);
    expect(check({ type: 'extend_offer', freeDays: 5 }, { freeDaysLast90: 10 })).toEqual({
      allowed: false,
      reason: 'free_days_cap',
    });
    expect(
      check({ type: 'extend_offer', freeDays: 7 }, {}, { settings: { maxFreeDaysPerQuarter: 6 } })
        .allowed,
    ).toBe(false);
    expect(
      check({ type: 'extend_offer', freeDays: 15 }, {}, { settings: { maxFreeDaysPerQuarter: 30 } })
        .allowed,
    ).toBe(false);
    expect(check({ type: 'extend_offer' }).allowed).toBe(true);
  });

  it('spaces the follow-ups: one every 5 days, before or after, any message counting', () => {
    const relance = { type: 'high_risk_message' } as const;
    expect(check(relance, { messages: [{ at: days(-3), kind: 'relance' }] })).toEqual({
      allowed: false,
      reason: 'message_spacing',
    });
    expect(check(relance, { messages: [{ at: days(-6), kind: 'relance' }] }).allowed).toBe(true);
    // A message already scheduled in two days.
    expect(check(relance, { messages: [{ at: days(2), kind: 'relance' }] }).allowed).toBe(false);
    // A service message holds a follow-up back too.
    expect(check(relance, { messages: [{ at: days(-1), kind: 'service' }] }).allowed).toBe(false);
    expect(
      check(
        relance,
        { messages: [{ at: days(-1), kind: 'relance' }] },
        { settings: { maxMessagesPer5Days: 2 } },
      ).allowed,
    ).toBe(true);
  });

  it('sends 4 messages a month at most to a member', () => {
    const four = [-29, -22, -15, -8].map((n) => ({ at: days(n), kind: 'relance' as const }));
    expect(check({ type: 'welcome_message' }, { messages: four })).toEqual({
      allowed: false,
      reason: 'monthly_message_cap',
    });
    expect(check({ type: 'welcome_message' }, { messages: four.slice(1) }).allowed).toBe(true);
    expect(
      check(
        { type: 'welcome_message' },
        { messages: four },
        { settings: { maxMessagesPerMonth: 5 } },
      ).allowed,
    ).toBe(true);
  });

  it('never holds back a service message for the caps: the member must act', () => {
    const busy = [-1, -2, -3, -4, -5].map((n) => ({ at: days(n), kind: 'relance' as const }));
    for (const type of ['payment_failed_notice', 'payment_action_notice', 'exit_survey'] as const) {
      expect(check({ type }, { messages: busy }).allowed).toBe(true);
    }
  });

  it('moves a message out of the quiet hours, never a Whop operation', () => {
    // 23:30 in Paris.
    const late = Date.parse('2026-10-01T21:30:00Z');
    const eight = Date.parse('2026-10-02T06:00:00Z');
    expect(check({ type: 'payment_action_notice', sendAt: late })).toMatchObject({ sendAt: eight });
    expect(check({ type: 'welcome_message', sendAt: late })).toMatchObject({ sendAt: eight });
    expect(check({ type: 'payment_retry', sendAt: late })).toMatchObject({ sendAt: late });
    // Spacing counts from the time the message really goes.
    expect(
      check(
        { type: 'welcome_message', sendAt: late },
        { messages: [{ at: eight + 5 * DAY_MS - 1, kind: 'relance' }] },
      ).allowed,
    ).toBe(false);
  });
});

describe('time of day', () => {
  it("reads the hour in the creator's time zone, UTC for a zone the runtime ignores", () => {
    expect(localHour(NOW, 'Europe/Paris')).toBe(10);
    expect(localHour(NOW, 'America/Toronto')).toBe(4);
    expect(localHour(NOW, 'Mars/Olympus_Mons')).toBe(8);
  });

  it('knows quiet hours that wrap around midnight, or not', () => {
    expect(isQuietHour(23, 22, 8)).toBe(true);
    expect(isQuietHour(7, 22, 8)).toBe(true);
    expect(isQuietHour(8, 22, 8)).toBe(false);
    expect(isQuietHour(13, 12, 14)).toBe(true);
    expect(isQuietHour(14, 12, 14)).toBe(false);
    expect(isQuietHour(3, 5, 5)).toBe(false);
  });

  it('waits for the end of the quiet hours, at a full hour', () => {
    expect(outOfQuietHours(NOW, PARIS)).toBe(NOW);
    // 06:45 in Paris → 08:00 in Paris.
    expect(outOfQuietHours(Date.parse('2026-10-01T04:45:00Z'), PARIS)).toBe(
      Date.parse('2026-10-01T06:00:00Z'),
    );
  });

  it('finds the next time the clock shows an hour', () => {
    // From 10:00 in Paris, 19:00 is the same day; 09:00 is tomorrow.
    expect(nextLocalHour(NOW, 19, 'Europe/Paris')).toBe(Date.parse('2026-10-01T17:00:00Z'));
    expect(nextLocalHour(NOW, 9, 'Europe/Paris')).toBe(Date.parse('2026-10-02T07:00:00Z'));
    expect(nextLocalHour(NOW + 1, 10, 'Europe/Paris')).toBe(Date.parse('2026-10-02T08:00:00Z'));
  });
});

describe('goldenHour', () => {
  const hours = (counts: Record<number, number>) =>
    Array.from({ length: 24 }, (_, hour) => counts[hour] ?? 0);

  it("is the hour the member is most often active, the creator's default without activity", () => {
    expect(goldenHour(hours({ 20: 9, 12: 3 }), PARIS, 19)).toBe(20);
    expect(goldenHour(null, PARIS, 19)).toBe(19);
    expect(goldenHour(hours({}), PARIS, 19)).toBe(19);
  });

  it('never falls in the quiet hours, and breaks ties toward the default hour', () => {
    expect(goldenHour(hours({ 23: 30, 18: 2 }), PARIS, 19)).toBe(18);
    expect(goldenHour(hours({ 9: 4, 17: 4, 21: 4 }), PARIS, 19)).toBe(17);
    expect(goldenHour(hours({ 2: 5, 9: 1, 12: 1 }), PARIS, 23)).toBe(9);
  });
});
