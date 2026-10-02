import {
  ACTION_VIEWS,
  type ActionOffer,
  type ActionRow,
  type ActionStatus,
  type ActionType,
  type ActionView,
  type ActionsPage,
  type BlockReason,
} from '@stayput/core';
import type { MessageKey } from '@stayput/i18n';
import {
  CalendarClock,
  CalendarPlus,
  Check,
  CheckCheck,
  CirclePause,
  CreditCard,
  FlaskConical,
  Gift,
  HeartHandshake,
  History,
  Inbox,
  LogOut,
  Mail,
  MessageCircleHeart,
  OctagonPause,
  OctagonX,
  Percent,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { postJson, useApi } from '../../api';
import { AlumniCard } from '../../components/AlumniCard';
import { ConfirmButton } from '../../components/ConfirmButton';
import { ErrorPanel, Loading } from '../../components/Status';
import { REASON_LABELS } from '../../exit-reasons';
import { useI18n } from '../../i18n';
import { Avatar } from '../../ui/Avatar';
import { Badge, Notice, type Tone } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { useCreatorData } from '../CreatorView';

/** The Worker passes approved actions through the guardrails after answering: read again then. */
const RELOAD_AFTER_MS = 3_000;

const VIEWS: Readonly<
  Record<ActionView, { label: MessageKey; empty: MessageKey; Icon: LucideIcon }>
> = {
  queue: { label: 'actions.view.queue', empty: 'actions.empty.queue', Icon: Inbox },
  scheduled: {
    label: 'actions.view.scheduled',
    empty: 'actions.empty.scheduled',
    Icon: CalendarClock,
  },
  history: { label: 'actions.view.history', empty: 'actions.empty.history', Icon: History },
};

const TYPES: Readonly<Record<ActionType, { label: MessageKey; Icon: LucideIcon }>> = {
  payment_retry: { label: 'actions.type.payment_retry', Icon: RefreshCw },
  payment_failed_notice: { label: 'actions.type.payment_failed_notice', Icon: CreditCard },
  payment_action_notice: { label: 'actions.type.payment_action_notice', Icon: ShieldCheck },
  exit_survey: { label: 'actions.type.exit_survey', Icon: LogOut },
  pause_offer: { label: 'actions.type.pause_offer', Icon: CirclePause },
  promo_offer: { label: 'actions.type.promo_offer', Icon: Percent },
  coaching_offer: { label: 'actions.type.coaching_offer', Icon: HeartHandshake },
  affiliate_invite: { label: 'actions.type.affiliate_invite', Icon: Gift },
  extend_offer: { label: 'actions.type.extend_offer', Icon: CalendarPlus },
  high_risk_message: { label: 'actions.type.high_risk_message', Icon: MessageCircleHeart },
  welcome_message: { label: 'actions.type.welcome_message', Icon: Sparkles },
  alumni_followup: { label: 'actions.type.alumni_followup', Icon: Mail },
};

const TRIGGERS: Readonly<Record<string, MessageKey>> = {
  payment_requires_action: 'actions.trigger.payment_requires_action',
  payment_failed: 'actions.trigger.payment_failed',
  cancel_at_period_end: 'actions.trigger.cancel_at_period_end',
  score_high: 'actions.trigger.score_high',
  activation_radar: 'actions.trigger.activation_radar',
  exit_survey: 'actions.trigger.exit_survey',
};

const STATUSES: Readonly<Record<ActionStatus, { label: MessageKey; tone: Tone }>> = {
  proposed: { label: 'actions.status.proposed', tone: 'info' },
  approved: { label: 'actions.status.approved', tone: 'info' },
  scheduled: { label: 'actions.status.scheduled', tone: 'info' },
  sent: { label: 'actions.status.sent', tone: 'accent' },
  simulated: { label: 'actions.status.simulated', tone: 'neutral' },
  failed: { label: 'actions.status.failed', tone: 'danger' },
  cancelled: { label: 'actions.status.cancelled', tone: 'neutral' },
  blocked_by_guardrail: { label: 'actions.status.blocked_by_guardrail', tone: 'warning' },
};

const BLOCKED: Readonly<Record<BlockReason, MessageKey>> = {
  global_kill_switch: 'actions.blocked.global_kill_switch',
  kill_switch: 'actions.blocked.kill_switch',
  do_not_contact: 'actions.blocked.do_not_contact',
  message_spacing: 'actions.blocked.message_spacing',
  monthly_message_cap: 'actions.blocked.monthly_message_cap',
  payment_retry_cap: 'actions.blocked.payment_retry_cap',
  promo_already_active: 'actions.blocked.promo_already_active',
  monthly_promo_cap: 'actions.blocked.monthly_promo_cap',
  free_days_cap: 'actions.blocked.free_days_cap',
};

const NOTES: Readonly<Record<string, MessageKey>> = {
  cancelled_by_creator: 'actions.note.cancelled_by_creator',
  member_left: 'actions.note.member_left',
  payment_no_longer_failed: 'actions.note.payment_no_longer_failed',
  payment_no_longer_waiting: 'actions.note.payment_no_longer_waiting',
  cancellation_withdrawn: 'actions.note.cancellation_withdrawn',
  whop_retries: 'actions.note.whop_retries',
  not_retryable: 'actions.note.not_retryable',
  membership_ended: 'actions.note.membership_ended',
  survey_answered: 'actions.note.survey_answered',
  member_returned: 'actions.note.member_returned',
  left_alumni: 'actions.note.left_alumni',
};

/**
 * What StayPut does for the members (SPEC Phase 4): the actions to approve in manual mode, each
 * with the message exactly as the member will read it; the scheduled ones; and what happened,
 * sent, simulated in test mode, blocked by a guardrail with the reason, cancelled or failed.
 */
export function ActionsTab() {
  const { t, number } = useI18n();
  const { api, root, integrations } = useCreatorData();
  const whopAppId =
    integrations.state.status === 'ready' ? integrations.state.data.whopAppId : null;
  const [params, setParams] = useSearchParams();
  const view = ACTION_VIEWS.find((v) => v === params.get('view')) ?? 'queue';
  const { state, retry, reload } = useApi<ActionsPage>(`${api}/actions?view=${view}`);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (later.current) clearTimeout(later.current);
    },
    [],
  );
  // Read now (the approval or the cancellation), and once more when the Worker is done with it.
  const changed = () => {
    reload();
    if (later.current) clearTimeout(later.current);
    later.current = setTimeout(reload, RELOAD_AFTER_MS);
  };

  const settingsLink = (
    <Link
      to={`${root}/settings`}
      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-accent hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <SlidersHorizontal aria-hidden="true" className="size-4" />
      {t('actions.settings')}
    </Link>
  );

  return (
    <div className="space-y-6">
      <Card
        icon={<Zap aria-hidden="true" className="size-4" />}
        title={t('actions.title')}
        description={t('actions.description')}
        actions={settingsLink}
      >
        {state.status === 'loading' ? (
          <Loading />
        ) : state.status === 'error' ? (
          <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {state.data.killSwitch ? (
                <Notice tone="danger" icon={<OctagonPause aria-hidden="true" className="size-4" />}>
                  {t('actions.killSwitch')}
                </Notice>
              ) : null}
              {state.data.dryRun ? (
                <Notice tone="info" icon={<FlaskConical aria-hidden="true" className="size-4" />}>
                  {t('actions.dryRun')}
                </Notice>
              ) : null}
              <p className="text-sm text-muted">
                {t(state.data.mode === 'auto' ? 'actions.mode.auto' : 'actions.mode.manual')}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div
                role="group"
                aria-label={t('actions.view.label')}
                className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1"
              >
                {ACTION_VIEWS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => {
                      const search = new URLSearchParams(params);
                      if (v === 'queue') search.delete('view');
                      else search.set('view', v);
                      setParams(search, { replace: true });
                    }}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      view === v ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'
                    }`}
                  >
                    {t(VIEWS[v].label)}
                    <span className="tabular ms-1.5 text-xs text-muted">
                      {number(state.data.counts[v])}
                    </span>
                  </button>
                ))}
              </div>
              {view === 'queue' && state.data.actions.some((a) => a.status === 'proposed') ? (
                <ApproveAll
                  api={api}
                  count={state.data.actions.filter((a) => a.status === 'proposed').length}
                  onDone={changed}
                />
              ) : null}
            </div>
            {state.data.actions.length === 0 ? (
              <EmptyState
                icon={(() => {
                  const Icon = VIEWS[view].Icon;
                  return <Icon aria-hidden="true" className="size-5" />;
                })()}
                body={t(VIEWS[view].empty)}
              />
            ) : (
              <ul className="divide-y divide-line">
                {state.data.actions.map((action) => (
                  <ActionItem key={action.id} action={action} api={api} onChange={changed} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
      <AlumniCard api={api} whopAppId={whopAppId} />
    </div>
  );
}

function ApproveAll({ api, count, onDone }: { api: string; count: number; onDone: () => void }) {
  const { t, number } = useI18n();
  const [step, setStep] = useState<'idle' | 'running' | 'failed'>('idle');
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm"
        icon={<CheckCheck aria-hidden="true" className="size-4" />}
        loading={step === 'running'}
        onClick={() => {
          setStep('running');
          postJson(`${api}/actions/approve`, {}).then(
            () => {
              setStep('idle');
              onDone();
            },
            () => setStep('failed'),
          );
        }}
      >
        {t('actions.approveAll', { count: number(count) })}
      </Button>
      {step === 'failed' ? (
        <span role="alert" className="text-xs text-danger">
          {t('actions.error')}
        </span>
      ) : null}
    </span>
  );
}

function ActionItem({
  action,
  api,
  onChange,
}: {
  action: ActionRow;
  api: string;
  onChange: () => void;
}) {
  const { t, relative, dateTime, percent } = useI18n();
  const [step, setStep] = useState<'idle' | 'running' | 'failed'>('idle');
  const { label, Icon } = TYPES[action.type];
  // An offer is not sent: it is applied to the membership.
  const applied = action.offer !== null && action.status === 'sent';
  const status = applied
    ? { label: 'actions.status.applied' as const, tone: STATUSES.sent.tone }
    : STATUSES[action.status];
  const trigger = action.alumniStep
    ? t('actions.trigger.alumni', { days: action.alumniStep })
    : action.milestone
      ? t('actions.trigger.milestone', { percent: percent(action.milestone / 100) })
      : TRIGGERS[action.trigger]
        ? t(TRIGGERS[action.trigger]!)
        : null;
  const waiting = ['proposed', 'approved', 'scheduled'].includes(action.status);

  const moment = (() => {
    const at = (value: string) => ({ date: new Date(value), text: relative(new Date(value)) });
    if (action.status === 'sent' && action.sentAt) {
      const { date, text } = at(action.sentAt);
      return {
        date,
        text: t(applied ? 'actions.when.applied' : 'actions.when.sent', { when: text }),
      };
    }
    if (action.status === 'simulated' && action.sentAt) {
      const { date, text } = at(action.sentAt);
      return { date, text: t('actions.when.simulated', { when: text }) };
    }
    if (waiting) {
      if (!action.sendAt) return { date: null, text: t('actions.when.goldenHour') };
      const { date, text } = at(action.sendAt);
      // Planned for the moment it was proposed: it leaves as soon as it is approved.
      if (action.status !== 'scheduled' && date.getTime() <= Date.parse(action.createdAt)) {
        return { date, text: t('actions.when.asap') };
      }
      return { date, text: t('actions.when.at', { when: text }) };
    }
    const { date, text } = at(action.createdAt);
    return { date, text: t('actions.when.created', { when: text }) };
  })();

  const note = action.note
    ? NOTES[action.note]
      ? t(NOTES[action.note]!)
      : t('actions.note.error', { error: action.note })
    : null;

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Avatar name={action.member.name} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{action.member.name ?? t('members.unnamed')}</p>
              {action.status !== 'proposed' ? (
                <Badge tone={status.tone}>{t(status.label)}</Badge>
              ) : null}
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
              <Icon aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <span className="font-medium">{t(label)}</span>
              {trigger ? <span className="text-muted">· {trigger}</span> : null}
            </p>
            {action.message ? (
              <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm">
                <p className="font-medium">{action.message.title}</p>
                <p className="mt-0.5 text-muted">{action.message.body}</p>
              </div>
            ) : null}
            {action.offer ? <OfferDetails type={action.type} offer={action.offer} /> : null}
            {action.blockedReason ? (
              <p className="flex items-center gap-1.5 text-sm text-warning">
                <OctagonX aria-hidden="true" className="size-4 shrink-0" />
                <span className="text-fg">{t(BLOCKED[action.blockedReason])}</span>
              </p>
            ) : null}
            {note ? <p className="text-sm text-muted">{note}</p> : null}
            <p className="text-xs text-muted">
              {moment.date ? (
                <time dateTime={moment.date.toISOString()} title={dateTime(moment.date)}>
                  {moment.text}
                </time>
              ) : (
                moment.text
              )}
            </p>
          </div>
        </div>
        {waiting ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {action.status === 'proposed' ? (
              <Button
                size="sm"
                icon={<Check aria-hidden="true" className="size-4" />}
                loading={step === 'running'}
                onClick={() => {
                  setStep('running');
                  postJson(`${api}/actions/approve`, { ids: [action.id] }).then(
                    () => {
                      setStep('idle');
                      onChange();
                    },
                    () => setStep('failed'),
                  );
                }}
              >
                {t('actions.approve')}
              </Button>
            ) : null}
            <ConfirmButton
              label={t('actions.cancel')}
              confirmLabel={t('actions.cancelConfirm')}
              icon={<X aria-hidden="true" className="size-4" />}
              run={() =>
                postJson(`${api}/actions/${encodeURIComponent(action.id)}/cancel`).then(onChange)
              }
            />
            {step === 'failed' ? (
              <span role="alert" className="w-full text-xs text-danger sm:text-end">
                {t('actions.error')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * An offer a member accepted in the departure survey: their reason in their words, the offer, and
 * once applied, the code or the end of the pause. Help and the affiliate invitation are the
 * creator's to follow up.
 */
function OfferDetails({ type, offer }: { type: ActionType; offer: ActionOffer }) {
  const { t, plural, percent, date } = useI18n();
  const day = (value: string | undefined) => (value ? date(new Date(value)) : '');
  const what =
    type === 'pause_offer' && offer.days
      ? t('actions.offer.pause', { days: offer.days })
      : type === 'promo_offer' && offer.percentOff && offer.months
        ? plural('actions.offer.promo', offer.months, {
            discount: percent(offer.percentOff / 100),
          })
        : type === 'extend_offer' && offer.days
          ? plural('actions.offer.extend', offer.days)
          : null;
  const lines = [
    offer.reason ? t('actions.offer.reason', { reason: t(REASON_LABELS[offer.reason]) }) : null,
    what,
    offer.promoCode
      ? t('actions.offer.code', { code: offer.promoCode, date: day(offer.expiresAt) })
      : null,
    offer.resumesAt ? t('actions.offer.resumes', { date: day(offer.resumesAt) }) : null,
    offer.keep ? t('actions.offer.kept') : null,
  ].filter((line): line is string => line !== null);
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm">
      <ul className="space-y-0.5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {type === 'coaching_offer' || type === 'affiliate_invite' ? (
        <p className="mt-1 text-muted">{t('actions.offer.followUp')}</p>
      ) : null}
    </div>
  );
}
