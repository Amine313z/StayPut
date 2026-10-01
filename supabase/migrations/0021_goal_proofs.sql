-- SPEC Phase 5, point 3: a screenshot backs a result. The member's browser reads the numbers on
-- it (Tesseract.js) and sends the image's SHA-256 and those numbers, never the image itself. The
-- result is `justified` when the number recorded is among them (the Worker checks it: then
-- only does it pass the proof here); a screenshot backs one result only, the same image again
-- leaves the result declared. The first proof brings the badge « First proof ».

-- One result per screenshot, in a company.
create unique index proofs_image_once on stayput.proofs (company_id, image_sha256)
  where image_sha256 is not null;

-- A result on the member's goal under way (0020), with the screenshot that backs it: `proof` in
-- the answer says `justified`, `duplicate` (the screenshot backed another result already), or
-- null (none).
create function stayput.record_result(p_company text, p_user text, p_goal uuid, p_value numeric,
                                      p_now timestamptz, p_proof jsonb)
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
  v_proof text;
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
  -- The screenshot backs this result, unless it already backed another one.
  if p_proof is not null then
    insert into stayput.proofs (company_id, member_id, result_id, level, ocr_values,
                                image_sha256, created_at)
    values (p_company, v_member, v_result, 'justified',
            jsonb_build_object('numbers', coalesce(p_proof -> 'numbers', '[]'::jsonb),
                               'matched', p_value),
            p_proof ->> 'sha256', p_now)
    on conflict (company_id, image_sha256) where image_sha256 is not null do nothing;
    if found then
      v_proof := 'justified';
      v_badges := v_badges || stayput.award_badge(p_company, v_member, 'first_proof', p_now,
                                                  jsonb_build_object('goal_id', p_goal));
    else
      v_proof := 'duplicate';
    end if;
  end if;
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
    'achieved', v_progress >= 100,
    'proof', v_proof);
end
$$;

-- 0020's, for the Worker deployed before this migration: a result without a screenshot.
create or replace function stayput.record_result(p_company text, p_user text, p_goal uuid,
                                                 p_value numeric, p_now timestamptz)
returns jsonb
language sql set search_path = ''
as $$
  select stayput.record_result(p_company, p_user, p_goal, p_value, p_now, null::jsonb)
$$;

-- The member space (0020), each result with the level of its proof (null: declared).
create or replace function stayput.member_space(p_company text, p_user text)
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
                                          'recordedAt', r.recorded_at,
                                          'proof', (select p.level from stayput.proofs p
                                                     where p.company_id = p_company
                                                       and p.result_id = r.id
                                                     order by p.created_at limit 1))
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

revoke all on function stayput.record_result(text, text, uuid, numeric, timestamptz, jsonb)
  from public;
