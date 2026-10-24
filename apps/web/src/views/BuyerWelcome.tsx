import type { BuyerWelcome as Welcome } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { useI18n } from '../i18n';
import { Badge } from '../ui/Badge';
import { ExternalButton } from '../ui/ExternalLink';

/** The three steps, in order: install, open, the plan that follows. */
const STEPS: readonly { title: MessageKey; body: MessageKey }[] = [
  { title: 'welcome.step.install.title', body: 'welcome.step.install.body' },
  { title: 'welcome.step.open.title', body: 'welcome.step.open.body' },
  { title: 'welcome.step.plan.title', body: 'welcome.step.plan.body' },
];

/**
 * What a buyer of StayPut finds in the products of StayPut's own community (decision of
 * 2026-10-24): StayPut works on the whop they own, so the one button installs it there (Whop's
 * page, where they pick their whop), with their plan, where it already runs, and three steps.
 */
export function BuyerWelcome({ welcome }: { welcome: Welcome }) {
  const { t, date } = useI18n();
  const { plan, installedOn } = welcome;
  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:py-16">
      <section className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{t('welcome.title')}</h1>
        <p className="text-muted text-balance">{t('welcome.body')}</p>
        {plan ? (
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Badge tone="accent">{t('welcome.plan', { tier: t(`plan.tier.${plan.tier}`) })}</Badge>
            {plan.trialEndsAt ? (
              <Badge>{t('welcome.trial', { date: date(new Date(plan.trialEndsAt)) })}</Badge>
            ) : null}
          </div>
        ) : null}
      </section>
      <div className="mt-8">
        <ExternalButton href={welcome.installUrl} whopAppId={welcome.whopAppId} block>
          {t('welcome.install')}
        </ExternalButton>
        {installedOn.length > 0 ? (
          <p className="mt-3 text-center text-sm text-muted">
            {t('welcome.installed', { names: installedOn.join(', ') })}
          </p>
        ) : null}
      </div>
      <ol className="mt-10 space-y-3">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className="flex gap-4 rounded-2xl border border-line bg-surface p-5 text-start"
          >
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-sm font-semibold text-accent"
            >
              {index + 1}
            </span>
            <div>
              <p className="font-medium">{t(step.title)}</p>
              <p className="mt-1 text-sm text-muted">{t(step.body)}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-center text-sm text-muted">{t('welcome.help')}</p>
    </div>
  );
}
