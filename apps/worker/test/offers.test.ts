import type { WhopClient } from '@stayput/whop';
import { describe, expect, it } from 'vitest';
import type { PlansConfig } from '../src/env';
import { planOffer, readOffers } from '../src/plans';

/** Settings › Plan's prices: Pro's and Scale's Whop plans, read from Whop (2026-10-13). */

const config = (pro: string[], scale: string[]): PlansConfig => ({
  enabled: pro.length > 0 && scale.length > 0,
  proPlans: pro,
  scalePlans: scale,
  founderPlan: null,
  checkout: { pro: null, scale: null },
  adminUserId: null,
  founderFallback: { on: false, betaEnd: null },
});

const plan = (overrides: Record<string, unknown>) => ({
  billing_period: 30,
  renewal_price: 29,
  currency: 'usd',
  trial_period_days: 7,
  purchase_url: 'https://whop.com/checkout/plan_X/',
  ...overrides,
});

function fakeWhop(plans: Record<string, Record<string, unknown>>) {
  const asked: string[] = [];
  const whop = {
    request: (_method: string, path: string) => {
      asked.push(path);
      const id = path.split('/').pop() ?? '';
      const found = plans[id];
      return found ? Promise.resolve(found) : Promise.reject(new Error('404'));
    },
  } as unknown as WhopClient;
  return { whop, asked };
}

describe('the plans Whop sells', () => {
  it('reads a monthly or yearly plan’s price, trial and checkout', () => {
    expect(planOffer(plan({}))).toEqual({
      period: 'month',
      amount: 29,
      currency: 'usd',
      trialDays: 7,
      checkout: 'https://whop.com/checkout/plan_X/',
    });
    expect(
      planOffer(plan({ billing_period: 365, renewal_price: '290', currency: 'USD' })),
    ).toMatchObject({ period: 'year', amount: 290, currency: 'usd' });
    expect(planOffer(plan({ trial_period_days: 0 }))?.trialDays).toBeNull();
  });

  it('leaves out what the page cannot show, and never a checkout outside Whop', () => {
    expect(planOffer(plan({ billing_period: 7 }))).toBeNull();
    expect(planOffer(plan({ billing_period: null }))).toBeNull();
    expect(planOffer(plan({ renewal_price: 0 }))).toBeNull();
    expect(planOffer(plan({ currency: 'dollars' }))).toBeNull();
    expect(planOffer(plan({ purchase_url: 'https://evil.example/whop.com' }))?.checkout).toBeNull();
    expect(planOffer(plan({ purchase_url: 'http://whop.com/checkout/x' }))?.checkout).toBeNull();
    expect(planOffer(plan({ purchase_url: 'https://sandbox.whop.com/c/x' }))?.checkout).toBe(
      'https://sandbox.whop.com/c/x',
    );
  });

  it('gives Pro’s and Scale’s plans, month first, and asks Whop once an hour', async () => {
    const { whop, asked } = fakeWhop({
      plan_OfY1: plan({ billing_period: 365, renewal_price: 290 }),
      plan_OfM1: plan({}),
      plan_OfS1: plan({ renewal_price: 79 }),
    });
    const plans = config(['plan_OfY1', 'plan_OfM1'], ['plan_OfS1', 'plan_OfGone']);
    const now = new Date('2026-10-13T12:00:00Z');
    const offers = await readOffers(whop, plans, now);
    expect(offers?.pro.map((o) => [o.period, o.amount])).toEqual([
      ['month', 29],
      ['year', 290],
    ]);
    expect(offers?.scale.map((o) => o.amount)).toEqual([79]);
    expect(asked).toHaveLength(4);
    await readOffers(whop, plans, new Date(now.getTime() + 30 * 60_000));
    expect(asked).toHaveLength(4);
    await readOffers(whop, plans, new Date(now.getTime() + 61 * 60_000));
    expect(asked).toHaveLength(8);
  });

  it('says nothing while plans are off, or when Whop gave none of them', async () => {
    const { whop, asked } = fakeWhop({});
    expect(await readOffers(whop, config([], []), new Date())).toBeNull();
    expect(asked).toEqual([]);
    expect(await readOffers(null, config(['plan_A'], ['plan_B']), new Date())).toBeNull();
    expect(await readOffers(whop, config(['plan_NoneP'], ['plan_NoneS']), new Date())).toBeNull();
  });
});
