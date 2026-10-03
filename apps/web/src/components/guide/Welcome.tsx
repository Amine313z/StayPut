import type { DashboardView, IntegrationsStatus } from '@stayput/core';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Hand,
  ShieldCheck,
  TrendingUp,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { postJson } from '../../api';
import { useI18n } from '../../i18n';
import { SPRING, ease } from '../../motion';
import { Badge } from '../../ui/Badge';
import { DiscordIcon, StayPutMark, TelegramIcon } from '../../ui/BrandIcons';
import { Button } from '../../ui/Button';
import { AnimatedNumber } from '../../ui/Motion';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { ConnectButton } from '../ConnectInvite';
import { failureText } from '../MemberActions';

type Mode = DashboardView['mode'];

/** The four steps (brief v4 §10). */
const STEPS = ['hello', 'connect', 'mode', 'audit'] as const;

const PROMISES: readonly {
  key: 'guide.who.title' | 'guide.keep.title' | 'guide.money.title';
  Icon: LucideIcon;
}[] = [
  { key: 'guide.who.title', Icon: Users },
  { key: 'guide.keep.title', Icon: Zap },
  { key: 'guide.money.title', Icon: TrendingUp },
];

/**
 * The first-run welcome (brief v4 §10), four steps in a window over the dashboard: welcome;
 * Discord or Telegram (optional, each connects in a tap); automatic or manual (saved on Next);
 * the first audit, the members at risk and the revenue they threaten counting up. It ends on
 * the tour or the dashboard; closing it (Skip, Escape) is final as well: it never opens by
 * itself again (`onClose`, the Worker keeps it per community).
 */
export function Welcome({
  view,
  integrations,
  api,
  root,
  importing,
  onClose,
}: {
  view: DashboardView | null;
  integrations: IntegrationsStatus | null;
  api: string;
  root: string;
  /** Whop's history still coming in: the audit's figures fill in on their own. */
  importing: boolean;
  onClose: (then: 'tour' | 'dashboard') => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);
  const chosen: Mode = mode ?? view?.mode ?? 'manual';
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // The keyboard on the main button (the window would start on « Skip »); it stays there from
    // step to step, the footer's buttons being the same ones.
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);
  const finish = (then: 'tour' | 'dashboard') => {
    // Seen: never again by itself, whatever answer comes back.
    void postJson(`${api}/getting-started/welcomed`).catch(() => undefined);
    onClose(then);
  };
  const next = async () => {
    if (STEPS[step] === 'mode' && view && chosen !== view.mode) {
      setSaving(true);
      try {
        await postJson(`${api}/mode`, { mode: chosen });
      } catch (error) {
        toast({ tone: 'error', title: failureText(error, t) });
        return;
      } finally {
        setSaving(false);
      }
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };
  const current = STEPS[step]!;

  let body: ReactNode = null;
  let primary: ReactNode = null;
  let secondary: ReactNode = null;
  switch (current) {
    case 'hello':
      body = <Hello titleId={titleId} />;
      primary = (
        <Button variant="primary" data-autofocus="" onClick={() => void next()}>
          {t('welcome.hello.start')}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      );
      break;
    case 'connect':
      body = <Connect titleId={titleId} integrations={integrations} root={root} />;
      break;
    case 'mode':
      body = <ModeChoice titleId={titleId} chosen={chosen} onChoose={setMode} />;
      break;
    case 'audit':
      body = <Audit titleId={titleId} view={view} importing={importing} />;
      secondary = (
        <Button variant="ghost" onClick={() => finish('dashboard')}>
          {t('welcome.audit.dashboard')}
        </Button>
      );
      primary = (
        <Button variant="primary" data-autofocus="" onClick={() => finish('tour')}>
          {t('welcome.audit.tour')}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      );
      break;
  }
  primary ??= (
    <Button variant="primary" data-autofocus="" loading={saving} onClick={() => void next()}>
      {t('welcome.next')}
      <ArrowRight aria-hidden="true" className="size-4" />
    </Button>
  );
  secondary ??=
    step > 0 ? (
      <Button
        variant="ghost"
        icon={<ArrowLeft aria-hidden="true" className="size-4" />}
        onClick={() => setStep((s) => Math.max(0, s - 1))}
      >
        {t('welcome.back')}
      </Button>
    ) : (
      <span />
    );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        finish('dashboard');
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-x-hidden overflow-y-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-lift"
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING}
        className="p-6 sm:p-8"
      >
        <header className="flex items-center justify-between gap-4">
          <Progress step={step} />
          {current === 'audit' ? null : (
            <Button variant="ghost" size="sm" className="-me-2" onClick={() => finish('dashboard')}>
              {t('welcome.skip')}
            </Button>
          )}
        </header>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12, transition: ease('micro') }}
            transition={ease('standard')}
            className="mt-6"
          >
            {body}
          </motion.div>
        </AnimatePresence>
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3">
          {secondary}
          {primary}
        </footer>
      </motion.div>
    </dialog>
  );
}

/** Four segments, the steps done and the current one turquoise; said as « Step 2 of 4 ». */
function Progress({ step }: { step: number }) {
  const { t, number } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <span className="sr-only">
        {t('welcome.step', { step: number(step + 1), total: number(STEPS.length) })}
      </span>
      {STEPS.map((id, index) => (
        <span
          key={id}
          aria-hidden="true"
          className="h-1 w-8 overflow-hidden rounded-full bg-black-600"
        >
          <motion.span
            className="block h-full origin-left rounded-full bg-turq-300"
            initial={false}
            animate={{ scaleX: index <= step ? 1 : 0 }}
            transition={ease('standard')}
          />
        </span>
      ))}
    </div>
  );
}

function Hello({ titleId }: { titleId: string }) {
  const { t } = useI18n();
  return (
    <>
      <span className="relative inline-flex">
        <span
          aria-hidden="true"
          className="hero-glow -z-10"
          style={{ width: 240, height: 240, left: -96, top: -96 }}
        />
        <StayPutMark size={48} />
      </span>
      <h2 id={titleId} className="title-page mt-5">
        {t('welcome.label')}
      </h2>
      <p className="mt-2 text-sm">{t('welcome.hello.body')}</p>
      <ul className="mt-6 space-y-3">
        {PROMISES.map(({ key, Icon }) => (
          <li key={key} className="flex items-center gap-3 text-sm font-medium text-fg">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-accent">
              <Icon aria-hidden="true" className="size-4" />
            </span>
            {t(key)}
          </li>
        ))}
      </ul>
    </>
  );
}

function Connect({
  titleId,
  integrations,
  root,
}: {
  titleId: string;
  integrations: IntegrationsStatus | null;
  root: string;
}) {
  const { t } = useI18n();
  const platforms = [
    {
      id: 'discord' as const,
      name: t('sources.discord.name'),
      Icon: DiscordIcon,
      connected: (integrations?.discord.servers.length ?? 0) > 0,
    },
    {
      id: 'telegram' as const,
      name: t('sources.telegram.name'),
      Icon: TelegramIcon,
      connected: (integrations?.telegram.groups.length ?? 0) > 0,
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={titleId} className="title-page">
          {t('guide.do.connect')}
        </h2>
        <Badge>{t('welcome.connect.optional')}</Badge>
      </div>
      <p className="mt-2 text-sm">{t('welcome.connect.body')}</p>
      <ul className="mt-6 divide-y divide-line rounded-xl border border-line">
        {platforms.map(({ id, name, Icon, connected }) => (
          <li key={id} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
            <Icon
              className={`size-5 shrink-0 ${id === 'discord' ? 'text-discord' : 'text-telegram'}`}
            />
            <span className="flex-1 text-sm font-medium text-fg">{name}</span>
            {integrations === null ? (
              <Skeleton className="h-8 w-36" />
            ) : connected ? (
              <Badge tone="accent" icon={<Check aria-hidden="true" className="size-3.5" />}>
                {t('welcome.connect.done')}
              </Badge>
            ) : (
              <ConnectButton platform={id} status={integrations} root={root} />
            )}
          </li>
        ))}
      </ul>
      <p className="mt-4 flex items-start gap-2 text-[0.8125rem]">
        <ShieldCheck aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 text-accent" />
        {t('sources.privacy')}
      </p>
    </>
  );
}

function ModeChoice({
  titleId,
  chosen,
  onChoose,
}: {
  titleId: string;
  chosen: Mode;
  onChoose: (mode: Mode) => void;
}) {
  const { t } = useI18n();
  const options = [
    {
      mode: 'auto' as const,
      Icon: Zap,
      label: t('actionSettings.mode.auto'),
      hint: t('actionSettings.mode.auto.hint'),
    },
    {
      mode: 'manual' as const,
      Icon: Hand,
      label: t('actionSettings.mode.manual'),
      hint: t('actionSettings.mode.manual.hint'),
    },
  ];
  return (
    <>
      <h2 id={titleId} className="title-page">
        {t('welcome.mode.title')}
      </h2>
      <p className="mt-2 text-sm">{t('welcome.mode.body')}</p>
      <div role="radiogroup" aria-labelledby={titleId} className="mt-6 grid gap-3 sm:grid-cols-2">
        {options.map(({ mode, Icon, label, hint }) => {
          const on = chosen === mode;
          return (
            <label
              key={mode}
              className={`relative flex cursor-pointer flex-col gap-2 rounded-xl border p-4 transition-colors duration-200 ${
                on ? 'border-accent bg-surface-2' : 'border-line hover:border-line-strong'
              }`}
            >
              <input
                type="radio"
                name={`${titleId}-mode`}
                value={mode}
                checked={on}
                onChange={() => onChoose(mode)}
                className="peer sr-only"
              />
              <span className="flex items-center justify-between">
                <Icon
                  aria-hidden="true"
                  className={`size-5 ${on ? 'text-accent' : 'text-subtle'}`}
                />
                <span
                  aria-hidden="true"
                  className={`flex size-4 items-center justify-center rounded-full border ${
                    on ? 'border-accent bg-turq-300 text-black-900' : 'border-line-strong'
                  }`}
                >
                  {on ? <Check className="size-3" /> : null}
                </span>
              </span>
              <span className="text-sm font-medium text-fg">{label}</span>
              <span className="text-[0.8125rem] leading-5">{hint}</span>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-xl peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
              />
            </label>
          );
        })}
      </div>
      <p className="mt-4 text-[0.8125rem] text-subtle">{t('welcome.mode.later')}</p>
    </>
  );
}

/** « 23 members at risk, $1,127.00 threatened »: the dashboard's own figures, counting up. */
function Audit({
  titleId,
  view,
  importing,
}: {
  titleId: string;
  view: DashboardView | null;
  importing: boolean;
}) {
  const { t, plural, number, currency } = useI18n();
  const ready = view !== null && !importing;
  const members = view?.atRisk.members ?? 0;
  const money = view?.currency ?? null;
  return (
    <>
      <h2 id={titleId} className="label-text">
        {t('welcome.audit.title')}
      </h2>
      {/* The figure first on screen, its words after it: « 23 members at risk ». */}
      <dl className="mt-4 space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <dt className="order-2 text-sm">
            {plural('welcome.audit.members', ready ? members : 2)}
          </dt>
          <dd className="metric-lead order-1 text-fg">
            {ready ? (
              <AnimatedNumber value={members} format={(value) => number(Math.round(value))} />
            ) : (
              <Skeleton className="h-12 w-16" />
            )}
          </dd>
        </div>
        {money ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <dt className="order-2 text-sm">{t('welcome.audit.threatened')}</dt>
            <dd className="metric-lead order-1 text-fg">
              {ready ? (
                <AnimatedNumber
                  value={view.atRisk.revenue}
                  format={(value) => currency(value, money)}
                />
              ) : (
                <Skeleton className="h-12 w-48" />
              )}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-6 text-sm" role="status">
        {!ready
          ? t('welcome.audit.reading')
          : members > 0
            ? t('welcome.audit.found')
            : t('welcome.audit.none')}
      </p>
    </>
  );
}
