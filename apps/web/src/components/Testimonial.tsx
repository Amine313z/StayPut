import {
  parseAffiliateUrl,
  type CardRequest,
  type GoalResult,
  type MemberGoal,
  type MemberSpaceView,
  type TestimonialCard,
} from '@stayput/core';
import { CircleAlert, Copy, Download, IdCard, LoaderCircle, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { CARD_HEIGHT, CARD_WIDTH, cardContent, renderCard, type CardContent } from '../card';
import { useI18n } from '../i18n';
import { useWithUnit } from '../units';
import { Notice } from '../ui/Badge';
import { Button, buttonClass } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmButton } from './ConfirmButton';
import { PagePreviewButton } from './PagePreview';
import { FIELD } from './SettingsParts';

/** Where the cards are made: StayPut for a member, the browser for the team's trial. */
export interface CardBackend {
  /** `current` is the space as shown, which the trial builds the card from. */
  makeCard: (request: CardRequest, current: MemberSpaceView) => Promise<TestimonialCard>;
  removeCard: (proofId: string) => Promise<void>;
  /** The member's own affiliate link, when Whop gives it (SPEC 5.6). */
  affiliateLink: () => Promise<string | null>;
}

/**
 * The testimonial cards (SPEC Phase 5, points 6 and 7): the member picks one of their results,
 * says whether their name shows, adds their affiliate link if they have one; the card is drawn
 * in their browser, with a QR code to its public page. They take that page down at any time.
 */
export function TestimonialCards({
  view,
  backend,
  trial,
}: {
  view: MemberSpaceView;
  backend: CardBackend;
  trial: boolean;
}) {
  const { t } = useI18n();
  // The cards made or taken down here, until the space comes back with them.
  const [local, setLocal] = useState<{
    base: TestimonialCard[];
    cards: TestimonialCard[];
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [removed, setRemoved] = useState(false);
  const cards = local && local.base === view.cards ? local.cards : view.cards;
  const shown = cards.find((card) => card.proofId === selected) ?? cards[0] ?? null;
  const goal = view.goal;
  const results = goal ? view.results : [];
  const update = (next: TestimonialCard[]) => setLocal({ base: view.cards, cards: next });

  return (
    <Card
      icon={<IdCard aria-hidden="true" className="size-4" />}
      title={t('card.title')}
      description={t('card.body')}
    >
      <div className="space-y-5">
        {trial ? <Notice tone="info">{t('card.trial')}</Notice> : null}
        {goal && results.length > 0 ? (
          making ? (
            <CardForm
              goal={goal}
              results={results}
              affiliateLink={backend.affiliateLink}
              onCancel={() => setMaking(false)}
              onMake={async (request) => {
                const card = await backend.makeCard(request, view);
                update([card, ...cards.filter((c) => c.proofId !== card.proofId)]);
                setSelected(card.proofId);
                setMaking(false);
                setRemoved(false);
              }}
            />
          ) : (
            <Button
              onClick={() => {
                setMaking(true);
                setRemoved(false);
              }}
              icon={<IdCard aria-hidden="true" className="size-4" />}
            >
              {t('card.start')}
            </Button>
          )
        ) : null}
        {removed ? (
          <p role="status" className="text-sm text-muted">
            {t('card.removed')}
          </p>
        ) : null}
        {shown ? (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('card.online')}</h3>
            <CardView
              key={shown.proofId}
              card={shown}
              whopAppId={view.whopAppId}
              trial={trial}
              onRemove={async () => {
                await backend.removeCard(shown.proofId);
                update(cards.filter((c) => c.proofId !== shown.proofId));
                setSelected(null);
                setRemoved(true);
              }}
            />
            {cards.length > 1 ? (
              <CardList
                cards={cards.filter((c) => c.proofId !== shown.proofId)}
                onShow={setSelected}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </Card>
  );
}

/** Which result, the member's name or not, their affiliate link or not. */
function CardForm({
  goal,
  results,
  affiliateLink,
  onMake,
  onCancel,
}: {
  goal: MemberGoal;
  results: GoalResult[];
  affiliateLink: () => Promise<string | null>;
  onMake: (request: CardRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, date } = useI18n();
  const withUnit = useWithUnit();
  const id = useId();
  const [resultId, setResultId] = useState(results[0]?.id ?? '');
  const [showName, setShowName] = useState(false);
  const [link, setLink] = useState('');
  // The link Whop gave, offered in the field: the member may change or clear it.
  const [found, setFound] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    affiliateLink().then(
      (url) => {
        if (!live || !url) return;
        setFound(url);
        setLink((current) => (current.trim() ? current : url));
      },
      // Without it, the member pastes theirs.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [affiliateLink]);

  const affiliate = parseAffiliateUrl(link.trim());
  const linkError = checked && affiliate === undefined ? t('card.affiliateInvalid') : null;
  const result = results.find((r) => r.id === resultId) ?? results[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (affiliate === undefined || !result) return;
    setBusy(true);
    setFailed(false);
    try {
      await onMake({ resultId: result.id, showName, affiliateUrl: affiliate });
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-4 rounded-xl bg-surface-2 p-3"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-result`} className="text-sm font-medium">
          {t('card.result')}
        </label>
        <select
          id={`${id}-result`}
          value={result?.id ?? ''}
          onChange={(event) => setResultId(event.target.value)}
          className={`${FIELD} w-full sm:w-96`}
        >
          {results.map((r) => (
            <option key={r.id} value={r.id}>
              {[
                withUnit(r.value, goal.unit),
                date(new Date(r.recordedAt)),
                ...(r.proof ? [t('space.proof.label')] : []),
              ].join(' · ')}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={showName}
          onChange={(event) => setShowName(event.target.checked)}
          aria-describedby={`${id}-name-hint`}
          className="mt-0.5 accent-accent"
        />
        <span>
          <span className="block font-medium">{t('card.showName')}</span>
          <span id={`${id}-name-hint`} className="block text-muted">
            {t('card.showNameHint')}
          </span>
        </span>
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-link`} className="text-sm font-medium">
          {t('card.affiliate')}
        </label>
        <input
          id={`${id}-link`}
          type="url"
          inputMode="url"
          autoComplete="off"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          aria-invalid={Boolean(linkError)}
          aria-describedby={`${id}-link-hint`}
          className={`${FIELD} w-full`}
        />
        <p id={`${id}-link-hint`} className={`text-sm ${linkError ? 'text-danger' : 'text-muted'}`}>
          {linkError ??
            (found && link.trim() === found ? t('card.affiliateFound') : t('card.affiliateHint'))}
        </p>
      </div>
      <p className="text-sm text-muted">{t('card.privacy')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={busy}
          icon={<IdCard aria-hidden="true" className="size-4" />}
        >
          {t('card.make')}
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
          icon={<X aria-hidden="true" className="size-4" />}
        >
          {t('common.cancel')}
        </Button>
        {failed ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t('common.failed')}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A card drawn in this browser: null while it is drawn, then its image as a PNG `data:` address
 * (null when the browser cannot draw).
 */
export function useCardImage(card: TestimonialCard): { url: string | null } | null {
  const i18n = useI18n();
  const content = useMemo(() => cardContent(card, i18n), [card, i18n]);
  // The image of `content`, once drawn.
  const [image, setImage] = useState<{ content: CardContent; url: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void renderCard(content).then((url) => {
      if (live) setImage({ content, url });
    });
    return () => {
      live = false;
    };
  }, [content]);
  return image && image.content === content ? image : null;
}

/** The image of a card, as `useCardImage` draws it: while drawing, drawn, or not drawable. */
export function CardPicture({
  card,
  drawn,
  className = 'max-w-xs',
}: {
  card: TestimonialCard;
  drawn: { url: string | null } | null;
  className?: string;
}) {
  const { t, percent } = useI18n();
  if (drawn === null) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-accent" />
        {t('card.drawing')}
      </p>
    );
  }
  if (!drawn.url) return <Notice tone="info">{t('card.noImage')}</Notice>;
  return (
    <img
      src={drawn.url}
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      alt={t('card.alt', {
        goal: card.display.goal,
        percent: percent(card.display.progress / 100),
      })}
      className={`h-auto w-full rounded-xl border border-line shadow-card ${className}`}
    />
  );
}

/** A card: its image to download, its page's link to copy or open, and taking it down. */
function CardView({
  card,
  whopAppId,
  trial,
  onRemove,
}: {
  card: TestimonialCard;
  whopAppId: string | null;
  trial: boolean;
  onRemove: () => Promise<void>;
}) {
  const { t } = useI18n();
  const drawn = useCardImage(card);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="space-y-3">
      <CardPicture card={card} drawn={drawn} />
      <div className="flex flex-wrap items-center gap-2">
        {drawn?.url ? (
          <a
            href={drawn.url}
            download={t('card.file', { day: card.display.day })}
            className={buttonClass('primary', 'sm')}
          >
            <Download aria-hidden="true" className="size-4" />
            {t('card.download')}
          </a>
        ) : null}
        <Button
          variant="secondary"
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
        {trial ? null : (
          <PagePreviewButton url={card.url} goal={card.display.goal} whopAppId={whopAppId} />
        )}
        <ConfirmButton
          label={t('card.remove')}
          confirmLabel={t('card.removeConfirm')}
          icon={<Trash2 aria-hidden="true" className="size-4" />}
          run={onRemove}
        />
      </div>
      <p role="status" className="text-sm">
        {copy === 'copied' ? (
          <span className="text-accent">{t('card.copied')}</span>
        ) : copy === 'failed' ? (
          <span className="text-warning">{t('card.copyFailed')}</span>
        ) : null}
      </p>
      <p className="break-all text-sm text-muted select-all">{card.url}</p>
      {drawn?.url ? <p className="text-xs text-muted">{t('card.saveHint')}</p> : null}
    </div>
  );
}

/** The member's other cards online, to see one of them. */
function CardList({
  cards,
  onShow,
}: {
  cards: TestimonialCard[];
  onShow: (proofId: string) => void;
}) {
  const { t, date } = useI18n();
  const withUnit = useWithUnit();
  return (
    <ul className="divide-y divide-line text-sm">
      {cards.map((card) => (
        <li
          key={card.proofId}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5"
        >
          <span className="min-w-0">
            <span className="font-medium">{card.display.goal}</span>
            <span className="text-muted">
              {` · ${withUnit(card.display.value, card.display.unit)} · ${date(
                new Date(`${card.display.day}T12:00:00`),
              )}`}
            </span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => onShow(card.proofId)}>
            {t('card.show')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
