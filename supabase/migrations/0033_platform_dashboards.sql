-- Fix prompt v4.1, block 7 (brief v4 §9.6): Integrations › Discord and Integrations › Telegram,
-- each a dashboard of its own. What a creator sees there, read from what StayPut already keeps
-- (who wrote, where and when; never what): the members active and gone silent, the messages per
-- day (everyone, and the members at risk today), when the community writes (day × hour), each
-- channel, group and topic, the most active and the silent members. And the signals: what a
-- platform says of a member (gone quiet, writes less, left the server or group), each adding the
-- points the creator gives it to the risk score, off until they turn it on.

-- 1. Where messages were written, by name: a Discord server's channels as Discord last gave them
--    (the dashboard never asks Discord on the way), and the topics of a Telegram forum group.
alter table stayput.discord_guilds
  add column channel_names jsonb not null default '{}'
    check (jsonb_typeof(channel_names) = 'object'),
  add column channel_names_at timestamptz;

create table stayput.telegram_topics (
  company_id text not null references stayput.companies (id) on delete cascade,
  chat_id text not null,
  topic_id text not null check (topic_id ~ '^[0-9]{1,20}$'),
  -- The topic's name, from the message that created it or an edit; null until StayPut sees one.
  name text check (char_length(name) <= 200),
  seen_at timestamptz not null,
  primary key (company_id, chat_id, topic_id)
);
alter table stayput.telegram_topics enable row level security;
create policy creator_read on stayput.telegram_topics for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.telegram_topics to stayput_user;

-- The dashboards read a company's messages of one kind over 91 days.
create index activity_events_company_type_time
  on stayput.activity_events (company_id, type, occurred_at);

-- The text channels of a server, as Discord just listed them ([{id, name, category}]): their
-- names replace the ones kept. Returns how many are named, 0 for a server not the company's.
create function stayput.note_discord_channels(p_company text, p_guild text, p_channels jsonb,
                                              p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_names jsonb;
begin
  select coalesce(jsonb_object_agg(c ->> 'id', jsonb_strip_nulls(jsonb_build_object(
           'name', left(c ->> 'name', 100), 'category', left(c ->> 'category', 100)))), '{}')
    into v_names
    from jsonb_array_elements(case jsonb_typeof(p_channels)
                                when 'array' then p_channels else '[]' end) c
   where c ->> 'id' ~ '^[0-9]{5,25}$' and coalesce(c ->> 'name', '') <> '';
  update stayput.discord_guilds set channel_names = v_names, channel_names_at = p_now
   where guild_id = p_guild and company_id = p_company;
  if not found then
    return 0;
  end if;
  return (select count(*) from jsonb_object_keys(v_names));
end
$$;

-- A topic of a connected Telegram group: created or renamed (a service message), or named by
-- the creation message a topic's messages answer. False for a group not connected.
create function stayput.note_telegram_topic(p_chat text, p_topic text, p_name text,
                                            p_at timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_company text;
begin
  if coalesce(p_topic, '') !~ '^[0-9]{1,20}$' then
    return false;
  end if;
  select company_id into v_company from stayput.telegram_chats
   where chat_id = p_chat and left_at is null;
  if v_company is null then
    return false;
  end if;
  insert into stayput.telegram_topics as t (company_id, chat_id, topic_id, name, seen_at)
  values (v_company, p_chat, p_topic, nullif(left(btrim(coalesce(p_name, '')), 200), ''),
          coalesce(p_at, now()))
  on conflict (company_id, chat_id, topic_id) do update set
    name = coalesce(excluded.name, t.name),
    seen_at = greatest(t.seen_at, excluded.seen_at);
  return true;
end
$$;

-- As in 0017, and the topic a message was written in (a forum group's), when it has one.
create function stayput.record_telegram_message(p_chat text, p_from text, p_message_id text,
                                                p_at timestamptz, p_name text, p_username text,
                                                p_topic text) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_company text;
  v_topic text := case when coalesce(p_topic, '') ~ '^[0-9]{1,20}$' then p_topic end;
begin
  update stayput.telegram_chats
     set last_message_at = greatest(last_message_at, p_at)
   where chat_id = p_chat and left_at is null
  returning company_id into v_company;
  if v_company is null then
    return false;
  end if;
  perform stayput.note_account(v_company, 'telegram', p_from, p_name, p_username, p_at);
  perform stayput.note_presence(v_company, 'telegram', p_chat, p_from, null, null, null, p_at);
  if v_topic is not null then
    insert into stayput.telegram_topics as t (company_id, chat_id, topic_id, seen_at)
    values (v_company, p_chat, v_topic, p_at)
    on conflict (company_id, chat_id, topic_id) do update set
      seen_at = greatest(t.seen_at, excluded.seen_at);
  end if;
  return stayput.record_platform_activity(v_company, 'telegram', p_from, 'telegram_message',
                                          p_chat || ':' || p_message_id, p_at,
                                          jsonb_build_object('chat_id', p_chat,
                                                             'topic_id', v_topic));
end
$$;

-- 2. The signals, per platform: {discord: {silent: {on, points}, drop: {…}, left: {…}},
--    telegram: {…}}; a platform not saved yet has StayPut's defaults (packages/core, risk.ts).
alter table stayput.company_settings
  add column platform_signals jsonb not null default '{}'
    check (jsonb_typeof(platform_signals) = 'object');

-- What a member's score was made of beyond its five factors: {base: the score before the
-- signals' points, discord: the signals that hold for them there (1 gone quiet, 2 writes less,
-- 4 left), telegram: the same, rule: 1 a departure scheduled, 2 a payment failed, 0 neither}. The
-- dashboards preview the scores other settings would give from it, without computing anything.
alter table stayput.member_risk
  add column signals jsonb not null default '{}' check (jsonb_typeof(signals) = 'object');

-- A platform's signals as the creator set them; every score is due again. Returns all of them.
create function stayput.set_platform_signals(p_company text, p_platform text, p_signals jsonb,
                                             p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_clean jsonb := '{}';
  v_signal text;
  v_value jsonb;
  v_points numeric;
  v_all jsonb;
begin
  if coalesce(p_platform, '') not in ('discord', 'telegram') then
    raise exception 'unknown platform %', p_platform;
  end if;
  foreach v_signal in array array['silent', 'drop', 'left'] loop
    v_value := p_signals -> v_signal;
    if coalesce(jsonb_typeof(v_value -> 'on'), '') <> 'boolean'
       or coalesce(jsonb_typeof(v_value -> 'points'), '') <> 'number' then
      raise exception 'invalid signal %', v_signal;
    end if;
    v_points := (v_value ->> 'points')::numeric;
    if v_points < 0 or v_points > 30 or v_points <> trunc(v_points) then
      raise exception 'invalid points for signal %', v_signal;
    end if;
    v_clean := v_clean || jsonb_build_object(v_signal, jsonb_build_object(
      'on', (v_value ->> 'on')::boolean, 'points', v_points::integer));
  end loop;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set platform_signals = platform_signals || jsonb_build_object(p_platform, v_clean)
   where company_id = p_company
  returning platform_signals into v_all;
  update stayput.member_risk set computed_at = least(computed_at, p_now - interval '1 hour')
   where company_id = p_company;
  return v_all;
end
$$;

-- 3. As in 0018, with the signals' settings, and each member's messages on Discord and Telegram:
--    [… as in 0008, discord7d, discordPrev28d, discordLastAt, discordLeftAt, telegram7d,
--    telegramPrev28d, telegramLastAt, telegramLeftAt]. A member left a platform when every
--    connected server or group StayPut saw their account in says they left.
create or replace function stayput.risk_features(p_company text, p_now timestamptz, p_limit integer)
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
                           and e.external_id is not null),
           'platformSignals', s.platform_signals)
    into v_settings
    from stayput.company_settings s where s.company_id = p_company;
  v_settings := coalesce(v_settings, jsonb_build_object(
    'weights', jsonb_build_object('recency', 0.3, 'frequency', 0.25, 'progress', 0.2,
                                  'payment', 0.15, 'friction', 0.1),
    'recencyThresholdDays', 14, 'mediumFrom', 40, 'highFrom', 70, 'tracksProgress', false,
    'platformSignals', '{}'::jsonb));

  with due as (
    select m.id, m.joined_at, m.last_action_at, m.discord_user_id, m.telegram_user_id
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
       and not exists (select 1 from stayput.alumni_members a
                        where a.company_id = m.company_id and a.member_id = m.id
                          and a.status = 'entered')
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
           coalesce(joined.active, false),
           coalesce(discord.week, 0),
           coalesce(discord.before, 0),
           stayput.epoch_ms(discord.last_at),
           stayput.epoch_ms(discord_left.at),
           coalesce(telegram.week, 0),
           coalesce(telegram.before, 0),
           stayput.epoch_ms(telegram.last_at),
           stayput.epoch_ms(telegram_left.at)
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
           and e.occurred_at >= d.joined_at) as active) joined on true
    -- Their messages on each platform: this week's (the last 7 days of the company's calendar),
    -- the 4 weeks' before, and the last one of those 5 weeks.
    left join lateral (
      select count(*) filter (where (e.occurred_at at time zone v_tz)::date > v_today - 7)
               ::integer as week,
             count(*) filter (where (e.occurred_at at time zone v_tz)::date <= v_today - 7)
               ::integer as before,
             max(e.occurred_at) as last_at
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id and e.type = 'discord_message'
         and e.occurred_at > p_now - interval '36 days'
         and (e.occurred_at at time zone v_tz)::date > v_today - 35) discord on true
    left join lateral (
      select count(*) filter (where (e.occurred_at at time zone v_tz)::date > v_today - 7)
               ::integer as week,
             count(*) filter (where (e.occurred_at at time zone v_tz)::date <= v_today - 7)
               ::integer as before,
             max(e.occurred_at) as last_at
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id and e.type = 'telegram_message'
         and e.occurred_at > p_now - interval '36 days'
         and (e.occurred_at at time zone v_tz)::date > v_today - 35) telegram on true
    left join lateral (
      select max(pp.left_at) as at
        from stayput.platform_presence pp
       where pp.company_id = p_company and pp.platform = 'discord'
         and pp.account_id = d.discord_user_id
         and pp.place_id in (select g.guild_id from stayput.discord_guilds g
                              where g.company_id = p_company)
      having bool_and(pp.left_at is not null)) discord_left on true
    left join lateral (
      select max(pp.left_at) as at
        from stayput.platform_presence pp
       where pp.company_id = p_company and pp.platform = 'telegram'
         and pp.account_id = d.telegram_user_id
         and pp.place_id in (select t.chat_id from stayput.telegram_chats t
                              where t.company_id = p_company and t.left_at is null)
      having bool_and(pp.left_at is not null)) telegram_left on true;

  return jsonb_build_object('settings', v_settings, 'members', v_members);
end
$$;

-- 4. As in 0008, and what each score was made of beyond its five factors (the 7th element:
--    {base, discord, telegram, rule}, see member_risk.signals).
create or replace function stayput.save_risk_scores(p_company text, p_scores jsonb,
                                                    p_now timestamptz)
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
           coalesce((s ->> 5)::boolean, false) as newcomer,
           case jsonb_typeof(s -> 6) when 'object' then s -> 6 else '{}'::jsonb end as signals
      from jsonb_array_elements(p_scores) s
  ), kept as (
    select i.* from input i
      join stayput.members m on m.company_id = p_company and m.id = i.member_id
     where m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
  ), current as (
    insert into stayput.member_risk as r (company_id, member_id, score, level, sub_scores,
                                          reasons, inactive_newcomer, level_since,
                                          previous_level, computed_at, signals)
    select p_company, member_id, score, level, sub_scores, reasons, newcomer, p_now, null, p_now,
           signals
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
      computed_at = excluded.computed_at,
      signals = excluded.signals
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

-- 5. The dashboards. A platform's messages since a moment: who wrote them (a member, the team, a
--    guest, an account not tied yet) and where (a Discord channel; a Telegram group, then its
--    topic after a colon, empty outside topics). Read by the functions below only.
create function stayput.platform_messages(p_company text, p_platform text, p_since timestamptz)
returns table (member_id text, account_id text, occurred_at timestamptz, place text, kind text)
language sql stable set search_path = ''
as $$
  select m.member_id, m.account_id, m.occurred_at,
         case p_platform
           when 'discord' then coalesce(m.metadata ->> 'channel_id', '')
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
       where e.company_id = p_company and e.type = p_platform || '_message'
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

-- The places StayPut knows on a platform, by name: Discord's channels (`followed` when StayPut
-- reads them), Telegram's groups (`followed` while connected) and their topics. A group with
-- topics is a forum: its own place holds the messages written outside them (`general`).
create function stayput.platform_places(p_company text, p_platform text)
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
$$;

-- Integrations › Discord or › Telegram (brief v4 §9.6), in the company's calendar, for its team
-- only: the three figures of the top (members active these 7 days, members gone silent, messages
-- over 30 days), the messages of each of the 30 days (everyone's, the members', the members' at
-- risk today), when they were written (day of the week × hour), each channel, group and topic
-- with its 3 most active members, the members most active and gone silent over 7, 14 and 30
-- days, and the signals: their settings, and the members' scores as made (member_risk.signals),
-- grouped, for the preview.
create function stayput.platform_dashboard(p_company text, p_platform text, p_now timestamptz)
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
           coalesce(n.kind, case p_platform when 'discord' then 'channel' else 'group' end)
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
                   and p_platform in ('discord', 'telegram') then jsonb_build_object(
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

-- A day of the chart, picked: its messages, each place with its 3 most active members, and the
-- members who wrote that day, the most first.
create function stayput.platform_day(p_company text, p_platform text, p_now timestamptz,
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
                   and p_platform in ('discord', 'telegram') then jsonb_build_object(
    'day', p_day,
    'messages', (select count(*) from picked),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.place,
               'kind', coalesce(n.kind, case p_platform when 'discord' then 'channel'
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

-- A cell of the heatmap, picked (a day of the week, 1 Monday to 7 Sunday, and an hour of the
-- company's calendar): over the 30 days, the members who wrote then, the most first, and how
-- many messages others wrote (the team, guests, accounts not tied yet).
create function stayput.platform_slot(p_company text, p_platform text, p_now timestamptz,
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
                   and p_platform in ('discord', 'telegram') then jsonb_build_object(
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

-- Everyone on Discord and in Telegram, each platform in its own tab now: 500 people at most per
-- platform (a big server no longer hides the group's people), and each platform's total.
create or replace function stayput.platform_people(p_company text, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with linked as (
    select 'discord' as platform, m.discord_user_id as account_id, m.id as member_id,
           m.display_name as member_name, m.access_level
      from stayput.members m
     where m.company_id = p_company and m.discord_user_id is not null
    union all
    select 'telegram', m.telegram_user_id, m.id, m.display_name, m.access_level
      from stayput.members m
     where m.company_id = p_company and m.telegram_user_id is not null
  ), presence as (
    select pp.platform, pp.account_id, min(pp.joined_at) as joined_at,
           bool_or(pp.left_at is null) as here, max(pp.left_at) as left_at
      from stayput.platform_presence pp
     where pp.company_id = p_company
     group by 1, 2
  ), member_messages as (
    select case e.type when 'discord_message' then 'discord' else 'telegram' end as platform,
           e.member_id,
           count(*) filter (where e.occurred_at > p_now - interval '30 days') as messages,
           max(e.occurred_at) as last_at
      from stayput.activity_events e
     where e.company_id = p_company and e.type in ('discord_message', 'telegram_message')
       and e.occurred_at > p_now - interval '90 days'
     group by 1, 2
  ), waiting_messages as (
    select split_part(p.user_id, ':', 1) as platform, split_part(p.user_id, ':', 2) as account_id,
           count(*) filter (where p.occurred_at > p_now - interval '30 days') as messages,
           max(p.occurred_at) as last_at
      from stayput.pending_activity p
     where p.company_id = p_company and p.user_id ~ '^(discord|telegram):'
     group by 1, 2
  ), people as (
    select pa.platform, pa.account_id, pa.display_name, pa.username,
           l.member_id, l.member_name,
           case when l.access_level = 'admin' then 'team'
                when l.member_id is not null then 'member'
                when pa.dismissed_as = 'team' then 'team'
                when pa.dismissed_as = 'guest' then 'guest'
                else 'unlinked' end as status,
           pr.here, pr.joined_at,
           case when not coalesce(pr.here, true) then pr.left_at end as left_at,
           coalesce(mm.messages, wm.messages, 0) as messages,
           coalesce(mm.last_at, wm.last_at) as last_at
      from stayput.platform_accounts pa
      left join linked l on l.platform = pa.platform and l.account_id = pa.account_id
      left join presence pr on pr.platform = pa.platform and pr.account_id = pa.account_id
      left join member_messages mm on mm.platform = pa.platform and mm.member_id = l.member_id
      left join waiting_messages wm
        on wm.platform = pa.platform and wm.account_id = pa.account_id and l.member_id is null
     where pa.company_id = p_company
  ), places as (
    select 'discord' as platform, g.guild_id as place_id, g.name, g.member_count,
           case when s.last_error like '403%' then 'blocked'
                when s.last_complete_pass_at is not null then 'listed'
                else 'pending' end as list
      from stayput.discord_guilds g
      left join stayput.sync_state s
        on s.company_id = p_company and s.stream = 'discord_members:' || g.guild_id
     where g.company_id = p_company
    union all
    select 'telegram', t.chat_id, t.title, t.member_count, 'joins'
      from stayput.telegram_chats t
     where t.company_id = p_company and t.left_at is null
  )
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', pl.platform, 'id', pl.place_id, 'name', pl.name,
               'total', pl.member_count,
               'known', (select count(*) from stayput.platform_presence pp
                          where pp.company_id = p_company and pp.platform = pl.platform
                            and pp.place_id = pl.place_id and pp.left_at is null),
               'list', pl.list)
             order by pl.platform, pl.name)
        from places pl), '[]'),
    'total', (select count(*) from people),
    'totals', jsonb_build_object(
      'discord', (select count(*) from people where platform = 'discord'),
      'telegram', (select count(*) from people where platform = 'telegram')),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', x.platform, 'accountId', x.account_id, 'name', x.display_name,
               'username', x.username, 'status', x.status,
               'member', case when x.member_id is not null then jsonb_build_object(
                                'id', x.member_id, 'name', x.member_name) end,
               'here', x.here, 'joinedAt', x.joined_at, 'leftAt', x.left_at,
               'messages', x.messages, 'lastMessageAt', x.last_at)
             order by x.last_at desc nulls last, x.here desc nulls last,
                      x.joined_at desc nulls last, x.display_name, x.account_id)
        from (select * from (
                select people.*, row_number() over (
                         partition by platform
                         order by last_at desc nulls last, here desc nulls last,
                                  joined_at desc nulls last, display_name, account_id) as rank
                  from people) ranked
               where rank <= 500) x), '[]'))
  end
$$;

revoke all on function stayput.note_discord_channels(text, text, jsonb, timestamptz) from public;
revoke all on function stayput.note_telegram_topic(text, text, text, timestamptz) from public;
revoke all on function stayput.record_telegram_message(text, text, text, timestamptz, text, text,
                                                       text) from public;
revoke all on function stayput.set_platform_signals(text, text, jsonb, timestamptz) from public;
revoke all on function stayput.platform_messages(text, text, timestamptz) from public;
revoke all on function stayput.platform_places(text, text) from public;
revoke all on function stayput.platform_dashboard(text, text, timestamptz) from public;
revoke all on function stayput.platform_day(text, text, timestamptz, date) from public;
revoke all on function stayput.platform_slot(text, text, timestamptz, integer, integer)
  from public;
-- Read as the creator: each checks they administer the company.
grant execute on function stayput.platform_dashboard(text, text, timestamptz) to stayput_user;
grant execute on function stayput.platform_day(text, text, timestamptz, date) to stayput_user;
grant execute on function stayput.platform_slot(text, text, timestamptz, integer, integer)
  to stayput_user;
