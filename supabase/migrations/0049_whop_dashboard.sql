-- Integrations › Whop, a dashboard like Discord's and Telegram's (the founder, 2026-10-10): the
-- members active and gone silent on Whop, the messages per day, when the community writes, each
-- chat and forum with its most active members, the most active and the silent members. A Whop
-- « message » is what a member writes there: a chat message or a forum post (who, where and
-- when, never what, as everywhere). The signals of Discord and Telegram stay theirs: Whop's
-- activity already makes the risk score's five factors.

-- 1. The chats and forums by name, as their Whop listings give them (the synchronization reads
--    them every day): a chat by its id, a forum by its experience, the ids its messages carry.
create table stayput.whop_places (
  company_id text not null references stayput.companies (id) on delete cascade,
  id text not null check (id ~ '^[a-z]+_[A-Za-z0-9]+$'),
  kind text not null check (kind in ('chat', 'forum')),
  name text check (char_length(name) <= 255),
  seen_at timestamptz not null,
  primary key (company_id, id)
);
alter table stayput.whop_places enable row level security;
create policy creator_read on stayput.whop_places for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.whop_places to stayput_user;

-- A page of Whop's chat_channels or forums listing (`{data: [...]}`, or the array alone): each
-- chat or forum's name, under the id its messages carry. Returns how many are named.
create function stayput.note_whop_places(p_company text, p_kind text, p_page jsonb,
                                         p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer := 0;
  item jsonb;
  v_id text;
  v_name text;
begin
  if p_kind not in ('chat_channels', 'forums') then
    return 0;
  end if;
  for item in
    select value from jsonb_array_elements(
      case jsonb_typeof(p_page) when 'array' then p_page
                                else coalesce(p_page -> 'data', '[]') end)
  loop
    v_id := case p_kind when 'forums' then coalesce(item -> 'experience' ->> 'id', item ->> 'id')
                        else item ->> 'id' end;
    v_name := nullif(btrim(left(coalesce(item -> 'experience' ->> 'name', item ->> 'name'),
                                255)), '');
    continue when v_id is null or v_id !~ '^[a-z]+_[A-Za-z0-9]+$';
    insert into stayput.whop_places as w (company_id, id, kind, name, seen_at)
    values (p_company, v_id, case p_kind when 'forums' then 'forum' else 'chat' end, v_name,
            p_now)
    on conflict (company_id, id) do update
      set name = coalesce(excluded.name, w.name), kind = excluded.kind, seen_at = excluded.seen_at;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- 2. The dashboards read Whop as a third platform: its messages (chat messages and forum posts),
--    its places (chats and forums), and the three readings open to it.
create or replace function stayput.platform_messages(p_company text, p_platform text, p_since timestamptz)
returns table (member_id text, account_id text, occurred_at timestamptz, place text, kind text)
language sql stable set search_path = ''
as $$
  select m.member_id, m.account_id, m.occurred_at,
         case p_platform
           when 'discord' then coalesce(m.metadata ->> 'channel_id', '')
           -- Whop: a chat's messages by their chat, a forum's posts by its experience.
           when 'whop' then coalesce(m.metadata ->> 'channel_id', m.metadata ->> 'experience_id', '')
           else coalesce(m.metadata ->> 'chat_id', '') || ':'
                || coalesce(m.metadata ->> 'topic_id', '')
         end,
         case when mem.access_level = 'admin' then 'team'
              when m.member_id is not null then 'member'
              when pa.dismissed_as = 'team' then 'team'
              when pa.dismissed_as = 'guest' then 'guest'
              else 'unlinked' end
    from (
      select e.member_id, null::text as account_id, e.occurred_at, e.metadata
        from stayput.activity_events e
       where e.company_id = p_company
         and e.type = any (case p_platform when 'whop' then array['message', 'forum_post']
                                           else array[p_platform || '_message'] end)
         and e.occurred_at > p_since
      union all
      select null, split_part(p.user_id, ':', 2), p.occurred_at, p.metadata
        from stayput.pending_activity p
       where p.company_id = p_company and p.user_id like p_platform || ':%'
         and p.occurred_at > p_since
    ) m
    left join stayput.members mem on mem.company_id = p_company and mem.id = m.member_id
    left join stayput.platform_accounts pa
      on pa.company_id = p_company and pa.platform = p_platform and pa.account_id = m.account_id
$$;

create or replace function stayput.platform_places(p_company text, p_platform text)
returns table (place text, kind text, name text, parent text, followed boolean)
language sql stable set search_path = ''
as $$
  select c.id, 'channel', g.channel_names -> c.id ->> 'name', g.name, c.id = any (g.channel_ids)
    from stayput.discord_guilds g
   cross join lateral (select jsonb_object_keys(g.channel_names) as id
                       union select unnest(g.channel_ids)) c
   where p_platform = 'discord' and g.company_id = p_company
  union all
  select t.chat_id || ':',
         case when exists (select 1 from stayput.telegram_topics o
                            where o.company_id = p_company and o.chat_id = t.chat_id)
              then 'general' else 'group' end,
         t.title, null, t.left_at is null
    from stayput.telegram_chats t
   where p_platform = 'telegram' and t.company_id = p_company
  union all
  select o.chat_id || ':' || o.topic_id, 'topic', o.name, t.title, t.left_at is null
    from stayput.telegram_topics o
    join stayput.telegram_chats t on t.chat_id = o.chat_id and t.company_id = o.company_id
   where p_platform = 'telegram' and o.company_id = p_company
  union all
  select w.id, w.kind, w.name, null, true
    from stayput.whop_places w
   where p_platform = 'whop' and w.company_id = p_company
$$;

create or replace function stayput.platform_dashboard(p_company text, p_platform text, p_now timestamptz)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), today as (
    select (p_now at time zone z.tz)::date as day, z.tz from zone z
  ), days as (
    select (t.day - g)::date as day from today t, generate_series(0, 29) g
  ), authored as (
    select m.*, (m.occurred_at at time zone t.tz) as local_at
      from stayput.platform_messages(p_company, p_platform, p_now - interval '91 days') m,
           today t
     where (m.occurred_at at time zone t.tz)::date > t.day - 90
  ), recent as (
    select a.*, a.local_at::date as day,
           coalesce(r.level in ('high', 'scheduled_departure'), false) as at_risk
      from authored a
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = a.member_id
     where a.local_at::date > (select day from today) - 30
  ), people as (
    -- The community's members who wrote there over 90 days, the team aside.
    select a.member_id,
           count(*) filter (where a.local_at::date > t.day - 7) as d7,
           count(*) filter (where a.local_at::date > t.day - 14) as d14,
           count(*) filter (where a.local_at::date > t.day - 30) as d30,
           count(*) as d90,
           max(a.occurred_at) as last_at,
           mem.display_name as name, r.score, r.level
      from authored a
      cross join today t
      join stayput.members mem on mem.company_id = p_company and mem.id = a.member_id
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = a.member_id
     where a.kind = 'member' and mem.status = 'joined'
     group by a.member_id, mem.display_name, r.score, r.level
  ), names as (
    select * from stayput.platform_places(p_company, p_platform)
  ), counts as (
    select r.place, count(*) as messages,
           count(distinct r.member_id) filter (where r.kind = 'member') as members,
           max(r.occurred_at) as last_at
      from recent r group by r.place
  ), leaders as (
    select x.place,
           jsonb_agg(jsonb_build_object('id', x.member_id, 'name', mem.display_name,
                                        'messages', x.n) order by x.n desc, x.member_id) as top
      from (select r.place, r.member_id, count(*) as n,
                   row_number() over (partition by r.place
                                      order by count(*) desc, r.member_id) as rank
              from recent r where r.kind = 'member' group by r.place, r.member_id) x
      join stayput.members mem on mem.company_id = p_company and mem.id = x.member_id
     where x.rank <= 3
     group by x.place
  ), places as (
    select coalesce(n.place, c.place) as place,
           coalesce(n.kind, case p_platform when 'discord' then 'channel' when 'whop' then 'chat' else 'group' end)
             as kind,
           n.name, n.parent,
           coalesce(c.messages, 0) as messages, coalesce(c.members, 0) as members, c.last_at
      from names n
      full join counts c on c.place = n.place
     where c.place is not null or (n.followed and n.kind <> 'topic')
  ), made as (
    -- The members' scores as made, for the preview of other settings.
    select coalesce((r.signals ->> 'base')::integer, r.score::integer) as base,
           coalesce((r.signals ->> 'discord')::integer, 0) as discord,
           coalesce((r.signals ->> 'telegram')::integer, 0) as telegram,
           coalesce((r.signals ->> 'rule')::integer,
                    case r.level when 'scheduled_departure' then 1 else 0 end) as rule,
           count(*) as n
      from stayput.member_risk r
      join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
     where r.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
     group by 1, 2, 3, 4
  ), lists as (
    select w.days,
           (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', a.member_id, 'name', a.name, 'messages', a.n, 'lastAt', a.last_at,
                      'score', a.score, 'level', a.level)
                    order by a.n desc, a.last_at desc, a.member_id), '[]')
              from (select pe.member_id, pe.name, pe.last_at, pe.score, pe.level,
                           case w.days when 7 then pe.d7 when 14 then pe.d14 else pe.d30 end as n
                      from people pe
                     where (case w.days when 7 then pe.d7 when 14 then pe.d14
                                        else pe.d30 end) > 0
                     order by n desc, pe.last_at desc, pe.member_id
                     limit 10) a) as active,
           (select count(*) from people pe
             where (case w.days when 7 then pe.d7 when 14 then pe.d14 else pe.d30 end) = 0)
             as silent_total,
           (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', s.member_id, 'name', s.name, 'messages', s.d90,
                      'lastAt', s.last_at, 'score', s.score, 'level', s.level)
                    order by s.score desc nulls last, s.last_at desc, s.member_id), '[]')
              from (select pe.* from people pe
                     where (case w.days when 7 then pe.d7 when 14 then pe.d14
                                        else pe.d30 end) = 0
                     order by pe.score desc nulls last, pe.last_at desc, pe.member_id
                     limit 10) s) as silent
      from (values (7), (14), (30)) w (days)
  )
  select case when stayput.is_company_admin(p_company)
                   and p_platform in ('discord', 'telegram', 'whop') then jsonb_build_object(
    'platform', p_platform,
    'from', (select min(day) from days),
    'to', (select max(day) from days),
    'hero', jsonb_build_object(
      'activeMembers7d', (select count(*) from people where d7 > 0),
      'silentMembers7d', (select count(*) from people where d7 = 0),
      'messages30d', (select count(*) from recent),
      'memberMessages30d', (select count(*) from recent where kind = 'member')),
    'daily', (
      select jsonb_agg(jsonb_build_object(
               'day', d.day, 'messages', coalesce(n.messages, 0),
               'members', coalesce(n.members, 0), 'atRisk', coalesce(n.at_risk, 0))
             order by d.day)
        from days d
        left join (select r.day, count(*) as messages,
                          count(*) filter (where r.kind = 'member') as members,
                          count(*) filter (where r.kind = 'member' and r.at_risk) as at_risk
                     from recent r group by r.day) n on n.day = d.day),
    'heatmap', coalesce((
      select jsonb_agg(jsonb_build_object('dow', h.dow, 'hour', h.hour,
                                          'messages', h.messages, 'members', h.members)
                       order by h.dow, h.hour)
        from (select extract(isodow from r.local_at)::integer as dow,
                     extract(hour from r.local_at)::integer as hour,
                     count(*) as messages,
                     count(distinct r.member_id) filter (where r.kind = 'member') as members
                from recent r group by 1, 2) h), '[]'),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.place, 'kind', p.kind, 'name', p.name, 'parent', p.parent,
               'messages', p.messages, 'members', p.members, 'lastAt', p.last_at,
               'top', coalesce(t.top, '[]'))
             order by p.messages desc, p.name nulls last, p.place)
        from places p left join leaders t on t.place = p.place), '[]'),
    'active', (select jsonb_object_agg('d' || l.days, l.active) from lists l),
    'silent', (select jsonb_object_agg('d' || l.days, jsonb_build_object(
                        'total', l.silent_total, 'members', l.silent)) from lists l),
    'signals', jsonb_build_object(
      'settings', coalesce((select s.platform_signals from stayput.company_settings s
                             where s.company_id = p_company), '{}'),
      'mediumFrom', coalesce((select s.medium_risk_from from stayput.company_settings s
                               where s.company_id = p_company), 40),
      'highFrom', coalesce((select s.high_risk_from from stayput.company_settings s
                             where s.company_id = p_company), 70),
      'groups', coalesce((select jsonb_agg(jsonb_build_array(g.base, g.discord, g.telegram,
                                                             g.rule, g.n)
                                           order by g.base, g.discord, g.telegram, g.rule)
                            from made g), '[]')))
  end
$$;

create or replace function stayput.platform_day(p_company text, p_platform text, p_now timestamptz,
                                     p_day date) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), picked as (
    select m.*
      from stayput.platform_messages(p_company, p_platform, p_now - interval '32 days') m, zone z
     where (m.occurred_at at time zone z.tz)::date = p_day
  ), names as (
    select * from stayput.platform_places(p_company, p_platform)
  ), counts as (
    select p.place, count(*) as messages,
           count(distinct p.member_id) filter (where p.kind = 'member') as members,
           max(p.occurred_at) as last_at
      from picked p group by p.place
  ), leaders as (
    select x.place,
           jsonb_agg(jsonb_build_object('id', x.member_id, 'name', mem.display_name,
                                        'messages', x.n) order by x.n desc, x.member_id) as top
      from (select p.place, p.member_id, count(*) as n,
                   row_number() over (partition by p.place
                                      order by count(*) desc, p.member_id) as rank
              from picked p where p.kind = 'member' group by p.place, p.member_id) x
      join stayput.members mem on mem.company_id = p_company and mem.id = x.member_id
     where x.rank <= 3
     group by x.place
  ), people as (
    select p.member_id, count(*) as n, max(p.occurred_at) as last_at,
           mem.display_name as name, r.score, r.level
      from picked p
      join stayput.members mem on mem.company_id = p_company and mem.id = p.member_id
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = p.member_id
     where p.kind = 'member' and mem.status = 'joined'
     group by p.member_id, mem.display_name, r.score, r.level
  )
  select case when stayput.is_company_admin(p_company)
                   and p_platform in ('discord', 'telegram', 'whop') then jsonb_build_object(
    'day', p_day,
    'messages', (select count(*) from picked),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.place,
               'kind', coalesce(n.kind, case p_platform when 'discord' then 'channel' when 'whop' then 'chat'
                                                        else 'group' end),
               'name', n.name, 'parent', n.parent, 'messages', c.messages,
               'members', c.members, 'lastAt', c.last_at, 'top', coalesce(t.top, '[]'))
             order by c.messages desc, n.name nulls last, c.place)
        from counts c
        left join names n on n.place = c.place
        left join leaders t on t.place = c.place), '[]'),
    'active', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.member_id, 'name', x.name,
                                          'messages', x.n, 'lastAt', x.last_at,
                                          'score', x.score, 'level', x.level)
                       order by x.n desc, x.last_at desc, x.member_id)
        from (select * from people order by n desc, last_at desc, member_id limit 20) x), '[]'))
  end
$$;

create or replace function stayput.platform_slot(p_company text, p_platform text, p_now timestamptz,
                                      p_dow integer, p_hour integer) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), today as (
    select (p_now at time zone z.tz)::date as day, z.tz from zone z
  ), picked as (
    select m.*
      from stayput.platform_messages(p_company, p_platform, p_now - interval '32 days') m,
           today t
     where (m.occurred_at at time zone t.tz)::date > t.day - 30
       and extract(isodow from m.occurred_at at time zone t.tz) = p_dow
       and extract(hour from m.occurred_at at time zone t.tz) = p_hour
  ), people as (
    select p.member_id, count(*) as n, max(p.occurred_at) as last_at,
           mem.display_name as name, r.score, r.level
      from picked p
      join stayput.members mem on mem.company_id = p_company and mem.id = p.member_id
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = p.member_id
     where p.kind = 'member' and mem.status = 'joined'
     group by p.member_id, mem.display_name, r.score, r.level
  )
  select case when stayput.is_company_admin(p_company)
                   and p_platform in ('discord', 'telegram', 'whop') then jsonb_build_object(
    'dow', p_dow,
    'hour', p_hour,
    'messages', (select count(*) from picked),
    'others', (select count(*) from picked p
                where p.member_id is null or p.member_id not in (select member_id from people)),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.member_id, 'name', x.name,
                                          'messages', x.n, 'lastAt', x.last_at,
                                          'score', x.score, 'level', x.level)
                       order by x.n desc, x.last_at desc, x.member_id)
        from (select * from people order by n desc, last_at desc, member_id limit 50) x), '[]'))
  end
$$;

revoke all on function stayput.note_whop_places(text, text, jsonb, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
