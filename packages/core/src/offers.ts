/**
 * The departure survey and its offers (SPEC Phase 4): a member who scheduled their cancellation
 * says why in one click, and gets the offer that answers it. Pure: the Worker applies what the
 * member accepts, through the guardrails (actions.ts).
 */

/** Why a member leaves: the five answers of the survey. */
export type ExitReason = 'too_expensive' | 'no_time' | 'no_results' | 'goal_reached' | 'other';

export const EXIT_REASONS: readonly ExitReason[] = [
  'too_expensive',
  'no_time',
  'no_results',
  'goal_reached',
  'other',
];

export function isExitReason(value: unknown): value is ExitReason {
  return typeof value === 'string' && (EXIT_REASONS as readonly string[]).includes(value);
}

/** What StayPut offers for each reason (actions.ts types). */
export type OfferType =
  'pause_offer' | 'promo_offer' | 'coaching_offer' | 'affiliate_invite' | 'extend_offer';

/**
 * The SPEC's answers: no time, a pause; too expensive, a single-use promo code; no results, the
 * creator's help; goal reached, an invitation to recommend the community; another reason, free
 * days.
 */
export const OFFER_FOR_REASON: Readonly<Record<ExitReason, OfferType>> = {
  too_expensive: 'promo_offer',
  no_time: 'pause_offer',
  no_results: 'coaching_offer',
  goal_reached: 'affiliate_invite',
  other: 'extend_offer',
};

/**
 * Whether accepting an offer undoes the cancellation, which StayPut only does with the member's
 * explicit consent (a box they tick): a pause makes no sense in a membership that ends, so it
 * requires it; free days and help leave it to the member; a promo code is for a later checkout.
 */
export type KeepMembership = 'required' | 'optional' | 'never';

export const KEEP_MEMBERSHIP: Readonly<Record<OfferType, KeepMembership>> = {
  pause_offer: 'required',
  promo_offer: 'never',
  coaching_offer: 'optional',
  affiliate_invite: 'never',
  extend_offer: 'optional',
};

/** The creator's offers (company_settings), within OFFER_LIMITS. */
export interface OfferSettings {
  /** How long a pause lasts; Whop resumes the payments then. */
  pauseDays: number;
  /** The promo code's discount, in percent, and for how many months of renewals. */
  promoPercent: number;
  promoMonths: number;
  /** Free days for « another reason » (the guardrails cap them at 14 per quarter). */
  extendDays: number;
  /** The creator's own words to a member without results; StayPut's when null. */
  coachingMessage: string | null;
}

export const DEFAULT_OFFERS: OfferSettings = {
  pauseDays: 30,
  promoPercent: 20,
  promoMonths: 3,
  extendDays: 7,
  coachingMessage: null,
};

export const OFFER_LIMITS = {
  pauseDays: [7, 90],
  promoPercent: [5, 50],
  promoMonths: [1, 12],
  extendDays: [1, 14],
} as const;

/** The creator's message to a member without results is at most this long. */
export const COACHING_MESSAGE_MAX = 400;

/** A promo code is valid this long (decision of 2026-09-30). */
export const PROMO_VALID_DAYS = 7;

/** One offer, as the member sees it and the action applies it. */
export interface ExitOffer {
  type: OfferType;
  /** Pause length, or free days. */
  days?: number;
  /** The promo code's discount and duration. */
  percentOff?: number;
  months?: number;
  validDays?: number;
  /** The creator's words (coaching). */
  message?: string | null;
  keep: KeepMembership;
}

/** The offer answering a reason, with the creator's settings. */
export function exitOffer(reason: ExitReason, settings: OfferSettings): ExitOffer {
  const type = OFFER_FOR_REASON[reason];
  const keep = KEEP_MEMBERSHIP[type];
  switch (type) {
    case 'pause_offer':
      return { type, days: settings.pauseDays, keep };
    case 'promo_offer':
      return {
        type,
        percentOff: settings.promoPercent,
        months: settings.promoMonths,
        validDays: PROMO_VALID_DAYS,
        keep,
      };
    case 'extend_offer':
      return { type, days: settings.extendDays, keep };
    case 'coaching_offer':
      return { type, message: settings.coachingMessage, keep };
    case 'affiliate_invite':
      return { type, keep };
  }
}

/** Letters and figures that cannot be mistaken for one another (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A promo code no one can guess: `STAY-` and 8 characters from `bytes` (random, 8 or more), about
 * 40 bits: Whop does not tie a code to a member, so its secrecy and its single use do.
 */
export function promoCode(bytes: Uint8Array): string {
  if (bytes.length < 8) throw new Error('8 random bytes at least');
  let code = '';
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `STAY-${code}`;
}

/** A return code and what it gives (SPEC 5.9): an Alumni follow-up's `{offer}`. */
export interface ReturnOffer {
  code: string;
  percentOff: number;
  months: number;
}

/**
 * The `{offer}` of an Alumni follow-up, in the company's language: the code, its discount and for
 * how long, and how long it is valid (`STAY-K7QM2XPA (-20 % pendant 3 mois, valable 7 jours)`).
 */
export function returnOfferText(locale: 'en' | 'fr', offer: ReturnOffer): string {
  // Written out rather than with Intl, whose spacing of « % » differs between runtimes.
  if (locale === 'fr') {
    return `${offer.code} (-${offer.percentOff}\u00a0% pendant ${offer.months} mois, valable ${PROMO_VALID_DAYS} jours)`;
  }
  const months = offer.months === 1 ? '1 month' : `${offer.months} months`;
  return `${offer.code} (${offer.percentOff}% off for ${months}, valid ${PROMO_VALID_DAYS} days)`;
}

/** The offers the creator makes from the dashboard: a pause, or a promo code. */
export type CreatorOfferKind = 'pause_offer' | 'promo_offer';

export function isCreatorOfferKind(value: unknown): value is CreatorOfferKind {
  return value === 'pause_offer' || value === 'promo_offer';
}

/** What such an offer gives, fixed when it is made (the creator's offer settings). */
export type CreatorOfferTerms = { days: number } | { percentOff: number; months: number };

/** How long the member has to accept it. */
export const CREATOR_OFFER_DAYS = 7;

/** The offer in words, for `{offer}` in its message: « a 30-day pause… », « 20% off… ». */
export function creatorOfferText(
  locale: 'en' | 'fr',
  kind: CreatorOfferKind,
  terms: CreatorOfferTerms,
): string {
  if (kind === 'pause_offer' && 'days' in terms) {
    return locale === 'fr'
      ? `une pause de ${terms.days} jours : ton abonnement t’attend`
      : `a ${terms.days}-day pause: your membership waits for you`;
  }
  if ('percentOff' in terms) {
    if (locale === 'fr') return `-${terms.percentOff}\u00a0% pendant ${terms.months} mois`;
    const months = terms.months === 1 ? '1 month' : `${terms.months} months`;
    return `${terms.percentOff}% off for ${months}`;
  }
  return locale === 'fr' ? 'une offre' : 'an offer';
}
