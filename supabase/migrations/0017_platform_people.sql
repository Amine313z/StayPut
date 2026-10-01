-- Everyone on the connected Discord servers and Telegram groups, not only who writes there (the
-- founder, 2026-10-01: « je veux qu'on puisse voir les membres »). Discord gives a server's member
-- list to a bot whose application turned the Server Members Intent on; Telegram gives a bot no
-- list at all, only who joins and leaves once it is there, the administrators, and how many people
-- a group has. Names and dates only, never what anyone wrote.

-- 1. Who is where: one row per account and server or group.
create table stayput.platform_presence (
  company_id text not null references stayput.companies (id) on delete cascade,
  platform text not null check (platform in ('discord', 'telegram')),
  -- The Discord server, the Telegram group.
  place_id text not null,
  account_id text not null,
  -- When they joined: as Discord says, or as StayPut saw it on Telegram.
  joined_at timestamptz,
  -- The last time StayPut saw them there: the server's list, a message, a join.
  seen_at timestamptz not null,
  -- They left, or the server's list no longer has them; null while they are there.
  left_at timestamptz,
  -- Met by the reading of the server's list under way: what its end did not meet has left.
  listed boolean not null default true,
  primary key (company_id, platform, place_id, account_id),
  foreign key (company_id, platform, account_id)
    references stayput.platform_accounts (company_id, platform, account_id) on delete cascade
);
alter table stayput.platform_presence enable row level security;
create policy creator_read on stayput.platform_presence for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.platform_presence to stayput_user;

-- 2. How many people each server and group has, as Discord and Telegram count them.
alter table stayput.discord_guilds
  add column member_count integer check (member_count >= 0),
  add column member_count_at timestamptz;
alter table stayput.telegram_chats
  add column member_count integer check (member_count >= 0),
  add column member_count_at timestamptz;

-- 3. A server's member list is a sync stream of its own, `discord_members:<server>`.
insert into stayput.sync_state (company_id, stream)
select company_id, 'discord_members:' || guild_id from stayput.discord_guilds
on conflict do nothing;

-- Someone is on a server or in a group: their names noted (note_account, which ties them to the
-- member they surely are), and that they are there. False for an id that is not an account's.
create function stayput.note_presence(p_company text, p_platform text, p_place text,
                                      p_account text, p_name text, p_username text,
                                      p_joined timestamptz, p_at timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
begin
  if not ((p_platform = 'discord' and coalesce(p_account, '') ~ '^[0-9]{5,25}$')
          or (p_platform = 'telegram' and coalesce(p_account, '') ~ '^[0-9]{1,20}$')) then
    return false;
  end if;
  perform stayput.note_account(p_company, p_platform, p_account, p_name, p_username, null);
  insert into stayput.platform_presence as p (company_id, platform, place_id, account_id,
                                              joined_at, seen_at)
  values (p_company, p_platform, p_place, p_account, p_joined, coalesce(p_at, now()))
  on conflict (company_id, platform, place_id, account_id) do update set
    joined_at = coalesce(excluded.joined_at, p.joined_at),
    seen_at = greatest(p.seen_at, excluded.seen_at),
    left_at = null,
    listed = true;
  return true;
end
$$;

-- A reading of a server's member list begins: each person is marked as it meets them.
create function stayput.discord_roster_start(p_company text, p_guild text) returns void
language sql set search_path = ''
as $$
  update stayput.platform_presence set listed = false
   where company_id = p_company and platform = 'discord' and place_id = p_guild
     and left_at is null;
$$;

-- The reading reached the end of the list: who it did not meet has left the server. Returns how
-- many.
create function stayput.discord_roster_end(p_company text, p_guild text, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  update stayput.platform_presence set left_at = p_now
   where company_id = p_company and platform = 'discord' and place_id = p_guild
     and left_at is null and not listed;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- People joined or left a connected Telegram group (its service messages, or the updates Telegram
-- sends a bot that administers it): `p_joined` [{id, name, username}], `p_left` [ids]. Returns how
-- many joined.
create function stayput.telegram_people(p_chat text, p_joined jsonb, p_left jsonb,
                                        p_at timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_company text;
  v_person jsonb;
  v_count integer := 0;
begin
  select company_id into v_company from stayput.telegram_chats
   where chat_id = p_chat and left_at is null;
  if v_company is null then
    return 0;
  end if;
  for v_person in select value from jsonb_array_elements(coalesce(p_joined, '[]')) loop
    if stayput.note_presence(v_company, 'telegram', p_chat, v_person ->> 'id',
                             v_person ->> 'name', v_person ->> 'username', p_at, p_at) then
      v_count := v_count + 1;
    end if;
  end loop;
  update stayput.platform_presence set left_at = p_at, listed = false
   where company_id = v_company and platform = 'telegram' and place_id = p_chat
     and left_at is null
     and account_id in (select jsonb_array_elements_text(coalesce(p_left, '[]')));
  return v_count;
end
$$;

-- How many people a Telegram group has, and its administrators: Telegram lists no one else. A
-- count Telegram did not give (null) keeps the last one, read again later.
create function stayput.telegram_chat_people(p_chat text, p_count integer, p_admins jsonb,
                                             p_now timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_company text;
  v_person jsonb;
begin
  update stayput.telegram_chats
     set member_count = coalesce(p_count, member_count), member_count_at = p_now
   where chat_id = p_chat and left_at is null
  returning company_id into v_company;
  if v_company is null then
    return false;
  end if;
  for v_person in select value from jsonb_array_elements(coalesce(p_admins, '[]')) loop
    perform stayput.note_presence(v_company, 'telegram', p_chat, v_person ->> 'id',
                                  v_person ->> 'name', v_person ->> 'username', null, p_now);
  end loop;
  return true;
end
$$;

-- How many people a Discord server has, as Discord counts them (no intent needed for that); null
-- keeps the last count.
create function stayput.discord_guild_count(p_guild text, p_count integer, p_now timestamptz)
returns void
language sql set search_path = ''
as $$
  update stayput.discord_guilds
     set member_count = coalesce(p_count, member_count), member_count_at = p_now
   where guild_id = p_guild;
$$;

-- As in 0012; who writes in a group is in it.
create or replace function stayput.record_telegram_message(p_chat text, p_from text,
                                                           p_message_id text, p_at timestamptz,
                                                           p_name text, p_username text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_company text;
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
  return stayput.record_platform_activity(v_company, 'telegram', p_from, 'telegram_message',
                                          p_chat || ':' || p_message_id, p_at,
                                          jsonb_build_object('chat_id', p_chat));
end
$$;

-- As in 0012, plus a server's member list (kind `discord_members`, scope: the server).
create or replace function stayput.ingest_item(p_company text, p_kind text, p_scope text,
                                               d jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_user text := coalesce(d -> 'user' ->> 'id', d ->> 'user_id');
  v_at timestamptz := stayput.whop_time(d ->> 'created_at');
begin
  case p_kind
    when 'members' then return stayput.upsert_member(p_company, d);
    when 'memberships' then return stayput.upsert_membership(p_company, d);
    when 'plans' then return stayput.upsert_plan(p_company, d);
    when 'payments' then return stayput.upsert_payment(p_company, d);
    when 'messages' then
      if coalesce(d ->> 'message_type', 'regular') <> 'regular' then
        return false;
      end if;
      return stayput.record_activity(p_company, 'message', v_user, d ->> 'id', v_at,
                                     jsonb_build_object('channel_id', p_scope));
    when 'reactions' then
      return stayput.record_activity(p_company, 'reaction', v_user, d ->> 'id',
                                     coalesce(v_at, now()),
                                     jsonb_build_object('on', d ->> 'resource_id'));
    when 'forum_posts' then
      return stayput.record_activity(p_company, 'forum_post', v_user, d ->> 'id', v_at,
                                     jsonb_build_object('experience_id', p_scope,
                                                        'comment', d ->> 'parent_id' is not null));
    when 'support_channels' then
      return stayput.record_support_channel(p_company, d);
    when 'lesson_interactions' then
      if not coalesce((d ->> 'completed')::boolean, false) then
        return false;
      end if;
      return stayput.record_activity(
        p_company, 'lesson_completed', v_user, d ->> 'id',
        coalesce(stayput.whop_time(d ->> 'completed_at'), stayput.whop_time(d ->> 'updated_at'),
                 v_at),
        jsonb_build_object('lesson_id', coalesce(d -> 'lesson' ->> 'id', d ->> 'lesson_id'),
                           'lesson_title', d -> 'lesson' ->> 'title',
                           'chapter_id', d -> 'lesson' -> 'chapter' ->> 'id',
                           'course_id', coalesce(p_scope, d ->> 'course_id')));
    when 'discord_messages' then
      -- People's messages only (default ones and replies), never a bot's or a webhook's.
      if coalesce((d -> 'author' ->> 'bot')::boolean, false) or d ->> 'webhook_id' is not null
         or coalesce(d ->> 'type', '0') not in ('0', '19') then
        return false;
      end if;
      perform stayput.note_account(p_company, 'discord', d -> 'author' ->> 'id',
                                   d -> 'author' ->> 'global_name', d -> 'author' ->> 'username',
                                   stayput.whop_time(d ->> 'timestamp'));
      return stayput.record_platform_activity(
        p_company, 'discord', d -> 'author' ->> 'id', 'discord_message', d ->> 'id',
        stayput.whop_time(d ->> 'timestamp'), jsonb_build_object('channel_id', p_scope));
    when 'discord_members' then
      -- Everyone on the server, by their name there (nickname, else display name); never a bot.
      if coalesce((d -> 'user' ->> 'bot')::boolean, false) then
        return false;
      end if;
      return stayput.note_presence(p_company, 'discord', p_scope, v_user,
                                   coalesce(d ->> 'nick', d -> 'user' ->> 'global_name'),
                                   d -> 'user' ->> 'username',
                                   stayput.whop_time(d ->> 'joined_at'), null);
    else
      raise exception 'unknown kind %', p_kind;
  end case;
end
$$;

-- As in 0007, plus a server's member list: an array sorted by account, whose next page is after
-- its last account, 1000 at most.
create or replace function stayput.ingest_page(p_company text, p_kind text, p_scope text,
                                               p_page jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  item jsonb;
  v_stored integer := 0;
  v_count integer := 0;
  v_oldest timestamptz;
  v_newest timestamptz;
  v_first timestamptz;
  v_last timestamptz;
  v_at timestamptz;
  v_scope text;
begin
  if jsonb_typeof(p_page) = 'array' and p_kind = 'discord_members' then
    p_page := jsonb_build_object(
      'data', p_page,
      'page_info', jsonb_build_object('end_cursor', p_page -> -1 -> 'user' ->> 'id',
                                      'has_next_page', jsonb_array_length(p_page) >= 1000));
  elsif jsonb_typeof(p_page) = 'array' then
    -- A page shorter than 100 messages, the most Discord gives at once, is the last one.
    p_page := jsonb_build_object(
      'data', p_page,
      'page_info', jsonb_build_object('end_cursor', p_page -> -1 ->> 'id',
                                      'has_next_page', jsonb_array_length(p_page) >= 100));
  end if;
  if jsonb_typeof(p_page -> 'data') is distinct from 'array' then
    raise exception 'not a page of a Whop list';
  end if;
  for item in select value from jsonb_array_elements(p_page -> 'data') loop
    v_count := v_count + 1;
    v_at := stayput.whop_time(coalesce(item ->> 'created_at', item ->> 'last_message_at',
                                       item ->> 'timestamp'));
    -- Pinned items come first whatever their age: they say nothing of where the page stands.
    if v_at is not null and not coalesce((item ->> 'is_pinned')::boolean, false) then
      v_oldest := least(v_oldest, v_at);
      v_newest := greatest(v_newest, v_at);
      v_first := coalesce(v_first, v_at);
      v_last := v_at;
    end if;
    if p_kind in ('chat_channels', 'forums', 'courses') then
      v_scope := case when p_kind = 'forums'
                      then coalesce(item -> 'experience' ->> 'id', item ->> 'id')
                      else item ->> 'id' end;
      if v_scope ~ '^[a-z]+_[A-Za-z0-9]+$' then
        insert into stayput.sync_state (company_id, stream)
        values (p_company,
                case p_kind when 'chat_channels' then 'messages:'
                            when 'forums' then 'forum_posts:'
                            else 'lesson_interactions:' end || v_scope)
        on conflict do nothing;
        v_stored := v_stored + 1;
      end if;
    elsif stayput.ingest_item(p_company, p_kind, p_scope, item) then
      v_stored := v_stored + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'count', v_count,
    'stored', v_stored,
    'oldest_at', v_oldest,
    'newest_at', v_newest,
    -- Oldest item first: the list is not sorted newest first, whatever was asked.
    'ascending', coalesce(v_first < v_last, false),
    'end_cursor', p_page -> 'page_info' ->> 'end_cursor',
    'has_next_page', coalesce((p_page -> 'page_info' ->> 'has_next_page')::boolean, false));
end
$$;

-- As in 0007, with the server's member list: its stream is the company's, and who StayPut saw on
-- the server under another company is forgotten there.
create or replace function stayput.connect_discord_guild(p_company text, p_guild text,
                                                         p_name text, p_user text,
                                                         p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_previous text;
  v_channels text[];
  v_followed integer;
begin
  select company_id, channel_ids into v_previous, v_channels
    from stayput.discord_guilds where guild_id = p_guild for update;
  if v_previous is not null and v_previous <> p_company then
    delete from stayput.sync_state
     where company_id = v_previous
       and (stream in (select 'discord_messages:' || c from unnest(v_channels) c)
            or stream = 'discord_members:' || p_guild);
    delete from stayput.platform_presence
     where company_id = v_previous and platform = 'discord' and place_id = p_guild;
  end if;
  insert into stayput.discord_guilds as g (guild_id, company_id, name, channel_ids,
                                           connected_by, connected_at)
  values (p_guild, p_company, p_name, '{}', p_user, p_now)
  on conflict (guild_id) do update set
    company_id = excluded.company_id,
    name = coalesce(excluded.name, g.name),
    channel_ids = case when g.company_id = excluded.company_id then g.channel_ids
                       else '{}' end,
    connected_by = excluded.connected_by,
    connected_at = excluded.connected_at
  returning cardinality(g.channel_ids) into v_followed;
  insert into stayput.sync_state (company_id, stream)
  values (p_company, 'discord_members:' || p_guild)
  on conflict do nothing;
  return v_followed;
end
$$;

-- As in 0007; the server's member list goes with it.
create or replace function stayput.disconnect_discord_guild(p_company text, p_guild text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_channels text[];
begin
  delete from stayput.discord_guilds where guild_id = p_guild and company_id = p_company
  returning channel_ids into v_channels;
  if not found then
    return false;
  end if;
  delete from stayput.sync_state
   where company_id = p_company
     and (stream in (select 'discord_messages:' || c from unnest(v_channels) c)
          or stream = 'discord_members:' || p_guild);
  delete from stayput.platform_presence
   where company_id = p_company and platform = 'discord' and place_id = p_guild;
  return true;
end
$$;

-- As in 0007; who StayPut saw in the group under another company is forgotten there.
create or replace function stayput.connect_telegram_chat(p_company text, p_chat text,
                                                         p_title text, p_now timestamptz)
returns void
language sql set search_path = ''
as $$
  delete from stayput.platform_presence
   where platform = 'telegram' and place_id = p_chat and company_id <> p_company;
  insert into stayput.telegram_chats as t (chat_id, company_id, title, connected_at)
  values (p_chat, p_company, p_title, p_now)
  on conflict (chat_id) do update set
    company_id = excluded.company_id,
    title = coalesce(excluded.title, t.title),
    connected_at = excluded.connected_at,
    left_at = null;
$$;

-- As in 0007; who was in the group goes with it.
create or replace function stayput.disconnect_telegram_chat(p_company text, p_chat text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  delete from stayput.telegram_chats where chat_id = p_chat and company_id = p_company;
  if not found then
    return false;
  end if;
  delete from stayput.platform_presence
   where company_id = p_company and platform = 'telegram' and place_id = p_chat;
  return true;
end
$$;

-- As in 0007; who is in the group follows it to its new id.
create or replace function stayput.migrate_telegram_chat(p_from text, p_to text) returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.telegram_chats set chat_id = p_to
   where chat_id = p_from
     and not exists (select 1 from stayput.telegram_chats where chat_id = p_to);
  if found then
    update stayput.platform_presence set place_id = p_to
     where platform = 'telegram' and place_id = p_from;
  end if;
end
$$;

-- As in 0012; the names of an account still on a server or in a group stay, however quiet.
create or replace function stayput.purge_pending_activity(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from stayput.pending_activity
   where received_at < p_now - case when user_id ~ '^(discord|telegram):' then interval '30 days'
                                    else interval '7 days' end;
  get diagnostics v_count = row_count;
  delete from stayput.platform_accounts pa
   where pa.last_seen_at < p_now - interval '30 days'
     and not exists (
       select 1 from stayput.members m
        where m.company_id = pa.company_id
          and case pa.platform when 'discord' then m.discord_user_id
                               else m.telegram_user_id end = pa.account_id)
     and not exists (
       select 1 from stayput.platform_presence pp
        where pp.company_id = pa.company_id and pp.platform = pa.platform
          and pp.account_id = pa.account_id
          and (pp.left_at is null or pp.left_at > p_now - interval '30 days'));
  return v_count;
end
$$;

-- What the Sources tab lists, for the company's team only: everyone StayPut knows on its Discord
-- servers and Telegram groups (500 at most: the latest to write first, then who is there, the
-- newest arrivals first), who each is for the
-- community (a member, the team, a guest, an account not tied yet), their messages over 30 days,
-- when they joined or left; and each server and group, with how many people it has and how
-- StayPut knows them.
create function stayput.platform_people(p_company text, p_now timestamptz) returns jsonb
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
        from (select * from people
               order by last_at desc nulls last, here desc nulls last,
                        joined_at desc nulls last, display_name, account_id
               limit 500) x), '[]'))
  end
$$;

revoke all on function stayput.note_presence(text, text, text, text, text, text, timestamptz,
                                             timestamptz) from public;
revoke all on function stayput.discord_roster_start(text, text) from public;
revoke all on function stayput.discord_roster_end(text, text, timestamptz) from public;
revoke all on function stayput.telegram_people(text, jsonb, jsonb, timestamptz) from public;
revoke all on function stayput.telegram_chat_people(text, integer, jsonb, timestamptz)
  from public;
revoke all on function stayput.discord_guild_count(text, integer, timestamptz) from public;
revoke all on function stayput.platform_people(text, timestamptz) from public;
-- Read as the creator: the view checks they administer the company.
grant execute on function stayput.platform_people(text, timestamptz) to stayput_user;
