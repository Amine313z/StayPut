-- SPEC Phase 8.4: each member's detailed activity (activity_events) is kept 12 months; after
-- that only its daily counts remain (member_stats_daily, activity_hours over 90 days). The
-- counts of a day are then never computed again from events partly gone.

create or replace function stayput.refresh_activity_stats(p_company text, p_since timestamptz,
                                                          p_now timestamptz) returns void
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_day date;
begin
  select timezone into v_tz from stayput.companies where id = p_company;
  v_tz := coalesce(v_tz, 'UTC');
  -- Never before the first day whose events are all still kept (12 months, SPEC Phase 8.4): the
  -- days before keep their counts, their events gone.
  v_day := greatest((p_since at time zone v_tz)::date,
                    ((p_now - interval '12 months') at time zone v_tz)::date + 1);
  delete from stayput.member_stats_daily where company_id = p_company and day >= v_day;
  insert into stayput.member_stats_daily (company_id, member_id, day, messages, reactions,
                                          lessons_completed, forum_posts, stayput_actions)
  select company_id, member_id, (occurred_at at time zone v_tz)::date,
         count(*) filter (where type in ('message', 'discord_message', 'telegram_message')),
         count(*) filter (where type = 'reaction'),
         count(*) filter (where type = 'lesson_completed'),
         count(*) filter (where type = 'forum_post'),
         count(*) filter (where type in ('stayput_open', 'goal_update'))
    from stayput.activity_events
   where company_id = p_company and (occurred_at at time zone v_tz)::date >= v_day
   group by company_id, member_id, (occurred_at at time zone v_tz)::date;

  with touched as (
    select distinct member_id from stayput.activity_events
     where company_id = p_company and occurred_at >= p_since
  ), counts as (
    select e.member_id, extract(hour from e.occurred_at at time zone v_tz)::integer as h,
           count(*)::integer as n
      from stayput.activity_events e join touched using (member_id)
     where e.company_id = p_company and e.occurred_at >= p_now - interval '90 days'
     group by 1, 2
  )
  insert into stayput.activity_hours (company_id, member_id, hours, updated_at)
  select p_company, t.member_id,
         array_agg(coalesce(c.n, 0) order by g.h), p_now
    from touched t
   cross join generate_series(0, 23) as g(h)
    left join counts c on c.member_id = t.member_id and c.h = g.h
   group by t.member_id
  on conflict (company_id, member_id) do update
    set hours = excluded.hours, updated_at = excluded.updated_at;
end
$$;

-- Every Monday: the events older than 12 months, deleted. Returns how many.
create function stayput.purge_old_activity(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from stayput.activity_events where occurred_at < p_now - interval '12 months';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function stayput.purge_old_activity(timestamptz) from public;
