import {
  EXIT_REASONS,
  exitOffer,
  type AffiliateLinkView,
  type AlumniReturn,
  type ExitOffer,
  type ExitReason,
  type MemberRetentionView,
  type OfferResult,
} from '@stayput/core';
import {
  CalendarClock,
  CalendarPlus,
  Check,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Copy,
  CreditCard,
  Eye,
  FlaskConical,
  Gift,
  GraduationCap,
  HeartHandshake,
  Hourglass,
  Percent,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { postJson, useApi, useReloadOnReturn } from '../api';
import { REASON_LABELS } from '../exit-reasons';
import { useI18n } from '../i18n';
import { Badge, Notice } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ExternalButton } from '../ui/ExternalLink';

type Departure = NonNullable<MemberRetentionView['departure']>;
type Payment = NonNullable<MemberRetentionView['payment']>;

/**
 * The member's own subscription (SPEC Phase 4): the payment that needs them, with the button to
 * settle it, and the cancellation they scheduled, with the one-click survey and the offer that
 * answers their reason. The team sees a preview instead, where nothing is recorded.
 */
export function MemberRetention({ api }: { api: string }) {
  const { state, reload } = useApi<MemberRetentionView>(`${api}/retention`);
  // Back from paying in another tab, or from Whop: the cards show where things stand.
  useReloadOnReturn(reload);
  const loaded = state.status === 'ready' ? state.data : undefined;
  // What an answer returned, until the next reading replaces it.
  const [answer, setAnswer] = useState<{
    base: MemberRetentionView | undefined;
    view: MemberRetentionView;
  } | null>(null);
  const view = answer && answer.base === loaded ? answer.view : loaded;
  if (!view) return null;
  if (view.preview) {
    return (
      <Preview
        offers={view.preview.offers}
        testMode={view.preview.testMode}
        alumniUrl={view.alumniUrl}
        whopAppId={view.whopAppId}
      />
    );
  }
  return (
    <>
      {view.payment ? <PaymentCard payment={view.payment} whopAppId={view.whopAppId} /> : null}
      {view.departure ? (
        <DepartureCard
          api={api}
          departure={view.departure}
          alumniUrl={view.alumniUrl}
          whopAppId={view.whopAppId}
          onAnswer={(next) => setAnswer({ base: loaded, view: next })}
        />
      ) : null}
      {view.alumni ? <AlumniReturnCard alumni={view.alumni} whopAppId={view.whopAppId} /> : null}
    </>
  );
}

/**
 * A former member in the Alumni space (SPEC 5.9): the community's news reach them here, with now
 * and then a return code; the code while it holds, and the way back to the offer they left.
 */
function AlumniReturnCard({
  alumni,
  whopAppId,
}: {
  alumni: AlumniReturn;
  whopAppId: string | null;
}) {
  const { t, plural, percent, date } = useI18n();
  const code = alumni.code;
  return (
    <Card
      icon={<GraduationCap aria-hidden="true" className="size-4 text-accent" />}
      title={t('member.alumniSpace.title')}
      description={t('member.alumniSpace.body')}
    >
      <div className="space-y-4">
        {code ? (
          <Notice tone="accent" icon={<Percent aria-hidden="true" className="size-4" />}>
            <div className="space-y-2">
              <p className="font-medium">
                {plural('member.offer.promo.title', code.months, {
                  discount: percent(code.percentOff / 100),
                })}
              </p>
              <PromoCode code={code.code} until={date(new Date(code.expiresAt))} />
              <p className="text-muted">{t('member.alumniSpace.codeHint')}</p>
            </div>
          </Notice>
        ) : null}
        {alumni.returnUrl ? (
          <ExternalButton
            href={alumni.returnUrl}
            whopAppId={whopAppId}
            icon={<RotateCcw aria-hidden="true" className="size-4" />}
          >
            {t('member.alumniSpace.return')}
          </ExternalButton>
        ) : null}
      </div>
    </Card>
  );
}

/** A payment waiting for the bank's check, or one that failed: the button to settle it. */
function PaymentCard({ payment, whopAppId }: { payment: Payment; whopAppId: string | null }) {
  const { t, currency } = useI18n();
  const failed = payment.kind === 'failed';
  const amount = currency(payment.amount, payment.currency);
  return (
    <Card
      icon={<CreditCard aria-hidden="true" className="size-4 text-warning" />}
      title={t('member.payment.title')}
      description={t(failed ? 'member.payment.failed' : 'member.payment.actionRequired', {
        amount,
      })}
    >
      {payment.url ? (
        <ExternalButton
          href={payment.url}
          whopAppId={whopAppId}
          icon={<CreditCard aria-hidden="true" className="size-4" />}
        >
          {t(failed ? 'member.payment.update' : 'member.payment.confirm')}
        </ExternalButton>
      ) : (
        <p className="text-sm text-muted">{t('member.payment.noLink')}</p>
      )}
    </Card>
  );
}

/** The cancellation the member scheduled: why, the offer for it, and what came of it. */
function DepartureCard({
  api,
  departure,
  alumniUrl,
  whopAppId,
  onAnswer,
}: {
  api: string;
  departure: Departure;
  alumniUrl: string | null;
  whopAppId: string | null;
  onAnswer: (view: MemberRetentionView) => void;
}) {
  const { t, date } = useI18n();
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const send = async (step: string, path: 'survey' | 'offer', body: unknown) => {
    setBusy(step);
    setFailed(false);
    try {
      onAnswer(await postJson<MemberRetentionView>(`${api}/retention/${path}`, body));
      setChanging(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      icon={<CalendarClock aria-hidden="true" className="size-4" />}
      title={t('member.leaving.title')}
      description={
        departure.endsAt
          ? t('member.leaving.endsAt', { date: date(new Date(departure.endsAt)) })
          : undefined
      }
    >
      <div className="space-y-4">
        {departure.outcome === 'pending' ? (
          <SurveyStep
            reason={changing ? null : departure.reason}
            offer={departure.offer}
            busy={busy}
            onReason={(reason) => void send(reason, 'survey', { reason })}
            onDecide={(accept, keep) =>
              void send(accept ? 'accept' : 'decline', 'offer', { accept, keep })
            }
            onChange={() => setChanging(true)}
          />
        ) : departure.outcome === 'declined' || !departure.offer ? (
          <p className="text-sm">{t('member.leaving.declined')}</p>
        ) : (
          <OfferOutcome api={api} offer={departure.offer} result={departure.result} />
        )}
        {failed ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t('common.failed')}
          </p>
        ) : null}
        {/* Leaving all the same: the Alumni keeps them in touch (not once they kept it). */}
        {alumniUrl && !departure.result?.kept ? (
          <AlumniInvite url={alumniUrl} whopAppId={whopAppId} />
        ) : null}
      </div>
    </Card>
  );
}

/** The free Alumni offer (SPEC 5.9): news of the community, and an offer to come back. */
function AlumniInvite({ url, whopAppId }: { url: string; whopAppId: string | null }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="flex items-center gap-2 font-medium">
        <GraduationCap aria-hidden="true" className="size-4 text-accent" />
        {t('member.alumni.title')}
      </p>
      <p className="text-sm text-muted">{t('member.alumni.body')}</p>
      <ExternalButton href={url} whopAppId={whopAppId} variant="secondary" size="sm">
        {t('member.alumni.join')}
      </ExternalButton>
    </div>
  );
}

/**
 * The survey while it waits for the member: the five reasons, then the offer for theirs (or
 * thanks, when no offer can be made), with their answer to change.
 */
function SurveyStep({
  reason,
  offer,
  busy,
  onReason,
  onDecide,
  onChange,
}: {
  reason: ExitReason | null;
  offer: ExitOffer | null;
  busy: string | null;
  onReason: (reason: ExitReason) => void;
  onDecide: (accept: boolean, keep: boolean) => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const legend = useId();
  if (!reason) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{t('member.leaving.ask')}</p>
        <div role="group" aria-labelledby={legend} className="grid gap-2 sm:grid-cols-2">
          <p id={legend} className="sr-only">
            {t('member.leaving.reasons')}
          </p>
          {EXIT_REASONS.map((value) => (
            <Button
              key={value}
              variant="secondary"
              className="justify-start whitespace-normal text-start"
              loading={busy === value}
              disabled={busy !== null}
              onClick={() => onReason(value)}
            >
              {t(REASON_LABELS[value])}
            </Button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <span>{t('member.leaving.yourReason', { reason: t(REASON_LABELS[reason]) })}</span>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw aria-hidden="true" className="size-3.5" />}
          disabled={busy !== null}
          onClick={onChange}
        >
          {t('member.leaving.change')}
        </Button>
      </div>
      {offer ? (
        <OfferChoice key={offer.type} offer={offer} busy={busy} onDecide={onDecide} />
      ) : (
        <p className="text-sm">{t('member.leaving.thanks')}</p>
      )}
    </div>
  );
}

/** The offer, the member's consent to keep their membership when it matters, and the choice. */
function OfferChoice({
  offer,
  busy,
  onDecide,
}: {
  offer: ExitOffer;
  busy: string | null;
  onDecide: (accept: boolean, keep: boolean) => void;
}) {
  const { t } = useI18n();
  const [keep, setKeep] = useState(false);
  const id = useId();
  const { title, body, accept, Icon } = useOfferText(offer);
  const required = offer.keep === 'required';
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-accent-soft px-4 py-3">
        <p className="flex items-start gap-2 font-semibold">
          <Icon aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent" />
          {title}
        </p>
        <p className="mt-1 text-sm">{body}</p>
      </div>
      {offer.keep !== 'never' ? (
        <div className="flex items-start gap-3">
          <input
            id={id}
            type="checkbox"
            checked={keep}
            aria-describedby={required ? `${id}-hint` : undefined}
            onChange={(event) => setKeep(event.target.checked)}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          <div>
            <label htmlFor={id} className="text-sm font-medium">
              {t(required ? 'member.offer.keep.required' : 'member.offer.keep.optional')}
            </label>
            {required ? (
              <p id={`${id}-hint`} className="text-sm text-muted">
                {t('member.offer.keep.hint')}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon={<Check aria-hidden="true" className="size-4" />}
          loading={busy === 'accept'}
          disabled={busy !== null || (required && !keep)}
          onClick={() => onDecide(true, keep)}
        >
          {accept}
        </Button>
        <Button
          variant="ghost"
          loading={busy === 'decline'}
          disabled={busy !== null}
          onClick={() => onDecide(false, false)}
        >
          {t('member.offer.decline')}
        </Button>
      </div>
    </div>
  );
}

/** What an offer says, in the member's language and with the creator's numbers. */
function useOfferText(offer: ExitOffer): {
  title: string;
  body: string;
  accept: string;
  Icon: LucideIcon;
} {
  const { t, plural, percent } = useI18n();
  switch (offer.type) {
    case 'pause_offer':
      return {
        title: t('member.offer.pause.title', { days: offer.days ?? 0 }),
        body: t('member.offer.pause.body', { days: offer.days ?? 0 }),
        accept: t('member.offer.pause.accept'),
        Icon: CirclePause,
      };
    case 'promo_offer':
      return {
        title: plural('member.offer.promo.title', offer.months ?? 1, {
          discount: percent((offer.percentOff ?? 0) / 100),
        }),
        body: t('member.offer.promo.body', { days: offer.validDays ?? 0 }),
        accept: t('member.offer.promo.accept'),
        Icon: Percent,
      };
    case 'extend_offer':
      return {
        title: plural('member.offer.extend.title', offer.days ?? 0),
        body: t('member.offer.extend.body'),
        accept: t('member.offer.extend.accept'),
        Icon: CalendarPlus,
      };
    case 'coaching_offer':
      return {
        title: t('member.offer.coaching.title'),
        // The creator's own words when they wrote some.
        body: offer.message ?? t('member.offer.coaching.body'),
        accept: t('member.offer.coaching.accept'),
        Icon: HeartHandshake,
      };
    case 'affiliate_invite':
      return {
        title: t('member.offer.affiliate.title'),
        body: t('member.offer.affiliate.body'),
        accept: t('member.offer.affiliate.accept'),
        Icon: Gift,
      };
  }
}

/** What came of the offer the member accepted. */
function OfferOutcome({
  api,
  offer,
  result,
}: {
  api: string;
  offer: ExitOffer;
  result: OfferResult | null;
}) {
  const { t, plural, date } = useI18n();
  if (!result || result.status === 'waiting') {
    return (
      <Notice tone="info" icon={<Hourglass aria-hidden="true" className="size-4" />}>
        {t('member.result.waiting')}
      </Notice>
    );
  }
  if (result.status === 'failed') {
    return (
      <Notice tone="warning" icon={<CircleAlert aria-hidden="true" className="size-4" />}>
        {t('member.result.failed')}
      </Notice>
    );
  }
  if (result.status === 'cancelled') {
    return <p className="text-sm text-muted">{t('member.result.cancelled')}</p>;
  }
  const when = (value: string | undefined) => (value ? date(new Date(value)) : '');
  let applied: ReactNode;
  switch (offer.type) {
    case 'pause_offer':
      applied = t('member.result.pause', { date: when(result.resumesAt) });
      break;
    case 'promo_offer':
      applied = result.promoCode ? (
        <PromoCode code={result.promoCode} until={when(result.expiresAt)} />
      ) : null;
      break;
    case 'extend_offer':
      applied = plural('member.result.extend', offer.days ?? 0);
      break;
    case 'coaching_offer':
      applied = t('member.result.coaching');
      break;
    case 'affiliate_invite':
      applied = <AffiliateLink api={api} />;
      break;
  }
  return (
    <Notice tone="accent" icon={<CircleCheck aria-hidden="true" className="size-4" />}>
      <div className="space-y-1">
        {applied ? <div>{applied}</div> : null}
        {result.kept ? <p>{t('member.result.kept')}</p> : null}
      </div>
    </Notice>
  );
}

/**
 * The affiliate invitation accepted: the member's own link when Whop has one (SPEC 5.6), to
 * copy; otherwise the creator sends the details.
 */
function AffiliateLink({ api }: { api: string }) {
  const { t } = useI18n();
  const { state } = useApi<AffiliateLinkView>(`${api}/space/affiliate`);
  const [copied, setCopied] = useState(false);
  const url = state.status === 'ready' ? state.data.url : null;
  if (!url) return <p>{t('member.result.affiliate')}</p>;
  return (
    <div className="space-y-2">
      <p>{t('member.result.affiliateLink')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-lg border border-line bg-surface px-3 py-1.5 break-all select-all">
          {url}
        </code>
        <Button
          variant="secondary"
          size="sm"
          icon={<Copy aria-hidden="true" className="size-4" />}
          onClick={() => void copy(url).then(setCopied)}
        >
          {t(copied ? 'member.result.copied' : 'member.result.copy')}
        </Button>
      </div>
    </div>
  );
}

/** The single-use code, to copy (or select, where the browser keeps the clipboard closed). */
function PromoCode({ code, until }: { code: string; until: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p>{t('member.result.code')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="tabular rounded-lg border border-line bg-surface px-3 py-1.5 text-base font-semibold tracking-wider select-all">
          {code}
        </code>
        <Button
          variant="secondary"
          size="sm"
          icon={<Copy aria-hidden="true" className="size-4" />}
          onClick={() => void copy(code).then(setCopied)}
        >
          {t(copied ? 'member.result.copied' : 'member.result.copy')}
        </Button>
      </div>
      {until ? <p className="text-muted">{t('member.result.codeUntil', { date: until })}</p> : null}
    </div>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The team's preview: the survey as a member sees it, with the creator's offers. Every reason can
 * be tried; nothing is recorded, nothing applied.
 */
function Preview({
  offers,
  testMode,
  alumniUrl,
  whopAppId,
}: {
  offers: NonNullable<MemberRetentionView['preview']>['offers'];
  testMode: boolean;
  alumniUrl: string | null;
  whopAppId: string | null;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState<ExitReason | null>(null);
  const [decided, setDecided] = useState(false);
  const again = () => {
    setReason(null);
    setDecided(false);
  };
  return (
    <Card
      icon={<Eye aria-hidden="true" className="size-4" />}
      title={t('member.preview.title')}
      description={t('member.preview.body')}
      actions={<Badge tone="info">{t('member.preview.badge')}</Badge>}
    >
      <div className="space-y-4">
        {testMode ? (
          <Notice tone="warning" icon={<FlaskConical aria-hidden="true" className="size-4" />}>
            {t('member.preview.testMode')}
          </Notice>
        ) : null}
        <div className="space-y-4 rounded-2xl border border-dashed border-line p-4">
          <p className="flex items-center gap-2 font-semibold">
            <CalendarClock aria-hidden="true" className="size-4 text-muted" />
            {t('member.leaving.title')}
          </p>
          {decided ? (
            <div className="space-y-3">
              <Notice tone="info" icon={<Eye aria-hidden="true" className="size-4" />}>
                {t('member.preview.done')}
              </Notice>
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCcw aria-hidden="true" className="size-4" />}
                onClick={again}
              >
                {t('member.preview.again')}
              </Button>
            </div>
          ) : (
            <SurveyStep
              reason={reason}
              offer={reason ? exitOffer(reason, offers) : null}
              busy={null}
              onReason={setReason}
              onDecide={() => setDecided(true)}
              onChange={again}
            />
          )}
          {alumniUrl ? <AlumniInvite url={alumniUrl} whopAppId={whopAppId} /> : null}
        </div>
        <p className="text-sm text-muted">{t('member.preview.payment')}</p>
      </div>
    </Card>
  );
}
