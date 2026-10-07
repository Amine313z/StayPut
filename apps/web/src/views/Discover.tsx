import type { MessageKey } from '@stayput/i18n';
import {
  BellOff,
  CircleDollarSign,
  FlaskConical,
  Gauge,
  Lock,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { LegalDialog, type LegalDocument } from '../components/Legal';
import { useI18n } from '../i18n';
import { StayPutMark } from '../ui/BrandIcons';
import { buttonClass } from '../ui/Button';
import { Card } from '../ui/Card';

/** The three steps of StayPut, as the App Store listing tells them (docs/app-store.md). */
const STEPS: readonly { icon: ReactNode; title: MessageKey; body: MessageKey }[] = [
  {
    icon: <Gauge aria-hidden="true" className="size-4" />,
    title: 'discover.detect.title',
    body: 'discover.detect.body',
  },
  {
    icon: <Zap aria-hidden="true" className="size-4" />,
    title: 'discover.act.title',
    body: 'discover.act.body',
  },
  {
    icon: <CircleDollarSign aria-hidden="true" className="size-4" />,
    title: 'discover.prove.title',
    body: 'discover.prove.body',
  },
];

const CONTROL: readonly { icon: ReactNode; text: MessageKey }[] = [
  {
    icon: <FlaskConical aria-hidden="true" className="size-4" />,
    text: 'discover.control.testMode',
  },
  {
    icon: <SlidersHorizontal aria-hidden="true" className="size-4" />,
    text: 'discover.control.mode',
  },
  { icon: <BellOff aria-hidden="true" className="size-4" />, text: 'discover.control.guardrails' },
];

const PRIVACY: readonly { icon: ReactNode; text: MessageKey }[] = [
  { icon: <Lock aria-hidden="true" className="size-4" />, text: 'discover.privacy.contacts' },
  { icon: <Trash2 aria-hidden="true" className="size-4" />, text: 'discover.privacy.retention' },
];

/**
 * Whop's Discover view (`discover_path`, WHOP_VIEW_PATHS): what a creator browsing Whop's app
 * store sees of StayPut before installing it. Public and static: no account, no call to the
 * API, nothing that leaves Whop's frame (the demo is StayPut's own page, the legal texts open in
 * a window). Whop shows its own Install button around it.
 */
export function Discover() {
  const { t } = useI18n();
  const [legal, setLegal] = useState<LegalDocument | null>(null);
  const list = (items: readonly { icon: ReactNode; text: MessageKey }[]) => (
    <ul className="space-y-3">
      {items.map(({ icon, text }) => (
        <li key={text} className="flex items-start gap-3 text-sm">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </span>
          <span className="pt-1">{t(text)}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="mx-auto max-w-4xl space-y-8 py-6 sm:py-10" data-discover>
      <div className="space-y-4 text-center">
        <StayPutMark size={48} className="mx-auto" />
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          {t('app.tagline')}
        </h1>
        <p className="text-lg text-muted">{t('discover.subtitle')}</p>
        <div className="space-y-2 pt-2">
          <Link to="/demo" className={buttonClass('primary', 'md')}>
            {t('discover.demo')}
          </Link>
          <p className="text-sm text-subtle">{t('discover.demoHint')}</p>
        </div>
      </div>

      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map(({ icon, title, body }) => (
          <li
            key={title}
            className="space-y-2 rounded-2xl border border-line bg-surface p-5 shadow-card"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
              {icon}
            </span>
            <h2 className="title-section">{t(title)}</h2>
            <p className="text-sm">{t(body)}</p>
          </li>
        ))}
      </ol>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card
          icon={<SlidersHorizontal aria-hidden="true" className="size-4" />}
          title={t('discover.control.title')}
        >
          {list(CONTROL)}
        </Card>
        <Card
          icon={<ShieldCheck aria-hidden="true" className="size-4" />}
          title={t('discover.privacy.title')}
        >
          {list(PRIVACY)}
        </Card>
      </div>

      <nav aria-label={t('legal.title')} className="flex flex-wrap justify-center gap-4">
        {(['privacy', 'terms'] as const).map((document) => (
          <button
            key={document}
            type="button"
            className="rounded-sm text-sm text-muted underline underline-offset-4 transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => setLegal(document)}
          >
            {t(document === 'privacy' ? 'legal.privacy' : 'legal.terms')}
          </button>
        ))}
      </nav>
      {legal ? <LegalDialog document={legal} onClose={() => setLegal(null)} /> : null}
    </div>
  );
}
