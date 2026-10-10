import { serverAllowed, type Feature, type ServerPlatform, type Tier } from '@stayput/core';
import { Lock, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { daysUntil, usePlan } from '../plans';
import { buttonClass, SECTION_LINK_CLASS } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ExternalButton } from '../ui/ExternalLink';

/**
 * What the page shows of the community's plan (decision of 2026-10-10): the level's badge, the
 * trial's and the founders' banners, a lock where the Worker would refuse, Free's count of manual
 * actions, and the dialog that offers the plan that opens something. Nothing shows while plans
 * are off.
 */

/** The level, in the top bar: Settings › Plan. */
export function PlanBadge() {
  const { t } = useI18n();
  const { on, plan, planPage } = usePlan();
  if (!on) return null;
  const tier = t(`plan.tier.${plan.tier}`);
  return (
    <Link
      to={planPage}
      aria-label={t('plan.badge', { tier })}
      data-plan-badge={plan.tier}
      className={`shrink-0 rounded-full border px-2 py-px text-[0.6875rem] font-medium ${
        plan.tier === 'free' ? 'border-white-100/20 text-muted' : 'border-line-strong text-accent'
      } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      {tier}
    </Link>
  );
}

/**
 * One line above every screen: the founders' (until their first charge, with its reminders 7
 * days and 1 day before), else Whop's trial under way, else nothing. And, when Whop does not
 * answer, that the last plan known applies.
 */
export function PlanBanner() {
  const { t, plural, date, currency } = useI18n();
  const { on, plan } = usePlan();
  if (!on) return null;
  const lines: { key: string; text: string }[] = [];
  const founderEnd = plan.founder?.trialEndsAt ?? null;
  if (plan.founder && founderEnd) {
    const days = daysUntil(founderEnd);
    const day = date(new Date(founderEnd));
    const price = plan.founder.price;
    lines.push({
      key: 'founder',
      text:
        days <= 1
          ? t('plan.founder.tomorrow', { date: day })
          : days <= 7
            ? t('plan.founder.week', { date: day })
            : price
              ? t('plan.founder', { date: day, price: currency(price.amount, price.currency) })
              : t('plan.founder.noPrice', { date: day }),
    });
  } else if (plan.trialEndsAt && plan.tier !== 'free') {
    lines.push({
      key: 'trial',
      text: plural('plan.trial', daysUntil(plan.trialEndsAt), {
        tier: t(`plan.tier.${plan.tier}`),
      }),
    });
  }
  if (plan.stale) lines.push({ key: 'stale', text: t('plan.stale') });
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      data-plan-banner=""
      className="mb-6 flex flex-col gap-1 rounded-xl border border-line-strong px-4 py-3 text-sm"
    >
      {lines.map((line) => (
        <p key={line.key} className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-accent" />
          {line.text}
        </p>
      ))}
    </div>
  );
}

/** A lock beside what a level opens: « Pro », « Scale »; pressed, it offers that plan. */
export function LockTag({ tier }: { tier: Tier }) {
  const { t } = useI18n();
  const { ask } = usePlan();
  return (
    <button
      type="button"
      onClick={() => ask(tier)}
      data-plan-lock={tier}
      title={t('plan.locked', { tier: t(`plan.tier.${tier}`) })}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-2 py-px text-[0.6875rem] font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Lock aria-hidden="true" className="size-3" />
      {t(`plan.tier.${tier}`)}
    </button>
  );
}

/**
 * What `feature` shows, when the plan opens it; else a locked block that says which plan opens
 * it and offers it.
 */
export function Locked({
  feature,
  title,
  children,
}: {
  feature: Feature;
  title?: ReactNode;
  children: ReactNode;
}) {
  const { lockedTo } = usePlan();
  const tier = lockedTo(feature);
  if (!tier) return <>{children}</>;
  return <LockedBlock tier={tier} title={title} />;
}

export function LockedBlock({ tier, title }: { tier: Tier; title?: ReactNode }) {
  const { t } = useI18n();
  const { ask } = usePlan();
  const name = t(`plan.tier.${tier}`);
  return (
    <section
      data-plan-locked={tier}
      className="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface/60 p-5 shadow-card"
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <Lock aria-hidden="true" className="size-4 text-accent" />
        {title ?? t('plan.locked', { tier: name })}
      </span>
      <p className="text-sm text-muted">{t('plan.locked.body', { tier: name })}</p>
      <button type="button" onClick={() => ask(tier)} className={buttonClass('secondary', 'sm')}>
        {t(tier === 'scale' ? 'plan.upgrade.scale' : 'plan.upgrade.pro')}
      </button>
    </section>
  );
}

/** Free's manual actions this month: « 3 / 5 actions this month »; nothing at other levels. */
export function ActionsLeft({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  const { on, plan, ask } = usePlan();
  const count = plan.manualActions;
  if (!on || !count) return null;
  const full = count.used >= count.limit;
  return (
    <p data-actions-left={`${count.used}/${count.limit}`} className={`text-xs ${className}`}>
      <span className={full ? 'text-fg' : 'text-muted'}>
        {t('plan.counter', { used: String(count.used), limit: String(count.limit) })}
      </span>
      {full ? (
        <>
          {' · '}
          <button type="button" onClick={() => ask('pro')} className={SECTION_LINK_CLASS}>
            {t('plan.counter.full')}
          </button>
        </>
      ) : null}
    </p>
  );
}

/** Whether Free has no manual action left this month. */
export function useActionsSpent(): boolean {
  const { on, plan } = usePlan();
  return on && plan.manualActions !== null && plan.manualActions.used >= plan.manualActions.limit;
}

/** The plan that opens what was asked: its checkout through Whop, or the plans' page. */
export function UpgradeDialog() {
  const { t } = useI18n();
  const { asked, dismiss, plan, planPage } = usePlan();
  if (!asked) return null;
  const tier = t(`plan.tier.${asked.tier}`);
  return (
    <Dialog
      title={t('plan.dialog.title', { tier })}
      description={t('plan.dialog.body', { tier, current: t(`plan.tier.${plan.tier}`) })}
      onClose={dismiss}
    >
      <div className="flex flex-wrap items-center gap-3">
        <ExternalButton href={asked.checkoutUrl} whopAppId={plan.whopAppId}>
          {t(asked.tier === 'scale' ? 'plan.upgrade.scale' : 'plan.upgrade.pro')}
        </ExternalButton>
        <Link to={planPage} onClick={dismiss} className={buttonClass('secondary', 'md')}>
          {t('plan.upgrade.see')}
        </Link>
        <button type="button" onClick={dismiss} className={buttonClass('ghost', 'md')}>
          {t('plan.dialog.later')}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * The level a server or group more on `platform` needs, or null when this plan counts it (the
 * Worker refuses the rest, packages/core/src/plans.ts serverAllowed).
 */
export function useServerLock(
  platform: ServerPlatform,
  connected: Readonly<Record<ServerPlatform, number>>,
): Tier | null {
  const { on, plan } = usePlan();
  return on ? serverAllowed(plan.tier, connected, platform) : null;
}
