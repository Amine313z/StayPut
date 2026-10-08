import {
  RISK_LEVELS,
  addDays,
  calibrateStay,
  isExitReason,
  observedSaveRate,
  type ActivityDay,
  type ExitReason,
  type InsightsOverview,
  type RiskLevel,
  type StaySample,
} from '@stayput/core';
import { withUser, type TransactionalDb } from './db';
import { PAYING_STATUSES_SQL, monthlyPrice } from './members';

/**
 * Analytics › Overview (brief v4 §9.5): the 90-day forecast's figures (SPEC 6.5–6.6), why members
 * leave (the departure survey, SPEC 6.8), what they did over 30 days. Read as the Whop user under
 * RLS, like the rest of the creator view; the team's members never count.
 */

/** The days the reasons and the save rate look back on. */
const LOOKBACK_DAYS = 90;

/** An action needs this long to be judged: what it saved comes within it (SPEC 6.4: 7–14 days). */
const SETTLE_DAYS = 14;

/** The actions that reach a member at risk: what acting means in the forecast. */
export const REACHING_ACTIONS = [
  'payment_retry',
  'payment_failed_notice',
  'payment_action_notice',
  'exit_survey',
  'pause_offer',
  'promo_offer',
  'coaching_offer',
  'affiliate_invite',
  'extend_offer',
  'high_risk_message',
  'creator_message',
  'creator_note',
  'creator_offer',
] as const;

export async function readInsightsOverview(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<InsightsOverview | null> {
  const at = now.toISOString();
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<{ today: Date | string; first_day: Date | string | null }>(
      `select ($2::timestamptz at time zone coalesce(c.timezone, 'UTC'))::date as today,
              (select min(r.day) from stayput.risk_scores r where r.company_id = c.id)
                as first_day
         from stayput.companies c where c.id = $1`,
      [companyId, at],
    );
    if (!company) return null;
    const today = day(company.today);

    // What each risk level brings in a month, per currency (as the dashboard counts it).
    const paying = await tx.query<{ currency: string; level: string; monthly: number }>(
      `select upper(ms.currency) as currency, coalesce(k.level, 'low') as level,
              round(sum(${monthlyPrice('ms')}), 2)::float8 as monthly
         from stayput.memberships ms
         join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
         left join stayput.member_risk k
           on k.company_id = ms.company_id and k.member_id = ms.member_id
        where ms.company_id = $1 and ms.status in ${PAYING_STATUSES_SQL}
          and ms.price > 0 and ms.billing_period_days > 0 and ms.currency is not null
          and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
        group by upper(ms.currency), coalesce(k.level, 'low')`,
      [companyId],
    );
    const totals = new Map<string, number>();
    for (const p of paying) totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.monthly);
    const currency =
      [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const revenue = Object.fromEntries(RISK_LEVELS.map((level) => [level, 0])) as Record<
      RiskLevel,
      number
    >;
    for (const p of paying) {
      if (p.currency === currency && isLevel(p.level)) {
        revenue[p.level] = Math.round((revenue[p.level] + p.monthly) * 100) / 100;
      }
    }

    // The community's own months: the members at each level on a day 30 and 60 days ago, and
    // those still there a month later (as the dashboard says when a member left).
    const samples = await tx.query<{ level: string; sampled: number; stayed: number }>(
      `with people as (
         select m.id, m.status,
                case when m.status = 'left' then coalesce(
                  (select max(ms.current_period_end) from stayput.memberships ms
                    where ms.company_id = m.company_id and ms.member_id = m.id
                      and ms.current_period_end <= $3::timestamptz),
                  m.updated_at) end as left_at
           from stayput.members m
          where m.company_id = $1 and coalesce(m.access_level, '') <> 'admin'
       ), windows (start_day, end_day) as (
         values ($2::date - 30, $2::date), ($2::date - 60, $2::date - 30)
       )
       select r.level, count(*)::int as sampled,
              count(*) filter (where p.status = 'joined'
                                  or (p.left_at at time zone 'UTC')::date > w.end_day)::int
                as stayed
         from windows w
         join stayput.risk_scores r on r.company_id = $1 and r.day = w.start_day
         join people p on p.id = r.member_id
        group by r.level`,
      [companyId, today, at],
    );
    const history = company.first_day === null ? 0 : daysBetween(day(company.first_day), today);
    const { stay, calibrated } = calibrateStay(
      samples.flatMap((s): StaySample[] =>
        isLevel(s.level) ? [{ level: s.level, sampled: s.sampled, stayed: s.stayed }] : [],
      ),
      history,
    );

    // What acting saved: the members at risk StayPut reached, long enough ago to be judged, and
    // those of them it saved (a direct save after it reached them).
    const [reach] = await tx.query<{ reached: number; saved: number }>(
      `with reached as (
         select a.member_id, min(coalesce(a.sent_at, a.updated_at)) as first_at
           from stayput.actions a
           join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
          where a.company_id = $1 and a.status = 'sent'
            and a.type = any(string_to_array($2, ','))
            and coalesce(a.sent_at, a.updated_at)
                between $3::timestamptz - make_interval(days => $4)
                    and $3::timestamptz - make_interval(days => $5)
            and coalesce(m.access_level, '') <> 'admin'
          group by a.member_id
       )
       select count(*)::int as reached,
              count(*) filter (where exists (
                select 1 from stayput.saves s
                 where s.company_id = $1 and s.member_id = r.member_id
                   and s.category = 'direct' and s.saved_at >= r.first_at))::int as saved
         from reached r`,
      [companyId, REACHING_ACTIONS.join(','), at, LOOKBACK_DAYS, SETTLE_DAYS],
    );
    const save = observedSaveRate(reach?.reached ?? 0, reach?.saved ?? 0);

    // Why members leave: the departure survey's answers of the last 90 days.
    const answers = await tx.query<{ reason: string; count: number }>(
      `select reason, count(*)::int as count from stayput.exit_surveys
        where company_id = $1 and reason is not null
          and answered_at > $2::timestamptz - make_interval(days => $3)
        group by reason`,
      [companyId, at, LOOKBACK_DAYS],
    );
    const reasons = answers
      .flatMap((a): { reason: ExitReason; count: number }[] =>
        isExitReason(a.reason) ? [{ reason: a.reason, count: a.count }] : [],
      )
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

    // What the members did, day by day (the community's days), over the last 30.
    const days = await tx.query<{ day: Date | string; actions: number; members: number }>(
      `select s.day,
              sum(s.messages + s.reactions + s.forum_posts + s.lessons_completed)::int as actions,
              count(*) filter (
                where s.messages + s.reactions + s.forum_posts + s.lessons_completed > 0)::int
                as members
         from stayput.member_stats_daily s
         join stayput.members m on m.company_id = s.company_id and m.id = s.member_id
        where s.company_id = $1 and s.day > $2::date - 30 and s.day <= $2::date
          and coalesce(m.access_level, '') <> 'admin'
        group by s.day`,
      [companyId, today],
    );
    const byDay = new Map(days.map((d) => [day(d.day), d]));
    const activity: ActivityDay[] = Array.from({ length: 30 }, (_, i) => {
      const date = addDays(today, i - 29);
      const found = byDay.get(date);
      return { day: date, actions: found?.actions ?? 0, members: found?.members ?? 0 };
    });

    return {
      currency,
      revenue,
      stay,
      calibrated,
      saveRate: save.rate,
      saveRateObserved: save.observed,
      reasons,
      activity,
    };
  });
}

function isLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value);
}

/** A date as `YYYY-MM-DD`, as Postgres gives a `date` (a Date at midnight UTC, or text). */
function day(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
