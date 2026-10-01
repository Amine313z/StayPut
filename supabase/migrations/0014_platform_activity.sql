-- What StayPut sees on Discord and Telegram (the founder, 2026-10-01: « comment avoir un suivi de
-- Discord et Telegram sur StayPut si rien n'est affiché ? »). Over the last 30 days, in the
-- creator's time zone: the messages per platform and per day, who wrote them (members, the team,
-- guests, accounts not tied yet), the most active members, and each server and group. For the
-- company's team only; counts and names, never what was written.
create function stayput.platform_activity(p_company text, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), days as (
    select ((p_now at time zone z.tz)::date - g)::date as day
      from zone z, generate_series(0, 29) g
  ), messages as (
    select case e.type when 'discord_message' then 'discord' else 'telegram' end as platform,
           e.member_id, null::text as account_id, e.occurred_at, e.metadata
      from stayput.activity_events e
     where e.company_id = p_company and e.type in ('discord_message', 'telegram_message')
       and e.occurred_at > p_now - interval '31 days'
    union all
    select split_part(p.user_id, ':', 1), null, split_part(p.user_id, ':', 2), p.occurred_at,
           p.metadata
      from stayput.pending_activity p
     where p.company_id = p_company and p.user_id ~ '^(discord|telegram):'
       and p.occurred_at > p_now - interval '31 days'
  ), authored as (
    select m.platform, m.occurred_at, m.metadata,
           m.member_id,
           coalesce(m.member_id, m.platform || ':' || m.account_id) as author,
           case when mem.access_level = 'admin' then 'team'
                when m.member_id is not null then 'member'
                when pa.dismissed_as = 'team' then 'team'
                when pa.dismissed_as = 'guest' then 'guest'
                else 'unlinked' end as kind,
           (m.occurred_at at time zone (select tz from zone))::date as day
      from messages m
      left join stayput.members mem on mem.company_id = p_company and mem.id = m.member_id
      left join stayput.platform_accounts pa
        on pa.company_id = p_company and pa.platform = m.platform and pa.account_id = m.account_id
  ), recent as (
    select * from authored where day >= (select min(day) from days)
  ), places as (
    select r.platform,
           case r.platform
             when 'telegram' then r.metadata ->> 'chat_id'
             else coalesce((select g.guild_id from stayput.discord_guilds g
                             where g.company_id = p_company
                               and r.metadata ->> 'channel_id' = any (g.channel_ids)
                             limit 1), '')
           end as place,
           r.occurred_at
      from recent r
  ), top_members as (
    select r.member_id, count(*) filter (where r.platform = 'discord') as discord,
           count(*) filter (where r.platform = 'telegram') as telegram,
           count(*) as total, max(r.occurred_at) as last_at
      from recent r
     where r.kind = 'member'
     group by r.member_id
     order by count(*) desc, max(r.occurred_at) desc
     limit 5
  )
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'from', (select min(day) from days),
    'to', (select max(day) from days),
    'platforms', (
      select jsonb_agg(jsonb_build_object(
               'platform', p.platform,
               'messages', (select count(*) from recent r where r.platform = p.platform),
               'authors', (select count(distinct r.author) from recent r
                            where r.platform = p.platform),
               'members', (select count(distinct r.author) from recent r
                            where r.platform = p.platform and r.kind = 'member'),
               'team', (select count(distinct r.author) from recent r
                         where r.platform = p.platform and r.kind = 'team'),
               'guests', (select count(distinct r.author) from recent r
                           where r.platform = p.platform and r.kind = 'guest'),
               'unlinked', (select count(distinct r.author) from recent r
                             where r.platform = p.platform and r.kind = 'unlinked'),
               'lastAt', (select max(r.occurred_at) from recent r where r.platform = p.platform),
               'daily', (select jsonb_agg(coalesce(n.messages, 0) order by d.day)
                           from days d
                           left join (select r.day, count(*) as messages from recent r
                                       where r.platform = p.platform group by r.day) n
                             on n.day = d.day))
             order by p.platform)
        from (values ('discord'), ('telegram')) p (platform)),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', x.platform, 'id', nullif(x.place, ''),
               'name', case x.platform
                         when 'telegram' then (select t.title from stayput.telegram_chats t
                                                where t.chat_id = x.place
                                                  and t.company_id = p_company)
                         else (select g.name from stayput.discord_guilds g
                                where g.guild_id = x.place and g.company_id = p_company)
                       end,
               'messages', x.messages, 'lastAt', x.last_at)
             order by x.messages desc, x.last_at desc)
        from (select pl.platform, pl.place, count(*) as messages,
                     max(pl.occurred_at) as last_at
                from places pl group by pl.platform, pl.place
                order by count(*) desc limit 10) x), '[]'),
    'topMembers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.member_id, 'name', mem.display_name, 'discord', t.discord,
               'telegram', t.telegram, 'lastAt', t.last_at)
             order by t.total desc, t.last_at desc)
        from top_members t
        join stayput.members mem on mem.company_id = p_company and mem.id = t.member_id), '[]'))
  end
$$;

revoke all on function stayput.platform_activity(text, timestamptz) from public;
grant execute on function stayput.platform_activity(text, timestamptz) to stayput_user;
