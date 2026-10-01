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
           s.stats_dirty_since
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
