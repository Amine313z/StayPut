import type { SpaceOverview, TestimonialCard } from '@stayput/core';
import {
  ArrowRight,
  Award,
  Copy,
  Eye,
  Handshake,
  IdCard,
  LifeBuoy,
  NotebookPen,
  ScanLine,
  Target,
  Users,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { MemberRetention } from '../../components/MemberRetention';
import { MemberSpace } from '../../components/MemberSpace';
import { PagePreviewButton } from '../../components/PagePreview';
import { QrCode } from '../../components/QrCode';
import { ErrorPanel, Loading } from '../../components/Status';
import { CardPicture, useCardImage } from '../../components/Testimonial';
import { useApi } from '../../api';
import { useI18n } from '../../i18n';
import { useWithUnit } from '../../units';
import { Badge, Notice } from '../../ui/Badge';
import { Button, SECTION_LINK_CLASS } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Stat } from '../../ui/Stat';
import { useCreatorData } from '../CreatorView';

/**
 * The member space in the dashboard (SPEC Phase 5), in three tabs: what members do with it (the
 * figures, the buddies and the challenges), the testimonial cards they put online (drawn here,
 * with a QR code to scan), and their space as it shows to them, to try (nothing recorded).
 */
function useSpaceOverview() {
  const { api } = useCreatorData();
  return useApi<SpaceOverview>(`${api}/space`);
}

/** The overview once read; meanwhile, the wait or what went wrong. */
function WithOverview({ children }: { children: (overview: SpaceOverview) => ReactNode }) {
  const { state, retry } = useSpaceOverview();
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  return <>{children(state.data)}</>;
}

/** Member space › Overview: the figures over 30 days, the buddies and the challenges. */
export function SpaceOverviewTab() {
  const { root } = useCreatorData();
  return (
    <WithOverview>
      {(overview) => (
        <div className="space-y-6">
          <Figures overview={overview} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <HelpingEachOther overview={overview} root={root} />
          </div>
        </div>
      )}
    </WithOverview>
  );
}

/** Member space › Testimonials: the cards online, each with a QR code to scan on the screen. */
export function SpaceCardsTab() {
  return (
    <WithOverview>
      {(overview) => <PublishedCards cards={overview.cards} whopAppId={overview.whopAppId} />}
    </WithOverview>
  );
}

/** Member space › Member view: their space as it shows to them, to try, nothing recorded. */
export function SpacePreviewTab() {
  const { api } = useCreatorData();
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Notice tone="info" icon={<Eye aria-hidden="true" className="size-4" />}>
        {t('spaceTab.preview.body')}
      </Notice>
      <MemberRetention api={`${api}/preview`} />
      <MemberSpace api={`${api}/preview`} />
    </div>
  );
}

function Figures({ overview }: { overview: SpaceOverview }) {
  const { t, number, plural } = useI18n();
  return (
    <section aria-labelledby="space-figures-title">
      <h2 id="space-figures-title" className="sr-only">
        {t('spaceTab.figures')}
      </h2>
      <dl className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @5xl:grid-cols-5">
        <Stat
          label={t('spaceTab.goals')}
          value={number(overview.goals.active)}
          hint={plural('spaceTab.achieved', overview.goals.achieved)}
          icon={<Target aria-hidden="true" className="size-4" />}
          tone="accent"
        />
        <Stat
          label={t('spaceTab.results')}
          value={number(overview.results.last30)}
          hint={plural('spaceTab.justified', overview.results.justified30)}
          icon={<NotebookPen aria-hidden="true" className="size-4" />}
          tone="info"
        />
        <Stat
          label={t('spaceTab.opens')}
          value={number(overview.opens30)}
          hint={plural('spaceTab.noting', overview.results.members30)}
          icon={<Users aria-hidden="true" className="size-4" />}
          tone="info"
        />
        <Stat
          label={t('spaceTab.badges')}
          value={number(overview.badges30)}
          icon={<Award aria-hidden="true" className="size-4" />}
          tone="accent"
        />
        <Stat
          label={t('spaceTab.cards')}
          value={number(overview.cards.online)}
          icon={<IdCard aria-hidden="true" className="size-4" />}
          tone="accent"
        />
      </dl>
    </section>
  );
}

/** The cards members put online, drawn as they shared them, with their page's link. */
function PublishedCards({
  cards,
  whopAppId,
}: {
  cards: SpaceOverview['cards'];
  whopAppId: string | null;
}) {
  const { t, plural } = useI18n();
  const more = cards.online - cards.latest.length;
  return (
    <Card
      icon={<IdCard aria-hidden="true" className="size-4" />}
      title={t('spaceTab.cards.title')}
      description={t('spaceTab.cards.body')}
    >
      {cards.latest.length === 0 ? (
        <p className="text-sm text-muted">{t('spaceTab.cards.none')}</p>
      ) : (
        <div className="space-y-4">
          <ul className="space-y-6">
            {cards.latest.map((card) => (
              <li key={card.proofId}>
                <PublishedCard card={card} whopAppId={whopAppId} />
              </li>
            ))}
          </ul>
          {more > 0 ? (
            <p className="text-sm text-muted">{plural('spaceTab.cards.more', more)}</p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function PublishedCard({ card, whopAppId }: { card: TestimonialCard; whopAppId: string | null }) {
  const { t, date } = useI18n();
  const withUnit = useWithUnit();
  const drawn = useCardImage(card);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <CardPicture card={card} drawn={drawn} className="max-w-56" />
      <div className="min-w-0 space-y-3">
        <p className="text-sm">
          <span className="font-medium">{card.display.goal}</span>
          <span className="text-muted">
            {` · ${withUnit(card.display.value, card.display.unit)} · ${date(
              new Date(`${card.display.day}T12:00:00`),
            )}`}
          </span>
        </p>
        {/* The card's own QR code is too small on a screen: this one is made to be scanned. */}
        <figure className="space-y-2">
          <QrCode
            value={card.url}
            size={220}
            label={t('spaceTab.cards.qr', { goal: card.display.goal })}
          />
          <figcaption className="flex items-center gap-1.5 text-sm text-muted">
            <ScanLine aria-hidden="true" className="size-4 shrink-0" />
            {t('spaceTab.cards.scan')}
          </figcaption>
        </figure>
        <div className="flex flex-wrap items-center gap-2">
          <PagePreviewButton url={card.url} goal={card.display.goal} whopAppId={whopAppId} />
          <Button
            variant="ghost"
            size="sm"
            icon={<Copy aria-hidden="true" className="size-4" />}
            onClick={() => {
              navigator.clipboard.writeText(card.url).then(
                () => setCopy('copied'),
                () => setCopy('failed'),
              );
            }}
          >
            {t('card.copy')}
          </Button>
        </div>
        <p role="status" className="text-sm">
          {copy === 'copied' ? (
            <span className="text-accent">{t('card.copied')}</span>
          ) : copy === 'failed' ? (
            <span className="text-warning">{t('card.copyFailed')}</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** The buddies and the rescue challenges: on or off, where they stand, and where to set them. */
function HelpingEachOther({ overview, root }: { overview: SpaceOverview; root: string }) {
  const { t, plural } = useI18n();
  const off = <Badge tone="neutral">{t('spaceTab.help.off')}</Badge>;
  return (
    <Card
      icon={<Handshake aria-hidden="true" className="size-4" />}
      title={t('spaceTab.help.title')}
      description={t('spaceTab.help.body')}
      actions={
        <Link to={`${root}/settings/space`} className={SECTION_LINK_CLASS}>
          {t('spaceTab.help.settings')}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      }
    >
      <ul className="divide-y divide-line">
        <HelpRow
          icon={<Handshake aria-hidden="true" className="size-4" />}
          label={t('buddies.title')}
        >
          {overview.buddies.enabled
            ? plural('spaceTab.help.pairs', overview.buddies.activePairs)
            : off}
        </HelpRow>
        <HelpRow
          icon={<LifeBuoy aria-hidden="true" className="size-4" />}
          label={t('rescues.title')}
        >
          {overview.rescues.enabled ? (
            <span className="flex flex-col items-end">
              <span>{plural('spaceTab.help.open', overview.rescues.open)}</span>
              <span className="text-xs text-muted">
                {plural('spaceTab.help.rescued', overview.rescues.rescuedLast30)}
              </span>
            </span>
          ) : (
            off
          )}
        </HelpRow>
      </ul>
    </Card>
  );
}

function HelpRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-3 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <span className="text-muted">{icon}</span>
        {label}
      </span>
      <span className="text-end">{children}</span>
    </li>
  );
}
