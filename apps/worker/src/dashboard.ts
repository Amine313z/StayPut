import {
  choosePriority,
  type DashboardView,
  type FeedItem,
  type FeedView,
  type RevenueDay,
  type RiskDay,
} from '@stayput/core';
import { withUser, type TransactionalDb } from './db';
import { PAYING_STATUSES_SQL, monthlyPrice } from './members';

/**
 * The home of the dashboard (SPEC Phase 6.2): the money first, what StayPut did, the one action
 * of the day; and what just happened. Read as the Whop user under RLS, like the rest of the
 * creator view; the team's members never count.
 */

/** Feed items shown at most; member activity takes at most this share of them. */
export const FEED_LIMIT = 24;
export const FEED_ACTIVITY_LIMIT = 10;

/** Members at high risk count as reached when a message went (or is planned) in these days. */
const REACHED_DAYS = 5;

export async function readDashboard(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<DashboardView | null> {
  const at = now.toISOString();
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<{
      mode: 'auto' | 'manual';
      zone: string;
      dry_run: boolean;
      guardrails: boolean;
      reviewed: boolean;
      welcomed: boolean;
      discord: boolean;
      acted: boolean;
    }>(
      `select c.mode, coalesce(c.timezone, 'UTC') as zone, coalesce(s.dry_run, false) as dry_run,
              s.guardrails_saved_at is not null as guardrails,
              s.at_risk_reviewed_at is not null as reviewed,
              s.welcomed_at is not null as welcomed,
              exists (select 1 from stayput.discord_guilds g where g.company_id = c.id) as discord,
              exists (select 1 from stayput.actions a
                       where a.company_id = c.id
                         and (a.approved_by like 'user_%'
                              or a.type in ('creator_message', 'creator_offer'))) as acted
         from stayput.companies c
         left join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    );
    if (!company) return null;

    // What each member still paying brings in a month, per currency; their risk level.
    const paying = await tx.query<{
      member_id: string;
      currency: string;
      monthly: number;
      level: string | null;
    }>(
      `select ms.member_id, upper(ms.currency) as currency,
              round(sum(${monthlyPrice('ms')}), 2)::float8 as monthly, max(k.level) as level
         from stayput.memberships ms
         join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
         left join stayput.member_risk k
           on k.company_id = ms.company_id and k.member_id = ms.member_id
        where ms.company_id = $1 and ms.status in ${PAYING_STATUSES_SQL}
          and ms.price > 0 and ms.billing_period_days > 0 and ms.currency is not null
          and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
        group by ms.member_id, upper(ms.currency)`,
      [companyId],
    );
    const totals = new Map<string, number>();
    for (const p of paying) totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.monthly);
    // The currency the community is paid in most; else the one of its saves.
    const currency =
      [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const monthlyOf = new Map(
      paying.filter((p) => p.currency === currency).map((p) => [p.member_id, p.monthly]),
    );
    const atRiskRevenue = paying
      .filter(
        (p) => p.currency === currency && (p.level === 'high' || p.level === 'scheduled_departure'),
      )
      .reduce((total, p) => total + p.monthly, 0);

    const [figures] = await tx.query<{
      members: number;
      new_7: number;
      high: number;
      departures: number;
      base: number;
      kept: number;
      activity: number;
      actions: number;
      messages: number;
      retries: number;
      offers: number;
      pauses: number;
      pending_actions: number;
      pending_members: string[];
    }>(
      `with people as (
         select m.id, m.joined_at, m.status,
                case when m.status = 'left' then coalesce(
                  (select max(ms.current_period_end) from stayput.memberships ms
                    where ms.company_id = m.company_id and ms.member_id = m.id
                      and ms.current_period_end <= $2::timestamptz),
                  m.updated_at) end as left_at
           from stayput.members m
          where m.company_id = $1 and coalesce(m.access_level, '') <> 'admin'
       ), done as (
         select a.type, a.message_kind from stayput.actions a
          where a.company_id = $1 and a.status in ('sent', 'simulated')
            and coalesce(a.sent_at, a.updated_at) > $2::timestamptz - interval '30 days'
       )
       select
         (select count(*) from people where status = 'joined')::int as members,
         (select count(*) from people
           where status = 'joined' and joined_at > $2::timestamptz - interval '7 days')::int
           as new_7,
         (select count(*) from stayput.member_risk k join people p on p.id = k.member_id
           where k.company_id = $1 and p.status = 'joined' and k.level = 'high')::int as high,
         (select count(*) from stayput.member_risk k join people p on p.id = k.member_id
           where k.company_id = $1 and p.status = 'joined'
             and k.level = 'scheduled_departure')::int as departures,
         (select count(*) from people
           where joined_at <= $2::timestamptz - interval '30 days'
             and (status = 'joined' or left_at > $2::timestamptz - interval '30 days'))::int
           as base,
         (select count(*) from people
           where joined_at <= $2::timestamptz - interval '30 days' and status = 'joined')::int
           as kept,
         (select coalesce(sum(s.messages + s.reactions + s.forum_posts + s.lessons_completed), 0)
            from stayput.member_stats_daily s join people p on p.id = s.member_id
           where s.company_id = $1
             and s.day >= ($2::timestamptz - interval '30 days')::date)::int as activity,
         (select count(*) from done)::int as actions,
         (select count(*) from done where message_kind <> 'none')::int as messages,
         (select count(*) from done where type = 'payment_retry')::int as retries,
         (select count(*) from done
           where type in ('pause_offer', 'promo_offer', 'extend_offer', 'coaching_offer',
                          'affiliate_invite'))::int as offers,
         ((select count(*) from stayput.exit_surveys e
            where e.company_id = $1 and e.offer_type = 'pause_offer'
              and e.answered_at > $2::timestamptz - interval '30 days')
          + (select count(*) from stayput.creator_offers o
              where o.company_id = $1 and o.kind = 'pause_offer'
                and o.created_at > $2::timestamptz - interval '30 days'))::int as pauses,
         (select count(*) from stayput.actions
           where company_id = $1 and status = 'proposed')::int as pending_actions,
         (select coalesce(jsonb_agg(distinct member_id), '[]'::jsonb) from stayput.actions
           where company_id = $1 and status = 'proposed') as pending_members`,
      [companyId, at],
    );

    // Saved this month and last month, in the community's own calendar: the months begin at
    // midnight there, and a save counts up to now included, as on the chart. A save keeps the
    // currency of its payment, which Whop writes in lowercase (`usd`): compared in capitals, as
    // the memberships' and the chart's.
    const savedRows = await tx.query<{
      currency: string;
      category: 'direct' | 'influenced';
      this_month: boolean;
      amount: number;
      saves: number;
    }>(
      `with bounds as (
         select (date_trunc('month', $2::timestamptz at time zone $3) at time zone $3)
                  as this_start,
                (date_trunc('month', ($2::timestamptz at time zone $3) - interval '1 month')
                  at time zone $3) as last_start
       )
       select upper(v.currency) as currency, v.category, v.saved_at >= b.this_start as this_month,
              round(sum(v.amount), 2)::float8 as amount, count(*)::int as saves
         from stayput.saves v, bounds b
        where v.company_id = $1 and v.saved_at >= b.last_start
          and v.saved_at <= $2::timestamptz
        group by upper(v.currency), v.category, this_month`,
      [companyId, at, company.zone],
    );
    const savedCurrency =
      currency ??
      [...savedRows].sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency))[0]
        ?.currency ??
      null;
    const savedSum = (category: 'direct' | 'influenced', thisMonth: boolean) =>
      round2(
        savedRows
          .filter(
            (r) =>
              r.currency === savedCurrency && r.category === category && r.this_month === thisMonth,
          )
          .reduce((total, r) => total + r.amount, 0),
      );

    const history = await tx.query<RiskDay>(
      `select to_char(r.day, 'YYYY-MM-DD') as day,
              count(*) filter (where r.level = 'scheduled_departure')::int as departure,
              count(*) filter (where r.level = 'high')::int as high,
              count(*) filter (where r.level = 'medium')::int as medium,
              count(*) filter (where r.level = 'low')::int as low
         from stayput.risk_scores r
         join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
        where r.company_id = $1 and coalesce(m.access_level, '') <> 'admin'
          and r.day > ($2::timestamptz at time zone $3)::date - 30
        group by r.day order by r.day`,
      [companyId, at, company.zone],
    );

    // The chart: what was saved each day (direct saves) and what the members at risk that day
    // pay a month, in the community's main currency, from the 1st of the month 89 days ago to
    // today: 90 days at least, each month whole so that its balance adds up from its 1st (brief
    // v4 §8). A day without scores has no risk figure (null), not a zero.
    const chartCurrency = currency ?? savedCurrency ?? '';
    const revenue = await tx.query<RevenueDay>(
      `with paying as (
         select ms.member_id, sum(${monthlyPrice('ms')}) as monthly
           from stayput.memberships ms
           join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
          where ms.company_id = $1 and ms.status in ${PAYING_STATUSES_SQL}
            and ms.price > 0 and ms.billing_period_days > 0 and upper(ms.currency) = $4
            and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
          group by ms.member_id
       ), today as (
         select ($2::timestamptz at time zone $3)::date as day
       ), since as (
         select date_trunc('month', (day - 89)::timestamp)::date as day from today
       ), days as (
         select (t.day - n)::date as day
           from today t, since f, generate_series(0, t.day - f.day) as n
       ), scored as (
         select r.day, sum(case when r.level in ('high', 'scheduled_departure')
                                then coalesce(p.monthly, 0) else 0 end) as at_risk
           from stayput.risk_scores r
           left join paying p on p.member_id = r.member_id
          where r.company_id = $1 and r.day >= (select day from since)
          group by r.day
       ), saved as (
         select (v.saved_at at time zone $3)::date as day, sum(v.amount) as amount
           from stayput.saves v
          where v.company_id = $1 and v.category = 'direct' and upper(v.currency) = $4
            and v.saved_at >= ((select day from since)::timestamp at time zone $3)
            and v.saved_at <= $2::timestamptz
          group by 1
       )
       select to_char(d.day, 'YYYY-MM-DD') as day,
              round(coalesce(s.amount, 0), 2)::float8 as saved,
              round(k.at_risk, 2)::float8 as "atRisk"
         from days d
         left join saved s on s.day = d.day
         left join scored k on k.day = d.day
        order by d.day`,
      [companyId, at, company.zone, chartCurrency],
    );

    // The members StayPut saved in the chart's last 30 days, each once: the plans behind its
    // 30-day total (brief v4 §13), so its direct saves, in its currency, on its days.
    const [savedMembers] = await tx.query<{ members: number }>(
      `select count(distinct v.member_id)::int as members
         from stayput.saves v
        where v.company_id = $1 and v.category = 'direct' and upper(v.currency) = $4
          and v.saved_at >= ((($2::timestamptz at time zone $3)::date - 29)::timestamp
                             at time zone $3)
          and v.saved_at <= $2::timestamptz`,
      [companyId, at, company.zone, chartCurrency],
    );

    // Members at high risk nobody reached in 5 days, the « never contact » list aside.
    const unreached = await tx.query<{ member_id: string }>(
      `select k.member_id from stayput.member_risk k
         join stayput.members m on m.company_id = k.company_id and m.id = k.member_id
        where k.company_id = $1 and k.level = 'high' and m.status = 'joined'
          and not m.do_not_contact and coalesce(m.access_level, '') <> 'admin'
          and not exists (
            select 1 from stayput.actions a
             where a.company_id = k.company_id and a.member_id = k.member_id
               and a.message_kind <> 'none'
               and a.status in ('proposed', 'approved', 'scheduled', 'sent', 'simulated')
               and coalesce(a.sent_at, a.send_at, a.created_at)
                   > $2::timestamptz - make_interval(days => $3))
        order by k.score desc, k.member_id`,
      [companyId, at, REACHED_DAYS],
    );

    // The failed payments StayPut may retry now (0029), what they come to in the main currency.
    const [retryable] = await tx.query<{ payments: number; revenue: number }>(
      `select count(*)::int as payments,
              round(coalesce(sum(r.amount) filter (where r.currency = $3), 0), 2)::float8
                as revenue
         from stayput.payments_to_retry($1, $2::timestamptz) r`,
      [companyId, at, chartCurrency],
    );

    // Every member whose last payment failed: still unpaid, whatever StayPut is doing about it.
    const failed = await tx.query<{ member_id: string; amount: number; currency: string }>(
      `select l.member_id, l.amount::float8 as amount, upper(l.currency) as currency
         from (select distinct on (p.member_id) p.member_id, p.amount, p.currency, p.status
                 from stayput.payments p
                 join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
                where p.company_id = $1 and m.status = 'joined'
                  and coalesce(m.access_level, '') <> 'admin'
                order by p.member_id, p.whop_created_at desc, p.id) l
        where l.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])`,
      [companyId],
    );

    // Every member leaving (a cancellation scheduled, not over yet): whether a pause can still be
    // offered to them (reachable, no offer of the creator's open).
    const leaving = await tx.query<{ member_id: string; reachable: boolean }>(
      `select ms.member_id,
              bool_and(not m.do_not_contact and not exists (
                select 1 from stayput.creator_offers o
                 where o.company_id = ms.company_id and o.member_id = ms.member_id
                   and o.outcome = 'open' and o.expires_at > $2::timestamptz)) as reachable
         from stayput.memberships ms
         join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
        where ms.company_id = $1 and (ms.cancel_at_period_end or ms.status = 'canceling')
          and ms.status = any (array['trialing', 'active', 'past_due', 'canceling'])
          and ms.current_period_end > $2::timestamptz
          and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
        group by ms.member_id`,
      [companyId, at],
    );
    const failedRevenue = round2(
      failed.filter((p) => p.currency === chartCurrency).reduce((t, p) => t + p.amount, 0),
    );
    const leavingRevenue = round2(
      leaving.reduce((t, m) => t + (monthlyOf.get(m.member_id) ?? 0), 0),
    );

    // Today ends on the live figure, the one the hero row shows.
    const today = revenue.at(-1);
    if (today && currency) today.atRisk = round2(atRiskRevenue);

    const f = figures!;
    const pendingMembers = f.pending_members;
    return {
      currency: currency ?? savedCurrency,
      saved: {
        thisMonth: {
          direct: savedSum('direct', true),
          influenced: savedSum('influenced', true),
          saves: savedRows
            .filter((r) => r.currency === savedCurrency && r.this_month)
            .reduce((total, r) => total + r.saves, 0),
        },
        lastMonth: { direct: savedSum('direct', false) },
        otherCurrencies: savedRows.some((r) => r.currency !== savedCurrency),
      },
      monthlyRevenue: currency ? round2(totals.get(currency) ?? 0) : null,
      atRisk: {
        revenue: round2(atRiskRevenue),
        members: f.high + f.departures,
        departures: f.departures,
        high: f.high,
      },
      retention30: { rate: f.base > 0 ? f.kept / f.base : null, kept: f.kept, base: f.base },
      members: { total: f.members, newLast7Days: f.new_7 },
      memberActivity30d: f.activity,
      stayputActions30d: {
        total: f.actions,
        messages: f.messages,
        paymentRetries: f.retries,
        offers: f.offers,
        pauses: f.pauses,
        saved: savedMembers?.members ?? 0,
      },
      mode: company.mode,
      testMode: company.dry_run,
      riskHistory: history,
      revenueHistory: revenue,
      gettingStarted: {
        discord: company.discord,
        automation: company.mode === 'auto' || company.acted,
        reviewed: company.reviewed,
        guardrails: company.guardrails,
      },
      welcomed: company.welcomed,
      priority: choosePriority({
        mode: company.mode,
        pending: {
          actions: f.pending_actions,
          members: pendingMembers.length,
          revenue: round2(pendingMembers.reduce((t, id) => t + (monthlyOf.get(id) ?? 0), 0)),
        },
        retryable: { payments: retryable?.payments ?? 0, revenue: retryable?.revenue ?? 0 },
        leaving: leaving
          .filter((m) => m.reachable && (monthlyOf.get(m.member_id) ?? 0) > 0)
          .map((m) => ({ memberId: m.member_id, monthly: monthlyOf.get(m.member_id) ?? 0 }))
          .sort((a, b) => b.monthly - a.monthly || a.memberId.localeCompare(b.memberId)),
        unreached: unreached
          .map((u) => ({ memberId: u.member_id, monthly: monthlyOf.get(u.member_id) ?? 0 }))
          .sort((a, b) => b.monthly - a.monthly),
        unresolved: {
          failed: { members: failed.length, revenue: failedRevenue },
          leaving: { members: leaving.length, revenue: leavingRevenue },
        },
      }),
    };
  });
}

/**
 * What just happened, the newest first: what StayPut did (messages, retries, offers, money
 * saved) and what members did (joined, paid, failed to pay, scheduled to leave, were active).
 * Never the content of a message: only who, what kind and when.
 */
export async function readFeed(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<FeedView> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{
      id: string;
      at: string;
      by: FeedItem['by'];
      event: FeedItem['event'];
      member_id: string | null;
      member_name: string | null;
      amount: number | null;
      currency: string | null;
      source: FeedItem['source'] | null;
      activity: FeedItem['activity'] | null;
    }>(
      `with team as (
         select id from stayput.members
          where company_id = $1 and access_level = 'admin'
       ), stayput_side as (
         select 'act:' || a.id as id, coalesce(a.sent_at, a.updated_at) as at, 'stayput' as by,
                case
                  when a.type = 'payment_retry' then 'payment_retry'
                  when a.type in ('pause_offer', 'promo_offer', 'extend_offer', 'coaching_offer',
                                  'affiliate_invite') then 'offer_applied'
                  when a.status = 'simulated' then 'message_simulated'
                  else 'message_sent'
                end as event,
                a.member_id, null::float8 as amount, null::text as currency,
                null::text as source, null::text as activity
           from stayput.actions a
          where a.company_id = $1 and a.status in ('sent', 'simulated')
            and coalesce(a.sent_at, a.updated_at) <= $2::timestamptz
            and (a.message_kind <> 'none' or a.type in ('payment_retry', 'pause_offer',
                 'promo_offer', 'extend_offer', 'coaching_offer', 'affiliate_invite'))
          order by at desc limit $3
       ), saves_side as (
         select 'save:' || v.id, v.saved_at, 'stayput', 'saved', v.member_id, v.amount::float8,
                v.currency::text, null::text, null::text
           from stayput.saves v
          where v.company_id = $1 and v.saved_at <= $2::timestamptz
          order by v.saved_at desc limit $3
       ), payments_side as (
         select 'pay:' || p.id || ':' || p.status, p.whop_created_at, 'member',
                case when p.status = any (array['succeeded', 'paid']) then 'payment_succeeded'
                     else 'payment_failed' end,
                p.member_id, p.amount::float8, upper(p.currency)::text, null::text, null::text
           from stayput.payments p
          where p.company_id = $1 and p.member_id is not null
            and p.whop_created_at <= $2::timestamptz
            and p.status = any (array['succeeded', 'paid', 'failed', 'past_due',
                                      'uncollectible', 'unresolved'])
          order by p.whop_created_at desc limit $3
       ), joins_side as (
         select 'join:' || m.id, m.joined_at, 'member', 'joined', m.id, null::float8,
                null::text, null::text, null::text
           from stayput.members m
          where m.company_id = $1 and m.joined_at <= $2::timestamptz
            and coalesce(m.access_level, '') <> 'admin'
          order by m.joined_at desc limit $3
       ), leaving_side as (
         select 'leave:' || ms.id, coalesce(ms.canceled_at, ms.updated_at), 'member',
                'cancellation_scheduled', ms.member_id, null::float8, null::text, null::text,
                null::text
           from stayput.memberships ms
          where ms.company_id = $1 and ms.member_id is not null and ms.cancel_at_period_end
            and coalesce(ms.canceled_at, ms.updated_at) <= $2::timestamptz
          order by 2 desc limit $3
       ), activity_side as (
         select 'ev:' || e.id, e.occurred_at, 'member', 'activity', e.member_id, null::float8,
                null::text,
                case when e.type = 'discord_message' then 'discord'
                     when e.type = 'telegram_message' then 'telegram'
                     else 'whop' end,
                case when e.type = 'lesson_completed' then 'lesson'
                     when e.type = 'forum_post' then 'post'
                     when e.type = 'goal_update' then 'result'
                     else 'message' end
           from stayput.activity_events e
          where e.company_id = $1 and e.occurred_at <= $2::timestamptz
            and e.type in ('message', 'discord_message', 'telegram_message', 'lesson_completed',
                           'forum_post', 'goal_update')
            and e.member_id not in (select id from team)
          order by e.occurred_at desc limit $4
       ), everything as (
         select * from stayput_side union all select * from saves_side
         union all select * from payments_side union all select * from joins_side
         union all select * from leaving_side union all select * from activity_side
       )
       select x.id, x.at, x.by, x.event, x.member_id, m.display_name as member_name,
              x.amount, x.currency, x.source, x.activity
         from everything x
         left join stayput.members m on m.company_id = $1 and m.id = x.member_id
        where x.at is not null and (x.member_id is null or x.member_id not in (select id from team))
        order by x.at desc, x.id
        limit $3`,
      [companyId, now.toISOString(), FEED_LIMIT, FEED_ACTIVITY_LIMIT],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: new Date(r.at).toISOString(),
        by: r.by,
        event: r.event,
        memberId: r.member_id,
        memberName: r.member_name,
        ...(r.amount === null ? {} : { amount: r.amount }),
        ...(r.currency === null ? {} : { currency: r.currency }),
        ...(r.source === null ? {} : { source: r.source }),
        ...(r.activity === null ? {} : { activity: r.activity }),
      })),
    };
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
