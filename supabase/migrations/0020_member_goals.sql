-- SPEC Phase 5, the member space, first part: the member's goal (one under way at a time), the
-- results they record, the milestones on the way (25, 50, 75 and 100 % of the distance from the
-- start to the target, whichever way it goes) and the first badges (first result, seven days in
-- a row, each milestone). Each opening of the space is an activity (stayput_open), each goal
-- set and result recorded one too (goal_update): what StayPut sees of a member when Whop shows
-- nothing (SPEC Phase 5, point 10). The Worker calls these after checking with Whop the
-- member's access to the experience; the creator reads the rows under RLS.

-- How the member records results: where they stand (`total`: a weight, a monthly revenue), or
-- what they did since the last time (`add`: two more clients).
alter table stayput.goals
  add column entry text not null default 'total' check (entry in ('total', 'add'));

-- Where the member stands: the start until the first result, then the last one (for `add`, the
-- sum of the entries). Kept on the goal, so that two entries at once never lose one.
alter table stayput.goals add column current_value numeric(14, 2);
update stayput.goals g
   set current_value = coalesce(
         (select r.value from stayput.results r
           where r.company_id = g.company_id and r.goal_id = g.id
           order by r.recorded_at desc, r.id desc limit 1),
         g.start_value);
alter table stayput.goals alter column current_value set not null;
-- A new goal starts where the member stands.
create function stayput.goal_current_default() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.current_value := coalesce(new.current_value, new.start_value);
  return new;
end
$$;
create trigger goals_current_default before insert on stayput.goals
  for each row execute function stayput.goal_current_default();

-- One goal under way per member: a new one ends the previous.
create unique index goals_one_active on stayput.goals (company_id, member_id)
  where status = 'active';

-- The goals the creator proposes to members (packages/core GoalProposal); null: their niche's
-- (packages/core NICHE_GOALS, in each member's language).
alter table stayput.company_settings
  add column goal_proposals jsonb
    check (goal_proposals is null or jsonb_typeof(goal_proposals) = 'array');

-- An opening of the space by a user StayPut does not know yet waits like their other activity,
-- until their membership is read (upsert_member moves it).
alter table stayput.pending_activity drop constraint pending_activity_type_check;
alter table stayput.pending_activity add constraint pending_activity_type_check check (type in (
  'message', 'reaction', 'lesson_completed', 'forum_post', 'support_ticket_opened',
  'support_ticket_resolved', 'discord_message', 'telegram_message', 'stayput_open'));

-- Where `p_current` stands from the start to the target, 0 to 100, never beyond: the progress the
-- member sees and the milestones they reach.
create function stayput.goal_progress(p_start numeric, p_target numeric, p_current numeric)
returns integer
language sql immutable set search_path = ''
as $$
  select case
           when p_target = p_start then 0
           else greatest(0, least(100, floor((p_current - p_start) * 100
                                             / (p_target - p_start))))::integer
         end
$$;

-- A badge for a member, once ever: the codes it gave (none when they had it already).
create function stayput.award_badge(p_company text, p_member text, p_badge text,
                                    p_at timestamptz, p_context jsonb)
returns text[]
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.member_badges (company_id, member_id, badge_code, awarded_at, context)
  values (p_company, p_member, p_badge, p_at, coalesce(p_context, '{}'))
  on conflict do nothing;
  return case when found then array[p_badge] else '{}'::text[] end;
end
$$;

-- Seven days in a row in the member space (opened, or a goal or result recorded), days of the
-- company's time zone: the assiduity badge.
create function stayput.award_streak(p_company text, p_member text, p_now timestamptz)
returns text[]
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_days integer;
begin
  if exists (select 1 from stayput.member_badges b
              where b.company_id = p_company and b.member_id = p_member
                and b.badge_code = 'streak_7_days') then
    return '{}';
  end if;
  select c.timezone into v_tz from stayput.companies c where c.id = p_company;
  v_tz := coalesce(v_tz, 'UTC');
  v_today := (p_now at time zone v_tz)::date;
  select count(distinct (e.occurred_at at time zone v_tz)::date) into v_days
    from stayput.activity_events e
   where e.company_id = p_company and e.member_id = p_member
     and e.type in ('stayput_open', 'goal_update')
     and e.occurred_at > p_now - interval '8 days' and e.occurred_at <= p_now
     and (e.occurred_at at time zone v_tz)::date > v_today - 7;
  if v_days < 7 then
    return '{}';
  end if;
  return stayput.award_badge(p_company, p_member, 'streak_7_days', p_now, '{}');
end
$$;

-- The member opened their space: one activity per day of the company's time zone (opening it
-- ten times a day is still one day of activity), and the badges this day brings.
create function stayput.record_open(p_company text, p_user text, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_member text;
begin
  select c.timezone into v_tz from stayput.companies c where c.id = p_company;
  if not found then
    return jsonb_build_object('badges', '[]'::jsonb);
  end if;
  perform stayput.record_activity(
    p_company, 'stayput_open', p_user,
    'open:' || p_user || ':' || to_char((p_now at time zone v_tz)::date, 'YYYY-MM-DD'),
    p_now, '{}');
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return jsonb_build_object('badges', '[]'::jsonb);
  end if;
  return jsonb_build_object('badges', to_jsonb(stayput.award_streak(p_company, v_member, p_now)));
end
$$;

-- The member's goal (packages/core GoalInput, checked by the Worker): the one under way ends
-- (abandoned; a goal reached stays reached). Null when StayPut does not know the member yet.
create function stayput.set_goal(p_company text, p_user text, p_goal jsonb, p_now timestamptz)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_goal uuid;
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  update stayput.goals set status = 'abandoned'
   where company_id = p_company and member_id = v_member and status = 'active';
  insert into stayput.goals (company_id, member_id, title, category, start_value, target_value,
                             current_value, unit, entry, target_date, status, created_at)
  values (p_company, v_member, p_goal ->> 'title', p_goal ->> 'category',
          (p_goal ->> 'start')::numeric, (p_goal ->> 'target')::numeric,
          (p_goal ->> 'start')::numeric, p_goal ->> 'unit', p_goal ->> 'entry',
          (p_goal ->> 'targetDate')::date, 'active', p_now)
  returning id into v_goal;
  perform stayput.record_activity(p_company, 'goal_update', p_user, 'goal:' || v_goal, p_now,
                                  jsonb_build_object('goal_id', v_goal));
  return v_goal;
end
$$;

-- A result on the member's goal under way: where they stand now (`total`), or what they add
-- (`add`). The milestones it reaches, the badges it brings, and the goal reached at 100 %. Null
-- when the goal is not theirs, not under way, or the sum would not fit.
create function stayput.record_result(p_company text, p_user text, p_goal uuid, p_value numeric,
                                      p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_goal stayput.goals;
  v_value numeric;
  v_result uuid;
  v_progress integer;
  v_percent integer;
  v_milestones integer[] := '{}';
  v_badges text[] := '{}';
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  -- Locked: a second entry at the same moment adds to this one, never beside it.
  select g.* into v_goal from stayput.goals g
   where g.company_id = p_company and g.member_id = v_member and g.id = p_goal
     and g.status = 'active'
     for update;
  if not found then
    return null;
  end if;
  v_value := round(case when v_goal.entry = 'add' then v_goal.current_value + p_value
                        else p_value end, 2);
  if abs(v_value) > 100000000000 then
    return null;
  end if;
  update stayput.goals set current_value = v_value where id = p_goal;
  insert into stayput.results (company_id, member_id, goal_id, value, recorded_at)
  values (p_company, v_member, p_goal, v_value, p_now)
  returning id into v_result;
  perform stayput.record_activity(p_company, 'goal_update', p_user, 'result:' || v_result, p_now,
                                  jsonb_build_object('goal_id', p_goal));

  v_badges := v_badges || stayput.award_badge(p_company, v_member, 'first_result', p_now,
                                              jsonb_build_object('goal_id', p_goal));
  v_progress := stayput.goal_progress(v_goal.start_value, v_goal.target_value, v_value);
  foreach v_percent in array array[25, 50, 75, 100] loop
    exit when v_progress < v_percent;
    insert into stayput.milestones (company_id, member_id, goal_id, percent, reached_at)
    values (p_company, v_member, p_goal, v_percent, p_now)
    on conflict (goal_id, percent) do nothing;
    if found then
      v_milestones := v_milestones || v_percent;
      v_badges := v_badges || stayput.award_badge(p_company, v_member, 'milestone_' || v_percent,
                                                  p_now, jsonb_build_object('goal_id', p_goal));
    end if;
  end loop;
  v_badges := v_badges || stayput.award_streak(p_company, v_member, p_now);
  if v_progress >= 100 then
    update stayput.goals set status = 'achieved' where id = p_goal;
  end if;
  return jsonb_build_object(
    'resultId', v_result,
    'value', v_value::float8,
    'progress', v_progress,
    'milestones', to_jsonb(v_milestones),
    'badges', to_jsonb(v_badges),
    'achieved', v_progress >= 100);
end
$$;

-- What the member space shows (packages/core MemberSpaceView, completed by the Worker): the goal
-- under way, or else the last one reached, its milestones and ten latest results, the member's
-- badges, and the goals the creator proposes (null: the niche's).
create function stayput.member_space(p_company text, p_user text)
returns jsonb
language sql stable set search_path = ''
as $$
  with m as (
    select m.id from stayput.members m where m.company_id = p_company and m.user_id = p_user
  ), g as (
    select g.* from stayput.goals g, m
     where g.company_id = p_company and g.member_id = m.id
       and g.status in ('active', 'achieved')
     order by g.status = 'active' desc, g.created_at desc, g.id
     limit 1
  )
  select jsonb_build_object(
    'known', exists (select 1 from m),
    'niche', (select c.niche from stayput.companies c where c.id = p_company),
    'proposals', (select s.goal_proposals from stayput.company_settings s
                   where s.company_id = p_company),
    'goal', (
      select jsonb_build_object(
               'id', g.id,
               'title', g.title,
               'category', coalesce(g.category, 'other'),
               'unit', g.unit,
               'entry', g.entry,
               'start', g.start_value::float8,
               'target', g.target_value::float8,
               'current', g.current_value::float8,
               'progress', stayput.goal_progress(g.start_value, g.target_value, g.current_value),
               'targetDate', g.target_date,
               'status', g.status,
               'createdAt', g.created_at,
               'milestones', coalesce((
                 select jsonb_agg(jsonb_build_object('percent', ms.percent,
                                                     'reachedAt', ms.reached_at)
                                  order by ms.percent)
                   from stayput.milestones ms
                  where ms.company_id = p_company and ms.goal_id = g.id), '[]'::jsonb))
        from g),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'value', r.value::float8,
                                          'recordedAt', r.recorded_at)
                       order by r.recorded_at desc, r.id desc)
        from (select r.* from stayput.results r, g
               where r.company_id = p_company and r.goal_id = g.id
               order by r.recorded_at desc, r.id desc
               limit 10) r), '[]'::jsonb),
    'badges', coalesce((
      select jsonb_agg(jsonb_build_object('code', b.badge_code, 'awardedAt', b.awarded_at)
                       order by b.awarded_at, b.badge_code)
        from stayput.member_badges b, m
       where b.company_id = p_company and b.member_id = m.id), '[]'::jsonb))
$$;

-- The goals the creator proposes; null goes back to the niche's.
create function stayput.save_goal_proposals(p_company text, p_proposals jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  if p_proposals is not null and jsonb_typeof(p_proposals) <> 'array' then
    raise exception 'goal proposals must be an array';
  end if;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set goal_proposals = p_proposals where company_id = p_company;
end
$$;

-- The words a message about a member uses (0010), with their goal under way and how far they
-- are: « 40 % » in French, « 40% » in English.
create or replace function stayput.message_values(p_company text, p_member text,
                                                  p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'first_name', nullif(split_part(coalesce(m.display_name, ''), ' ', 1), ''),
    'creator_name', c.name,
    'days_inactive', (
      select floor(extract(epoch from p_now - coalesce(max(e.occurred_at), m.joined_at))
                   / 86400)::integer
        from stayput.activity_events e
       where e.company_id = m.company_id and e.member_id = m.id),
    'last_lesson', (
      select e.metadata ->> 'lesson_title'
        from stayput.activity_events e
       where e.company_id = m.company_id and e.member_id = m.id and e.type = 'lesson_completed'
       order by e.occurred_at desc limit 1),
    'goal', g.title,
    'progress', case
                  when g.id is null then null
                  else stayput.goal_progress(g.start_value, g.target_value, g.current_value)
                       || case when c.locale = 'fr' then chr(160) || '%' else '%' end
                end)
    from stayput.members m
    join stayput.companies c on c.id = m.company_id
    left join lateral (
      select g.id, g.title, g.start_value, g.target_value, g.current_value
        from stayput.goals g
       where g.company_id = m.company_id and g.member_id = m.id and g.status = 'active'
       limit 1) g on true
   where m.company_id = p_company and m.id = p_member;
$$;

revoke all on function stayput.goal_current_default() from public;
revoke all on function stayput.goal_progress(numeric, numeric, numeric) from public;
revoke all on function stayput.award_badge(text, text, text, timestamptz, jsonb) from public;
revoke all on function stayput.award_streak(text, text, timestamptz) from public;
revoke all on function stayput.record_open(text, text, timestamptz) from public;
revoke all on function stayput.set_goal(text, text, jsonb, timestamptz) from public;
revoke all on function stayput.record_result(text, text, uuid, numeric, timestamptz) from public;
revoke all on function stayput.member_space(text, text) from public;
revoke all on function stayput.save_goal_proposals(text, jsonb) from public;
-- The previews of the actions list read message_values as the creator (under RLS).
grant execute on function stayput.goal_progress(numeric, numeric, numeric) to stayput_user;
