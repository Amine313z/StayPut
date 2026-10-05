/**
 * What the database holds, without anything personal: the schema version, each company's
 * synchronization (streams, errors), row counts and risk levels, and the webhook deliveries by
 * type and status. Names, user ids, e-mails and payloads are never read.
 *
 *   DATABASE_URL=… npx tsx scripts/ops/inspect.ts
 *
 * The Inspect workflow runs it (GitHub → Actions → Inspect → Run workflow); the report also
 * goes to the run's summary page.
 */
import { appendFileSync } from 'node:fs';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL.');
  process.exit(1);
}
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  max: 1,
  ssl: local ? false : 'require',
  prepare: !url.includes(':6543'),
  onnotice: () => {},
});

const lines: string[] = [];
const out = (line = '') => {
  lines.push(line);
  console.info(line);
};
const table = (rows: Record<string, unknown>[]) => {
  if (rows.length === 0) {
    out('(none)');
    return;
  }
  const columns = Object.keys(rows[0]!);
  out(`| ${columns.join(' | ')} |`);
  out(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows) out(`| ${columns.map((c) => cell(row[c])).join(' | ')} |`);
};
const cell = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().replace('.000Z', 'Z');
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\|/g, '/');
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value).replace(/\|/g, '/');
};

async function main() {
  const [schema] = await sql`select max(name) as latest from stayput.schema_migrations`;
  out(`## StayPut database, ${new Date().toISOString()}`);
  out();
  out(`Latest migration: ${String(schema?.latest)}`);
  out();

  const companies = await sql`
    select c.id, c.status, c.is_demo, c.installed_at, s.last_synced_at, s.lease_until,
           s.stats_dirty_since,
           -- 0040: when Whop withdrew access, if it did (read whole: older schemas have neither).
           to_jsonb(c) ->> 'access_lost_at' as access_lost_at, c.uninstalled_at
      from stayput.companies c left join stayput.company_sync s on s.company_id = c.id
     order by c.installed_at`;
  out('### Companies');
  table(companies);

  for (const { id } of companies) {
    out();
    out(`### ${String(id)}`);
    out();
    table(
      await sql`
        select stream, backfill_done, cursor is not null as in_progress, last_pass_at,
               last_run_at, left(last_error, 120) as last_error
          from stayput.sync_state where company_id = ${id as string} order by stream`,
    );
    out();
    table(
      await sql`
        select 'members' as rows, count(*) filter (where status = 'joined') as joined,
               count(*) filter (where status = 'left') as left_, count(*) as total
          from stayput.members where company_id = ${id as string}
        union all
        select 'memberships', count(*) filter (where status in ('active', 'trialing')),
               count(*) filter (where cancel_at_period_end), count(*)
          from stayput.memberships where company_id = ${id as string}
        union all
        select 'payments', count(*) filter (where status in ('succeeded', 'paid')),
               count(*) filter (where status in ('failed', 'past_due')), count(*)
          from stayput.payments where company_id = ${id as string}
        union all
        select 'activity_events', count(*) filter (where occurred_at > now() - interval '30 days'),
               count(distinct member_id), count(*)
          from stayput.activity_events where company_id = ${id as string}
        union all
        select 'pending_activity', 0, count(distinct user_id), count(*)
          from stayput.pending_activity where company_id = ${id as string}
        union all
        select 'member_stats_daily', 0, count(distinct member_id), count(*)
          from stayput.member_stats_daily where company_id = ${id as string}`,
    );
    // Discord and Telegram (migration 0007): what is connected, who is linked, what was counted.
    const [sources] = await sql`
      select to_regclass('stayput.discord_guilds') is not null as present`;
    if (sources?.present) {
      out();
      table(
        await sql`
          select 'discord' as source,
                 (select count(*) from stayput.discord_guilds
                   where company_id = ${id as string}) as connected,
                 (select coalesce(sum(cardinality(channel_ids)), 0) from stayput.discord_guilds
                   where company_id = ${id as string}) as channels,
                 (select count(*) from stayput.members
                   where company_id = ${id as string} and discord_user_id is not null)
                   as linked_members,
                 (select count(*) from stayput.activity_events
                   where company_id = ${id as string} and type = 'discord_message') as events
          union all
          select 'telegram',
                 (select count(*) from stayput.telegram_chats
                   where company_id = ${id as string} and left_at is null),
                 0,
                 (select count(*) from stayput.members
                   where company_id = ${id as string} and telegram_user_id is not null),
                 (select count(*) from stayput.activity_events
                   where company_id = ${id as string} and type = 'telegram_message')`,
      );
      // Each Telegram group, without its name or id: a group Telegram turns into a supergroup
      // (a channel's discussion group, say) changes id, and its messages must follow it.
      out();
      table(
        await sql`
          select case when c.chat_id like '-100%' then 'supergroup' else 'group' end as kind,
                 c.connected_at, c.left_at, c.last_message_at,
                 (select count(*) from stayput.pending_activity p
                   where p.company_id = c.company_id and p.metadata ->> 'chat_id' = c.chat_id)
                   as pending_messages
            from stayput.telegram_chats c
           where c.company_id = ${id as string}
           order by c.connected_at`,
      );
      // Activity waiting for its account to be linked to a member, per platform.
      out();
      table(
        await sql`
          select split_part(user_id, ':', 1) as platform, count(distinct user_id) as accounts,
                 count(*) as messages, max(occurred_at) as last_at
            from stayput.pending_activity
           where company_id = ${id as string} and user_id like '%:%'
           group by 1 order by 1`,
      );
      // The accounts seen writing (migration 0012): how each got its member, without a name.
      const [accounts] = await sql`
        select to_regclass('stayput.platform_accounts') is not null as present`;
      if (accounts?.present) {
        out();
        table(
          await sql`
            select pa.platform,
                   coalesce(case pa.platform when 'discord' then m.discord_link
                                             else m.telegram_link end,
                            case when pa.dismissed_at is not null then 'dismissed'
                                 else 'not tied' end) as member,
                   count(*) as accounts,
                   count(*) filter (where pa.display_name is null and pa.username is null)
                     as without_names
              from stayput.platform_accounts pa
              left join stayput.members m
                on m.company_id = pa.company_id
               and case pa.platform when 'discord' then m.discord_user_id
                                    else m.telegram_user_id end = pa.account_id
             where pa.company_id = ${id as string}
             group by 1, 2 order by 1, 2`,
        );
      }
      // Who is on each server and in each group (migration 0017): there or gone, against the
      // head count Discord or Telegram gives, and how the server's member list reads. Counts.
      const [presence] = await sql`
        select to_regclass('stayput.platform_presence') is not null as present`;
      if (presence?.present) {
        out();
        table(
          await sql`
            select x.platform, x.kind, x.member_count,
                   (select count(*) from stayput.platform_presence p
                     where p.company_id = ${id as string} and p.platform = x.platform
                       and p.place_id = x.place_id and p.left_at is null) as here,
                   (select count(*) from stayput.platform_presence p
                     where p.company_id = ${id as string} and p.platform = x.platform
                       and p.place_id = x.place_id and p.left_at is not null) as left_,
                   x.list_error
              from (select 'discord' as platform, 'server' as kind, g.guild_id as place_id,
                           g.member_count,
                           (select left(s.last_error, 60) from stayput.sync_state s
                             where s.company_id = g.company_id
                               and s.stream = 'discord_members:' || g.guild_id) as list_error
                      from stayput.discord_guilds g where g.company_id = ${id as string}
                    union all
                    select 'telegram', 'group', t.chat_id, t.member_count, null
                      from stayput.telegram_chats t
                     where t.company_id = ${id as string} and t.left_at is null) x
             order by 1`,
        );
      }
    }
    // How long the blocks of Integrations › Activity take to read (the founder's « stays on
    // Loading… », brief v4 §9.6), read as the team reads them (role stayput_user, a verified
    // admin's id, never printed), twice each, and the calls to Discord or Telegram a read makes
    // before it answers. Durations and counts only; nothing is written.
    const [readers] = await sql`
      select to_regprocedure('stayput.platform_people(text, timestamptz)') is not null as present`;
    const [admin] = readers?.present
      ? await sql`
          select user_id from stayput.company_admins
           where company_id = ${id as string} and verified_at is not null
           order by verified_at limit 1`
      : [];
    if (admin) {
      const timings: Record<string, unknown>[] = [];
      await sql.begin(async (tx) => {
        await tx`select set_config('role', 'stayput_user', true),
                        set_config('stayput.user_id', ${admin.user_id as string}, true)`;
        const reads: [string, () => Promise<{ view: string | null }[]>][] = [
          [
            'activity',
            () => tx`select stayput.platform_activity(${id as string}, now())::text as view`,
          ],
          [
            'accounts',
            () => tx`select stayput.platform_accounts_view(${id as string})::text as view`,
          ],
          [
            'people',
            () => tx`select stayput.platform_people(${id as string}, now())::text as view`,
          ],
        ];
        for (const [block, read] of reads) {
          const durations: number[] = [];
          let size = 0;
          let answered = false;
          for (let pass = 0; pass < 2; pass++) {
            const start = performance.now();
            const [row] = await read();
            durations.push(Math.round(performance.now() - start));
            size = row?.view?.length ?? 0;
            answered = row?.view != null;
          }
          timings.push({
            block,
            first_ms: durations[0],
            again_ms: durations[1],
            kb: Math.round((size / 1024) * 10) / 10,
            answered,
          });
        }
      });
      out();
      table(timings);
      out();
      table(
        await sql`
          select (select count(*) from stayput.accounts_without_names(${id as string}, 10))
                   as names_to_ask,
                 (select count(*) from stayput.discord_guilds g
                   where g.company_id = ${id as string}
                     and (g.member_count_at is null
                          or g.member_count_at < now() - interval '10 minutes'))
                 + (select count(*) from stayput.telegram_chats t
                     where t.company_id = ${id as string} and t.left_at is null
                       and (t.member_count_at is null
                            or t.member_count_at < now() - interval '10 minutes'))
                   as places_to_count`,
      );
    }
    // The Alumni offer (migration 0018): which steps of its creation are done on Whop, and who
    // entered, left or came back; its follow-ups (0019) and the return codes they made. Counts
    // only.
    const [alumni] = await sql`
      select to_regclass('stayput.alumni_offers') is not null as present`;
    if (alumni?.present) {
      out();
      table(
        await sql`
          select (o.company_id is not null) as offer, (o.product_id is not null) as product,
                 (o.plan_id is not null) as variant, (o.experience_id is not null) as experience,
                 (o.completed_at is not null) as ready,
                 (select count(*) from stayput.alumni_members a
                   where a.company_id = ${id as string} and a.status = 'entered') as entered,
                 (select count(*) from stayput.alumni_members a
                   where a.company_id = ${id as string} and a.status = 'left') as left_,
                 (select count(*) from stayput.alumni_members a
                   where a.company_id = ${id as string} and a.status = 'returned') as returned,
                 (select count(*) from stayput.actions f
                   where f.company_id = ${id as string} and f.type = 'alumni_followup')
                   as followups,
                 (select count(*) from stayput.actions f
                   where f.company_id = ${id as string} and f.type = 'alumni_followup'
                     and f.status = 'sent' and f.result ->> 'code' is not null) as codes_sent
            from (select ${id as string}::text as company_id) c
            left join stayput.alumni_offers o on o.company_id = c.company_id`,
      );
    }
    // The dashboard's proof (SPEC Phase 6): the welcome, the money saved by kind, the departure
    // answers, the Monday reports (0035), the benchmarks shared (0036), the badge (0037), the
    // team (0038) and what the Alumni got back (0039). Counts and sums only.
    const [phase6] = await sql`
      select to_regclass('stayput.weekly_reports') is not null as present`;
    if (phase6?.present) {
      out();
      table(
        await sql`
          select c.niche, s.welcomed_at,
                 coalesce((s.options ->> 'weekly_report')::boolean, true) as monday_report,
                 coalesce((s.options ->> 'benchmarks_opt_in')::boolean, false) as shares_figures,
                 coalesce((s.options ->> 'public_badge')::boolean, false) as public_badge,
                 (select count(*) from stayput.company_admins a
                   where a.company_id = c.id) as team_opened
            from stayput.companies c
            left join stayput.company_settings s on s.company_id = c.id
           where c.id = ${id as string}`,
      );
      out();
      table(
        await sql`
          select category, save_type, currency, count(*) as saves, sum(amount) as amount,
                 max(saved_at) as last_saved_at
            from stayput.saves where company_id = ${id as string}
           group by 1, 2, 3 order by 1, 2, 3`,
      );
      out();
      table(
        await sql`
          select coalesce(reason, 'none') as departure_reason, count(*) as answers,
                 count(*) filter (where outcome = 'accepted') as offers_accepted
            from stayput.exit_surveys where company_id = ${id as string}
           group by 1 order by 2 desc, 1`,
      );
      out();
      table(
        await sql`
          select week_start, sent_at, attempts, left(error, 80) as error,
                 report -> 'saved' ->> 'direct' as saved_direct,
                 report ->> 'lost' as lost
            from stayput.weekly_reports where company_id = ${id as string}
           order by week_start desc limit 4`,
      );
      out();
      table(
        await sql`
          select b.metric, b.period_month, b.contributors, b.value
            from stayput.benchmarks b
            join stayput.companies c on c.niche = b.niche and c.id = ${id as string}
           where b.period_month = (select max(period_month) from stayput.benchmarks)
           order by b.metric`,
      );
      out();
      table(
        await sql`
          select (select count(*) from stayput.webhook_events w
                   where w.company_id = ${id as string}) as deliveries_kept,
                 (select count(*) from stayput.activity_events e
                   where e.company_id = ${id as string}
                     and e.occurred_at < now() - interval '12 months') as activity_over_12_months,
                 (select coalesce(sum(cs.eligible_90), 0) from stayput.cohort_stats cs
                   where cs.company_id = ${id as string}
                     and cs.cohort_month >= date_trunc('month', now()) - interval '12 months')
                   as badge_members,
                 (select count(*) from stayput.alumni_members a
                   where a.company_id = ${id as string}) as alumni_ever,
                 (select coalesce(sum(p.amount), 0) from stayput.alumni_members a
                   join stayput.payments p
                     on p.company_id = a.company_id and p.member_id = a.member_id
                  where a.company_id = ${id as string} and a.status = 'returned'
                    and p.status in ('succeeded', 'paid') and p.amount > 0
                    and p.paid_at >= coalesce(a.entered_at, a.departed_at)) as alumni_recovered`,
      );
    }
    // The actions (migration 0009): how many of each type are at each step of their cycle,
    // with the reasons the guardrails gave. Counts only.
    const [actions] = await sql`
      select exists (select 1 from information_schema.columns
                      where table_schema = 'stayput' and table_name = 'actions'
                        and column_name = 'dedupe_key') as present`;
    if (actions?.present) {
      out();
      table(
        await sql`
          select type, status, coalesce(blocked_reason, '') as reason, count(*) as actions,
                 min(send_at) as first_send_at, max(send_at) as last_send_at
            from stayput.actions where company_id = ${id as string}
           group by 1, 2, 3 order by 1, 2, 3`,
      );
      // How the actions run: the mode, the test mode, the stops, the hours and their zone, and
      // whether StayPut knows the experience its notifications go through.
      out();
      table(
        await sql`
          select c.mode, c.locale, c.timezone, s.dry_run, s.kill_switch,
                 (select g.kill_switch from stayput.app_settings g) as global_stop,
                 concat(s.quiet_hours_start, '-', s.quiet_hours_end) as quiet_hours,
                 s.default_send_hour, c.experience_id is not null as experience_known
            from stayput.companies c
            join stayput.company_settings s on s.company_id = c.id
           where c.id = ${id as string}`,
      );
    }
    // The risk score (migration 0008): members per level, when they were scored, the history
    // kept, and the weekly analyses. Counts only, like the rest.
    const [detection] = await sql`
      select to_regclass('stayput.member_risk') is not null as present`;
    if (detection?.present) {
      out();
      table(
        await sql`
          select level, count(*) as members,
                 count(*) filter (where inactive_newcomer) as inactive_newcomers,
                 min(score) as min_score, max(score) as max_score,
                 max(computed_at) as last_computed
            from stayput.member_risk where company_id = ${id as string}
           group by level order by max(score) desc`,
      );
      out();
      table(
        await sql`
          select (select count(*) from stayput.risk_scores
                   where company_id = ${id as string}) as history_rows,
                 (select count(distinct day) from stayput.risk_scores
                   where company_id = ${id as string}) as history_days,
                 (select count(*) from stayput.cohort_stats
                   where company_id = ${id as string}) as cohorts,
                 (select count(*) from stayput.cohort_stats
                   where company_id = ${id as string} and alert_horizon is not null)
                   as cohort_alerts,
                 (select count(*) from stayput.lesson_dropoff_stats
                   where company_id = ${id as string}) as lessons,
                 (select count(*) from stayput.lesson_dropoff_stats
                   where company_id = ${id as string} and flagged) as blocking_lessons,
                 (select analyses_at from stayput.company_sync
                   where company_id = ${id as string}) as analyses_at`,
      );
    }
  }

  out();
  out('### Webhook deliveries');
  table(
    await sql`
      select type, status, count(*) as deliveries, max(received_at) as last_received,
             max(attempts) as max_attempts
        from stayput.webhook_events group by type, status order by type, status`,
  );

  // SPEC Phase 8.5: each scheduled job's last runs, and the error log (its messages are
  // scrubbed when recorded: no person, no secret). Absent before 0042.
  const operations = await sql`select to_regclass('stayput.job_runs') is not null as ready`;
  if (operations[0]?.ready) {
    out();
    out('### Scheduled jobs');
    table(
      await sql`
        select job, runs, failures, last_finished_at, last_ok_at, last_failed_at,
               last_duration_ms, left(last_error, 120) as last_error
          from stayput.job_runs order by job`,
    );
    out();
    out('### Error log (30 days)');
    table(
      await sql`
        select source, company_id, count, first_at, last_at, left(message, 160) as message
          from stayput.error_log order by last_at desc limit 20`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    }
  });
