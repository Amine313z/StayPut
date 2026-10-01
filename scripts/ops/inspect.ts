/**
 * What the database holds, without anything personal: the schema version, each company's
 * synchronization (streams, errors) and row counts, and the webhook deliveries by type and
 * status. Names, user ids, e-mails and payloads are never read.
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
