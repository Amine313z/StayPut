-- SPEC Phase 5, point 5, the earned days: when the creator turns them on (company_settings
-- .options.earned_days, off by default), a milestone a member reaches gives free days on their
-- membership: 3 at 50 %, 7 at 100 % by default, the creator's numbers otherwise. Once per member
-- and milestone (the first time they reach it while the earned days are on), so that a goal made
-- easy on purpose cannot be repeated for more days. The days are an `extend_offer` action
-- (trigger `milestone`):
-- the guardrails count them with the departure survey's free days (14 a quarter at most), test
-- mode simulates them, manual mode waits for the creator.

alter table stayput.company_settings
  add column earned_days_50 smallint not null default 3 check (earned_days_50 between 0 and 14),
  add column earned_days_100 smallint not null default 7 check (earned_days_100 between 0 and 14);

-- The days the milestones `p_percents` bring the member, as actions to schedule: one per
-- milestone the creator rewards, on the membership the member pays now. The actions made, each
-- with its days (none when the earned days are off, the member has no live membership, or
-- already had them for that milestone).
create function stayput.plan_earned_days(p_company text, p_user text, p_goal uuid,
                                         p_percents integer[], p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_membership text;
  v_on boolean;
  v_at50 integer;
  v_at100 integer;
  v_percent integer;
  v_days integer;
  v_action uuid;
  v_actions jsonb := '[]';
begin
  select coalesce((s.options ->> 'earned_days')::boolean, false), s.earned_days_50,
         s.earned_days_100
    into v_on, v_at50, v_at100
    from stayput.company_settings s
    join stayput.companies c on c.id = s.company_id
   where s.company_id = p_company and c.status = 'active' and not c.is_demo;
  if not coalesce(v_on, false) then
    return v_actions;
  end if;
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user and m.status = 'joined';
  if v_member is null then
    return v_actions;
  end if;
  -- The membership the member pays now (a cancellation scheduled keeps it live until its end).
  select ms.id into v_membership from stayput.memberships ms
   where ms.company_id = p_company and ms.member_id = v_member
     and ms.status in ('active', 'trialing', 'canceling')
     and coalesce(ms.current_period_end, p_now + interval '1 day') > p_now
   order by ms.current_period_end desc nulls last, ms.id
   limit 1;
  if v_membership is null then
    return v_actions;
  end if;
  foreach v_percent in array coalesce(p_percents, '{}') loop
    v_days := case v_percent when 50 then v_at50 when 100 then v_at100 else 0 end;
    continue when v_days <= 0;
    -- The milestone must be reached on this goal of the member's.
    continue when not exists (
      select 1 from stayput.milestones ms
       where ms.company_id = p_company and ms.member_id = v_member and ms.goal_id = p_goal
         and ms.percent = v_percent);
    insert into stayput.actions (company_id, member_id, type, trigger, subject_id, content,
                                 send_at, message_kind, dedupe_key, created_at)
    values (p_company, v_member, 'extend_offer', 'milestone', v_membership,
            jsonb_build_object('days', v_days, 'percent', v_percent, 'goal_id', p_goal,
                               'membership_id', v_membership),
            p_now, 'none', 'earned_days:' || v_member || ':' || v_percent, p_now)
    on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing
    returning id into v_action;
    if v_action is not null then
      v_actions := v_actions || jsonb_build_object('id', v_action, 'days', v_days);
    end if;
  end loop;
  return v_actions;
end
$$;

-- What the member space shows of the earned days: the ones the creator offers now (null when
-- off), and the ones the member received (sent, not simulated).
create function stayput.member_rewards(p_company text, p_user text)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'offered', (
      select case when coalesce((s.options ->> 'earned_days')::boolean, false)
                  then jsonb_build_object('at50', s.earned_days_50, 'at100', s.earned_days_100)
             end
        from stayput.company_settings s
       where s.company_id = p_company),
    'received', coalesce((
      select jsonb_agg(jsonb_build_object('percent', (a.content ->> 'percent')::integer,
                                          'days', (a.content ->> 'days')::integer,
                                          'at', a.sent_at)
                       order by a.sent_at)
        from stayput.actions a
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
       where a.company_id = p_company and m.user_id = p_user
         and a.type = 'extend_offer' and a.trigger = 'milestone' and a.status = 'sent'),
      '[]'::jsonb))
$$;

-- The earned days as the creator sets them.
create function stayput.save_earned_days(p_company text, p_enabled boolean, p_at50 integer,
                                         p_at100 integer)
returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('earned_days', p_enabled),
         earned_days_50 = p_at50,
         earned_days_100 = p_at100
   where company_id = p_company;
end
$$;

revoke all on function stayput.plan_earned_days(text, text, uuid, integer[], timestamptz)
  from public;
revoke all on function stayput.member_rewards(text, text) from public;
revoke all on function stayput.save_earned_days(text, boolean, integer, integer) from public;
