-- SPEC Phase 5, point 8: the buddies. When the creator turns them on (company_settings.options
-- .buddies, off by default), each newcomer (joined less than 7 days ago) is paired with a
-- veteran: a member for more than 30 days whose risk is low, of the same goal category when one
-- is free, with at most 3 active pairs. Newcomers the activation radar flags come first. Both
-- get an introduction (a Whop notification at their golden hour: an action like the others,
-- through the guardrails, simulated in test mode, waiting for the creator in manual mode). After
-- 30 days, a newcomer still there earns the veteran the Mentor badge. Either of them may ask
-- not to be paired; the « never contact » list is never paired.

-- When the member asked not to be paired (null: they may be).
alter table stayput.members add column buddy_optout_at timestamptz;

-- How a pair ended: done after 30 days (completed), or cut short (ended) and why.
alter table stayput.buddy_pairs
  add column ended_at timestamptz,
  add column end_reason text
    check (end_reason in ('newcomer_left', 'veteran_left', 'optout', 'do_not_contact')),
  add constraint buddy_pairs_ended check ((status = 'active') = (ended_at is null)),
  add constraint buddy_pairs_reason check ((status = 'ended') = (end_reason is not null));

-- The category a member's goal is in (the one under way, else the last reached), for pairing
-- alike; null without one, or for « other », which pairs nobody alike.
create function stayput.member_goal_category(p_company text, p_member text) returns text
language sql stable set search_path = ''
as $$
  select nullif(coalesce(g.category, 'other'), 'other')
    from stayput.goals g
   where g.company_id = p_company and g.member_id = p_member
     and g.status in ('active', 'achieved')
   order by g.status = 'active' desc, g.created_at desc, g.id
   limit 1
$$;

-- A pair cut short: its introductions not sent yet no longer go.
create function stayput.end_buddy_pair(p_company text, p_pair uuid, p_reason text,
                                       p_now timestamptz)
returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.buddy_pairs
     set status = 'ended', ended_at = p_now, end_reason = p_reason
   where company_id = p_company and id = p_pair and status = 'active';
  update stayput.actions
     set status = 'cancelled', result = jsonb_build_object('reason', 'pair_ended', 'at', p_now)
   where company_id = p_company and type in ('buddy_intro', 'mentor_intro')
     and subject_id = p_pair::text and status in ('proposed', 'approved', 'scheduled');
end
$$;

-- The hourly pairing of a company: the pairs that end, those 30 days old (the Mentor badge),
-- then the new pairs while the creator has the buddies on, each with its two introductions.
-- Returns the introductions planned.
create function stayput.plan_buddies(p_company text, p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_pair record;
  v_newcomer record;
  v_veteran record;
  v_pair_id uuid;
  v_planned integer := 0;
begin
  -- One run at a time per company: a veteran's pairs are counted, then added to.
  perform 1 from stayput.companies c
   where c.id = p_company and c.status = 'active' and not c.is_demo
     for update;
  if not found then
    return 0;
  end if;

  -- Gone, asked not to be paired, or on the « never contact » list: the pair ends.
  for v_pair in
    select p.id,
           case
             when n.status <> 'joined' then 'newcomer_left'
             when v.status <> 'joined' then 'veteran_left'
             when n.buddy_optout_at is not null or v.buddy_optout_at is not null then 'optout'
             when n.do_not_contact or v.do_not_contact then 'do_not_contact'
           end as reason
      from stayput.buddy_pairs p
      join stayput.members n on n.company_id = p.company_id and n.id = p.newcomer_member_id
      join stayput.members v on v.company_id = p.company_id and v.id = p.veteran_member_id
     where p.company_id = p_company and p.status = 'active'
  loop
    continue when v_pair.reason is null;
    perform stayput.end_buddy_pair(p_company, v_pair.id, v_pair.reason, p_now);
  end loop;

  -- 30 days on, the newcomer is still there: the veteran is a mentor.
  for v_pair in
    update stayput.buddy_pairs p
       set status = 'completed', ended_at = p_now
     where p.company_id = p_company and p.status = 'active'
       and p.paired_at <= p_now - interval '30 days'
    returning p.id, p.newcomer_member_id, p.veteran_member_id
  loop
    perform stayput.award_badge(p_company, v_pair.veteran_member_id, 'mentor', p_now,
                                jsonb_build_object('pair_id', v_pair.id,
                                                   'newcomer_id', v_pair.newcomer_member_id));
  end loop;

  if not coalesce((select (s.options ->> 'buddies')::boolean from stayput.company_settings s
                    where s.company_id = p_company), false) then
    return 0;
  end if;

  -- The newcomers without a buddy, those who have not started first, then the earliest.
  for v_newcomer in
    select m.id, nullif(split_part(coalesce(m.display_name, ''), ' ', 1), '') as first_name,
           stayput.member_goal_category(m.company_id, m.id) as category
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and m.access_level is distinct from 'admin'
       and not m.do_not_contact and m.buddy_optout_at is null
       and m.joined_at > p_now - interval '7 days' and m.joined_at <= p_now
       and not exists (select 1 from stayput.buddy_pairs p
                        where p.company_id = m.company_id and p.newcomer_member_id = m.id
                          and p.status in ('active', 'completed'))
     order by coalesce(r.inactive_newcomer, false) desc, m.joined_at, m.id
  loop
    -- A veteran with room: of the same category when one is, then the least taken, the most
    -- engaged, the longest there. At most one new pair every 5 days (the guardrails let one
    -- introduction through in that time), never the same pair twice.
    select v.id, nullif(split_part(coalesce(v.display_name, ''), ' ', 1), '') as first_name
      into v_veteran
      from stayput.members v
      join stayput.member_risk r
        on r.company_id = v.company_id and r.member_id = v.id and r.level = 'low'
      cross join lateral (
        select count(*) as active from stayput.buddy_pairs p
         where p.company_id = v.company_id and p.veteran_member_id = v.id
           and p.status = 'active') taken
     where v.company_id = p_company and v.status = 'joined'
       and v.access_level is distinct from 'admin'
       and not v.do_not_contact and v.buddy_optout_at is null
       and v.joined_at <= p_now - interval '30 days'
       and taken.active < 3
       and not exists (select 1 from stayput.buddy_pairs p
                        where p.company_id = v.company_id and p.veteran_member_id = v.id
                          and (p.paired_at > p_now - interval '5 days'
                               or p.newcomer_member_id = v_newcomer.id))
     order by (stayput.member_goal_category(v.company_id, v.id) = v_newcomer.category) is true
                desc,
              taken.active, r.score, v.joined_at, v.id
     limit 1;
    continue when v_veteran.id is null;

    insert into stayput.buddy_pairs (company_id, newcomer_member_id, veteran_member_id,
                                     paired_at)
    values (p_company, v_newcomer.id, v_veteran.id, p_now)
    returning id into v_pair_id;
    -- Each learns the other's first name; the Worker sets the time (the golden hour).
    insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                                 dedupe_key, content)
    values
      (p_company, v_newcomer.id, 'buddy_intro', 'buddy_pair', v_pair_id::text, 'relance',
       'buddy_intro:' || v_pair_id,
       jsonb_build_object('pair_id', v_pair_id, 'buddy_id', v_veteran.id,
                          'buddy_name', v_veteran.first_name)),
      (p_company, v_veteran.id, 'mentor_intro', 'buddy_pair', v_pair_id::text, 'relance',
       'mentor_intro:' || v_pair_id,
       jsonb_build_object('pair_id', v_pair_id, 'buddy_id', v_newcomer.id,
                          'buddy_name', v_newcomer.first_name));
    v_planned := v_planned + 2;
  end loop;
  return v_planned;
end
$$;

-- What the member space shows of the member's buddies: each one paired with them now (the
-- other's name, since when they are a member, their goal category when it is the member's),
-- and whether they asked not to be paired. Null for someone StayPut does not know.
create function stayput.member_buddies(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'optedOut', m.buddy_optout_at is not null,
           'partners', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'pairId', p.id,
                      -- What the other one is to the member.
                      'role', case when p.newcomer_member_id = m.id then 'veteran'
                                   else 'newcomer' end,
                      'name', o.display_name,
                      'joinedAt', o.joined_at,
                      'pairedAt', p.paired_at,
                      'sameCategory',
                        case when mine.category = stayput.member_goal_category(o.company_id, o.id)
                             then mine.category end)
                    order by p.paired_at, p.id)
               from stayput.buddy_pairs p
               join stayput.members o
                 on o.company_id = p.company_id
                and o.id = case when p.newcomer_member_id = m.id then p.veteran_member_id
                                else p.newcomer_member_id end
              where p.company_id = m.company_id and p.status = 'active'
                and m.id in (p.newcomer_member_id, p.veteran_member_id)), '[]'::jsonb))
    from stayput.members m
    cross join lateral (
      select stayput.member_goal_category(m.company_id, m.id) as category) mine
   where m.company_id = p_company and m.user_id = p_user
$$;

-- The member asks not to be paired (their pairs end), or may be again.
create function stayput.set_buddy_optout(p_company text, p_user text, p_optout boolean,
                                         p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_pair uuid;
begin
  update stayput.members m
     set buddy_optout_at = case when p_optout then coalesce(m.buddy_optout_at, p_now) end
   where m.company_id = p_company and m.user_id = p_user
  returning m.id into v_member;
  if v_member is null then
    return false;
  end if;
  if p_optout then
    for v_pair in
      select p.id from stayput.buddy_pairs p
       where p.company_id = p_company and p.status = 'active'
         and v_member in (p.newcomer_member_id, p.veteran_member_id)
    loop
      perform stayput.end_buddy_pair(p_company, v_pair, 'optout', p_now);
    end loop;
  end if;
  return true;
end
$$;

-- The creator turns the buddies on or off (the pairs under way go on to their end).
create function stayput.save_buddies(p_company text, p_enabled boolean) returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('buddies', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.member_goal_category(text, text) from public;
revoke all on function stayput.end_buddy_pair(text, uuid, text, timestamptz) from public;
revoke all on function stayput.plan_buddies(text, timestamptz) from public;
revoke all on function stayput.member_buddies(text, text) from public;
revoke all on function stayput.set_buddy_optout(text, text, boolean, timestamptz) from public;
revoke all on function stayput.save_buddies(text, boolean) from public;
