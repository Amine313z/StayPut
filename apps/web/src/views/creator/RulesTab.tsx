import type { ActionSettingsView } from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  ArrowRight,
  CalendarClock,
  CreditCard,
  MessageSquareText,
  RefreshCw,
  SlidersHorizontal,
  Sprout,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { useApi } from '../../api';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { SECTION_LINK_CLASS } from '../../ui/Button';
import { Stagger, StaggerItem } from '../../ui/Motion';
import { Skeleton } from '../../ui/Skeleton';
import { useCreatorData } from '../CreatorView';

interface Rule {
  id: string;
  /** Where the guide may light it up (`data-tour`, guide.ts). */
  tour?: string;
  Icon: LucideIcon;
  title: MessageKey;
  when: MessageKey;
  check: string;
  then: string;
  on: boolean;
}

/**
 * Automations › Rules (brief v4 §9.4, first version): what StayPut does on its own, one card per
 * rule — when it starts, what it checks, what it does — as the engine runs them
 * (supabase/migrations, `prepare_actions`). The mode says who decides; the limits hold for every
 * rule. Turning a rule on or off, the limits panel and the message previews come with the
 * Automations step (fix prompt v4.1, block 7).
 */
export function RulesTab() {
  const { t } = useI18n();
  const { api, root } = useCreatorData();
  const settings = useApi<ActionSettingsView>(`${api}/settings/actions`);
  if (settings.state.status === 'error') {
    return (
      <ErrorPanel
        error={settings.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={settings.retry}
      />
    );
  }
  const view = settings.state.status === 'ready' ? settings.state.data : null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {view ? (
          <p className="text-sm">
            <span className="font-medium text-fg">
              {t(view.mode === 'auto' ? 'actionSettings.mode.auto' : 'actionSettings.mode.manual')}
            </span>
            <span className="text-muted">
              {' · '}
              {t(
                view.mode === 'auto'
                  ? 'actionSettings.mode.auto.hint'
                  : 'actionSettings.mode.manual.hint',
              )}
            </span>
          </p>
        ) : (
          <Skeleton className="h-4 w-80" />
        )}
        <Link to={`${root}/settings/actions`} className={SECTION_LINK_CLASS}>
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          {t('rules.settings')}
        </Link>
      </div>
      {view ? (
        <Stagger as="ul" className="grid grid-cols-1 gap-3 @container lg:grid-cols-2">
          {rulesOf(view, t).map((rule) => (
            <StaggerItem key={rule.id} as="li">
              <RuleCard rule={rule} />
            </StaggerItem>
          ))}
        </Stagger>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      )}
    </div>
  );
}

/** The rules StayPut runs, the one that brings money back first. */
function rulesOf(view: ActionSettingsView, t: (key: MessageKey) => string): Rule[] {
  const retries = view.maxPaymentRetries;
  return [
    {
      id: 'payment-retry',
      tour: 'rule-payment-retry',
      Icon: RefreshCw,
      title: 'rules.retry.title',
      when: 'rules.when.paymentFailed',
      check: t('rules.retry.check'),
      then: t(
        retries >= 2
          ? 'rules.retry.then.twice'
          : retries === 1
            ? 'rules.retry.then.once'
            : 'rules.retry.then.off',
      ),
      on: retries > 0,
    },
    {
      id: 'payment-notice',
      Icon: CreditCard,
      title: 'rules.notice.title',
      when: 'rules.when.paymentFailed',
      check: t('rules.notice.check'),
      then: t('rules.notice.then'),
      on: true,
    },
    {
      id: 'cancellation',
      Icon: CalendarClock,
      title: 'rules.cancel.title',
      when: 'rules.when.cancel',
      check: t('rules.cancel.check'),
      then: t('rules.cancel.then'),
      on: true,
    },
    {
      id: 'check-in',
      Icon: MessageSquareText,
      title: 'rules.checkIn.title',
      when: 'rules.when.high',
      check: t('rules.limits.check'),
      then: t('rules.checkIn.then'),
      on: true,
    },
    {
      id: 'welcome',
      Icon: Sprout,
      title: 'rules.welcome.title',
      when: 'rules.when.newcomer',
      check: t('rules.limits.check'),
      then: t('rules.welcome.then'),
      on: true,
    },
  ];
}

/** A rule: its name and state, then when → if → then, one line each. */
function RuleCard({ rule }: { rule: Rule }) {
  const { t } = useI18n();
  const { Icon } = rule;
  const steps: { label: MessageKey; text: string }[] = [
    { label: 'rules.when', text: t(rule.when) },
    { label: 'rules.if', text: rule.check },
    { label: 'rules.then', text: rule.then },
  ];
  return (
    <article
      data-tour={rule.tour}
      className={`h-full rounded-xl border border-line bg-surface p-4 ${rule.on ? '' : 'opacity-70'}`}
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2.5 text-sm font-medium text-fg">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <span className="truncate">{t(rule.title)}</span>
        </h3>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
            rule.on ? 'border-line-strong text-turq-300' : 'border-line text-subtle'
          }`}
        >
          {t(rule.on ? 'rules.on' : 'rules.off')}
        </span>
      </header>
      <ol className="mt-3 space-y-1.5 text-[0.8125rem]">
        {steps.map((step, index) => (
          <li key={step.label} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2">
            <span className="label-text pt-px">{t(step.label)}</span>
            <span
              className={`flex min-w-0 items-start gap-1.5 ${index === 2 ? 'text-fg' : 'text-muted'}`}
            >
              {index === 2 ? (
                <ArrowRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
              ) : null}
              <span>{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}
