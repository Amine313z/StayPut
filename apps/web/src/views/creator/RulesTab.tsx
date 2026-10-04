import {
  DEFAULT_TEMPLATES,
  renderMessage,
  type ActionSettingsView,
  type MessageAction,
  type RuleId,
  type TemplateValues,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  ArrowRight,
  CalendarClock,
  ChevronDown,
  CreditCard,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Sprout,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { postJson, putJson, useApi } from '../../api';
import { ErrorPanel } from '../../components/Status';
import { useI18n } from '../../i18n';
import { ease } from '../../motion';
import { Button, SECTION_LINK_CLASS } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Stagger, StaggerItem } from '../../ui/Motion';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/Toast';
import { useCreatorData } from '../CreatorView';

interface Rule {
  id: RuleId;
  /** Where the guide may light it up (`data-tour`, guide.ts). */
  tour?: string;
  Icon: LucideIcon;
  title: MessageKey;
  when: MessageKey;
  check: string;
  then: string;
  /** What it writes to the member, previewed on its card; none for a payment retry. */
  message?: MessageAction;
}

/** What an empty page proposes (brief v4 §9.4): the three rules that bring money back first. */
export const READY_MADE: readonly RuleId[] = ['payment_retry', 'payment_notice', 'exit_survey'];

/** What a preview fills the templates with: a member named Alex, the community's own name. */
function sampleValues(companyName: string | null): TemplateValues {
  return {
    first_name: 'Alex',
    creator_name: companyName,
    days_inactive: 12,
    last_lesson: 'Module 2',
  };
}

type Mode = ActionSettingsView['mode'];

/** The settings with one rule turned on or off, its list kept in order as the Worker keeps it. */
function withRule(view: ActionSettingsView, rule: RuleId, on: boolean): ActionSettingsView {
  const off = new Set(view.rulesOff);
  if (on) off.delete(rule);
  else off.add(rule);
  return { ...view, rulesOff: [...off].sort() };
}

/**
 * Automations › Rules (brief v4 §9.4): what StayPut does on its own, one card per rule — when it
 * starts, what it checks, what it does — as the engine runs them (`plan_actions`), each with its
 * switch (migration 0032) and, for a message, its preview in the language the members get. Above
 * them, who decides (manual or automatic); beside them, the limits every rule stays within. With
 * every rule off, the three that bring money back first, to turn on at once.
 */
export function RulesTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { api, root, companyName, members } = useCreatorData();
  const settings = useApi<ActionSettingsView>(`${api}/settings/actions`);
  // What the creator changed here: shown at once, ahead of the Worker's answer.
  const [changed, setChanged] = useState<ActionSettingsView | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<RuleId | 'mode'>>(new Set());
  const [allShown, setAllShown] = useState(false);
  const modeLabel = useId();

  if (settings.state.status === 'error') {
    return (
      <ErrorPanel
        error={settings.state.error}
        forbiddenKey="error.forbidden.creator"
        onRetry={settings.retry}
      />
    );
  }
  const view = changed ?? (settings.state.status === 'ready' ? settings.state.data : null);
  const working = (what: RuleId | 'mode', on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(what);
      else next.delete(what);
      return next;
    });

  const setRule = async (base: ActionSettingsView, rule: RuleId, on: boolean) => {
    setChanged((current) => withRule(current ?? base, rule, on));
    working(rule, true);
    try {
      const answer = await putJson<ActionSettingsView>(`${api}/rules/${encodeURIComponent(rule)}`, {
        on,
      });
      // The Worker's word on this rule; one switched meanwhile keeps its own.
      setChanged((current) => withRule(current ?? answer, rule, !answer.rulesOff.includes(rule)));
    } catch {
      setChanged((current) => withRule(current ?? base, rule, !on));
      toast({ tone: 'error', title: t('rules.switchFailed') });
    } finally {
      working(rule, false);
    }
  };

  const setMode = async (base: ActionSettingsView, mode: Mode) => {
    if (mode === base.mode) return;
    setChanged((current) => ({ ...(current ?? base), mode }));
    working('mode', true);
    try {
      await postJson(`${api}/mode`, { mode });
      toast({ title: t(mode === 'auto' ? 'actions.mode.auto' : 'actions.mode.manual') });
    } catch {
      setChanged((current) => ({ ...(current ?? base), mode: base.mode }));
      toast({ tone: 'error', title: t('rules.modeFailed') });
    } finally {
      working('mode', false);
    }
  };

  const rules = view ? rulesOf(view, t) : [];
  const allOff = view !== null && rules.every((rule) => view.rulesOff.includes(rule.id));
  const never =
    members.state.status === 'ready'
      ? members.state.data.members.filter((m) => m.doNotContact).length
      : null;

  return (
    <div className="space-y-6">
      <section
        aria-labelledby={modeLabel}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-5"
      >
        <h2 id={modeLabel} className="label-text">
          {t('actionSettings.mode')}
        </h2>
        {view ? (
          <>
            <Segmented<Mode>
              labelledBy={modeLabel}
              value={view.mode}
              options={[
                { value: 'manual', label: t('actionSettings.mode.manual') },
                { value: 'auto', label: t('actionSettings.mode.auto') },
              ]}
              onChange={(mode) => {
                if (!busy.has('mode')) void setMode(view, mode);
              }}
            />
            <p className="text-sm text-muted">
              {t(
                view.mode === 'auto'
                  ? 'actionSettings.mode.auto.hint'
                  : 'actionSettings.mode.manual.hint',
              )}
            </p>
          </>
        ) : (
          <Skeleton className="h-8 w-80" />
        )}
      </section>
      <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="@container min-w-0">
          {!view ? (
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2" aria-hidden="true">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-40 w-full rounded-xl" />
              ))}
            </div>
          ) : allOff && !allShown ? (
            <NoRuleOn
              rules={rules}
              busy={READY_MADE.some((rule) => busy.has(rule))}
              onTurnOn={() => {
                for (const rule of READY_MADE) void setRule(view, rule, true);
              }}
              onShowAll={() => setAllShown(true)}
            />
          ) : (
            <Stagger as="ul" className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              {rules.map((rule) => (
                <StaggerItem key={rule.id} as="li">
                  <RuleCard
                    rule={rule}
                    on={!view.rulesOff.includes(rule.id)}
                    busy={busy.has(rule.id)}
                    onChange={(on) => void setRule(view, rule.id, on)}
                    preview={
                      rule.message ? (
                        <MessagePreview
                          action={rule.message}
                          view={view}
                          companyName={companyName}
                          root={root}
                        />
                      ) : null
                    }
                  />
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>
        {view ? (
          <Limits view={view} never={never} root={root} />
        ) : (
          <Skeleton className="h-64 w-full rounded-xl" />
        )}
      </div>
    </div>
  );
}

/** The rules StayPut runs, the one that brings money back first. */
function rulesOf(view: ActionSettingsView, t: (key: MessageKey) => string): Rule[] {
  const retries = view.maxPaymentRetries;
  return [
    {
      id: 'payment_retry',
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
    },
    {
      id: 'payment_notice',
      Icon: CreditCard,
      title: 'rules.notice.title',
      when: 'rules.when.paymentFailed',
      check: t('rules.notice.check'),
      then: t('rules.notice.then'),
      message: 'payment_failed_notice',
    },
    {
      id: 'exit_survey',
      Icon: CalendarClock,
      title: 'rules.cancel.title',
      when: 'rules.when.cancel',
      check: t('rules.cancel.check'),
      then: t('rules.cancel.then'),
      message: 'exit_survey',
    },
    {
      id: 'check_in',
      Icon: MessageSquareText,
      title: 'rules.checkIn.title',
      when: 'rules.when.high',
      check: t('rules.limits.check'),
      then: t('rules.checkIn.then'),
      message: 'high_risk_message',
    },
    {
      id: 'welcome',
      Icon: Sprout,
      title: 'rules.welcome.title',
      when: 'rules.when.newcomer',
      check: t('rules.limits.check'),
      then: t('rules.welcome.then'),
      message: 'welcome_message',
    },
  ];
}

/** A rule: its name and switch, then when → if → then, one line each, and its message. */
function RuleCard({
  rule,
  on,
  busy,
  onChange,
  preview,
}: {
  rule: Rule;
  on: boolean;
  busy: boolean;
  onChange: (on: boolean) => void;
  preview: ReactNode;
}) {
  const { t } = useI18n();
  const title = useId();
  const { Icon } = rule;
  const steps: { label: MessageKey; text: string }[] = [
    { label: 'rules.when', text: t(rule.when) },
    { label: 'rules.if', text: rule.check },
    { label: 'rules.then', text: rule.then },
  ];
  return (
    <article
      data-tour={rule.tour}
      data-rule={rule.id}
      data-on={on}
      className={`flex h-full flex-col rounded-xl border bg-surface p-4 transition-colors duration-200 ease-brand ${
        on ? 'border-line-strong' : 'border-line'
      }`}
    >
      <header className="flex items-center justify-between gap-3">
        <h3 id={title} className="flex min-w-0 items-center gap-2.5 text-sm font-medium text-fg">
          <span
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 transition-colors duration-200 ${
              on ? 'text-accent' : 'text-subtle'
            }`}
          >
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <span className="truncate">{t(rule.title)}</span>
        </h3>
        <Switch checked={on} onChange={onChange} labelledBy={title} busy={busy} />
      </header>
      <ol
        className={`mt-3 space-y-1.5 text-[0.8125rem] transition-opacity duration-200 ${
          on ? '' : 'opacity-50'
        }`}
      >
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
      {preview}
    </article>
  );
}

/**
 * A rule's message as a member will read it (brief v4 §9.4): the creator's own words when they
 * wrote some (Settings › Automations), StayPut's otherwise, in the language the members get,
 * tagged EN or FR. Folded until asked for: the page stays a list of rules.
 */
function MessagePreview({
  action,
  view,
  companyName,
  root,
}: {
  action: MessageAction;
  view: ActionSettingsView;
  companyName: string | null;
  root: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const locale = view.locale;
  const template = view.templates[locale]?.[action] ?? DEFAULT_TEMPLATES[locale][action];
  const message = renderMessage(template, sampleValues(companyName));
  return (
    <div className="mt-auto pt-3">
      <div className="border-t border-line pt-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((current) => !current)}
          className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-[0.8125rem] font-medium text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span>{t('rules.preview')}</span>
          <span className="flex items-center gap-2">
            <span
              data-lang-tag=""
              className="rounded border border-line-strong px-1.5 text-[0.6875rem] leading-4 font-semibold tracking-wide text-turq-300"
            >
              <span aria-hidden="true">{locale.toUpperCase()}</span>
              <span className="sr-only">{t(`rules.preview.lang.${locale}`)}</span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`size-4 transition-transform duration-200 ease-brand ${open ? 'rotate-180' : ''}`}
            />
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              id={panel}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: ease('micro') }}
              transition={ease('standard')}
              className="pt-2"
            >
              <div lang={locale} className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
                <p className="text-sm font-medium text-fg">{message.title}</p>
                <p className="mt-0.5 text-sm text-muted">{message.body}</p>
              </div>
              <p className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 text-xs text-subtle">
                <span>{t('rules.preview.sample')}</span>
                <Link to={`${root}/settings/actions`} className={`${SECTION_LINK_CLASS} -me-2`}>
                  {t('rules.preview.edit')}
                </Link>
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The limits every rule stays within (brief v4 §9.4: the guardrails, named « limits »): messages
 * per member, quiet hours, the discounts a month, the members never contacted. Changed in
 * Settings › Automations, where StayPut's own caps hold them.
 */
function Limits({
  view,
  never,
  root,
}: {
  view: ActionSettingsView;
  /** Members on the never-contact list; null while the members load. */
  never: number | null;
  root: string;
}) {
  const { t, plural, number } = useI18n();
  const title = useId();
  const hour = (value: number) => `${String(value).padStart(2, '0')}:00`;
  const rows: { label: MessageKey; value: string | null; to?: string }[] = [
    {
      label: 'rules.limits.messages',
      value:
        view.maxMessagesPer5Days > 0
          ? t('rules.limits.messages.value', {
              count: number(view.maxMessagesPer5Days),
              month: number(view.maxMessagesPerMonth),
            })
          : t('rules.limits.messages.none'),
    },
    {
      label: 'rules.limits.quiet',
      value: t('rules.limits.quiet.value', {
        from: hour(view.quietHoursStart),
        to: hour(view.quietHoursEnd),
      }),
    },
    {
      label: 'rules.limits.discounts',
      value:
        view.monthlyPromoCap > 0
          ? t('rules.limits.discounts.value', { count: number(view.monthlyPromoCap) })
          : t('rules.limits.discounts.none'),
    },
    {
      label: 'rules.limits.never',
      value: never === null ? null : plural('rules.limits.never', never),
      to: `${root}/members/never-contact`,
    },
  ];
  return (
    <section
      aria-labelledby={title}
      data-limits=""
      className="rounded-xl border border-line p-4 @4xl:sticky @4xl:top-20"
    >
      <h2 id={title} className="flex items-center gap-2 text-sm font-medium text-fg">
        <ShieldCheck aria-hidden="true" className="size-4 text-accent" />
        {t('rules.limits.title')}
      </h2>
      <p className="mt-1 text-[0.8125rem] text-muted">{t('rules.limits.hint')}</p>
      <dl className="mt-4 space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="label-text">{t(row.label)}</dt>
            <dd className="mt-0.5 text-sm text-fg">
              {row.value === null ? (
                <Skeleton className="h-4 w-20" />
              ) : row.to ? (
                <Link
                  to={row.to}
                  className="underline decoration-line-strong underline-offset-4 transition-colors duration-150 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {row.value}
                </Link>
              ) : (
                <span className="tabular">{row.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <Link to={`${root}/settings/actions`} className={`${SECTION_LINK_CLASS} -ms-2 mt-4`}>
        {t('rules.limits.change')}
        <ArrowRight aria-hidden="true" className="size-3.5" />
      </Link>
    </section>
  );
}

/**
 * Every rule off (brief v4 §9.4, the empty state): StayPut does nothing on its own. The three
 * that bring money back first, to turn on in one click; or the five, to choose one by one.
 */
function NoRuleOn({
  rules,
  busy,
  onTurnOn,
  onShowAll,
}: {
  rules: readonly Rule[];
  busy: boolean;
  onTurnOn: () => void;
  onShowAll: () => void;
}) {
  const { t } = useI18n();
  const ready = READY_MADE.map((id) => rules.find((rule) => rule.id === id)!);
  return (
    <EmptyState
      title={t('rules.empty.title')}
      body={t('rules.empty.body')}
      action={
        <div className="flex flex-col items-center gap-5">
          <ul className="grid w-full max-w-md gap-2 text-start">
            {ready.map(({ id, tour, Icon, title, then }) => (
              <li
                key={id}
                data-tour={tour}
                data-ready={id}
                className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <span className="min-w-0 text-[0.8125rem]">
                  <span className="block font-medium text-fg">{t(title)}</span>
                  <span className="block text-muted">{then}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" loading={busy} onClick={onTurnOn}>
              {t('rules.empty.turnOn')}
            </Button>
            <Button variant="ghost" onClick={onShowAll}>
              {t('rules.empty.all')}
            </Button>
          </div>
        </div>
      }
    />
  );
}
