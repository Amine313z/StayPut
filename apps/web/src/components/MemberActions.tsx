import {
  CREATOR_NOTE_LIMITS,
  creatorNote,
  type ActionSettingsView,
  type CreatorNoteSent,
  type CreatorOfferKind,
  type CreatorOfferMade,
  type MemberRow,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { BellOff, Check, Gift, MessageSquareText, PauseCircle, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError, postJson, useApi } from '../api';
import { useI18n } from '../i18n';
import { ActionButton } from '../ui/ActionButton';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IconTip } from '../ui/IconTip';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { FIELD } from './SettingsParts';

/** Why the Worker refused an offer (create_creator_offer), in the creator's words. */
const REFUSALS: Readonly<Record<string, MessageKey>> = {
  do_not_contact: 'dash.act.neverContact',
  no_membership: 'dash.act.noMembership',
  offer_open: 'dash.offer.open',
  too_many_notes: 'dash.note.tooMany',
  already_decided: 'dash.pause.alreadyApplied',
  expired: 'dash.pause.expired',
};

/** What went wrong, in words the creator can act on. */
export function failureText(error: unknown, t: (key: MessageKey) => string): string {
  if (!(error instanceof ApiError)) return t('common.failed');
  if (error.code === 'conflict') return t(REFUSALS[error.message] ?? 'error.conflict');
  if (error.code === 'forbidden') return t('error.forbidden.creator');
  return t(`error.${error.code}`);
}

/**
 * What the creator can do for one member from the dashboard: write to them in their own words
 * (sent word for word in the support chat, now or after the quiet hours), give them a discount
 * or propose a pause (confirmed first: it gives something). Each says how it went in a toast; an offer stays marked
 * on the row. A member on the « never contact » list gets nothing, said as such; a member without
 * a paid membership can only be written to.
 */
export function MemberActions({
  member,
  api,
  testMode,
  offers = true,
  wide = false,
  compact = false,
  onDone,
}: {
  member: MemberRow;
  api: string;
  testMode: boolean;
  /** Pause and Offer beside Message (a newcomer is only welcomed). */
  offers?: boolean;
  /** Pause and Offer say their words whatever the room (a member's drawer). */
  wide?: boolean;
  /** Icons only, each named over it on hover and focus (the dashboard's « Needs attention »). */
  compact?: boolean;
  /** Something was queued: the figures and the feed may have changed. */
  onDone: () => void;
}) {
  const { t, relative } = useI18n();
  const toast = useToast();
  const [writing, setWriting] = useState(false);
  const [asking, setAsking] = useState<CreatorOfferKind | null>(null);
  const [offered, setOffered] = useState<CreatorOfferKind | null>(null);
  const name = member.name ?? t('members.unnamed');
  if (member.doNotContact && compact) {
    return (
      <IconTip label={t('dash.act.never')}>
        <span className="flex size-8 items-center justify-center text-subtle">
          <BellOff aria-hidden="true" className="size-4" />
          <span className="sr-only">{t('dash.act.neverContact')}</span>
        </span>
      </IconTip>
    );
  }
  if (member.doNotContact) {
    return (
      <span title={t('dash.act.neverContact')}>
        <Badge icon={<BellOff aria-hidden="true" className="size-3" />}>
          {t('dash.act.never')}
        </Badge>
      </span>
    );
  }
  const paying = offers && (member.membership?.price ?? 0) > 0;
  const note = writing ? (
    <NoteDialog
      name={name}
      api={api}
      memberId={member.id}
      testMode={testMode}
      onClose={() => setWriting(false)}
      onSent={(sent) => {
        setWriting(false);
        // What Whop did with it, as the Worker read it back: never « sent » before Whop took it.
        const when = relative(new Date(sent.sendAt));
        toast(
          sent.status === 'sent'
            ? { title: t('dash.note.sent.now', { name }) }
            : sent.status === 'simulated'
              ? { title: t('dash.note.sent.test', { name }), body: t('dash.note.how.test') }
              : sent.status === 'scheduled'
                ? {
                    title: t('dash.note.sent.later', { name, when }),
                    body: t('dash.note.sent.laterBody'),
                  }
                : sent.status === 'retrying'
                  ? {
                      tone: 'error',
                      title: t('dash.note.retrying', { name }),
                      body: t('dash.note.retryingBody', { when }),
                    }
                  : {
                      tone: 'error',
                      title: t(
                        sent.reason === 'permission' ? 'dash.note.permission' : 'dash.note.refused',
                        { name },
                      ),
                    },
        );
        onDone();
      }}
    />
  ) : null;
  const dialog = asking ? (
    <OfferDialog
      kind={asking}
      name={name}
      api={api}
      memberId={member.id}
      onClose={() => setAsking(null)}
      onMade={(made) => {
        setAsking(null);
        setOffered(made.kind);
        toast({
          title: t(
            made.kind === 'pause_offer' ? 'dash.toast.offered.pause' : 'dash.toast.offered.promo',
            { name },
          ),
          body: t(
            made.kind === 'pause_offer'
              ? 'dash.toast.offered.pauseBody'
              : 'dash.toast.offered.promoBody',
          ),
        });
        onDone();
      }}
    />
  ) : null;
  if (compact) {
    // Square ghosts, their words in the tooltip over them and in their names.
    const square = 'w-8 px-0';
    return (
      <div className="flex items-center gap-1">
        <IconTip label={t('dash.act.message')}>
          <Button
            variant="ghost"
            size="sm"
            className={square}
            onClick={() => setWriting(true)}
            aria-label={t('dash.act.messageLabel', { name })}
            icon={<MessageSquareText aria-hidden="true" className="size-4" />}
          />
        </IconTip>
        {!paying ? null : offered ? (
          <IconTip
            label={t(offered === 'pause_offer' ? 'dash.act.pauseOffered' : 'dash.act.offerMade')}
          >
            <span className="flex size-8 items-center justify-center text-accent">
              <Check aria-hidden="true" className="size-4" />
              <span className="sr-only">
                {t(offered === 'pause_offer' ? 'dash.act.pauseOffered' : 'dash.act.offerMade')}
              </span>
            </span>
          </IconTip>
        ) : (
          <>
            <IconTip label={t('dash.act.pause')}>
              <Button
                variant="ghost"
                size="sm"
                className={square}
                onClick={() => setAsking('pause_offer')}
                aria-label={t('dash.act.pauseLabel', { name })}
                icon={<PauseCircle aria-hidden="true" className="size-4" />}
              />
            </IconTip>
            <IconTip label={t('dash.act.offer')}>
              <Button
                variant="ghost"
                size="sm"
                className={square}
                onClick={() => setAsking('promo_offer')}
                aria-label={t('dash.act.offerLabel', { name })}
                icon={<Gift aria-hidden="true" className="size-4" />}
              />
            </IconTip>
          </>
        )}
        {note}
        {dialog}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setWriting(true)}
        aria-label={t('dash.act.messageLabel', { name })}
        icon={<MessageSquareText aria-hidden="true" className="size-4" />}
      >
        {t('dash.act.message')}
      </Button>
      {!paying ? null : offered ? (
        <Badge tone="accent" icon={<Check aria-hidden="true" className="size-3" />}>
          {t(offered === 'pause_offer' ? 'dash.act.pauseOffered' : 'dash.act.offerMade')}
        </Badge>
      ) : (
        <>
          {/* Ghosts all three (brief v3 §6.2); their words when the list has room, else the icon. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAsking('pause_offer')}
            aria-label={t('dash.act.pauseLabel', { name })}
            title={t('dash.act.pauseLabel', { name })}
            icon={<PauseCircle aria-hidden="true" className="size-4" />}
          >
            <span className={wide ? '' : 'sr-only @2xl/list:not-sr-only'}>
              {t('dash.act.pause')}
            </span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAsking('promo_offer')}
            aria-label={t('dash.act.offerLabel', { name })}
            title={t('dash.act.offerLabel', { name })}
            icon={<Gift aria-hidden="true" className="size-4" />}
          >
            <span className={wide ? '' : 'sr-only @2xl/list:not-sr-only'}>
              {t('dash.act.offer')}
            </span>
          </Button>
        </>
      )}
      {note}
      {dialog}
    </div>
  );
}

/**
 * The creator's own message to one member: a title and a text, within Whop's limits, sent word
 * for word as a notification with their picture (create_creator_note). Test mode keeps it in the
 * history without sending it, and says so before it is written.
 */
function NoteDialog({
  name,
  api,
  memberId,
  testMode,
  onClose,
  onSent,
}: {
  name: string;
  api: string;
  memberId: string;
  testMode: boolean;
  onClose: () => void;
  onSent: (sent: CreatorNoteSent) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const ids = useId();
  const [title, setTitle] = useState(() => t('dash.note.titleDefault'));
  const [body, setBody] = useState('');
  const note = creatorNote({ title, body });
  return (
    <Dialog title={t('dash.note.title', { name })} onClose={onClose}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-title`} className="text-sm font-medium">
            {t('dash.note.subject')}
          </label>
          <input
            id={`${ids}-title`}
            type="text"
            maxLength={CREATOR_NOTE_LIMITS.title}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={`${FIELD} w-full`}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-body`} className="text-sm font-medium">
            {t('dash.note.body')}
          </label>
          <textarea
            id={`${ids}-body`}
            rows={5}
            maxLength={CREATOR_NOTE_LIMITS.body}
            value={body}
            placeholder={t('dash.note.placeholder')}
            onChange={(event) => setBody(event.target.value)}
            className={`${FIELD} w-full resize-y`}
          />
          <p className="text-right text-xs text-subtle tabular-nums">
            {t('dash.note.count', { count: body.length, max: CREATOR_NOTE_LIMITS.body })}
          </p>
        </div>
        <p className="text-sm text-muted">{t(testMode ? 'dash.note.how.test' : 'dash.note.how')}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <ActionButton
            disabled={!note}
            run={async () => {
              onSent(
                await postJson<CreatorNoteSent>(
                  `${api}/members/${encodeURIComponent(memberId)}/note`,
                  note,
                ),
              );
            }}
            onError={(error) => toast({ tone: 'error', title: failureText(error, t) })}
            icon={<Send aria-hidden="true" className="size-4" />}
          >
            {t('dash.note.send')}
          </ActionButton>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Before an offer leaves: exactly what the member gets (the creator's offer settings), and how
 * it works: a discount is applied when its message leaves, a pause waits for the member's yes in
 * the support chat (0046). Confirmed, it goes through the guardrails like every action.
 */
function OfferDialog({
  kind,
  name,
  api,
  memberId,
  onClose,
  onMade,
}: {
  kind: CreatorOfferKind;
  name: string;
  api: string;
  memberId: string;
  onClose: () => void;
  onMade: (made: CreatorOfferMade) => void;
}) {
  const { t, percent } = useI18n();
  const toast = useToast();
  const settings = useApi<ActionSettingsView>(`${api}/settings/actions`);
  const offers = settings.state.status === 'ready' ? settings.state.data.offers : null;
  const pause = kind === 'pause_offer';
  return (
    <Dialog
      title={t(pause ? 'dash.offer.pause.title' : 'dash.offer.promo.title', { name })}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            {pause ? (
              <PauseCircle aria-hidden="true" className="size-4" />
            ) : (
              <Gift aria-hidden="true" className="size-4" />
            )}
          </span>
          {offers ? (
            <p className="font-medium">
              {pause
                ? t('dash.offer.pause.terms', { days: offers.pauseDays })
                : t('dash.offer.promo.terms', {
                    percent: percent(offers.promoPercent / 100),
                    months: offers.promoMonths,
                  })}
            </p>
          ) : settings.state.status === 'loading' ? (
            <Skeleton className="mt-2 h-4 w-64" />
          ) : null}
        </div>
        <p className="text-sm text-muted">
          {t(pause ? 'dash.offer.how.pause' : 'dash.offer.how.promo')}
        </p>
        <p className="text-xs text-subtle">{t('dash.offer.settings')}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <ActionButton
            run={async () => {
              onMade(
                await postJson<CreatorOfferMade>(
                  `${api}/members/${encodeURIComponent(memberId)}/offer`,
                  { kind },
                ),
              );
            }}
            onError={(error) => toast({ tone: 'error', title: failureText(error, t) })}
            icon={
              pause ? (
                <PauseCircle aria-hidden="true" className="size-4" />
              ) : (
                <Gift aria-hidden="true" className="size-4" />
              )
            }
          >
            {t(pause ? 'dash.offer.confirm.pause' : 'dash.offer.confirm.promo')}
          </ActionButton>
        </div>
      </div>
    </Dialog>
  );
}
