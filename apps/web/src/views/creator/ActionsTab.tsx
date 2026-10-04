import {
  ACTION_VIEWS,
  type ActionOffer,
  type ActionOutcome,
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
  Handshake,
  HeartHandshake,
  History,
  Inbox,
  LogOut,
  Mail,
  Megaphone,
  MessageCircleHeart,
  MessageSquareText,
  OctagonPause,
  OctagonX,
  Percent,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRoundPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { postJson, useApi } from '../../api';
import { AlumniCard } from '../../components/AlumniCard';
import { ConfirmButton } from '../../components/ConfirmButton';
import { ErrorPanel, Loading } from '../../components/Status';
import { REASON_LABELS } from '../../exit-reasons';
import { useI18n } from '../../i18n';
import { Avatar } from '../../ui/Avatar';
import { Badge, Notice, type Tone } from '../../ui/Badge';
import { ease } from '../../motion';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { useCreatorData, type CreatorData, type TabCounts } from '../CreatorView';
import { RulesTab } from './RulesTab';

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
  milestone_announcement: { label: 'actions.type.milestone_announcement', Icon: Megaphone },
  buddy_intro: { label: 'actions.type.buddy_intro', Icon: Handshake },
  mentor_intro: { label: 'actions.type.mentor_intro', Icon: UserRoundPlus },
  creator_message: { label: 'actions.type.creator_message', Icon: MessageSquareText },
  creator_offer: { label: 'actions.type.creator_offer', Icon: Gift },
};

const TRIGGERS: Readonly<Record<string, MessageKey>> = {
  payment_requires_action: 'actions.trigger.payment_requires_action',
  payment_failed: 'actions.trigger.payment_failed',
  cancel_at_period_end: 'actions.trigger.cancel_at_period_end',
  score_high: 'actions.trigger.score_high',
  activation_radar: 'actions.trigger.activation_radar',
  exit_survey: 'actions.trigger.exit_survey',
  member_request: 'actions.trigger.member_request',
  buddy_pair: 'actions.trigger.buddy_pair',
  creator: 'actions.trigger.creator',
  creator_offer: 'actions.trigger.creator_offer',
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

/** What the creator just did to an action, shown before the list is read again. */
type Move = 'approved' | 'cancelled';

/**
 * A list with the creator's latest moves applied (fix prompt v4.1, block 4): an action approved
 * or cancelled leaves its list at once, and every count moves with it. Once the Worker's answer
 * has it (the action is no longer where it was), the move has nothing left to change.
 */
export function withMoves(page: ActionsPage, moves: ReadonlyMap<string, Move>): ActionsPage {
  if (moves.size === 0) return page;
  const counts = { ...page.counts };
  const actions = page.actions.filter((action) => {
    const move = moves.get(action.id);
    if (!move) return true;
    const from: ActionView | null =
      action.status === 'proposed' || action.status === 'approved'
        ? 'queue'
        : action.status === 'scheduled'
          ? 'scheduled'
          : null;
    // Approving moves an action from the queue to the scheduled ones; cancelling, to the history.
    if (from === null || (move === 'approved' && from !== 'queue')) return true;
    counts[from] -= 1;
    counts[move === 'approved' ? 'scheduled' : 'history'] += 1;
    return false;
  });
  return { ...page, counts, actions };
}

/**
 * What StayPut does for the members (SPEC Phase 4): the actions to approve in manual mode, each
 * with the message exactly as the member will read it; the scheduled ones; and what happened,
 * sent, simulated in test mode, blocked by a guardrail with the reason, cancelled or failed, each
 * with what came of it.
 */
export function ActionsTab({ view }: { view: ActionView }) {
  const { t } = useI18n();
  const { api, tabCounts } = useCreatorData();
  const { state: read, retry, reload } = useApi<ActionsPage>(`${api}/actions?view=${view}`);
  // An approval or a cancellation shows at once: the list, its button and the counts together.
  const [moves, setMoves] = useState<ReadonlyMap<string, Move>>(new Map());
  const page = read.status === 'ready' ? read.data : null;
  const shown = useMemo(() => (page ? withMoves(page, moves) : null), [page, moves]);
  const state = shown && read.status === 'ready' ? { ...read, data: shown } : read;
  const moved = (ids: readonly string[], move: Move) =>
    setMoves((current) => new Map([...current, ...ids.map((id) => [id, move] as const)]));
  // The queue's filters say how many actions each view holds: set before the screen is painted,
  // so a filter never shows another count than the list's button.
  const counts = shown?.counts ?? null;
  useLayoutEffect(() => {
    if (counts) {
      tabCounts?.({ queue: counts.queue, scheduled: counts.scheduled, history: counts.history });
    }
  }, [tabCounts, counts]);
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

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') {
    return (
      <ErrorPanel error={state.error} forbiddenKey="error.forbidden.creator" onRetry={retry} />
    );
  }
  const proposed = state.data.actions.filter((a) => a.status === 'proposed');
  const Icon = VIEWS[view].Icon;
  return (
    <div className="space-y-4">
      {state.data.killSwitch || state.data.dryRun ? (
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
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {t(state.data.mode === 'auto' ? 'actions.mode.auto' : 'actions.mode.manual')}
        </p>
        {/* The page's one primary button (brief v4 §9.4): every row's own are ghosts. */}
        {view === 'queue' && proposed.length > 0 ? (
          <ApproveAll
            api={api}
            count={proposed.length}
            onDone={() => {
              moved(
                proposed.map((a) => a.id),
                'approved',
              );
              changed();
            }}
          />
        ) : null}
      </div>
      {state.data.actions.length === 0 ? (
        <EmptyState
          icon={<Icon aria-hidden="true" className="size-5" />}
          body={t(VIEWS[view].empty)}
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {state.data.actions.map((action) => (
            <ActionItem
              key={action.id}
              action={action}
              api={api}
              onChange={(move) => {
                moved([action.id], move);
                changed();
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The queue's filters (brief v4 §9.4): what waits, what is scheduled, what happened, Alumni. */
const QUEUE_FILTERS: readonly { path: string; label: MessageKey; count?: ActionView }[] = [
  { path: '', label: 'actions.view.queue', count: 'queue' },
  { path: 'scheduled', label: 'actions.view.scheduled', count: 'scheduled' },
  { path: 'history', label: 'actions.view.history', count: 'history' },
  { path: 'alumni', label: 'alumni.title' },
];

/**
 * Automations › Queue (brief v4 §9.4): the actions to approve, then — as filters of the same tab,
 * not tabs of their own — the scheduled ones, the history and the Alumni offer. The section's tab
 * counts what waits for approval; each filter, what it holds.
 */
export function QueueTab() {
  const data = useCreatorData();
  const { t, number } = useI18n();
  const location = useLocation();
  const [arrival] = useState(location.key);
  const [counts, setCounts] = useState<TabCounts>({});
  const section = data.tabCounts;
  const tabCounts = useCallback(
    (next: TabCounts) => {
      setCounts((current) =>
        Object.entries(next).every(([key, n]) => current[key] === n)
          ? current
          : { ...current, ...next },
      );
      if (next.queue !== undefined) section?.({ queue: next.queue });
    },
    [section],
  );
  const context: CreatorData = { ...data, tabCounts };
  const base = `${data.root}/actions/queue`;
  const pill = useId();
  return (
    <div className="space-y-5">
      <nav
        aria-label={t('queue.filters')}
        className="-mx-1 -my-1 flex gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none]"
      >
        {QUEUE_FILTERS.map((filter) => (
          <NavLink
            key={filter.path}
            to={filter.path ? `${base}/${filter.path}` : base}
            end
            className={({ isActive }) =>
              `relative shrink-0 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium whitespace-nowrap transition-colors duration-200 ease-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                isActive ? 'text-turq-300' : 'text-subtle hover:text-fg'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <motion.span
                    layoutId={pill}
                    transition={ease('standard')}
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full bg-surface-3"
                  />
                ) : null}
                <span className="relative">
                  {t(filter.label)}
                  {filter.count && counts[filter.count] !== undefined ? (
                    <span className="tabular ms-1.5 text-xs text-subtle">
                      {number(counts[filter.count]!)}
                    </span>
                  ) : null}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
      {/* A filter's list fades in; the filters above stay put. */}
      <motion.div
        key={location.pathname}
        initial={location.key === arrival ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={ease('standard')}
      >
        <Outlet context={context} />
      </motion.div>
    </div>
  );
}

/**
 * The addresses the queue's filters had as tabs, before (fix prompt v4.1, block 7): each opens its
 * filter, with what the address carried.
 */
export function QueueFilterAddress({ filter }: { filter: 'scheduled' | 'history' | 'alumni' }) {
  const { root } = useCreatorData();
  const { search } = useLocation();
  return <Navigate to={`${root}/actions/queue/${filter}${search}`} replace />;
}

/**
 * Automations' first page: its rules (brief v4 §9.4). An older link that named a view
 * (`?view=history`, `?view=queue`) opens that view in the queue.
 */
export function ActionsHome() {
  const [params] = useSearchParams();
  const view = ACTION_VIEWS.find((v) => v === params.get('view'));
  if (view) return <Navigate to={view === 'queue' ? 'queue' : `queue/${view}`} replace />;
  return <RulesTab />;
}

/** Automations › Queue › Alumni offer: former members keep in touch, and come back (SPEC 5.9). */
export function AlumniTab() {
  const { api, integrations } = useCreatorData();
  const whopAppId =
    integrations.state.status === 'ready' ? integrations.state.data.whopAppId : null;
  return <AlumniCard api={api} whopAppId={whopAppId} />;
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
  /** It was approved or cancelled. */
  onChange: (move: Move) => void;
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
    <li className="py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Avatar name={action.member.name} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{action.member.name ?? t('members.unnamed')}</p>
              {action.outcome ? (
                <OutcomeBadge outcome={action.outcome} />
              ) : action.status !== 'proposed' ? (
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
                variant="secondary"
                size="sm"
                icon={<Check aria-hidden="true" className="size-4" />}
                loading={step === 'running'}
                onClick={() => {
                  setStep('running');
                  postJson(`${api}/actions/approve`, { ids: [action.id] }).then(
                    () => {
                      setStep('idle');
                      onChange('approved');
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
                postJson(`${api}/actions/${encodeURIComponent(action.id)}/cancel`).then(() =>
                  onChange('cancelled'),
                )
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

const OUTCOME_TONES: Readonly<Record<ActionOutcome['kind'], Tone>> = {
  recovered: 'accent',
  still_failing: 'danger',
  paused: 'info',
  came_back: 'accent',
  no_reply: 'neutral',
  left: 'neutral',
};

/**
 * What came of an action that reached the member, in its History item (fix prompt v4.1, block 4):
 * « Recovered $49.00 », « Still failing », « Paused until Nov 2 », « Came back », « No reply yet »,
 * « Left ». The proof of value, in place of « Sent ».
 */
function OutcomeBadge({ outcome }: { outcome: ActionOutcome }) {
  const { t, currency, day } = useI18n();
  const text =
    outcome.kind === 'recovered'
      ? t('actions.outcome.recovered', {
          amount: currency(outcome.amount, outcome.currency.toUpperCase()),
        })
      : outcome.kind === 'paused' && outcome.until
        ? t('actions.outcome.pausedUntil', { date: day(new Date(outcome.until), new Date()) })
        : t(`actions.outcome.${outcome.kind}`);
  return (
    <span data-outcome={outcome.kind} title={t('actions.outcome.label')}>
      <Badge tone={OUTCOME_TONES[outcome.kind]}>{text}</Badge>
    </span>
  );
}

/**
 * An offer a member accepted in the departure survey: their reason in their words, the offer, and
 * once applied, the discount on the membership (or an older offer's code) or the end of the pause. Help and the affiliate invitation are the
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
    offer.promoApplied
      ? t('actions.offer.applied')
      : offer.promoCode
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
