import {
  WEEKLY_REPORT_ATTEMPTS,
  isExitReason,
  nextReportAt,
  weeklyNotification,
  type ExitReason,
  type SentWeeklyReport,
  type WeeklyReport,
  type WeeklyReportsView,
} from '@stayput/core';
import { WhopApiError, type WhopClient } from '@stayput/whop';
import { dashboardOf } from './dashboard';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * The Monday report (SPEC Phase 6.9). Every hour, the communities where it is Monday past 8:00
 * get the week that just ended, made once and kept (weekly_reports, 0035), then sent to their team
 * as a Whop notification (`account_id`: every team member). A refusal is retried at the next
 * hours, 3 times at most; the report stays readable in Analytics › Reports either way.
 */

/** Communities reported per hourly run at most: one Whop call each. */
export const WEEKLY_REPORT_BATCH = 20;

/** The reports the dashboard lists: 12 weeks. */
export const WEEKLY_REPORTS_SHOWN = 12;

/**
 * The week from `weekStart` (a Monday) to the next one, in `zone`: the members StayPut saved and
 * the money (direct saves, in the community's main currency; influenced apart), the members who
 * left, the departure survey's answers; then the priority the dashboard gives at `now`.
 */
export async function makeWeeklyReport(
  db: TransactionalDb,
  companyId: string,
  weekStart: string,
  zone: string,
  now: Date,
): Promise<WeeklyReport> {
  return db.transaction(async (tx) => {
    const home = await dashboardOf(tx, companyId, now);
    const currency = home?.currency ?? null;
    const [figures] = await tx.query<{
      members: number;
      direct: number;
      influenced: number;
      lost: number;
    }>(
      `with bounds as (
         select ($2::date::timestamp at time zone $3) as start_at,
                (($2::date + 7)::timestamp at time zone $3) as end_at
       ), saved as (
         select v.member_id, v.category, v.amount
           from stayput.saves v, bounds b
          where v.company_id = $1 and upper(v.currency) = $5
            and v.saved_at >= b.start_at and v.saved_at < b.end_at
       ), people as (
         -- When a member left: the end of their last period, else when their row last changed
         -- (the dashboard's retention reads it the same way).
         select case when m.status = 'left' then coalesce(
                  (select max(ms.current_period_end) from stayput.memberships ms
                    where ms.company_id = m.company_id and ms.member_id = m.id
                      and ms.current_period_end <= $4::timestamptz),
                  m.updated_at) end as left_at
           from stayput.members m
          where m.company_id = $1 and coalesce(m.access_level, '') <> 'admin'
       )
       select (select count(distinct member_id) from saved where category = 'direct')::int
                as members,
              (select round(coalesce(sum(amount), 0), 2) from saved
                where category = 'direct')::float8 as direct,
              (select round(coalesce(sum(amount), 0), 2) from saved
                where category = 'influenced')::float8 as influenced,
              (select count(*) from people p, bounds b
                where p.left_at >= b.start_at and p.left_at < b.end_at)::int as lost`,
      [companyId, weekStart, zone, now.toISOString(), currency],
    );
    const answers = await tx.query<{ reason: string; count: number }>(
      `select e.reason, count(*)::int as count
         from stayput.exit_surveys e
        where e.company_id = $1 and e.reason is not null
          and e.answered_at >= ($2::date::timestamp at time zone $3)
          and e.answered_at < (($2::date + 7)::timestamp at time zone $3)
        group by e.reason`,
      [companyId, weekStart, zone],
    );
    const f = figures!;
    return {
      weekStart,
      currency,
      saved: { members: f.members, direct: f.direct, influenced: f.influenced },
      lost: f.lost,
      reasons: answers
        .flatMap((a): { reason: ExitReason; count: number }[] =>
          isExitReason(a.reason) ? [{ reason: a.reason, count: a.count }] : [],
        )
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      priority: home?.priority ?? null,
    };
  });
}

/**
 * Every hour: the reports due, each made once (a retry sends the report first made), then sent.
 * Returns what was sent and what Whop refused this run.
 */
export async function sendWeeklyReports(
  db: TransactionalDb,
  whop: WhopClient | null,
  now: Date,
  limit = WEEKLY_REPORT_BATCH,
): Promise<{ sent: string[]; failed: string[] }> {
  const at = now.toISOString();
  const due = await db.query<{
    company_id: string;
    week_start: string;
    zone: string;
    locale: string;
  }>(
    `select company_id, to_char(week_start, 'YYYY-MM-DD') as week_start, zone, locale
       from stayput.weekly_reports_due($1::timestamptz, $2)`,
    [at, limit],
  );
  const sent: string[] = [];
  const failed: string[] = [];
  for (const company of due) {
    const report = await keptReport(db, company.company_id, company.week_start, company.zone, now);
    const error = await notifyTeam(
      whop,
      company.company_id,
      company.week_start,
      report,
      company.locale,
    );
    if (error === null) {
      await db.query(
        `update stayput.weekly_reports set sent_at = $3::timestamptz, error = null
          where company_id = $1 and week_start = $2::date`,
        [company.company_id, company.week_start, at],
      );
      sent.push(company.company_id);
    } else {
      await db.query(
        `update stayput.weekly_reports set attempts = attempts + 1, error = left($3, 500)
          where company_id = $1 and week_start = $2::date`,
        [company.company_id, company.week_start, error],
      );
      failed.push(company.company_id);
    }
  }
  return { sent, failed };
}

/** The week's report as first made: made and kept now when it is the first attempt. */
async function keptReport(
  db: TransactionalDb,
  companyId: string,
  weekStart: string,
  zone: string,
  now: Date,
): Promise<WeeklyReport> {
  const read = () =>
    db.query<{ report: WeeklyReport }>(
      `select report from stayput.weekly_reports where company_id = $1 and week_start = $2::date`,
      [companyId, weekStart],
    );
  const [kept] = await read();
  if (kept) return kept.report;
  const report = await makeWeeklyReport(db, companyId, weekStart, zone, now);
  await db.query(
    `insert into stayput.weekly_reports (company_id, week_start, report, created_at)
     values ($1, $2::date, $3::text::jsonb, $4::timestamptz)
     on conflict do nothing`,
    [companyId, weekStart, JSON.stringify(report), now.toISOString()],
  );
  // Another run may have kept its own first: that one is sent.
  const [first] = await read();
  return first?.report ?? report;
}

/** The notification to every team member of the community; null when Whop took it. */
async function notifyTeam(
  whop: WhopClient | null,
  companyId: string,
  weekStart: string,
  report: WeeklyReport,
  locale: string,
): Promise<string | null> {
  if (!whop) return 'the Whop API key is not set';
  const { title, content } = weeklyNotification(report, locale === 'fr' ? 'fr' : 'en');
  try {
    await whop.request('POST', '/notifications', {
      body: { account_id: companyId, title, content },
      // One notification per community and week, whatever the retries.
      idempotencyKey: `stayput-weekly-${companyId}-${weekStart}`,
    });
    return null;
  } catch (error) {
    if (error instanceof WhopApiError) return `${error.status} ${error.type}: ${error.message}`;
    return error instanceof Error ? error.message : 'unknown error';
  }
}

/** Analytics › Reports: on or off, when the next one goes, the last 12 weeks. Under RLS. */
export async function readWeeklyReports(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<WeeklyReportsView | null> {
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<{ zone: string; enabled: boolean | null }>(
      `select c.timezone as zone, (s.options ->> 'weekly_report')::boolean as enabled
         from stayput.companies c
         left join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    );
    if (!company) return null;
    const rows = await reportsOf(tx, companyId);
    return {
      enabled: company.enabled !== false,
      nextAt: new Date(nextReportAt(now.getTime(), company.zone)).toISOString(),
      timezone: company.zone,
      reports: rows,
    };
  });
}

async function reportsOf(tx: Db, companyId: string): Promise<SentWeeklyReport[]> {
  const rows = await tx.query<{
    report: WeeklyReport;
    sent_at: Date | string | null;
    attempts: number;
  }>(
    `select r.report, r.sent_at, r.attempts
       from stayput.weekly_reports r
      where r.company_id = $1
      order by r.week_start desc
      limit $2`,
    [companyId, WEEKLY_REPORTS_SHOWN],
  );
  return rows.map((r) => ({
    ...r.report,
    sentAt: r.sent_at === null ? null : new Date(r.sent_at).toISOString(),
    failed: r.sent_at === null && r.attempts >= WEEKLY_REPORT_ATTEMPTS,
  }));
}

/** The report on or off (requireCreator checked the team member with Whop). */
export async function saveWeeklyReportSetting(
  db: Db,
  companyId: string,
  enabled: boolean,
): Promise<void> {
  await db.query('select stayput.save_weekly_report_setting($1, $2)', [companyId, enabled]);
}
