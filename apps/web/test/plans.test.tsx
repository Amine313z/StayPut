import { cleanup, render, screen } from '@testing-library/react';
import type { PlanView } from '@stayput/core';
import { createTranslator } from '@stayput/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionsLeft, PlanBadge, PlanBanner } from '../src/components/Plans';
import { I18nProvider } from '../src/i18n';
import { OPEN_PLAN, PlanProvider } from '../src/plans';

/**
 * What the page says of the plan (decision of 2026-10-10): the founders' banner with its date and
 * price, and its reminders 7 days and 1 day before the first charge; a trial's days left; Free's
 * count of manual actions; nothing at all while plans are off.
 */

afterEach(cleanup);

const DAY = 86_400_000;
const fr = createTranslator('fr');
const inDays = (days: number) => new Date(Date.now() + days * DAY - 60_000).toISOString();

function show(plan: PlanView) {
  render(
    <I18nProvider initialLocale="fr">
      <MemoryRouter>
        <PlanProvider plan={plan} planPage="/dashboard/biz_A1/settings/plan">
          <PlanBadge />
          <PlanBanner />
          <ActionsLeft />
        </PlanProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const founder = (days: number): PlanView => ({
  ...OPEN_PLAN,
  tier: 'scale',
  source: 'whop',
  trialEndsAt: inDays(days),
  founder: { trialEndsAt: inDays(days), price: { amount: 39.5, currency: 'usd' } },
});

describe('the plan on the page', () => {
  it('says the founders’ free months, their end date and the price for life', () => {
    const plan = founder(45);
    show(plan);
    const day = fr.date(new Date(plan.founder!.trialEndsAt!));
    expect(screen.getByRole('status').textContent).toBe(
      fr.t('plan.founder', { date: day, price: fr.currency(39.5, 'usd') }),
    );
    expect(screen.getByRole('status').textContent).toMatch(
      /^Fondateur · gratuit jusqu’au .+, puis 39,50.\$\/mois à vie$/,
    );
    expect(screen.getByRole('link', { name: /Scale/ }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/settings/plan',
    );
  });

  it('reminds the founders 7 days and 1 day before the first charge', () => {
    const week = founder(7);
    show(week);
    expect(screen.getByRole('status').textContent).toBe(
      fr.t('plan.founder.week', { date: fr.date(new Date(week.trialEndsAt!)) }),
    );
    cleanup();
    const tomorrow = founder(1);
    show(tomorrow);
    expect(screen.getByRole('status').textContent).toBe(
      fr.t('plan.founder.tomorrow', { date: fr.date(new Date(tomorrow.trialEndsAt!)) }),
    );
  });

  it('counts a trial’s days, and Free’s manual actions', () => {
    show({ ...OPEN_PLAN, tier: 'pro', source: 'whop', trialEndsAt: inDays(12) });
    expect(screen.getByRole('status').textContent).toBe('Essai Pro : 12 jours restants');
    cleanup();
    show({ ...OPEN_PLAN, tier: 'free', source: 'none', manualActions: { used: 3, limit: 5 } });
    expect(screen.getByText('3 / 5 actions ce mois-ci')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing while plans are off', () => {
    const { container } = render(
      <I18nProvider initialLocale="fr">
        <MemoryRouter>
          <PlanProvider plan={OPEN_PLAN} planPage="/x">
            <PlanBadge />
            <PlanBanner />
            <ActionsLeft />
          </PlanProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(container.textContent).toBe('');
  });
});
