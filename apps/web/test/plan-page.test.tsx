import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PlanOffersView, PlanView } from '@stayput/core';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { OPEN_PLAN, PlanProvider } from '../src/plans';
import { PlanTab, monthsFree } from '../src/views/creator/PlanTab';

/**
 * Settings › Plan (decision of 2026-10-13): the three levels with their prices as Whop sells them,
 * the recommended one, the community's own, the yearly prices, and the checkout of each plan.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OFFERS: PlanOffersView = {
  offers: {
    pro: [
      {
        period: 'month',
        amount: 29,
        currency: 'usd',
        trialDays: 7,
        checkout: 'https://whop.com/checkout/plan_ProM/',
      },
      {
        period: 'year',
        amount: 290,
        currency: 'usd',
        trialDays: 7,
        checkout: 'https://whop.com/checkout/plan_ProY/',
      },
    ],
    scale: [
      {
        period: 'month',
        amount: 79,
        currency: 'usd',
        trialDays: 7,
        checkout: 'https://whop.com/checkout/plan_ScaleM/',
      },
      {
        period: 'year',
        amount: 790,
        currency: 'usd',
        trialDays: 7,
        checkout: 'https://whop.com/checkout/plan_ScaleY/',
      },
    ],
  },
};

function show(plan: PlanView, offers: PlanOffersView = OFFERS) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) =>
      Promise.resolve(
        input === '/api/creator/biz_A1/offers'
          ? new Response(JSON.stringify(offers), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 404 }),
      ),
    ),
  );
  render(
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={['/plan']}>
        <Routes>
          <Route element={<Outlet context={{ api: '/api/creator/biz_A1', demo: false }} />}>
            <Route
              path="/plan"
              element={
                <PlanProvider plan={plan} planPage="/plan">
                  <PlanTab />
                </PlanProvider>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const onFree: PlanView = {
  ...OPEN_PLAN,
  tier: 'free',
  source: 'none',
  checkout: { pro: 'https://whop.com/stayput-pro/', scale: 'https://whop.com/stayput-scale/' },
};
const column = (tier: string) =>
  document.querySelector<HTMLElement>(`[data-plan-column="${tier}"]`)!;

describe('Settings › Plan', () => {
  it('shows each level’s price as Whop sells it, Pro recommended, the trial in its button', async () => {
    show(onFree);
    expect(await screen.findByText('$29')).toBeTruthy();
    expect(within(column('scale')).getByText('$79')).toBeTruthy();
    expect(within(column('free')).getByText('$0')).toBeTruthy();
    expect(column('pro').querySelector('[data-plan-recommended]')?.textContent).toBe('Recommended');
    expect(within(column('free')).getByRole('button', { name: 'Current plan' })).toHaveProperty(
      'disabled',
      true,
    );
    const pro = within(column('pro')).getByRole('link', { name: /Start your 7-day free trial/ });
    expect(pro.getAttribute('href')).toBe('https://whop.com/checkout/plan_ProM/');
    // The one primary button: the first level above the community's.
    expect(pro.className).toContain('button-primary');
    expect(
      within(column('scale')).getByRole('link', { name: /Start your 7-day free trial/ }).className,
    ).not.toContain('button-primary');
    expect(
      screen.getByText('Pro and Scale start with 7 days free. Cancel anytime on Whop.'),
    ).toBeTruthy();
  });

  it('switches to the yearly prices, their monthly cost and their checkout', async () => {
    show(onFree);
    await screen.findByText('$29');
    fireEvent.click(screen.getByRole('radio', { name: /Yearly/ }));
    expect(within(column('pro')).getByText('$290')).toBeTruthy();
    expect(within(column('pro')).getByText('$24.17 / month, billed yearly')).toBeTruthy();
    expect(within(column('scale')).getByText('$790')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Yearly/ }).textContent).toContain('2 months free');
    expect(
      within(column('scale'))
        .getByRole('link', { name: /Start your 7-day free trial/ })
        .getAttribute('href'),
    ).toBe('https://whop.com/checkout/plan_ScaleY/');
  });

  it('says « Current plan » on the community’s level and offers only the levels above', async () => {
    show({ ...onFree, tier: 'pro', source: 'whop' });
    await screen.findByText('$29');
    expect(within(column('pro')).getByRole('button', { name: 'Current plan' })).toBeTruthy();
    expect(
      within(column('free')).getByRole('button', { name: 'Included in your plan' }),
    ).toBeTruthy();
    expect(
      within(column('scale')).getByRole('link', { name: /Start your 7-day free trial/ }).className,
    ).toContain('button-primary');
  });

  it('keeps the configured checkout and no price when Whop did not answer', async () => {
    show(onFree, { offers: null });
    const upgrade = await within(column('pro')).findByRole('link', { name: /Upgrade to Pro/ });
    expect(upgrade.getAttribute('href')).toBe('https://whop.com/stayput-pro/');
    expect(column('pro').querySelector('[data-plan-price]')).toBeNull();
    expect(screen.queryByRole('radio', { name: /Yearly/ })).toBeNull();
  });

  it('counts the months a year saves', () => {
    expect(monthsFree(OFFERS.offers?.pro)).toBe(2);
    expect(monthsFree(OFFERS.offers?.pro.slice(0, 1))).toBe(0);
    expect(monthsFree(undefined)).toBe(0);
  });
});
