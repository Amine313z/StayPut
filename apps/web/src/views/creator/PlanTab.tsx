import { TIERS, tierAtLeast, type Tier } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { Check } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePlan } from '../../plans';
import { ExternalButton } from '../../ui/ExternalLink';

/**
 * Settings › Plan (decision of 2026-10-10): the community's level, what each level opens, and
 * the checkout of the visible plans (Pro, Scale) through Whop. Never the founders' plan, and no
 * price: Whop's checkout says it, and runs any trial.
 */

/** Each level's lines, as the offer lists them (packages/core/src/plans.ts opens them). */
const LINES: Record<Tier, readonly MessageKey[]> = {
  free: [
    'plan.feature.dashboard',
    'plan.feature.needs_attention',
    'plan.feature.whop_activity',
    'plan.feature.badge',
    'plan.feature.forecast_preview',
    'plan.feature.history_7',
    'plan.feature.manual_actions',
    'plan.feature.export',
  ],
  pro: [
    'plan.feature.unlimited_actions',
    'plan.feature.payment_recovery',
    'plan.feature.automations',
    'plan.feature.exit_survey',
    'plan.feature.both_platforms',
    'plan.feature.forecast',
  ],
  scale: [
    'plan.feature.autopilot',
    'plan.feature.winback',
    'plan.feature.lessons',
    'plan.feature.several_servers',
    'plan.feature.priority_support',
  ],
};

export function PlanTab() {
  const { t, date } = useI18n();
  const { on, plan, checkoutFor } = usePlan();
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">{t('plan.page.title')}</h2>
        <p className="text-sm text-muted">
          {on ? t('plan.page.current', { tier: t(`plan.tier.${plan.tier}`) }) : t('plan.page.off')}
        </p>
        {on && plan.trialEndsAt ? (
          <p className="text-sm text-muted">
            {t('plan.page.trialEnds', { date: date(new Date(plan.trialEndsAt)) })}
          </p>
        ) : null}
        <p className="text-sm text-muted">{t('plan.page.whop')}</p>
      </section>
      <div className="grid gap-4 @3xl:grid-cols-3">
        {TIERS.map((tier, index) => {
          const current = on && plan.tier === tier;
          const above = on && !tierAtLeast(plan.tier, tier);
          const below = TIERS[index - 1];
          return (
            <section
              key={tier}
              data-plan-column={tier}
              className={`flex flex-col gap-4 rounded-xl border p-5 shadow-card ${
                current ? 'border-line-strong bg-surface' : 'border-line bg-surface/60'
              }`}
            >
              <header className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{t(`plan.tier.${tier}`)}</h3>
                {current ? (
                  <span className="rounded-full border border-line-strong px-2 py-px text-[0.6875rem] font-medium text-accent">
                    {t('plan.page.current.badge')}
                  </span>
                ) : null}
              </header>
              {below ? (
                <p className="text-xs text-muted">
                  {t('plan.page.everything', { tier: t(`plan.tier.${below}`) })}
                </p>
              ) : null}
              <ul className="flex-1 space-y-2 text-sm">
                {LINES[tier].map((line) => (
                  <li key={line} className="flex gap-2">
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                    <span>{t(line)}</span>
                  </li>
                ))}
              </ul>
              {above && tier !== 'free' ? (
                <ExternalButton href={checkoutFor(tier)} whopAppId={plan.whopAppId}>
                  {t(tier === 'scale' ? 'plan.upgrade.scale' : 'plan.upgrade.pro')}
                </ExternalButton>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
