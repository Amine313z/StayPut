import {
  COHORT_HORIZONS,
  FAILED_PAYMENT_STATUSES,
  LIVE_MEMBERSHIP_STATUSES,
  MEMBER_PAYMENTS_LIMIT,
  RISK_LEVELS,
  analyzeCohorts,
  isAccessLevel,
  isBlockingLesson,
  isNiche,
  type CohortCounts,
  type CohortHorizon,
  type InsightsReport,
  type MemberDetail,
  type MemberPlatformActivity,
  type MemberRisk,
  type MemberRow,
  type MembersPage,
  type RevenueSummary,
  type RiskLevel,
  type RiskReason,
  type RiskSettingsView,
  type RiskSummary,
  type SyncStatus,
  type SyncStreamStatus,
} from '@stayput/core';
import { withUser, type TransactionalDb } from './db';
import { STREAMS } from './sync';

/**
 * What the creator view reads, always as the Whop user under RLS (withUser): the policies of
 * supabase/migrations decide which rows exist, the Worker's own checks come on top.
 */

/** Members shown at most, active ones first, then by last activity. */
export const MEMBERS_PAGE_LIMIT = 200;

const live = LIVE_MEMBERSHIP_STATUSES.join(',');

/**
 * A membership's price brought back to a month (SQL, on the alias of a memberships row): a year
 * counts for a twelfth, a week for 52 twelfths, any other period in proportion to 30 days.
 */
export function monthlyPrice(alias: string): string {
  return `case
    when ${alias}.billing_period_days between 28 and 31 then ${alias}.price
    when ${alias}.billing_period_days = 7 then ${alias}.price * 52 / 12
    when ${alias}.billing_period_days between 365 and 366 then ${alias}.price / 12
    else ${alias}.price * 30 / ${alias}.billing_period_days
  end`;
}

/** Memberships still paying: the ones a month of revenue counts. */
export const PAYING_STATUSES_SQL = `('active', 'past_due', 'canceling')`;
const failed = FAILED_PAYMENT_STATUSES.join(',');

export async function readSyncStatus(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<SyncStatus> {
  const rows = await withUser(db, userId, (tx) =>
    tx.query<{
      stream: string;
      backfill_done: boolean;
      in_progress: boolean;
      last_pass_at: Date | string | null;
      last_run_at: Date | string | null;
      last_error: string | null;
    }>(
      // Discord's channels and member lists have their own status (the integrations, the
      // people); this one is Whop's.
      `select stream, backfill_done, cursor is not null as in_progress, last_pass_at,
              last_run_at, last_error
         from stayput.sync_state
        where company_id = $1 and stream not like 'discord_%'
        order by stream`,
      [companyId],
    ),
  );
  const streams: SyncStreamStatus[] = rows.map((r) => ({
    stream: r.stream,
    backfillDone: r.backfill_done,
    inProgress: r.in_progress,
    lastPassAt: iso(r.last_pass_at),
    error: r.last_error,
  }));
  const lastRuns = rows.map((r) => iso(r.last_run_at)).filter((at): at is string => at !== null);
  return {
    backfillDone: backfillDone(streams),
    lastSyncAt: lastRuns.length > 0 ? lastRuns.sort().at(-1)! : null,
    streams,
  };
}

/**
 * Every list of the company was read once: each account-wide stream exists, and each stream
 * finished its first pass or was refused for good (403: a permission the creator did not grant,
 * 404: gone), which no retry will change.
 */
export function backfillDone(streams: readonly SyncStreamStatus[]): boolean {
  const byName = new Map(streams.map((s) => [s.stream, s]));
  const settled = (s: SyncStreamStatus) => s.backfillDone || /^(403|404)\b/.test(s.error ?? '');
  return (
    STREAMS.filter((s) => !s.scoped && !s.source).every((s) => {
      const state = byName.get(s.name);
      return state !== undefined && settled(state);
    }) && streams.every(settled)
  );
}

export async function readMembers(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<MembersPage> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  return withUser(db, userId, async (tx) => {
    const [summary] = await tx.query<{
      members: number;
      live_memberships: number;
      scheduled_cancellations: number;
      failed_payments: number;
      activity_30d: number;
      revenue: { currency: string; monthly: number; at_risk: number }[] | null;
      risk: {
        high: number;
        medium: number;
        low: number;
        scheduled_departure: number;
        inactive_newcomers: number;
        computed_at: string | null;
      } | null;
    }>(
      `select
         (select count(*) from stayput.members
           where company_id = $1 and status = 'joined'
             and coalesce(access_level, '') <> 'admin')::int as members,
         (select count(*) from stayput.memberships
           where company_id = $1 and status = any(string_to_array($3, ',')))::int
           as live_memberships,
         (select count(*) from stayput.memberships
           where company_id = $1 and status = any(string_to_array($3, ','))
             and cancel_at_period_end)::int as scheduled_cancellations,
         (select count(distinct member_id) from (
            select distinct on (coalesce(membership_id, id)) member_id, status
              from stayput.payments where company_id = $1 and member_id is not null
             order by coalesce(membership_id, id), whop_created_at desc) latest
           where status = any(string_to_array($4, ',')))::int as failed_payments,
         (select coalesce(sum(s.messages + s.reactions + s.forum_posts + s.lessons_completed), 0)
            from stayput.member_stats_daily s
            join stayput.members m on m.company_id = s.company_id and m.id = s.member_id
           where s.company_id = $1 and s.day >= $2::timestamptz::date
             and coalesce(m.access_level, '') <> 'admin')::int as activity_30d,
         -- Recurring memberships still paying, brought back to a month, per currency.
         (select jsonb_agg(jsonb_build_object('currency', r.currency, 'monthly', r.monthly,
                                              'at_risk', r.at_risk)
                           order by r.monthly desc)
            from (
              select upper(x.currency) as currency,
                     round(sum(x.monthly), 2)::float8 as monthly,
                     round(coalesce(sum(x.monthly) filter (
                       where x.level in ('high', 'scheduled_departure')), 0), 2)::float8
                       as at_risk
                from (
                  select ms.currency, k.level, ${monthlyPrice('ms')} as monthly
                    from stayput.memberships ms
                    join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
                    left join stayput.member_risk k
                      on k.company_id = ms.company_id and k.member_id = ms.member_id
                   where ms.company_id = $1
                     and ms.status in ('active', 'past_due', 'canceling')
                     and ms.price > 0 and ms.billing_period_days > 0
                     and ms.currency is not null
                     and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin') x
               group by upper(x.currency)) r) as revenue,
         (select jsonb_build_object(
                   'high', count(*) filter (where level = 'high'),
                   'medium', count(*) filter (where level = 'medium'),
                   'low', count(*) filter (where level = 'low'),
                   'scheduled_departure', count(*) filter (where level = 'scheduled_departure'),
                   'inactive_newcomers', count(*) filter (where inactive_newcomer),
                   'computed_at', max(computed_at))
            from stayput.member_risk where company_id = $1) as risk`,
      [companyId, since, live, failed],
    );
    const rows = await tx.query<MemberSqlRow>(
      `with recent as (
         select member_id, sum(messages)::int as messages, sum(reactions)::int as reactions,
                sum(forum_posts)::int as posts, sum(lessons_completed)::int as lessons
           from stayput.member_stats_daily
          where company_id = $1 and day >= $2::timestamptz::date
          group by member_id
       )
       select m.id, m.display_name as name, m.status, m.access_level, m.joined_at,
              m.last_action_at, a.last_activity_at, m.do_not_contact,
              coalesce(r.messages, 0) as messages, coalesce(r.reactions, 0) as reactions,
              coalesce(r.posts, 0) as posts, coalesce(r.lessons, 0) as lessons,
              ms.status as membership_status, ms.price::float8 as price, ms.currency,
              ms.billing_period_days, ms.cancel_at_period_end, ms.current_period_end,
              p.status as payment_status, p.amount::float8 as payment_amount,
              p.currency as payment_currency, p.whop_created_at as payment_at,
              p.failure_reason, k.score as risk_score, k.level as risk_level,
              k.reasons as risk_reasons, k.inactive_newcomer, k.computed_at as risk_computed_at
         from stayput.members m
         left join recent r on r.member_id = m.id
         left join stayput.member_risk k on k.company_id = m.company_id and k.member_id = m.id
         left join lateral (
           select max(e.occurred_at) as last_activity_at from stayput.activity_events e
            where e.company_id = m.company_id and e.member_id = m.id) a on true
         left join lateral (
           select x.status, x.price, x.currency, x.billing_period_days, x.cancel_at_period_end,
                  x.current_period_end
             from stayput.memberships x
            where x.company_id = m.company_id and x.member_id = m.id
            order by x.status = any(string_to_array($4, ',')) desc,
                     x.current_period_end desc nulls last, x.whop_created_at desc nulls last
            limit 1) ms on true
         left join lateral (
           select y.status, y.amount, y.currency, y.whop_created_at, y.failure_reason
             from stayput.payments y
            where y.company_id = m.company_id and y.member_id = m.id
            order by y.whop_created_at desc
            limit 1) p on true
        where m.company_id = $1
        order by m.status = 'joined' desc, k.score desc nulls last,
                 greatest(m.last_action_at, a.last_activity_at) desc nulls last,
                 m.joined_at desc nulls last, m.id
        limit $3`,
      [companyId, since, MEMBERS_PAGE_LIMIT + 1, live],
    );
    return {
      summary: {
        members: summary?.members ?? 0,
        liveMemberships: summary?.live_memberships ?? 0,
        scheduledCancellations: summary?.scheduled_cancellations ?? 0,
        failedPayments: summary?.failed_payments ?? 0,
        activity30d: summary?.activity_30d ?? 0,
        revenue: toRevenue(summary?.revenue ?? null),
        risk: toRiskSummary(summary?.risk ?? null),
      },
      members: rows.slice(0, MEMBERS_PAGE_LIMIT).map(toMemberRow),
      truncated: rows.length > MEMBERS_PAGE_LIMIT,
    };
  });
}

interface MemberSqlRow {
  id: string;
  name: string | null;
  status: 'joined' | 'left';
  access_level: string | null;
  joined_at: Date | string | null;
  last_action_at: Date | string | null;
  last_activity_at: Date | string | null;
  do_not_contact: boolean;
  messages: number;
  reactions: number;
  posts: number;
  lessons: number;
  membership_status: string | null;
  price: number | null;
  currency: string | null;
  billing_period_days: number | null;
  cancel_at_period_end: boolean | null;
  current_period_end: Date | string | null;
  payment_status: string | null;
  payment_amount: number | null;
  payment_currency: string | null;
  payment_at: Date | string | null;
  failure_reason: string | null;
  risk_score: number | null;
  risk_level: string | null;
  risk_reasons: RiskReason[] | null;
  inactive_newcomer: boolean | null;
  risk_computed_at: Date | string | null;
}

function toRevenue(
  rows: { currency: string; monthly: number; at_risk: number }[] | null,
): RevenueSummary | null {
  const main = rows?.[0];
  if (!main) return null;
  return {
    currency: main.currency,
    monthly: main.monthly,
    atRisk: main.at_risk,
    otherCurrencies: (rows?.length ?? 0) > 1,
  };
}

function toRiskSummary(
  risk: {
    high: number;
    medium: number;
    low: number;
    scheduled_departure: number;
    inactive_newcomers: number;
    computed_at: string | null;
  } | null,
): RiskSummary {
  return {
    high: risk?.high ?? 0,
    medium: risk?.medium ?? 0,
    low: risk?.low ?? 0,
    scheduledDeparture: risk?.scheduled_departure ?? 0,
    inactiveNewcomers: risk?.inactive_newcomers ?? 0,
    computedAt: risk?.computed_at ? iso(risk.computed_at) : null,
  };
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

function toMemberRisk(r: MemberSqlRow): MemberRisk | null {
  if (r.risk_score === null || !isRiskLevel(r.risk_level) || r.risk_computed_at === null) {
    return null;
  }
  return {
    score: r.risk_score,
    level: r.risk_level,
    reasons: Array.isArray(r.risk_reasons) ? r.risk_reasons : [],
    inactiveNewcomer: r.inactive_newcomer ?? false,
    computedAt: iso(r.risk_computed_at)!,
  };
}

function toMemberRow(r: MemberSqlRow): MemberRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    accessLevel: isAccessLevel(r.access_level) ? r.access_level : null,
    joinedAt: iso(r.joined_at),
    lastActionAt: iso(r.last_action_at),
    lastActivityAt: iso(r.last_activity_at),
    doNotContact: r.do_not_contact,
    activity: { messages: r.messages, reactions: r.reactions, posts: r.posts, lessons: r.lessons },
    membership: r.membership_status
      ? {
          status: r.membership_status,
          price: r.price,
          currency: r.currency,
          billingPeriodDays: r.billing_period_days,
          cancelAtPeriodEnd: r.cancel_at_period_end ?? false,
          currentPeriodEnd: iso(r.current_period_end),
        }
      : null,
    lastPayment:
      r.payment_status && r.payment_at
        ? {
            status: r.payment_status,
            amount: r.payment_amount ?? 0,
            currency: r.payment_currency ?? 'usd',
            at: iso(r.payment_at)!,
            failureReason: r.failure_reason,
          }
        : null,
    risk: toMemberRisk(r),
  };
}

/** What counts as activity on Whop itself (Discord and Telegram messages have their own type). */
const WHOP_ACTIVITY = `('message', 'reaction', 'forum_post', 'lesson_completed')`;

/**
 * One member's drawer (brief v4 §9.3), as the Whop user under RLS: their score over the last 30
 * days of the community's calendar, their memberships (the one that counts first, as the list
 * shows it), their latest payments, and what they did on Whop, Discord and Telegram (the last
 * two only once connected). Null when the member is not the company's.
 */
export async function readMemberDetail(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  memberId: string,
  now: Date,
): Promise<MemberDetail | null> {
  const at = now.toISOString();
  return withUser(db, userId, async (tx) => {
    const [member] = await tx.query<{
      discord_linked: boolean;
      telegram_linked: boolean;
      discord: boolean;
      telegram: boolean;
    }>(
      `select m.discord_user_id is not null as discord_linked,
              m.telegram_user_id is not null as telegram_linked,
              exists (select 1 from stayput.discord_guilds g where g.company_id = m.company_id)
                as discord,
              exists (select 1 from stayput.telegram_chats t where t.company_id = m.company_id)
                as telegram
         from stayput.members m
        where m.company_id = $1 and m.id = $2`,
      [companyId, memberId],
    );
    if (!member) return null;
    const scores = await tx.query<{ day: Date | string; score: number }>(
      `select s.day, s.score
         from stayput.risk_scores s
         join stayput.companies c on c.id = s.company_id
        where s.company_id = $1 and s.member_id = $2
          and s.day > ($3::timestamptz at time zone coalesce(c.timezone, 'UTC'))::date - 30
        order by s.day`,
      [companyId, memberId, at],
    );
    const memberships = await tx.query<{
      id: string;
      status: string;
      price: number | null;
      currency: string | null;
      billing_period_days: number | null;
      cancel_at_period_end: boolean;
      current_period_end: Date | string | null;
      whop_created_at: Date | string | null;
    }>(
      `select id, status, price::float8 as price, currency, billing_period_days,
              cancel_at_period_end, current_period_end, whop_created_at
         from stayput.memberships
        where company_id = $1 and member_id = $2
        order by status = any(string_to_array($3, ',')) desc,
                 current_period_end desc nulls last, whop_created_at desc nulls last, id`,
      [companyId, memberId, live],
    );
    const payments = await tx.query<{
      id: string;
      status: string;
      amount: number;
      currency: string;
      whop_created_at: Date | string;
      failure_reason: string | null;
    }>(
      `select id, status, amount::float8 as amount, currency, whop_created_at, failure_reason
         from stayput.payments
        where company_id = $1 and member_id = $2
        order by whop_created_at desc, id
        limit $3`,
      [companyId, memberId, MEMBER_PAYMENTS_LIMIT],
    );
    const [activity] = await tx.query<{
      whop: number;
      whop_last: Date | string | null;
      discord: number;
      discord_last: Date | string | null;
      telegram: number;
      telegram_last: Date | string | null;
    }>(
      `select count(*) filter (where type in ${WHOP_ACTIVITY} and occurred_at >= $3::timestamptz)::int
                as whop,
              max(occurred_at) filter (where type in ${WHOP_ACTIVITY}) as whop_last,
              count(*) filter (where type = 'discord_message'
                                 and occurred_at >= $3::timestamptz)::int as discord,
              max(occurred_at) filter (where type = 'discord_message') as discord_last,
              count(*) filter (where type = 'telegram_message'
                                 and occurred_at >= $3::timestamptz)::int as telegram,
              max(occurred_at) filter (where type = 'telegram_message') as telegram_last
         from stayput.activity_events
        where company_id = $1 and member_id = $2`,
      [companyId, memberId, new Date(now.getTime() - 30 * 86_400_000).toISOString()],
    );
    const platforms: MemberPlatformActivity[] = [
      {
        platform: 'whop',
        events: activity?.whop ?? 0,
        lastAt: iso(activity?.whop_last ?? null),
        linked: true,
      },
    ];
    if (member.discord) {
      platforms.push({
        platform: 'discord',
        events: activity?.discord ?? 0,
        lastAt: iso(activity?.discord_last ?? null),
        linked: member.discord_linked,
      });
    }
    if (member.telegram) {
      platforms.push({
        platform: 'telegram',
        events: activity?.telegram ?? 0,
        lastAt: iso(activity?.telegram_last ?? null),
        linked: member.telegram_linked,
      });
    }
    return {
      memberId,
      scores: scores.map((s) => ({ day: day(s.day), score: s.score })),
      memberships: memberships.map((ms) => ({
        id: ms.id,
        status: ms.status,
        price: ms.price,
        currency: ms.currency,
        billingPeriodDays: ms.billing_period_days,
        cancelAtPeriodEnd: ms.cancel_at_period_end,
        currentPeriodEnd: iso(ms.current_period_end),
        startedAt: iso(ms.whop_created_at),
      })),
      payments: payments.map((p) => ({
        id: p.id,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        at: iso(p.whop_created_at)!,
        failureReason: p.failure_reason,
      })),
      platforms,
    };
  });
}

/** Lessons shown at most in the insights, the flagged ones first. */
export const INSIGHT_LESSONS_LIMIT = 50;

/** The weekly analyses as the creator reads them: cohorts with their rates, stalling lessons. */
export async function readInsights(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<InsightsReport> {
  return withUser(db, userId, async (tx) => {
    const cohortRows = await tx.query<{
      cohort_month: Date | string;
      members: number;
      eligible_30: number;
      eligible_60: number;
      eligible_90: number;
      left_by_30: number;
      left_by_60: number;
      left_by_90: number;
      alert_horizon: number | null;
    }>(
      `select cohort_month, members, eligible_30, eligible_60, eligible_90, left_by_30,
              left_by_60, left_by_90, alert_horizon
         from stayput.cohort_stats where company_id = $1 order by cohort_month desc`,
      [companyId],
    );
    const lessonRows = await tx.query<{
      lesson_id: string;
      course_id: string;
      lesson_title: string | null;
      members_concerned: number;
      stalled: number;
      dropoff_rate: string | number;
      course_average_rate: string | number;
    }>(
      `select lesson_id, course_id, lesson_title, members_concerned, stalled, dropoff_rate,
              course_average_rate
         from stayput.lesson_dropoff_stats where company_id = $1
        order by flagged desc, dropoff_rate desc, members_concerned desc, lesson_id
        limit $2`,
      [companyId, INSIGHT_LESSONS_LIMIT],
    );
    const [run] = await tx.query<{ at: Date | string | null }>(
      'select stayput.analyses_at($1) as at',
      [companyId],
    );
    const counts: CohortCounts[] = cohortRows.map((c) => ({
      month: day(c.cohort_month),
      members: c.members,
      eligible: { 30: c.eligible_30, 60: c.eligible_60, 90: c.eligible_90 },
      left: { 30: c.left_by_30, 60: c.left_by_60, 90: c.left_by_90 },
    }));
    const report = analyzeCohorts(counts);
    return {
      computedAt: iso(run?.at ?? null),
      averages: report.averages,
      cohorts: report.cohorts.map((c, i) => ({
        month: c.month,
        members: c.members,
        rates: c.rates,
        // As stored by the weekly run (the same rule, judged with that week's figures).
        alertHorizon: horizon(cohortRows[i]?.alert_horizon ?? null),
      })),
      // The rule applied again to the stored counts: a change of rule shows at once, without
      // waiting for the next weekly run.
      lessons: lessonRows
        .map((l) => {
          const lesson = {
            lessonId: l.lesson_id,
            courseId: l.course_id,
            title: l.lesson_title,
            reached: l.members_concerned,
            stalled: l.stalled,
            rate: Number(l.dropoff_rate),
            courseAverage: Number(l.course_average_rate),
          };
          return { ...lesson, flagged: isBlockingLesson(lesson) };
        })
        .sort(
          (a, b) =>
            Number(b.flagged) - Number(a.flagged) || b.rate - a.rate || b.reached - a.reached,
        ),
    };
  });
}

function horizon(value: number | null): CohortHorizon | null {
  return COHORT_HORIZONS.find((h) => h === value) ?? null;
}

function day(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** How the company's score is computed: its niche, weights and thresholds. */
export async function readRiskSettings(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<RiskSettingsView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{
      niche: string;
      weight_recency: string | number;
      weight_frequency: string | number;
      weight_progress: string | number;
      weight_payment: string | number;
      weight_friction: string | number;
      recency_threshold_days: number;
      medium_risk_from: number;
      high_risk_from: number;
    }>(
      `select c.niche, s.weight_recency, s.weight_frequency, s.weight_progress,
              s.weight_payment, s.weight_friction, s.recency_threshold_days,
              s.medium_risk_from, s.high_risk_from
         from stayput.companies c
         join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    ),
  );
  if (!row) return null;
  return {
    niche: isNiche(row.niche) ? row.niche : 'other',
    weights: {
      recency: Number(row.weight_recency),
      frequency: Number(row.weight_frequency),
      progress: Number(row.weight_progress),
      payment: Number(row.weight_payment),
      friction: Number(row.weight_friction),
    },
    recencyThresholdDays: row.recency_threshold_days,
    mediumFrom: row.medium_risk_from,
    highFrom: row.high_risk_from,
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
