import { describe, expect, it } from 'vitest';
import type { RiskReason } from '@stayput/core';
import { createTranslator } from '@stayput/i18n';
import { reasonText } from '../src/risk-text';

/**
 * Every reason the score gives reads as a sentence in both languages (the members' drawers, the
 * table, the Monday report): no code, no {placeholder} left, the numbers in it; and a reason a
 * newer Worker knows but this page does not says nothing.
 */

const REASONS: RiskReason[] = [
  { code: 'inactive', days: 12 },
  { code: 'inactive', days: 1 },
  { code: 'never_active', days: 4 },
  { code: 'activity_drop', percent: 60 },
  { code: 'activity_drop', percent: 100 },
  { code: 'no_progress', days: 21, lesson: 'Risk management' },
  { code: 'no_progress', days: 21, lesson: null },
  { code: 'payment_failed' },
  { code: 'payment_action_required' },
  { code: 'cancel_scheduled', date: '2026-10-29T00:00:00.000Z' },
  { code: 'cancel_scheduled', date: null },
  { code: 'ticket_open', days: 3 },
  { code: 'reactions_drop', percent: 55 },
  { code: 'reactions_drop', percent: 100 },
  { code: 'platform_silent', platform: 'discord', days: 9 },
  { code: 'platform_silent', platform: 'telegram', days: 9 },
  { code: 'platform_drop', platform: 'discord', percent: 70 },
  { code: 'platform_drop', platform: 'telegram', percent: 70 },
  { code: 'platform_left', platform: 'discord' },
  { code: 'platform_left', platform: 'telegram' },
];

describe('the reasons of the risk score, in words', () => {
  for (const locale of ['en', 'fr'] as const) {
    it(`says each one in ${locale}, its numbers in it`, () => {
      const i18n = createTranslator(locale);
      const texts = REASONS.map((reason) => {
        const text = reasonText(reason, i18n);
        expect(text, JSON.stringify(reason)).toBeTruthy();
        expect(text, JSON.stringify(reason)).not.toMatch(/[{}]|risk\.reason|undefined|NaN/);
        if ('days' in reason) expect(text).toContain(String(reason.days));
        if ('lesson' in reason && reason.lesson) expect(text).toContain(reason.lesson);
        if ('platform' in reason) expect(text).toMatch(/Discord|Telegram/);
        return text;
      });
      // Down 100 % reads as « nothing this week », never as a percentage.
      expect(texts[4]).not.toMatch(/100/);
      expect(texts[13]).not.toMatch(/100/);
      // Each case its own sentence.
      expect(new Set(texts).size).toBe(texts.length);
    });
  }

  it('says nothing of a reason it does not know, rather than a code', () => {
    const unknown = { code: 'from_the_future', days: 3 } as unknown as RiskReason;
    expect(reasonText(unknown, createTranslator('en'))).toBeNull();
  });
});
