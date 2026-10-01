-- Detection (SPEC Phase 3). Every hour, Postgres gathers the figures of each member
-- (risk_features), the Worker computes the score with the pure functions of packages/core
-- (src/risk.ts), and Postgres keeps the result: the current score of each member (member_risk)
-- and one score a day for the history (risk_scores). Every week, cohorts and lessons are counted
-- here (analysis_features) and judged by packages/core (src/analyses.ts).

-- The current score of each member of the community (team excluded), replaced every hour.
create table stayput.member_risk (
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  score smallint not null check (score between 0 and 100),
  level text not null check (level in ('low', 'medium', 'high', 'scheduled_departure')),
  -- {recency, frequency, progress, payment, friction}, each between 0 and 1.
  sub_scores jsonb not null check (jsonb_typeof(sub_scores) = 'object'),
  -- The two main reasons as codes and figures, worded by the dashboard.
  reasons jsonb not null default '[]' check (jsonb_typeof(reasons) = 'array'),
  -- Joined 3 to 7 days ago and did nothing since: the activation radar.
  inactive_newcomer boolean not null default false,
  -- Since when the member is at this level, and the level before (Phase 4 acts on changes).
  level_since timestamptz not null,
  previous_level text check (previous_level in ('low', 'medium', 'high', 'scheduled_departure')),
  computed_at timestamptz not null,
  primary key (company_id, member_id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index member_risk_company_score on stayput.member_risk (company_id, score desc);
create index member_risk_company_computed on stayput.member_risk (company_id, computed_at);

alter table stayput.member_risk enable row level security;
-- Never the member: no risk score is ever visible to them (SPEC 5.3).
create policy creator_read on stayput.member_risk for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.member_risk to stayput_user;

-- The history keeps one score a day per member (the day's last) rather than one an hour.
alter table stayput.risk_scores add column day date;
update stayput.risk_scores set day = (computed_at at time zone 'UTC')::date;
alter table stayput.risk_scores alter column day set not null;
-- save_risk_scores gives the day in the company's time zone; anything else falls on today (UTC).
alter table stayput.risk_scores alter column day set default current_date;
create unique index risk_scores_member_day on stayput.risk_scores (company_id, member_id, day);

-- Departures counted at each horizon only among members who joined long enough ago.
alter table stayput.cohort_stats
  add column eligible_30 integer not null default 0 check (eligible_30 >= 0),
  add column eligible_60 integer not null default 0 check (eligible_60 >= 0),
  add column eligible_90 integer not null default 0 check (eligible_90 >= 0),
  -- The first horizon at which the cohort leaves 1.5 times more than the creator's average.
  add column alert_horizon smallint check (alert_horizon in (30, 60, 90));

-- Per lesson: how many members reached it, and how many stalled right after it.
alter table stayput.lesson_dropoff_stats
  add column stalled integer not null default 0 check (stalled >= 0);

-- When the weekly analyses last ran for the company.
alter table stayput.company_sync add column analyses_at timestamptz;

-- What a member does that counts as activity (support tickets are friction, not activity).
create function stayput.engagement_types() returns text[]
language sql immutable set search_path = ''
as $$
  select array['message', 'reaction', 'lesson_completed', 'forum_post', 'stayput_open',
               'goal_update', 'discord_message', 'telegram_message']
$$;

-- Milliseconds since the epoch: the Worker compares numbers, it never parses a date.
create function stayput.epoch_ms(p_at timestamptz) returns bigint
language sql immutable set search_path = ''
as $$
  select (extract(epoch from p_at) * 1000)::bigint
$$;

-- The figures of up to `p_limit` members whose score is due (never computed, or 50 minutes
-- ago), and the company's settings. Members of the community only, team excluded. One JSON
-- document, compact: the Worker parses it once (packages/core, RiskInputs):
-- [id, joinedAt, lastActivityAt, activity7d, activityPrev28d, lastProgressAt, lastLessonTitle,
--  payment, cancelAtPeriodEnd, cancelAt, openTicketSince, reactions14d, reactionsPrev14d,
--  activeSinceJoin].
create function stayput.risk_features(p_company text, p_now timestamptz, p_limit integer)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_settings jsonb;
  v_members jsonb;
begin
  select coalesce(c.timezone, 'UTC') into v_tz from stayput.companies c where c.id = p_company;
  if v_tz is null then
    return jsonb_build_object('settings', null, 'members', '[]'::jsonb);
  end if;
  v_today := (p_now at time zone v_tz)::date;
  select jsonb_build_object(
           'weights', jsonb_build_object(
             'recency', s.weight_recency::float8, 'frequency', s.weight_frequency::float8,
             'progress', s.weight_progress::float8, 'payment', s.weight_payment::float8,
             'friction', s.weight_friction::float8),
           'recencyThresholdDays', s.recency_threshold_days,
           'mediumFrom', s.medium_risk_from,
           'highFrom', s.high_risk_from,
           -- Courses read from Whop, or lessons and goals on record: progress counts.
           'tracksProgress',
             exists (select 1 from stayput.sync_state t
                      where t.company_id = p_company and t.stream like 'lesson_interactions:%')
             or exists (select 1 from stayput.activity_events e
                         where e.company_id = p_company
                           and e.type in ('lesson_completed', 'goal_update')
                           and e.external_id is not null))
    into v_settings
    from stayput.company_settings s where s.company_id = p_company;
  v_settings := coalesce(v_settings, jsonb_build_object(
    'weights', jsonb_build_object('recency', 0.3, 'frequency', 0.25, 'progress', 0.2,
                                  'payment', 0.15, 'friction', 0.1),
    'recencyThresholdDays', 14, 'mediumFrom', 40, 'highFrom', 70, 'tracksProgress', false));

  with due as (
    select m.id, m.joined_at, m.last_action_at
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
       and (r.computed_at is null or r.computed_at <= p_now - interval '50 minutes')
     order by r.computed_at nulls first, m.id
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_array(
           d.id,
           stayput.epoch_ms(d.joined_at),
           stayput.epoch_ms(greatest(last_event.at, d.last_action_at)),
           coalesce(stats.activity_7d, 0),
           coalesce(stats.activity_prev_28d, 0),
           stayput.epoch_ms(progress.at),
           progress.title,
           case
             when payment.failed or exists (
               select 1 from stayput.memberships ms
                where ms.company_id = p_company and ms.member_id = d.id
                  and ms.status = 'past_due') then 'failed'
             when payment.action_required then 'action_required'
             else 'ok'
           end,
           cancel.at is not null,
           stayput.epoch_ms(cancel.at),
           stayput.epoch_ms(ticket.since),
           coalesce(stats.reactions_14d, 0),
           coalesce(stats.reactions_prev_14d, 0),
           coalesce(joined.active, false)
         ) order by d.id), '[]'::jsonb)
    into v_members
    from due d
    left join lateral (
      select e.occurred_at as at from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type = any (stayput.engagement_types())
       order by e.occurred_at desc limit 1) last_event on true
    left join lateral (
      select sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day > v_today - 7)::integer
               as activity_7d,
             sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day <= v_today - 7)::integer
               as activity_prev_28d,
             sum(s.reactions) filter (where s.day > v_today - 14)::integer as reactions_14d,
             sum(s.reactions) filter (where s.day <= v_today - 14 and s.day > v_today - 28)::integer
               as reactions_prev_14d
        from stayput.member_stats_daily s
       where s.company_id = p_company and s.member_id = d.id and s.day > v_today - 35) stats
      on true
    left join lateral (
      select e.occurred_at as at, e.metadata ->> 'lesson_title' as title
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type in ('lesson_completed', 'goal_update')
       order by e.occurred_at desc limit 1) progress on true
    left join lateral (
      select p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
               as failed,
             p.recovery_url is not null
               and p.status = any (array['open', 'pending', 'incomplete', 'requires_action',
                                         'requires_capture']) as action_required
        from stayput.payments p
       where p.company_id = p_company and p.member_id = d.id
       order by p.whop_created_at desc limit 1) payment on true
    left join lateral (
      select min(ms.current_period_end) as at
        from stayput.memberships ms
       where ms.company_id = p_company and ms.member_id = d.id
         and ms.status = any (array['trialing', 'active', 'past_due', 'canceling', 'completed'])
         and (ms.cancel_at_period_end or ms.status = 'canceling')
      having count(*) > 0) cancel on true
    left join lateral (
      -- A support conversation whose last event is the member's, not a resolution.
      select min(t.occurred_at) as since from (
        select distinct on (e.metadata ->> 'channel_id') e.type, e.occurred_at
          from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type in ('support_ticket_opened', 'support_ticket_resolved')
         order by e.metadata ->> 'channel_id', e.occurred_at desc) t
       where t.type = 'support_ticket_opened') ticket on true
    left join lateral (
      select exists (
        select 1 from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type = any (stayput.engagement_types())
           and e.occurred_at >= d.joined_at) as active) joined on true;

  return jsonb_build_object('settings', v_settings, 'members', v_members);
end
$$;

-- The scores the Worker computed: [id, score, level, [recency, frequency, progress, payment,
-- friction], reasons, inactiveNewcomer]. The current score replaces the previous one (its level
-- change is remembered), the day's history keeps the last. Members who left or joined the team
-- lose their score. Returns how many were saved.
create function stayput.save_risk_scores(p_company text, p_scores jsonb, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_saved integer;
begin
  select coalesce(timezone, 'UTC') into v_tz from stayput.companies where id = p_company;
  if v_tz is null then
    return 0;
  end if;
  with input as (
    select s ->> 0 as member_id,
           (s ->> 1)::smallint as score,
           s ->> 2 as level,
           jsonb_build_object('recency', s -> 3 -> 0, 'frequency', s -> 3 -> 1,
                              'progress', s -> 3 -> 2, 'payment', s -> 3 -> 3,
                              'friction', s -> 3 -> 4) as sub_scores,
           coalesce(s -> 4, '[]'::jsonb) as reasons,
           coalesce((s ->> 5)::boolean, false) as newcomer
      from jsonb_array_elements(p_scores) s
  ), kept as (
    select i.* from input i
      join stayput.members m on m.company_id = p_company and m.id = i.member_id
     where m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
  ), current as (
    insert into stayput.member_risk as r (company_id, member_id, score, level, sub_scores,
                                          reasons, inactive_newcomer, level_since,
                                          previous_level, computed_at)
    select p_company, member_id, score, level, sub_scores, reasons, newcomer, p_now, null, p_now
      from kept
    on conflict (company_id, member_id) do update set
      score = excluded.score,
      level = excluded.level,
      sub_scores = excluded.sub_scores,
      reasons = excluded.reasons,
      inactive_newcomer = excluded.inactive_newcomer,
      previous_level = case when r.level <> excluded.level then r.level else r.previous_level end,
      level_since = case when r.level <> excluded.level then excluded.computed_at
                         else r.level_since end,
      computed_at = excluded.computed_at
    returning member_id, score, level, sub_scores, reasons
  )
  insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores, reasons,
                                   computed_at, day)
  select p_company, member_id, score, level, sub_scores, reasons, p_now,
         (p_now at time zone v_tz)::date
    from current
  on conflict (company_id, member_id, day) do update set
    score = excluded.score,
    level = excluded.level,
    sub_scores = excluded.sub_scores,
    reasons = excluded.reasons,
    computed_at = excluded.computed_at;
  get diagnostics v_saved = row_count;

  delete from stayput.member_risk r
   using stayput.members m
   where r.company_id = p_company and m.company_id = r.company_id and m.id = r.member_id
     and (m.status <> 'joined' or coalesce(m.access_level, '') = 'admin');
  return v_saved;
end
$$;

-- The companies with scores or weekly analyses due, those that waited longest first. Only
-- companies whose team opened StayPut, never a demo.
create function stayput.companies_to_score(p_now timestamptz, p_limit integer)
returns setof text
language sql stable set search_path = ''
as $$
  select c.id
    from stayput.companies c
    left join stayput.company_sync s on s.company_id = c.id
   where c.status = 'active' and not c.is_demo
     and exists (select 1 from stayput.company_admins a where a.company_id = c.id)
     and (exists (
            select 1 from stayput.members m
              left join stayput.member_risk r on r.company_id = m.company_id
                                             and r.member_id = m.id
             where m.company_id = c.id and m.status = 'joined'
               and coalesce(m.access_level, '') <> 'admin'
               and (r.computed_at is null or r.computed_at <= p_now - interval '50 minutes'))
          or s.analyses_at is null or s.analyses_at <= p_now - interval '7 days')
   order by (select min(r.computed_at) from stayput.member_risk r where r.company_id = c.id)
            nulls first, c.id
   limit p_limit
$$;

-- The weekly analyses are due: never run, or a week ago.
create function stayput.analyses_due(p_company text, p_now timestamptz) returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((select s.analyses_at is null or s.analyses_at <= p_now - interval '7 days'
                     from stayput.company_sync s where s.company_id = p_company), true)
$$;

-- What the weekly analyses judge (packages/core, src/analyses.ts):
-- cohorts: per month of arrival, the members, and per horizon (30, 60, 90 days) those who
-- joined long enough ago and those of them who left within that many days;
-- lessons: per lesson, the members who completed it, and those for whom it is the last lesson
-- completed and who stalled (left, or no activity for 14 days).
-- A departure is dated by the end of the member's last membership, else their last update.
create function stayput.analysis_features(p_company text, p_now timestamptz) returns jsonb
language sql stable set search_path = ''
as $$
  with people as (
    select m.id, m.joined_at, m.cohort_month, m.status,
           case when m.status = 'left' then coalesce(
             (select max(ms.current_period_end) from stayput.memberships ms
               where ms.company_id = m.company_id and ms.member_id = m.id
                 and ms.current_period_end <= p_now),
             m.updated_at) end as left_at,
           greatest(m.last_action_at, (
             select max(e.occurred_at) from stayput.activity_events e
              where e.company_id = m.company_id and e.member_id = m.id
                and e.type = any (stayput.engagement_types()))) as last_activity_at
      from stayput.members m
     where m.company_id = p_company and coalesce(m.access_level, '') <> 'admin'
  ), cohorts as (
    select jsonb_build_object(
             'month', to_char(p.cohort_month, 'YYYY-MM-DD'),
             'members', count(*),
             'eligible', jsonb_build_object(
               '30', count(*) filter (where p.joined_at <= p_now - interval '30 days'),
               '60', count(*) filter (where p.joined_at <= p_now - interval '60 days'),
               '90', count(*) filter (where p.joined_at <= p_now - interval '90 days')),
             'left', jsonb_build_object(
               '30', count(*) filter (where p.joined_at <= p_now - interval '30 days'
                                        and p.left_at <= p.joined_at + interval '30 days'),
               '60', count(*) filter (where p.joined_at <= p_now - interval '60 days'
                                        and p.left_at <= p.joined_at + interval '60 days'),
               '90', count(*) filter (where p.joined_at <= p_now - interval '90 days'
                                        and p.left_at <= p.joined_at + interval '90 days'))
           ) as cohort
      from people p
     where p.cohort_month is not null and p.joined_at is not null
     group by p.cohort_month
  ), completions as (
    select e.member_id, e.metadata ->> 'lesson_id' as lesson_id,
           coalesce(e.metadata ->> 'course_id', '') as course_id,
           e.metadata ->> 'lesson_title' as title, e.occurred_at
      from stayput.activity_events e
     where e.company_id = p_company and e.type = 'lesson_completed'
       and e.metadata ->> 'lesson_id' is not null
  ), last_lesson as (
    select distinct on (member_id) member_id, lesson_id
      from completions order by member_id, occurred_at desc
  ), lessons as (
    select jsonb_build_object(
             'lessonId', c.lesson_id,
             'courseId', max(c.course_id),
             'title', max(c.title),
             'reached', count(distinct c.member_id),
             'stalled', count(distinct c.member_id) filter (
               where l.lesson_id = c.lesson_id
                 and (p.status = 'left'
                      or coalesce(p.last_activity_at, p.joined_at)
                         <= p_now - interval '14 days'))) as lesson
      from completions c
      join people p on p.id = c.member_id
      left join last_lesson l on l.member_id = c.member_id
     group by c.lesson_id
  )
  select jsonb_build_object(
    'cohorts', coalesce((select jsonb_agg(cohort order by cohort ->> 'month') from cohorts),
                        '[]'::jsonb),
    'lessons', coalesce((select jsonb_agg(lesson order by lesson ->> 'lessonId') from lessons),
                        '[]'::jsonb))
$$;

-- What the weekly analyses concluded: cohorts and lessons replace the previous week's.
create function stayput.save_analyses(p_company text, p_cohorts jsonb, p_lessons jsonb,
                                      p_now timestamptz) returns void
language plpgsql set search_path = ''
as $$
begin
  delete from stayput.cohort_stats where company_id = p_company;
  insert into stayput.cohort_stats (company_id, cohort_month, members, left_by_30, left_by_60,
                                    left_by_90, eligible_30, eligible_60, eligible_90, alert,
                                    alert_horizon, computed_at)
  select p_company, (c ->> 'month')::date, (c ->> 'members')::integer,
         (c -> 'left' ->> '30')::integer, (c -> 'left' ->> '60')::integer,
         (c -> 'left' ->> '90')::integer, (c -> 'eligible' ->> '30')::integer,
         (c -> 'eligible' ->> '60')::integer, (c -> 'eligible' ->> '90')::integer,
         c ->> 'alertHorizon' is not null, (c ->> 'alertHorizon')::smallint, p_now
    from jsonb_array_elements(coalesce(p_cohorts, '[]'::jsonb)) c;

  delete from stayput.lesson_dropoff_stats where company_id = p_company;
  insert into stayput.lesson_dropoff_stats (company_id, lesson_id, course_id, lesson_title,
                                            members_concerned, stalled, dropoff_rate,
                                            course_average_rate, flagged, computed_at)
  select p_company, l ->> 'lessonId', l ->> 'courseId', l ->> 'title',
         (l ->> 'reached')::integer, (l ->> 'stalled')::integer,
         round(least(1, greatest(0, (l ->> 'rate')::numeric)), 4),
         round(least(1, greatest(0, (l ->> 'courseAverage')::numeric)), 4),
         coalesce((l ->> 'flagged')::boolean, false), p_now
    from jsonb_array_elements(coalesce(p_lessons, '[]'::jsonb)) l;

  insert into stayput.company_sync (company_id, analyses_at) values (p_company, p_now)
  on conflict (company_id) do update set analyses_at = excluded.analyses_at;
end
$$;

-- The creator's detection settings: the niche, the five weights (the Worker brings them to a
-- sum of 1), the recency threshold and the two level thresholds. Every score of the company is
-- then due again, so that the dashboard shows the new settings at the next computation.
create function stayput.save_risk_settings(p_company text, p_niche text, p_weights jsonb,
                                           p_recency_days integer, p_medium_from integer,
                                           p_high_from integer, p_now timestamptz) returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.companies set niche = p_niche where id = p_company;
  if not found then
    raise exception 'unknown company %', p_company;
  end if;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set
    weight_recency = (p_weights ->> 'recency')::numeric,
    weight_frequency = (p_weights ->> 'frequency')::numeric,
    weight_progress = (p_weights ->> 'progress')::numeric,
    weight_payment = (p_weights ->> 'payment')::numeric,
    weight_friction = (p_weights ->> 'friction')::numeric,
    recency_threshold_days = p_recency_days,
    medium_risk_from = p_medium_from,
    high_risk_from = p_high_from
  where company_id = p_company;
  update stayput.member_risk set computed_at = least(computed_at, p_now - interval '1 hour')
   where company_id = p_company;
end
$$;

-- The daily history is kept 400 days (a year compared with the one before).
create function stayput.purge_risk_history(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from stayput.risk_scores where computed_at < p_now - interval '400 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- When the weekly analyses last ran, for the team only (company_sync is the Worker's own table):
-- the dashboard tells « analyzed 2 days ago » even when there was nothing to report.
create function stayput.analyses_at(p_company text) returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select s.analyses_at from stayput.company_sync s
   where s.company_id = p_company and stayput.is_company_admin(p_company)
$$;

revoke execute on all functions in schema stayput from public;
grant execute on function stayput.unlinked_authors(text) to stayput_user;
grant execute on function stayput.analyses_at(text) to stayput_user;
