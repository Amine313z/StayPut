import {
  LIMITS,
  TIERS,
  tierAtLeast,
  type PlanOffer,
  type PlanOffersView,
  type Tier,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApi } from '../../api';
import { useI18n } from '../../i18n';
import { usePlan } from '../../plans';
import { buttonClass } from '../../ui/Button';
import { ExternalButton } from '../../ui/ExternalLink';
import { Segmented } from '../../ui/Segmented';
import { useCreatorData } from '../CreatorView';

/**
 * Settings › Plan (decision of 2026-10-13, after Sendoo's page): the three levels side by side,
 * each with its price as Whop sells it (month or year), its trial, what it opens grouped by what
 * a creator does with it, and one button: « Current plan » on the community's own, the checkout
 * of Whop on the levels above it (the first of them the one primary button), nothing to buy below
 * it. Pro is the recommended one. Whop runs the checkout, the trial and any cancellation.
 */

type Period = 'month' | 'year';

interface Line {
  key: MessageKey;
  params?: Record<string, number>;
}

interface Group {
  title: MessageKey;
  lines: readonly Line[];
}

/** What each level opens, as packages/core/src/plans.ts opens it (FEATURES, LIMITS). */
const GROUPS: Readonly<Record<Tier, readonly Group[]>> = {
  free: [
    {
      title: 'plan.group.detect',
      lines: [
        { key: 'plan.line.risk_all' },
        { key: 'plan.line.money_at_risk' },
        { key: 'plan.line.forecast_preview' },
      ],
    },
    {
      title: 'plan.group.act',
      lines: [
        {
          key: 'plan.line.actions_limited',
          params: { count: LIMITS.free.manualActionsPerMonth ?? 0 },
        },
      ],
    },
    { title: 'plan.group.connect', lines: [{ key: 'plan.line.one_platform' }] },
    {
      title: 'plan.group.analyze',
      lines: [
        { key: 'plan.line.history', params: { days: LIMITS.free.historyDays } },
        { key: 'plan.line.badge' },
      ],
    },
  ],
  pro: [
    {
      title: 'plan.group.detect',
      lines: [
        { key: 'plan.line.risk_all' },
        { key: 'plan.line.money_at_risk' },
        { key: 'plan.line.forecast_full' },
      ],
    },
    {
      title: 'plan.group.act',
      lines: [{ key: 'plan.line.actions_unlimited' }, { key: 'plan.line.followups' }],
    },
    {
      title: 'plan.group.recover',
      lines: [{ key: 'plan.line.payments' }, { key: 'plan.line.pause_survey' }],
    },
    {
      title: 'plan.group.connect',
      lines: [{ key: 'plan.line.two_platforms', params: { count: LIMITS.pro.servers ?? 2 } }],
    },
    {
      title: 'plan.group.analyze',
      lines: [
        { key: 'plan.line.history_cohorts', params: { days: LIMITS.pro.historyDays } },
        { key: 'plan.line.monday' },
      ],
    },
  ],
  scale: [
    {
      title: 'plan.group.detect',
      lines: [
        { key: 'plan.line.risk_all' },
        { key: 'plan.line.forecast_full' },
        { key: 'plan.line.lessons' },
      ],
    },
    {
      title: 'plan.group.act',
      lines: [{ key: 'plan.line.actions_unlimited' }, { key: 'plan.line.autopilot' }],
    },
    {
      title: 'plan.group.recover',
      lines: [
        { key: 'plan.line.payments' },
        { key: 'plan.line.pause_survey' },
        { key: 'plan.line.winback' },
      ],
    },
    { title: 'plan.group.connect', lines: [{ key: 'plan.line.unlimited_servers' }] },
    {
      title: 'plan.group.analyze',
      lines: [
        { key: 'plan.line.history_cohorts', params: { days: LIMITS.scale.historyDays } },
        { key: 'plan.line.monday' },
      ],
    },
    { title: 'plan.group.support', lines: [{ key: 'plan.line.priority' }] },
  ],
};

const TAGLINES: Readonly<Record<Tier, MessageKey>> = {
  free: 'plan.tagline.free',
  pro: 'plan.tagline.pro',
  scale: 'plan.tagline.scale',
};

/** A text with **strong** parts, as the lines write the figures that make the difference. */
export function Rich({ text }: { text: string }): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold text-fg">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

/** A level's offer for the period shown: that period's, else the one Whop has. */
function offerFor(offers: readonly PlanOffer[] | undefined, period: Period): PlanOffer | null {
  if (!offers || offers.length === 0) return null;
  return offers.find((offer) => offer.period === period) ?? offers[0] ?? null;
}

/** The months a year costs less than twelve of them (290 for 29 a month: 2). */
export function monthsFree(offers: readonly PlanOffer[] | undefined): number {
  const month = offers?.find((offer) => offer.period === 'month');
  const year = offers?.find((offer) => offer.period === 'year');
  if (!month || !year || month.currency !== year.currency) return 0;
  return Math.max(0, Math.round(12 - year.amount / month.amount));
}

export function PlanTab() {
  const { t, plural, date, currency } = useI18n();
  const { api } = useCreatorData();
  const { on, plan, checkoutFor } = usePlan();
  const { state } = useApi<PlanOffersView>(`${api}/offers`);
  const offers = state.status === 'ready' ? state.data.offers : null;
  const [period, setPeriod] = useState<Period>('month');
  const saving = monthsFree(offers?.pro);
  const yearly = Boolean(offers?.pro.some((offer) => offer.period === 'year'));
  const trial = offers?.pro.find((offer) => offer.trialDays)?.trialDays ?? null;
  /** A price as a creator reads it: « $29 », « $79.99 ». */
  const price = (amount: number, code: string) =>
    Number.isInteger(amount) && amount < 1000
      ? currency(amount, code, { compact: true })
      : currency(amount, code);
  // The one primary button: the first level above the community's.
  const next = TIERS.find((tier) => !tierAtLeast(plan.tier, tier));
  return (
    <div className="space-y-8">
      <section className="mx-auto max-w-2xl space-y-3 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {t('plan.hero.title')}
        </h2>
        <p className="text-muted text-balance">
          {on
            ? trial
              ? t('plan.hero.body', { days: trial })
              : t('plan.page.current', { tier: t(`plan.tier.${plan.tier}`) })
            : t('plan.page.off')}
        </p>
        {on && yearly ? (
          <div className="flex justify-center pt-1">
            <Segmented<Period>
              label={t('plan.billing.label')}
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'month', label: t('plan.billing.monthly') },
                {
                  value: 'year',
                  label: (
                    <span className="inline-flex items-center gap-2">
                      {t('plan.billing.yearly')}
                      {saving > 0 ? (
                        <span className="rounded-full bg-accent-soft px-2 py-px text-[0.6875rem] font-semibold text-accent">
                          {plural('plan.billing.save', saving)}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </section>
      <div className="grid gap-5 @3xl:grid-cols-3">
        {TIERS.map((tier) => {
          const current = on && plan.tier === tier;
          const below = on && tierAtLeast(plan.tier, tier) && !current;
          const recommended = tier === 'pro';
          const offer = tier === 'free' ? null : offerFor(offers?.[tier], period);
          const freeCurrency = offerFor(offers?.pro, 'month')?.currency ?? 'usd';
          return (
            <section
              key={tier}
              data-plan-column={tier}
              aria-labelledby={`plan-${tier}`}
              className={`relative flex flex-col overflow-hidden rounded-2xl border p-6 ${
                recommended
                  ? 'border-turq-300/60 bg-surface shadow-[0_0_0_1px_var(--glow),0_24px_64px_-28px_var(--glow)]'
                  : current
                    ? 'border-line-strong bg-surface'
                    : 'border-line bg-surface/60'
              }`}
            >
              {recommended ? (
                <span
                  data-plan-recommended=""
                  className="absolute end-[-52px] top-[30px] w-[190px] rotate-45 bg-accent py-1 text-center text-[0.6875rem] font-semibold tracking-wide text-on-accent uppercase rtl:-rotate-45"
                >
                  {t('plan.recommended')}
                </span>
              ) : null}
              <header className="space-y-1 pe-12">
                <h3 id={`plan-${tier}`} className="text-lg font-semibold">
                  {t(`plan.tier.${tier}`)}
                </h3>
                <p className="min-h-10 text-sm text-muted">{t(TAGLINES[tier])}</p>
              </header>
              <div className="mt-5 min-h-[5.5rem]">
                {tier === 'free' ? (
                  <>
                    <p className="flex items-baseline gap-1.5">
                      <span className="text-4xl font-semibold tracking-tight tabular-nums">
                        {price(0, freeCurrency)}
                      </span>
                      <span className="text-sm text-muted">{t('plan.price.month')}</span>
                    </p>
                    <p className="mt-2 text-xs text-subtle">{t('plan.price.free')}</p>
                  </>
                ) : offer ? (
                  <>
                    <p className="flex items-baseline gap-1.5" data-plan-price={tier}>
                      <span className="text-4xl font-semibold tracking-tight tabular-nums">
                        {price(offer.amount, offer.currency)}
                      </span>
                      <span className="text-sm text-muted">
                        {t(offer.period === 'year' ? 'plan.price.year' : 'plan.price.month')}
                      </span>
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
                      {offer.trialDays ? (
                        <span className="rounded-full border border-turq-300/40 bg-accent-soft px-2 py-0.5 font-medium text-accent">
                          {t('plan.trial.badge', { days: offer.trialDays })}
                        </span>
                      ) : null}
                      {offer.period === 'year' ? (
                        <span>
                          {t('plan.price.perMonthYearly', {
                            price: currency(offer.amount / 12, offer.currency),
                          })}
                        </span>
                      ) : null}
                    </p>
                  </>
                ) : null}
              </div>
              <div className="mt-6 flex-1 space-y-5">
                {GROUPS[tier].map((group) => (
                  <div key={group.title}>
                    <h4 className="text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
                      {t(group.title)}
                    </h4>
                    <ul className="mt-2 space-y-2 text-sm text-muted">
                      {group.lines.map((line) => (
                        <li key={line.key} className="flex gap-2">
                          <Check
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-accent"
                          />
                          <span>
                            <Rich text={t(line.key, line.params)} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="mt-7">
                {!on ? null : current || below ? (
                  <button
                    type="button"
                    disabled
                    data-plan-cta={current ? 'current' : 'included'}
                    className={buttonClass('secondary', 'md', 'w-full')}
                  >
                    {t(current ? 'plan.cta.current' : 'plan.cta.included')}
                  </button>
                ) : (
                  <ExternalButton
                    block
                    href={offer?.checkout ?? checkoutFor(tier)}
                    whopAppId={plan.whopAppId}
                    variant={tier === next ? 'primary' : 'secondary'}
                  >
                    {offer?.trialDays
                      ? t('plan.cta.trial', { days: offer.trialDays })
                      : t(tier === 'scale' ? 'plan.upgrade.scale' : 'plan.upgrade.pro')}
                  </ExternalButton>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <footer className="mx-auto max-w-2xl space-y-1 text-center text-xs text-subtle">
        {on && plan.trialEndsAt ? (
          <p>{t('plan.page.trialEnds', { date: date(new Date(plan.trialEndsAt)) })}</p>
        ) : null}
        <p>{t('plan.footer')}</p>
      </footer>
    </div>
  );
}
