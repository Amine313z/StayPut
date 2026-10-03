import type {
  ActionSettingsView,
  CreatorMessagesResult,
  CreatorOfferKind,
  CreatorOfferMade,
  MemberRow,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import { BellOff, Check, Gift, MessageSquareText, PauseCircle } from 'lucide-react';
import { useState } from 'react';
import { ApiError, postJson, useApi } from '../api';
import { useI18n } from '../i18n';
import { ActionButton } from '../ui/ActionButton';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IconTip } from '../ui/IconTip';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';

/** Why the Worker refused an offer (create_creator_offer), in the creator's words. */
const REFUSALS: Readonly<Record<string, MessageKey>> = {
  do_not_contact: 'dash.act.neverContact',
  no_membership: 'dash.act.noMembership',
  offer_open: 'error.conflict',
};

/** What went wrong, in words the creator can act on. */
export function failureText(error: unknown, t: (key: MessageKey) => string): string {
  if (!(error instanceof ApiError)) return t('common.failed');
  if (error.code === 'conflict') return t(REFUSALS[error.message] ?? 'error.conflict');
  if (error.code === 'forbidden') return t('error.forbidden.creator');
  return t(`error.${error.code}`);
}

/**
 * What the creator can do for one member from the dashboard: write to them (one click, through
 * the guardrails), offer them a pause or a discount (confirmed first: it gives something). Each
 * says how it went in a toast; what is done stays marked on the row. A member on the « never
 * contact » list gets nothing, said as such; a member without a paid membership can only be
 * written to.
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
  const { t, plural } = useI18n();
  const toast = useToast();
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
  const message = async () => {
    const result = await postJson<CreatorMessagesResult>(`${api}/members/message`, {
      memberIds: [member.id],
    });
    toast(
      result.queued > 0
        ? {
            title: plural('dash.toast.messaged', result.queued),
            body: t(testMode ? 'dash.toast.simulated' : 'dash.toast.messaged.body'),
          }
        : { title: t('dash.toast.nothingNew') },
    );
    onDone();
  };
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
          body: t('dash.toast.offered.body'),
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
          <ActionButton
            variant="ghost"
            size="sm"
            className={square}
            stayDone
            run={message}
            onError={(error) => toast({ tone: 'error', title: failureText(error, t) })}
            icon={<MessageSquareText aria-hidden="true" className="size-4" />}
            doneLabel={<span className="sr-only">{t('dash.act.queued')}</span>}
            aria-label={t('dash.act.messageLabel', { name })}
          >
            <span className="sr-only">{t('dash.act.message')}</span>
          </ActionButton>
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
        {dialog}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ActionButton
        variant="secondary"
        size="sm"
        stayDone
        run={message}
        onError={(error) => toast({ tone: 'error', title: failureText(error, t) })}
        icon={<MessageSquareText aria-hidden="true" className="size-4" />}
        doneLabel={t('dash.act.queued')}
        aria-label={t('dash.act.messageLabel', { name })}
      >
        {t('dash.act.message')}
      </ActionButton>
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
      {dialog}
    </div>
  );
}

/**
 * Before an offer leaves: exactly what the member gets (the creator's offer settings), and how
 * it works. Confirmed, it goes through the guardrails like every action.
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
        <p className="text-sm text-muted">{t('dash.offer.how')}</p>
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
