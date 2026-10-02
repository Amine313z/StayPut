-- SPEC Phase 5, point 4: a member's milestone announced in the community's chat, when the creator
-- chose where (a Whop chat channel, a Discord channel, a Telegram group) and the member asks for
-- it, after seeing the exact words. An action like the others (`milestone_announcement`): the
-- stops, « never contact », test mode and manual mode apply. Once per goal and milestone. Only
-- the member's first name, the goal's title and the milestone: never their numbers.

-- Where the announcements go (packages/core AnnounceDestination: platform, id, the channel's
-- name and where it is, kept for the member view); null: none.
alter table stayput.company_settings
  add column announce_to jsonb check (
    announce_to is null
    or (jsonb_typeof(announce_to) = 'object'
        and announce_to ->> 'platform' in ('whop', 'discord', 'telegram')
        and announce_to ->> 'id' is not null));

create function stayput.save_announce_to(p_company text, p_destination jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set announce_to = p_destination where company_id = p_company;
end
$$;

-- What the member space needs to offer the sharing: the community's language, the member's first
-- name as the announcement writes it, and where it goes. Null when the creator chose nowhere.
create function stayput.member_announce(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select case when s.announce_to is null then null else jsonb_build_object(
           'locale', c.locale,
           'firstName', (
             select nullif(split_part(coalesce(m.display_name, ''), ' ', 1), '')
               from stayput.members m
              where m.company_id = p_company and m.user_id = p_user),
           'place', coalesce(s.announce_to ->> 'name', s.announce_to ->> 'id')) end
    from stayput.company_settings s
    join stayput.companies c on c.id = s.company_id
   where s.company_id = p_company;
$$;

-- The member asks for a milestone of their goal to be announced: the action, with where it goes
-- and what it says (the goal's title, the milestone); the words are written when it runs, in
-- the community's language. `{"id": …}`, `{"duplicate": true}` when this milestone was shared
-- already, null when there is nowhere to announce, the goal is not theirs, or the milestone is
-- not reached.
create function stayput.share_milestone(p_company text, p_user text, p_goal uuid,
                                        p_percent integer, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_to jsonb;
  v_title text;
  v_action uuid;
begin
  select s.announce_to into v_to from stayput.company_settings s
    join stayput.companies c on c.id = s.company_id
   where s.company_id = p_company and c.status = 'active' and not c.is_demo;
  if v_to is null then
    return null;
  end if;
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user and m.status = 'joined';
  if v_member is null then
    return null;
  end if;
  select g.title into v_title from stayput.goals g
   where g.company_id = p_company and g.member_id = v_member and g.id = p_goal
     and exists (select 1 from stayput.milestones ms
                  where ms.company_id = p_company and ms.goal_id = g.id
                    and ms.percent = p_percent);
  if v_title is null then
    return null;
  end if;
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, content,
                               send_at, message_kind, dedupe_key, created_at)
  values (p_company, v_member, 'milestone_announcement', 'member_request', p_goal::text,
          jsonb_build_object('platform', v_to ->> 'platform', 'channel_id', v_to ->> 'id',
                             'channel', coalesce(v_to ->> 'name', v_to ->> 'id'),
                             'goal_id', p_goal, 'goal_title', v_title, 'percent', p_percent),
          p_now, 'none', 'announce:' || p_goal || ':' || p_percent, p_now)
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_action;
  if v_action is null then
    return jsonb_build_object('duplicate', true);
  end if;
  return jsonb_build_object('id', v_action);
end
$$;

revoke all on function stayput.save_announce_to(text, jsonb) from public;
revoke all on function stayput.member_announce(text, text) from public;
revoke all on function stayput.share_milestone(text, text, uuid, integer, timestamptz)
  from public;
