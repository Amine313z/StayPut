import {
  FAILED_PAYMENT_STATUSES,
  LIVE_MEMBERSHIP_STATUSES,
  isAccessLevel,
  type MemberRow,
  type MembersPage,
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
      `select stream, backfill_done, cursor is not null as in_progress, last_pass_at,
              last_run_at, last_error
         from stayput.sync_state where company_id = $1 order by stream`,
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
    STREAMS.filter((s) => !s.scoped).every((s) => {
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
    }>(
      `select
         (select count(*) from stayput.members
           where company_id = $1 and status = 'joined')::int as members,
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
         (select count(*) from stayput.activity_events
           where company_id = $1 and occurred_at >= $2::timestamptz)::int as activity_30d`,
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
              m.last_action_at, a.last_activity_at,
              coalesce(r.messages, 0) as messages, coalesce(r.reactions, 0) as reactions,
              coalesce(r.posts, 0) as posts, coalesce(r.lessons, 0) as lessons,
              ms.status as membership_status, ms.price::float8 as price, ms.currency,
              ms.billing_period_days, ms.cancel_at_period_end, ms.current_period_end,
              p.status as payment_status, p.amount::float8 as payment_amount,
              p.currency as payment_currency, p.whop_created_at as payment_at,
              p.failure_reason
         from stayput.members m
         left join recent r on r.member_id = m.id
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
        order by m.status = 'joined' desc,
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
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
