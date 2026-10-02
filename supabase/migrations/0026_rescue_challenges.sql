-- SPEC Phase 5, point 9 (and the Phase 4 trigger): the rescue challenges. When the creator turns
-- them on (company_settings.options.rescue_challenges, off by default), a member inactive for 14
-- days becomes a challenge the community's members see in their space, anonymized: « Help a
-- member who stalled: answer their last message », with a link to that message where the
-- platform gives one (Discord, a Telegram supergroup). A member takes it up; if the stalled
-- member comes back, those who took it up before earn the « Rescuer » badge. A challenge ends
-- after 14 days, or when its member leaves or goes on the « never contact » list.

-- Where to answer the stalled member, frozen when the challenge is made: the platform, the place
-- (a server's or group's name), the link to the message when there is one, and its time.
alter table stayput.rescue_challenges
  add column last_message jsonb not null default '{}'
    check (jsonb_typeof(last_message) = 'object');
create index rescue_challenges_open on stayput.rescue_challenges (company_id, status, created_at);

-- The member's last message in the community (Whop chat, Discord, Telegram), within 90 days,
-- as a challenge shows it; null without one.
create function stayput.last_public_message(p_company text, p_member text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select case e.type
           when 'discord_message' then jsonb_build_object(
             'platform', 'discord',
             'place', g.name,
             'url', case when g.guild_id is not null then
                      'https://discord.com/channels/' || g.guild_id || '/'
                      || (e.metadata ->> 'channel_id') || '/' || e.external_id end,
             'at', e.occurred_at)
           when 'telegram_message' then jsonb_build_object(
             'platform', 'telegram',
             'place', tc.title,
             -- A supergroup's message has a link its members can open; a small group's has none.
             'url', case when e.metadata ->> 'chat_id' like '-100%' then
                      'https://t.me/c/' || substr(e.metadata ->> 'chat_id', 5) || '/'
                      || split_part(e.external_id, ':', 2) end,
             'at', e.occurred_at)
           else jsonb_build_object('platform', 'whop', 'place', null, 'url', null,
                                   'at', e.occurred_at)
         end
    from stayput.activity_events e
    left join stayput.discord_guilds g
      on e.type = 'discord_message' and g.company_id = e.company_id
     and e.metadata ->> 'channel_id' = any (g.channel_ids)
    left join stayput.telegram_chats tc
      on e.type = 'telegram_message' and tc.company_id = e.company_id
     and tc.chat_id = e.metadata ->> 'chat_id'
   where e.company_id = p_company and e.member_id = p_member
     and e.type in ('message', 'discord_message', 'telegram_message')
     and e.occurred_at > p_now - interval '90 days' and e.occurred_at <= p_now
   order by e.occurred_at desc, e.id desc
   limit 1
$$;

-- The hourly round of a company's challenges: those that end (14 days, their member gone or on
-- the « never contact » list), those whose member came back (the Rescuer badge for whoever took
-- it up before), then the new ones while the creator has them on: at most 10 open, the members
-- who stalled most recently first (the easiest to bring back). Returns the challenges made.
create function stayput.plan_rescues(p_company text, p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_challenge record;
  v_open integer;
  v_made integer := 0;
begin
  perform 1 from stayput.companies c
   where c.id = p_company and c.status = 'active' and not c.is_demo
     for update;
  if not found then
    return 0;
  end if;

  -- The member came back: any activity of theirs after the challenge was made.
  for v_challenge in
    select r.id, back.at
      from stayput.rescue_challenges r
      cross join lateral (
        select min(e.occurred_at) as at from stayput.activity_events e
         where e.company_id = r.company_id and e.member_id = r.target_member_id
           and e.occurred_at > r.created_at and e.occurred_at <= p_now) back
     where r.company_id = p_company and r.status = 'open' and back.at is not null
  loop
    update stayput.rescue_challenges set status = 'resolved', resolved_at = v_challenge.at
     where id = v_challenge.id;
    update stayput.rescue_challenge_participants p set reengaged_target = true
     where p.company_id = p_company and p.challenge_id = v_challenge.id
       and p.joined_at <= v_challenge.at;
    perform stayput.award_badge(p_company, p.member_id, 'rescuer', p_now,
                                jsonb_build_object('challenge_id', v_challenge.id))
       from stayput.rescue_challenge_participants p
      where p.company_id = p_company and p.challenge_id = v_challenge.id
        and p.reengaged_target;
  end loop;

  -- Two weeks without coming back, gone, or never to be contacted: the challenge ends.
  update stayput.rescue_challenges r
     set status = 'expired', resolved_at = p_now
    from stayput.members m
   where r.company_id = p_company and r.status = 'open'
     and m.company_id = r.company_id and m.id = r.target_member_id
     and (r.created_at <= p_now - interval '14 days' or m.status <> 'joined'
          or m.do_not_contact);

  if not coalesce((select (s.options ->> 'rescue_challenges')::boolean
                     from stayput.company_settings s where s.company_id = p_company), false) then
    return 0;
  end if;

  select count(*) into v_open from stayput.rescue_challenges r
   where r.company_id = p_company and r.status = 'open';
  insert into stayput.rescue_challenges (company_id, target_member_id, status, created_at,
                                         last_message)
  select p_company, y.id, 'open', p_now, y.last_message
    from (
      -- The last message is read only for the members who stalled (within 90 days: an older
      -- one is no conversation to answer).
      select x.id, x.last_active,
             stayput.last_public_message(p_company, x.id, p_now) as last_message
        from (
          select m.id,
                 (select max(e.occurred_at) from stayput.activity_events e
                   where e.company_id = m.company_id and e.member_id = m.id) as last_active
            from stayput.members m
           where m.company_id = p_company and m.status = 'joined'
             and m.access_level is distinct from 'admin' and not m.do_not_contact
             and m.joined_at <= p_now - interval '14 days'
             -- One challenge a month at most for the same member.
             and not exists (select 1 from stayput.rescue_challenges r
                              where r.company_id = m.company_id and r.target_member_id = m.id
                                and r.created_at > p_now - interval '30 days')) x
       where x.last_active <= p_now - interval '14 days'
         and x.last_active > p_now - interval '90 days') y
   where y.last_message is not null
   order by y.last_active desc, y.id
   limit greatest(10 - v_open, 0);
  get diagnostics v_made = row_count;
  return v_made;
end
$$;

-- The challenges a member sees: the open ones of their community, never their own, the least
-- taken up first, then whose member stalled most recently, 5 at most; with what they took up,
-- and how many members they brought back.
-- Null for someone StayPut does not know, or while the creator has the challenges off.
create function stayput.member_rescues(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'challenges', coalesce((
             select jsonb_agg(c.item order by c.helpers, c.at desc, c.id)
               from (
                 select r.id, (r.last_message ->> 'at')::timestamptz as at,
                        (select count(*) from stayput.rescue_challenge_participants p
                          where p.company_id = r.company_id and p.challenge_id = r.id) as helpers,
                        jsonb_build_object(
                          'id', r.id,
                          'platform', r.last_message ->> 'platform',
                          'place', r.last_message ->> 'place',
                          'url', r.last_message ->> 'url',
                          'lastMessageAt', r.last_message ->> 'at',
                          'createdAt', r.created_at,
                          'helpers', (select count(*) from stayput.rescue_challenge_participants p
                                       where p.company_id = r.company_id
                                         and p.challenge_id = r.id),
                          'joined', exists (select 1 from stayput.rescue_challenge_participants p
                                             where p.company_id = r.company_id
                                               and p.challenge_id = r.id
                                               and p.member_id = m.id)) as item
                   from stayput.rescue_challenges r
                  where r.company_id = m.company_id and r.status = 'open'
                    and r.target_member_id <> m.id
                  order by helpers, at desc, r.id
                  limit 5) c), '[]'::jsonb),
           'rescued', (select count(*) from stayput.rescue_challenge_participants p
                        where p.company_id = m.company_id and p.member_id = m.id
                          and p.reengaged_target))
    from stayput.members m
    join stayput.company_settings s on s.company_id = m.company_id
   where m.company_id = p_company and m.user_id = p_user
     and coalesce((s.options ->> 'rescue_challenges')::boolean, false)
$$;

-- The member takes a challenge up: an open one of their community, not about them.
create function stayput.join_rescue(p_company text, p_user text, p_challenge uuid,
                                    p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user and m.status = 'joined';
  if v_member is null or not exists (
       select 1 from stayput.rescue_challenges r
        where r.company_id = p_company and r.id = p_challenge and r.status = 'open'
          and r.target_member_id <> v_member) then
    return false;
  end if;
  insert into stayput.rescue_challenge_participants (company_id, challenge_id, member_id,
                                                     joined_at)
  values (p_company, p_challenge, v_member, p_now)
  on conflict (challenge_id, member_id) do nothing;
  return true;
end
$$;

-- The creator turns the challenges on or off (the open ones go on to their end).
create function stayput.save_rescues(p_company text, p_enabled boolean) returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('rescue_challenges', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.last_public_message(text, text, timestamptz) from public;
revoke all on function stayput.plan_rescues(text, timestamptz) from public;
revoke all on function stayput.member_rescues(text, text) from public;
revoke all on function stayput.join_rescue(text, text, uuid, timestamptz) from public;
revoke all on function stayput.save_rescues(text, boolean) from public;
