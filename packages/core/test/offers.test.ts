import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OFFERS,
  EXIT_REASONS,
  KEEP_MEMBERSHIP,
  OFFER_FOR_REASON,
  exitOffer,
  isExitReason,
  promoCode,
  returnOfferText,
} from '../src/offers';

describe('the departure survey’s offers (SPEC Phase 4)', () => {
  it('answers each reason with the SPEC’s offer, in the creator’s numbers', () => {
    const settings = { ...DEFAULT_OFFERS, pauseDays: 45, coachingMessage: 'Écris-moi.' };
    expect(EXIT_REASONS.map((reason) => exitOffer(reason, settings))).toEqual([
      { type: 'promo_offer', percentOff: 20, months: 3, keep: 'required' },
      { type: 'pause_offer', days: 45, keep: 'required' },
      { type: 'coaching_offer', message: 'Écris-moi.', keep: 'optional' },
      { type: 'affiliate_invite', keep: 'never' },
      { type: 'extend_offer', days: 7, keep: 'optional' },
    ]);
  });

  it('keeps a membership only with consent, required where an ending one makes no sense', () => {
    // A pause of a membership that ends is meaningless: it needs the member to keep it.
    expect(KEEP_MEMBERSHIP[OFFER_FOR_REASON.no_time]).toBe('required');
    // So is a discount: it comes off the next payments of a membership that continues.
    expect(KEEP_MEMBERSHIP[OFFER_FOR_REASON.too_expensive]).toBe('required');
    expect(KEEP_MEMBERSHIP[OFFER_FOR_REASON.goal_reached]).toBe('never');
  });

  it('knows the five answers and nothing else', () => {
    expect(EXIT_REASONS.filter(isExitReason)).toHaveLength(5);
    for (const wrong of ['bored', '', null, 42, 'TOO_EXPENSIVE']) {
      expect(isExitReason(wrong)).toBe(false);
    }
  });

  it('makes promo codes no one can guess or misread, the same for the same bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 30, 31, 200, 255]);
    const code = promoCode(bytes);
    expect(code).toMatch(/^STAY-[A-HJKMNP-Z2-9]{8}$/);
    expect(promoCode(bytes)).toBe(code);
    expect(promoCode(Uint8Array.from([1, 1, 2, 3, 30, 31, 200, 255]))).not.toBe(code);
    // No 0/O, 1/I/L: read over the phone or copied by hand, it stays right.
    const all = Array.from({ length: 32 }, (_, i) =>
      promoCode(Uint8Array.from({ length: 8 }, (_, j) => i * 8 + j)),
    ).join('');
    expect(all.slice(5)).not.toMatch(/[01OIL]/);
    expect(() => promoCode(new Uint8Array(7))).toThrow();
  });

  it('words an Alumni return code in the company’s language', () => {
    const offer = { code: 'STAY-K7QM2XPA', percentOff: 20, months: 3 };
    expect(returnOfferText('fr', offer)).toBe(
      'STAY-K7QM2XPA (-20\u00a0% pendant 3 mois, valable 7 jours)',
    );
    expect(returnOfferText('en', offer)).toBe('STAY-K7QM2XPA (20% off for 3 months, valid 7 days)');
    expect(returnOfferText('en', { ...offer, months: 1 })).toBe(
      'STAY-K7QM2XPA (20% off for 1 month, valid 7 days)',
    );
  });
});
