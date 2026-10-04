-- The Monday report (SPEC Phase 6.9): every Monday from 8:00 in the community's time zone, the
-- week before (members saved and lost, money saved, why members left) and the week's priority,
-- sent to the community's team as a Whop notification. Each report is kept as made, with when
-- Whop took it: the dashboard lists them (Analytics › Reports), and a report is sent only once.
-- On by default; the team turns it off from that page (company_settings.options.weekly_report).

create table stayput.weekly_reports (
  company_id text not null references stayput.companies (id) on delete cascade,
  -- The Monday the reported week began, in the community's time zone.
  week_start date not null check (extract(isodow from week_start) = 1),
  -- packages/core WeeklyReport, as made on Monday morning.
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  created_at timestamptz not null,
  -- When Whop took the notification; while it did not, the attempts and Whop's last answer.
  sent_at timestamptz,
  attempts smallint not null default 0 check (attempts >= 0),
  error text check (char_length(error) <= 500),
  primary key (company_id, week_start)
);

alter table stayput.weekly_reports enable row level security;
create policy creator_read on stayput.weekly_reports for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.weekly_reports to stayput_user;

-- The communities whose report is due at p_now: Monday from 8:00 where they are, the report on,
-- installed before that Monday, that week's report neither sent nor given up (3 attempts, one an
-- hour). The demo communities never get one. The week reported is the one that just ended.
create function stayput.weekly_reports_due(p_now timestamptz, p_limit integer)
returns table (company_id text, week_start date, zone text, locale text)
language sql stable set search_path = ''
as $$
  select c.id, (l.local::date - 7), c.timezone, c.locale
    from stayput.companies c
    left join stayput.company_settings s on s.company_id = c.id
   cross join lateral (select p_now at time zone c.timezone as local) l
   where c.status = 'active' and not c.is_demo
     and coalesce((s.options ->> 'weekly_report')::boolean, true)
     and extract(isodow from l.local) = 1 and extract(hour from l.local) >= 8
     and c.installed_at < (l.local::date::timestamp at time zone c.timezone)
     and not exists (
       select 1 from stayput.weekly_reports r
        where r.company_id = c.id and r.week_start = l.local::date - 7
          and (r.sent_at is not null or r.attempts >= 3))
   order by c.id
   limit p_limit
$$;

-- The report on or off, as the team sets it.
create function stayput.save_weekly_report_setting(p_company text, p_enabled boolean)
returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('weekly_report', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.weekly_reports_due(timestamptz, integer) from public;
revoke all on function stayput.save_weekly_report_setting(text, boolean) from public;
