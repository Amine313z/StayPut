import {
  ACTION_VIEWS,
  BLOCK_REASONS,
  COACHING_MESSAGE_MAX,
  MESSAGE_ACTIONS,
  OFFER_LIMITS,
  actionOutcome,
  isActionType,
  isFailedPayment,
  isExitReason,
  isRuleId,
  templateProblems,
  timeZoneName,
  type ActionOffer,
  type ActionRow,
  type ActionSettingsUpdate,
  type ActionSettingsView,
  type ActionStatus,
  type ActionView,
  type ActionsPage,
  type BlockReason,
  type MessageAction,
  type MessageTemplate,
  type OfferSettings,
  type TemplateLocale,
  type TemplateValues,
} from '@stayput/core';
import {
  announcementOf,
  followupMessage,
  followupOffer,
  messageValues,
  renderActionMessage,
} from './actions';
import { withUser, type TransactionalDb } from './db';

/**
 * The creator's side of the actions (SPEC Phase 4): the three lists (to approve, scheduled,
 * done), each message previewed with the creator's own templates, and the settings. Read under
 * RLS, as the creator.
 */

const VIEW_STATUSES: Readonly<Record<ActionView, readonly ActionStatus[]>> = {
  queue: ['proposed', 'approved'],
  scheduled: ['scheduled'],
  history: ['sent', 'simulated', 'failed', 'cancelled', 'blocked_by_guardrail'],
};

const VIEW_ORDER: Readonly<Record<ActionView, string>> = {
  queue: 'a.created_at, a.id',
  scheduled: 'a.send_at, a.id',
  history: 'coalesce(a.sent_at, a.updated_at) desc, a.id',
};

/** Rows a list shows at most. */
export const ACTIONS_PAGE_SIZE = 100;

export function isActionView(value: unknown): value is ActionView {
  return typeof value === 'string' && (ACTION_VIEWS as readonly string[]).includes(value);
}

type Templates = ActionSettingsView['templates'];

export async function readActions(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  view: ActionView,
  now: Date,
): Promise<ActionsPage | null> {
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<{
      mode: string;
      locale: string;
      dry_run: boolean;
      kill_switch: boolean;
      templates: Templates;
      promo_percent: number;
      promo_months: number;
      queue: number;
      scheduled: number;
      history: number;
    }>(
      `select c.mode, c.locale, s.dry_run, s.kill_switch, s.active_templates as templates,
              s.promo_percent, s.promo_months,
              (select count(*) from stayput.actions a
                where a.company_id = c.id and a.status in ('proposed', 'approved'))::int as queue,
              (select count(*) from stayput.actions a
                where a.company_id = c.id and a.status = 'scheduled')::int as scheduled,
              (select count(*) from stayput.actions a
                where a.company_id = c.id
                  and a.status in ('sent', 'simulated', 'failed', 'cancelled',
                                   'blocked_by_guardrail'))::int as history
         from stayput.companies c
         join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    );
    if (!company) return null;
    const rows = await tx.query<{
      id: string;
      type: string;
      status: ActionStatus;
      trigger: string;
      member_id: string;
      display_name: string | null;
      send_at: Date | string | null;
      sent_at: Date | string | null;
      created_at: Date | string;
      blocked_reason: string | null;
      result: Record<string, unknown> | null;
      content: Record<string, unknown> | null;
      last_error: string | null;
      message_values: TemplateValues | null;
      saved: { amount: number; currency: string } | null;
      payment_status: string | null;
      active_after: boolean | null;
      left_after: boolean | null;
    }>(
      `select a.id, a.type, a.status, a.trigger, a.member_id, m.display_name, a.send_at,
              a.sent_at, a.created_at, a.blocked_reason, a.result,
              -- What came of it (History only): the money saved through it, the member's latest
              -- payment, whether they did anything since it reached them, or left since.
              case when $3 = 'history' then (
                select jsonb_build_object('amount', s.amount::float8, 'currency', s.currency)
                  from stayput.saves s
                 where s.company_id = a.company_id and s.action_id = a.id
                 order by s.saved_at desc limit 1) end as saved,
              case when $3 = 'history' then (
                select y.status from stayput.payments y
                 where y.company_id = a.company_id and y.member_id = a.member_id
                 order by y.whop_created_at desc limit 1) end as payment_status,
              case when $3 = 'history' and a.sent_at is not null then exists (
                select 1 from stayput.activity_events e
                 where e.company_id = a.company_id and e.member_id = a.member_id
                   and e.occurred_at > a.sent_at) end as active_after,
              -- Left since: their membership's last end, as the dashboard dates a departure.
              case when $3 = 'history' and a.sent_at is not null
                   then m.status = 'left' and coalesce(
                     (select max(ms.current_period_end) from stayput.memberships ms
                       where ms.company_id = a.company_id and ms.member_id = a.member_id
                         and ms.current_period_end <= $4::timestamptz),
                     m.updated_at) > a.sent_at end as left_after,
              case when a.trigger in ('exit_survey', 'alumni', 'milestone', 'member_request',
                                      'buddy_pair')
                   then a.content end as content,
              a.error_log -> -1 ->> 'error' as last_error,
              case when $3 <> 'history' and a.message_kind <> 'none'
                   then stayput.message_values(a.company_id, a.member_id, $4::timestamptz)
              end as message_values
         from stayput.actions a
         join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
        where a.company_id = $1 and a.status = any (string_to_array($2, ','))
        order by ${VIEW_ORDER[view]}
        limit ${ACTIONS_PAGE_SIZE}`,
      [companyId, VIEW_STATUSES[view].join(','), view, now.toISOString()],
    );
    const actions: ActionRow[] = rows.flatMap((row): ActionRow[] => {
      if (!isActionType(row.type)) return [];
      const preview = !row.message_values
        ? null
        : row.type === 'alumni_followup'
          ? // The return code is the action's own: the preview shows the one that will go.
            followupMessage(
              company.locale,
              company.templates,
              row.message_values,
              followupOffer(row.id, {
                percentOff: company.promo_percent,
                months: company.promo_months,
              }),
            )
          : (MESSAGE_ACTIONS as readonly string[]).includes(row.type)
            ? renderActionMessage(
                row.type as MessageAction,
                company.locale,
                company.templates,
                messageValues(
                  row.type as MessageAction,
                  company.locale,
                  row.message_values,
                  row.content,
                ),
              )
            : null;
      // An announcement: where it goes, and its words (the member's first name, as members'
      // messages write it).
      const announcement =
        row.type === 'milestone_announcement' && row.content
          ? announcementOf(
              company.locale,
              row.content,
              (row.display_name ?? '').split(' ')[0] || null,
            )
          : null;
      const step = row.type === 'alumni_followup' ? Number(row.content?.step) : 0;
      return [
        {
          id: row.id,
          type: row.type,
          status: row.status,
          trigger: row.trigger,
          member: { id: row.member_id, name: row.display_name },
          sendAt: iso(row.send_at),
          sentAt: iso(row.sent_at),
          createdAt: iso(row.created_at) ?? '',
          blockedReason: isBlockReason(row.blocked_reason) ? row.blocked_reason : null,
          message: announcement
            ? { title: announcement.channel, body: announcement.text }
            : (preview ?? storedMessage(row.result) ?? null),
          note:
            row.status === 'failed'
              ? row.last_error
              : row.status === 'cancelled'
                ? text(row.result?.reason)
                : null,
          // An accepted offer, or the free days a milestone earned.
          offer:
            (row.trigger === 'exit_survey' || row.trigger === 'milestone') && row.content
              ? offerOf(row.content, row.result)
              : null,
          ...(step > 0 ? { alumniStep: step } : {}),
          ...(row.trigger === 'milestone' && Number(row.content?.percent) > 0
            ? { milestone: Number(row.content?.percent) }
            : {}),
          ...(view === 'history'
            ? {
                outcome: actionOutcome({
                  type: row.type,
                  status: row.status,
                  saved: row.saved,
                  paymentFailing: isFailedPayment(row.payment_status),
                  activeAfter: row.active_after === true,
                  leftAfter: row.left_after === true,
                  resumesAt: text(row.result?.resumes_at),
                }),
              }
            : {}),
        },
      ];
    });
    return {
      view,
      counts: { queue: company.queue, scheduled: company.scheduled, history: company.history },
      actions,
      mode: company.mode === 'auto' ? 'auto' : 'manual',
      dryRun: company.dry_run,
      killSwitch: company.kill_switch,
    };
  });
}

export async function readActionSettings(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<ActionSettingsView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{
      mode: string;
      locale: string;
      dry_run: boolean;
      kill_switch: boolean;
      timezone: string;
      quiet_hours_start: number;
      quiet_hours_end: number;
      default_send_hour: number;
      max_messages_per_5_days: number;
      max_messages_per_month: number;
      max_payment_retries: number;
      monthly_promo_cap: number;
      max_free_days_per_quarter: number;
      templates: Templates;
      pause_days: number;
      promo_percent: number;
      promo_months: number;
      extend_days: number;
      coaching_message: string | null;
      rules_off: string[];
    }>(
      `select c.mode, c.locale, s.dry_run, s.kill_switch, c.timezone, s.quiet_hours_start,
              s.quiet_hours_end, s.default_send_hour, s.max_messages_per_5_days,
              s.max_messages_per_month, s.max_payment_retries, s.monthly_promo_cap,
              s.max_free_days_per_quarter, s.active_templates as templates, s.pause_days,
              s.promo_percent, s.promo_months, s.extend_days, s.coaching_message,
              to_jsonb(s.rules_off) as rules_off
         from stayput.companies c
         join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    ),
  );
  if (!row) return null;
  return {
    mode: row.mode === 'auto' ? 'auto' : 'manual',
    rulesOff: (row.rules_off ?? []).filter(isRuleId),
    locale: row.locale === 'fr' ? 'fr' : 'en',
    dryRun: row.dry_run,
    killSwitch: row.kill_switch,
    timezone: row.timezone,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    defaultSendHour: row.default_send_hour,
    maxMessagesPer5Days: row.max_messages_per_5_days,
    maxMessagesPerMonth: row.max_messages_per_month,
    maxPaymentRetries: row.max_payment_retries,
    monthlyPromoCap: row.monthly_promo_cap,
    maxFreeDaysPerQuarter: row.max_free_days_per_quarter,
    templates: cleanTemplates(row.templates) ?? {},
    offers: {
      pauseDays: row.pause_days,
      promoPercent: row.promo_percent,
      promoMonths: row.promo_months,
      extendDays: row.extend_days,
      coachingMessage: row.coaching_message,
    },
  };
}

/**
 * The limits a creator may set: the SPEC's guardrails can be made stricter, never looser (the
 * promo cap is the one the SPEC leaves to the creator).
 */
export const ACTION_LIMITS = {
  maxMessagesPer5Days: [0, 1],
  maxMessagesPerMonth: [0, 4],
  maxPaymentRetries: [0, 2],
  monthlyPromoCap: [0, 100],
  maxFreeDaysPerQuarter: [0, 14],
} as const;

export const TEMPLATE_TITLE_MAX = 80;
export const TEMPLATE_BODY_MAX = 300;

/**
 * The settings as the creator sent them, or null when one value is out of bounds. The time
 * zone comes only when the creator changed it.
 */
export function validActionSettings(body: unknown): ActionSettingsUpdate | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const hour = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23;
  const within = (v: unknown, [min, max]: readonly [number, number]) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (b.mode !== 'auto' && b.mode !== 'manual') return null;
  if (b.locale !== 'en' && b.locale !== 'fr') return null;
  if (typeof b.dryRun !== 'boolean' || typeof b.killSwitch !== 'boolean') return null;
  if (!hour(b.quietHoursStart) || !hour(b.quietHoursEnd) || !hour(b.defaultSendHour)) return null;
  const timezone = b.timezone === undefined ? undefined : timeZoneName(b.timezone);
  if (timezone === null) return null;
  for (const [key, range] of Object.entries(ACTION_LIMITS)) {
    if (!within(b[key], range)) return null;
  }
  const templates = cleanTemplates(b.templates ?? {});
  if (!templates) return null;
  const offers = b.offers === undefined ? undefined : validOffers(b.offers);
  if (offers === null) return null;
  return {
    mode: b.mode,
    locale: b.locale,
    dryRun: b.dryRun,
    killSwitch: b.killSwitch,
    ...(timezone ? { timezone } : {}),
    quietHoursStart: b.quietHoursStart as number,
    quietHoursEnd: b.quietHoursEnd as number,
    defaultSendHour: b.defaultSendHour as number,
    maxMessagesPer5Days: b.maxMessagesPer5Days as number,
    maxMessagesPerMonth: b.maxMessagesPerMonth as number,
    maxPaymentRetries: b.maxPaymentRetries as number,
    monthlyPromoCap: b.monthlyPromoCap as number,
    maxFreeDaysPerQuarter: b.maxFreeDaysPerQuarter as number,
    templates,
    ...(offers ? { offers } : {}),
  };
}

/** The departure survey's offers, within OFFER_LIMITS, or null; an empty message is StayPut's. */
function validOffers(value: unknown): OfferSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  for (const [key, [min, max]] of Object.entries(OFFER_LIMITS)) {
    const n = o[key];
    if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) return null;
  }
  const message = o.coachingMessage ?? null;
  if (message !== null && typeof message !== 'string') return null;
  const words = message?.trim() ?? '';
  if (words.length > COACHING_MESSAGE_MAX) return null;
  return {
    pauseDays: o.pauseDays as number,
    promoPercent: o.promoPercent as number,
    promoMonths: o.promoMonths as number,
    extendDays: o.extendDays as number,
    coachingMessage: words === '' ? null : words,
  };
}

/**
 * The creator's templates, kept only for known languages and messages, trimmed, without empty
 * ones (StayPut's default then applies); null when one is too long or uses an unknown variable.
 */
function cleanTemplates(value: unknown): Templates | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: Templates = {};
  for (const locale of ['en', 'fr'] as const satisfies readonly TemplateLocale[]) {
    const byAction = (value as Record<string, unknown>)[locale];
    if (byAction === undefined) continue;
    if (typeof byAction !== 'object' || byAction === null) return null;
    for (const action of MESSAGE_ACTIONS) {
      const template = (byAction as Record<string, unknown>)[action];
      if (template === undefined) continue;
      if (typeof template !== 'object' || template === null) return null;
      const { title, body } = template as Record<string, unknown>;
      if (typeof title !== 'string' || typeof body !== 'string') return null;
      const [t, b] = [title.trim(), body.trim()];
      if (t === '' && b === '') continue;
      if (t.length > TEMPLATE_TITLE_MAX || b.length > TEMPLATE_BODY_MAX) return null;
      if (templateProblems(t).length > 0 || templateProblems(b).length > 0) return null;
      out[locale] = { ...out[locale], [action]: { title: t, body: b } };
    }
  }
  return out;
}

function isBlockReason(value: unknown): value is BlockReason {
  return typeof value === 'string' && (BLOCK_REASONS as readonly string[]).includes(value);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The message an action sent (or would have sent, in test mode), as kept in its result. */
function storedMessage(result: Record<string, unknown> | null): MessageTemplate | null {
  const message = result?.message as Record<string, unknown> | undefined;
  const [title, body] = [text(message?.title), text(message?.body)];
  return title !== null && body !== null ? { title, body } : null;
}

/** An offer a member accepted: its content (the offer, their consent, their reason) and result. */
function offerOf(
  content: Record<string, unknown>,
  result: Record<string, unknown> | null,
): ActionOffer {
  const reason = content.reason;
  // A discount on the membership needs no code; an offer made before that gave one to type.
  const applied = result?.applied === true;
  const optional = {
    days: count(content.days),
    percentOff: count(content.percentOff),
    months: count(content.months),
    promoApplied: applied ? true : undefined,
    promoCode: applied ? undefined : (text(result?.code) ?? undefined),
    expiresAt: applied ? undefined : (text(result?.expires_at) ?? undefined),
    resumesAt: text(result?.resumes_at) ?? undefined,
  };
  return {
    reason: isExitReason(reason) ? reason : null,
    keep: content.keep === true,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}
