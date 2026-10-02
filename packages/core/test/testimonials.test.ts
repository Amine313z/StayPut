import { describe, expect, it } from 'vitest';
import { isProofId, isProofLevel, parseAffiliateUrl, parseCardRequest } from '../src';

describe('the affiliate link on a card (SPEC 5.6)', () => {
  it('is a Whop address, or none', () => {
    expect(parseAffiliateUrl('https://whop.com/le-club/?a=lina')).toBe(
      'https://whop.com/le-club/?a=lina',
    );
    expect(parseAffiliateUrl('  https://whop.com/checkout/plan_X/?a=lina  ')).toBe(
      'https://whop.com/checkout/plan_X/?a=lina',
    );
    expect(parseAffiliateUrl('https://sandbox.whop.com/le-club')).toBe(
      'https://sandbox.whop.com/le-club',
    );
    expect(parseAffiliateUrl('https://WHOP.com')).toBe('https://WHOP.com');
    for (const none of [null, undefined, '']) expect(parseAffiliateUrl(none)).toBeNull();
  });

  it('never sends anyone elsewhere', () => {
    for (const bad of [
      'http://whop.com/le-club',
      'https://whop.com.evil.example/',
      'https://evilwhop.com/',
      'https://evil.example/?u=https://whop.com',
      'https://user:pass@whop.com/',
      'https://whop.com@evil.example/',
      'javascript:alert(1)',
      'whop.com/le-club',
      'https://whop.com/a b',
      'https://whop.com/"onmouseover="x',
      `https://whop.com/${'a'.repeat(300)}`,
      42,
    ]) {
      expect(parseAffiliateUrl(bad)).toBeUndefined();
    }
  });
});

describe('a card request', () => {
  const resultId = '0b9d4c8e-3f2a-4c1d-9e8f-7a6b5c4d3e2f';

  it('names a result, whether the name shows, and the link', () => {
    expect(parseCardRequest({ resultId, showName: true, affiliateUrl: null })).toEqual({
      resultId,
      showName: true,
      affiliateUrl: null,
    });
    expect(
      parseCardRequest({ resultId, showName: false, affiliateUrl: 'https://whop.com/x' }),
    ).toEqual({ resultId, showName: false, affiliateUrl: 'https://whop.com/x' });
    // No link given: none.
    expect(parseCardRequest({ resultId, showName: false })).toMatchObject({ affiliateUrl: null });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      'card',
      { showName: true, affiliateUrl: null },
      { resultId: 'r1', showName: true, affiliateUrl: null },
      { resultId, showName: 'yes', affiliateUrl: null },
      { resultId, affiliateUrl: null },
      { resultId, showName: true, affiliateUrl: 'https://evil.example/' },
    ]) {
      expect(parseCardRequest(bad)).toBeNull();
    }
  });

  it('knows a proof’s id and level', () => {
    expect(isProofId(resultId)).toBe(true);
    expect(isProofId('0B9D4C8E-3F2A-4C1D-9E8F-7A6B5C4D3E2F')).toBe(false);
    expect(isProofId('not-a-proof')).toBe(false);
    expect(['declared', 'justified', 'connected', 'verified'].map(isProofLevel)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
