-- SPEC Phase 8.5, robustness: what went wrong, where StayPut stands, and Whop's failed
-- deliveries replayed on demand.
-- 1. error_log: an error once per place, community and message, with how many times and when
--    first and last. The Worker scrubs each message before (no secret, no person's id, no
--    e-mail, no phone number). Kept 30 days after it last happened.
-- 2. job_runs: each scheduled job's last run, last success and last failure.
-- 3. operator_status: what the internal status page reads, never what a delivery contains.
-- 4. Whop's failed deliveries replayed from that page, even those the replays of every ten
--    minutes gave up on (5 attempts).

-- 1. The errors ----------------------------------------------------------------------------------

create table stayput.error_log (
  id bigint generated always as identity primary key,
  -- Where it happened: `job:<name>`, `request`, `background:<what>`.
  source text not null check (source ~ '^[a-z][a-z0-9:_ -]{0,79}$'),
  -- The community concerned, when there is one. No foreign key: an error may name a community
  -- that never opened StayPut, or is gone (its errors go with its data, delete_company_data).
  company_id text,
  message text not null check (length(message) between 1 and 500),
  first_at timestamptz not null,
  last_at timestamptz not null,
  count integer not null default 1 check (count >= 1)
);
create unique index error_log_once
  on stayput.error_log (source, (coalesce(company_id, '')), message);
create index error_log_last on stayput.error_log (last_at);
-- The Worker's alone: no policy.
alter table stayput.error_log enable row level security;

create function stayput.log_error(p_source text, p_company text, p_message text,
                                  p_at timestamptz)
returns void
language sql set search_path = ''
as $$
  insert into stayput.error_log as e (source, company_id, message, first_at, last_at)
  values (p_source, p_company, left(p_message, 500), p_at, p_at)
  on conflict (source, (coalesce(company_id, '')), message)
  do update set count = e.count + 1, last_at = greatest(e.last_at, excluded.last_at);
$$;

-- Every hour, with the deliveries: an error that has not happened for 30 days goes.
create function stayput.purge_error_log(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from stayput.error_log where last_at < p_now - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- A community's errors go with its data (Settings › General › « Delete all data », and 30 days
-- after an uninstall): 0038's function, plus the errors.
create or replace function stayput.delete_company_data(p_company text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  delete from stayput.webhook_events where company_id = p_company;
  delete from stayput.error_log where company_id = p_company;
  delete from stayput.companies where id = p_company;
  return found;
end
$$;

-- 2. The scheduled jobs --------------------------------------------------------------------------

create table stayput.job_runs (
  job text primary key check (job ~ '^[a-z][a-z0-9_-]{0,39}$'),
  last_started_at timestamptz not null,
  last_finished_at timestamptz not null,
  last_ok_at timestamptz,
  last_failed_at timestamptz,
  -- The last failure's message, scrubbed like the errors': kept after the job runs well again,
  -- beside when it happened.
  last_error text check (length(last_error) <= 500),
  runs integer not null default 0 check (runs >= 0),
  failures integer not null default 0 check (failures >= 0),
  last_duration_ms integer not null default 0 check (last_duration_ms >= 0)
);
alter table stayput.job_runs enable row level security;

create function stayput.record_job_run(p_job text, p_started timestamptz, p_finished timestamptz,
                                       p_error text)
returns void
language sql set search_path = ''
as $$
  insert into stayput.job_runs as j (job, last_started_at, last_finished_at, last_ok_at,
                                     last_failed_at, last_error, runs, failures,
                                     last_duration_ms)
  values (p_job, p_started, p_finished,
          case when p_error is null then p_finished end,
          case when p_error is not null then p_finished end,
          left(p_error, 500), 1, case when p_error is null then 0 else 1 end,
          greatest(0, least(2147483647,
                            round(extract(epoch from p_finished - p_started) * 1000)))::integer)
  on conflict (job) do update
    set last_started_at = excluded.last_started_at,
        last_finished_at = excluded.last_finished_at,
        last_ok_at = coalesce(excluded.last_ok_at, j.last_ok_at),
        last_failed_at = coalesce(excluded.last_failed_at, j.last_failed_at),
        last_error = coalesce(excluded.last_error, j.last_error),
        runs = j.runs + 1,
        failures = j.failures + excluded.failures,
        last_duration_ms = excluded.last_duration_ms;
$$;

-- 3. The status page ------------------------------------------------------------------------------

-- Everything the internal status page shows, in one reading: the jobs, Whop's deliveries of the
-- last day and the failed ones (their type, community and error, never their content), the
-- communities, the readings Whop refused, the actions that failed this week, and the errors.
-- The Worker scrubs every message again before it answers.
create function stayput.operator_status(p_now timestamptz) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job', j.job, 'lastStartedAt', j.last_started_at,
               'lastFinishedAt', j.last_finished_at, 'lastOkAt', j.last_ok_at,
               'lastFailedAt', j.last_failed_at, 'lastError', j.last_error, 'runs', j.runs,
               'failures', j.failures, 'lastDurationMs', j.last_duration_ms) order by j.job)
        from stayput.job_runs j), '[]'),
    'webhooks', jsonb_build_object(
      'lastDay', coalesce((
        select jsonb_object_agg(s.status, s.n)
          from (select status, count(*) as n from stayput.webhook_events
                 where received_at > p_now - interval '1 day' group by status) s), '{}'),
      'lastReceivedAt', (select max(received_at) from stayput.webhook_events),
      'failedCount', (select count(*) from stayput.webhook_events where status = 'failed'),
      'failed', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', w.id, 'type', w.type, 'companyId', w.company_id,
                 'companyName', c.name, 'attempts', w.attempts, 'lastError', w.last_error,
                 'receivedAt', w.received_at) order by w.received_at desc)
          from (select * from stayput.webhook_events where status = 'failed'
                 order by received_at desc limit 50) w
          left join stayput.companies c on c.id = w.company_id), '[]')),
    'companies', (
      select jsonb_build_object(
               'active', count(*) filter (where status = 'active' and not is_demo),
               'accessLost', count(*) filter (where status = 'active' and not is_demo
                                                and access_lost_at is not null),
               'uninstalled', count(*) filter (where status = 'uninstalled'))
        from stayput.companies),
    'syncErrors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'companyId', s.company_id, 'companyName', c.name, 'stream', s.stream,
               'error', s.last_error, 'at', s.last_error_at) order by s.last_error_at desc)
        from (select * from stayput.sync_state where last_error is not null
               order by last_error_at desc nulls last limit 50) s
        join stayput.companies c on c.id = s.company_id), '[]'),
    'failedActions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'companyId', a.company_id, 'companyName', c.name, 'type', a.type,
               'count', a.n, 'lastAt', a.last_at, 'lastError', a.last_error)
               order by a.last_at desc)
        from (select company_id, type, count(*) as n, max(updated_at) as last_at,
                     (array_agg(error_log -> -1 ->> 'error' order by updated_at desc))[1]
                       as last_error
                from stayput.actions
               where status = 'failed' and updated_at > p_now - interval '7 days'
               group by company_id, type) a
        join stayput.companies c on c.id = a.company_id), '[]'),
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'source', e.source, 'companyId', e.company_id, 'message', e.message,
               'count', e.count, 'firstAt', e.first_at, 'lastAt', e.last_at)
               order by e.last_at desc)
        from (select * from stayput.error_log order by last_at desc limit 100) e), '[]'));
$$;

-- 4. Whop's failed deliveries, replayed from the status page ----------------------------------

-- The failed deliveries, the oldest first, each processed again now whatever its attempts
-- (process_webhook_event, as every ten minutes). Returns how many ended in which status.
create function stayput.replay_failed_webhooks(p_limit integer, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_id text;
  v_status text;
  v_counts jsonb := '{}';
begin
  for v_id in
    select id from stayput.webhook_events
     where status = 'failed'
     order by received_at
     limit p_limit
  loop
    v_status := stayput.process_webhook_event(v_id, p_now);
    v_counts := v_counts
      || jsonb_build_object(v_status, coalesce((v_counts ->> v_status)::integer, 0) + 1);
  end loop;
  return v_counts;
end
$$;

revoke all on function stayput.log_error(text, text, text, timestamptz) from public;
revoke all on function stayput.purge_error_log(timestamptz) from public;
revoke all on function stayput.record_job_run(text, timestamptz, timestamptz, text) from public;
revoke all on function stayput.operator_status(timestamptz) from public;
revoke all on function stayput.replay_failed_webhooks(integer, timestamptz) from public;
