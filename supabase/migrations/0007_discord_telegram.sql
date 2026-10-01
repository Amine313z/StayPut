-- Optional activity sources (SPEC Phase 2, 5): Discord, and Telegram (decision of 2026-10-01).
-- A creator connects a Discord server, whose chosen channels StayPut reads (the 90-day history,
-- then what is new), or a Telegram group, whose messages reach StayPut from then on (Telegram
-- lets no bot read the past). Only the author and the date of a message are kept, never its
-- content. An author counts for a member through their account: the Discord account linked on
-- their Whop profile (the primary Discord is public on Whop), the Telegram account they link
-- themselves from StayPut (Whop shows no one else's Telegram). Until StayPut knows whose it is,
-- the activity waits 7 days in pending_activity under the account.

alter table stayput.members
  add column telegram_user_id text check (telegram_user_id ~ '^[0-9]{1,20}$'),
  -- When StayPut last read the Discord account the member linked on Whop (GET /users/{id}).
  add column discord_checked_at timestamptz,
  add constraint members_discord_user_id_check check (discord_user_id ~ '^[0-9]{5,25}$');
create unique index members_discord_user on stayput.members (company_id, discord_user_id)
  where discord_user_id is not null;
create unique index members_telegram_user on stayput.members (company_id, telegram_user_id)
  where telegram_user_id is not null;

alter table stayput.activity_events drop constraint activity_events_type_check;
alter table stayput.activity_events add constraint activity_events_type_check check (type in (
  'message', 'reaction', 'lesson_completed', 'forum_post', 'support_ticket_opened',
  'support_ticket_resolved', 'stayput_open', 'goal_update', 'discord_message',
  'telegram_message'));

-- Activity waits under the identity StayPut saw: a Whop user, or a Discord or Telegram account.
alter table stayput.pending_activity drop constraint pending_activity_user_id_check;
alter table stayput.pending_activity add constraint pending_activity_user_id_check check (
  user_id ~ '^(user_[A-Za-z0-9]+|discord:[0-9]{5,25}|telegram:[0-9]{1,20})$');
alter table stayput.pending_activity drop constraint pending_activity_type_check;
alter table stayput.pending_activity add constraint pending_activity_type_check check (type in (
  'message', 'reaction', 'lesson_completed', 'forum_post', 'support_ticket_opened',
  'support_ticket_resolved', 'discord_message', 'telegram_message'));

-- A Discord server a company connected: the StayPut bot was added to it from Discord's
-- authorization page, opened by StayPut for that company (the server is the creator's: adding a
-- bot takes the right to manage it). A server belongs to the last company that connected it.
create table stayput.discord_guilds (
  guild_id text primary key check (guild_id ~ '^[0-9]{5,25}$'),
  company_id text not null references stayput.companies (id) on delete cascade,
  name text,
  -- The text channels whose messages count as activity, chosen by the creator.
  channel_ids text[] not null default '{}',
  connected_by text check (connected_by ~ '^user_[A-Za-z0-9]+$'),
  connected_at timestamptz not null
);
create index discord_guilds_company on stayput.discord_guilds (company_id);

-- A Telegram group a company connected: the StayPut bot was added to it with a link StayPut
-- made for that company.
create table stayput.telegram_chats (
  chat_id text primary key check (chat_id ~ '^-?[0-9]{1,20}$'),
  company_id text not null references stayput.companies (id) on delete cascade,
  title text,
  connected_at timestamptz not null,
  -- The bot was removed from the group: nothing arrives any more.
  left_at timestamptz,
  -- The last message the group sent StayPut: proof that the bot reads it.
  last_message_at timestamptz
);
create index telegram_chats_company on stayput.telegram_chats (company_id);

alter table stayput.discord_guilds enable row level security;
alter table stayput.telegram_chats enable row level security;
create policy creator_read on stayput.discord_guilds for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.telegram_chats for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.discord_guilds, stayput.telegram_chats to stayput_user;

-- A message on Discord or Telegram: stored for the member who linked that account on Whop, or
-- kept under the account (pending_activity) until StayPut learns whose it is.
create function stayput.record_platform_activity(p_company text, p_platform text,
                                                 p_account text, p_type text,
                                                 p_external text, p_at timestamptz,
                                                 p_metadata jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_metadata jsonb := jsonb_strip_nulls(coalesce(p_metadata, '{}'));
  v_inserted integer;
begin
  if not ((p_platform = 'discord' and coalesce(p_account, '') ~ '^[0-9]{5,25}$')
          or (p_platform = 'telegram' and coalesce(p_account, '') ~ '^[0-9]{1,20}$'))
     or p_external is null or p_at is null then
    return false;
  end if;
  select id into v_member from stayput.members
   where company_id = p_company
     and (case p_platform when 'discord' then discord_user_id else telegram_user_id end)
         = p_account;
  if v_member is null then
    insert into stayput.pending_activity (company_id, user_id, type, occurred_at, external_id,
                                          metadata)
    values (p_company, p_platform || ':' || p_account, p_type, p_at, p_external, v_metadata)
    on conflict do nothing;
    return false;
  end if;
  insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                       metadata)
  values (p_company, v_member, p_type, p_at, p_external, v_metadata)
  on conflict (company_id, type, external_id) where external_id is not null do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    perform stayput.mark_stats_dirty(p_company, p_at);
  end if;
  return true;
end
$$;

-- The Discord account a member linked on Whop: the primary Discord of `social_accounts`
-- (GET /users/{id}), which Whop shows to the apps of the member's communities. Read again every
-- 7 days, and unlinked when the member unlinked it on Whop. An account belongs to one member of
-- a company; the activity waiting under it joins the member. Returns whether one is linked.
create function stayput.link_member_discord(p_company text, u jsonb, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_discord text;
  v_moved timestamptz;
begin
  select id into v_member from stayput.members
   where company_id = p_company and user_id = u ->> 'id';
  if v_member is null then
    return false;
  end if;
  select s ->> 'external_id' into v_discord
    from jsonb_array_elements(case jsonb_typeof(u -> 'social_accounts')
                                when 'array' then u -> 'social_accounts' else '[]' end) s
   where s ->> 'platform' = 'discord' and s ->> 'external_id' ~ '^[0-9]{5,25}$'
   limit 1;
  update stayput.members set discord_user_id = null
   where company_id = p_company and discord_user_id = v_discord and id <> v_member;
  update stayput.members set discord_user_id = v_discord, discord_checked_at = p_now
   where company_id = p_company and id = v_member;
  if v_discord is null then
    return false;
  end if;
  with moved as (
    delete from stayput.pending_activity
     where company_id = p_company and user_id = 'discord:' || v_discord
    returning type, occurred_at, external_id, metadata
  ), stored as (
    insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                         metadata)
    select p_company, v_member, type, occurred_at, external_id, metadata from moved
    on conflict (company_id, type, external_id) where external_id is not null do nothing
    returning occurred_at
  )
  select min(occurred_at) into v_moved from stored;
  perform stayput.mark_stats_dirty(p_company, v_moved);
  return true;
end
$$;

-- A member Whop does not know as a user (a fake member of the sandbox): checked, nothing to link.
create function stayput.mark_discord_checked(p_company text, p_user text, p_now timestamptz)
returns void
language sql set search_path = ''
as $$
  update stayput.members set discord_checked_at = p_now
   where company_id = p_company and user_id = p_user;
$$;

-- The members whose Whop profile StayPut reads next (never read, or a week ago), for a company
-- that connected a Discord server.
create function stayput.members_to_link(p_company text, p_now timestamptz, p_limit integer)
returns setof text
language sql stable set search_path = ''
as $$
  select m.user_id from stayput.members m
   where m.company_id = p_company and m.status = 'joined'
     and (m.discord_checked_at is null or m.discord_checked_at <= p_now - interval '7 days')
     and exists (select 1 from stayput.discord_guilds g where g.company_id = p_company)
   order by m.discord_checked_at nulls first, m.joined_at desc nulls last, m.id
   limit p_limit
$$;

-- The Telegram account a member linked from StayPut: they opened the bot with a link signed for
-- them, and Telegram said which account sent it. One member per account in a company; the
-- activity waiting under the account joins the member. 'linked', or 'no_member' when StayPut
-- does not know the member yet (the next synchronization brings them).
create function stayput.link_telegram_member(p_company text, p_user text, p_telegram text,
                                             p_now timestamptz) returns text
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_moved timestamptz;
begin
  if coalesce(p_telegram, '') !~ '^[0-9]{1,20}$' then
    raise exception 'not a Telegram user id: %', p_telegram;
  end if;
  select id into v_member from stayput.members
   where company_id = p_company and user_id = p_user;
  if v_member is null then
    return 'no_member';
  end if;
  update stayput.members set telegram_user_id = null
   where company_id = p_company and telegram_user_id = p_telegram and id <> v_member;
  update stayput.members set telegram_user_id = p_telegram
   where company_id = p_company and id = v_member;
  with moved as (
    delete from stayput.pending_activity
     where company_id = p_company and user_id = 'telegram:' || p_telegram
    returning type, occurred_at, external_id, metadata
  ), stored as (
    insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                         metadata)
    select p_company, v_member, type, occurred_at, external_id, metadata from moved
    on conflict (company_id, type, external_id) where external_id is not null do nothing
    returning occurred_at
  )
  select min(occurred_at) into v_moved from stored;
  perform stayput.mark_stats_dirty(p_company, v_moved);
  return 'linked';
end
$$;

-- The member unlinks their Telegram account: what it brought stays, nothing more is counted.
create function stayput.unlink_telegram_member(p_company text, p_user text) returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.members set telegram_user_id = null
   where company_id = p_company and user_id = p_user and telegram_user_id is not null;
  return found;
end
$$;

-- A Discord server connected by a company. Moving from another company, it leaves that
-- company's streams behind, and its channels are chosen again. Returns how many channels the
-- company follows on it (0 for a server new to it: the Worker then follows the readable ones).
create function stayput.connect_discord_guild(p_company text, p_guild text, p_name text,
                                              p_user text, p_now timestamptz) returns integer
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
       and stream in (select 'discord_messages:' || c from unnest(v_channels) c);
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
  return v_followed;
end
$$;

-- The channels a company follows on its Discord server (comma-separated ids): one sync stream
-- each, the streams of the channels it stops following removed. Returns how many it follows.
create function stayput.set_discord_channels(p_company text, p_guild text, p_channels text)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_before text[];
  v_after text[] := array(
    select distinct c from unnest(string_to_array(coalesce(p_channels, ''), ',')) c
     where c ~ '^[0-9]{5,25}$' order by c);
begin
  select channel_ids into v_before from stayput.discord_guilds
   where guild_id = p_guild and company_id = p_company for update;
  if not found then
    raise exception 'Discord server % is not connected to %', p_guild, p_company;
  end if;
  update stayput.discord_guilds set channel_ids = v_after
   where guild_id = p_guild and company_id = p_company;
  delete from stayput.sync_state
   where company_id = p_company
     and stream in (select 'discord_messages:' || c from unnest(v_before) c
                     where c <> all (v_after));
  insert into stayput.sync_state (company_id, stream)
  select p_company, 'discord_messages:' || c from unnest(v_after) c
  on conflict do nothing;
  return cardinality(v_after);
end
$$;

create function stayput.disconnect_discord_guild(p_company text, p_guild text) returns boolean
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
     and stream in (select 'discord_messages:' || c from unnest(v_channels) c);
  return true;
end
$$;

-- A Telegram group connected by a company (the bot was added with the company's link).
create function stayput.connect_telegram_chat(p_company text, p_chat text, p_title text,
                                              p_now timestamptz) returns void
language sql set search_path = ''
as $$
  insert into stayput.telegram_chats as t (chat_id, company_id, title, connected_at)
  values (p_chat, p_company, p_title, p_now)
  on conflict (chat_id) do update set
    company_id = excluded.company_id,
    title = coalesce(excluded.title, t.title),
    connected_at = excluded.connected_at,
    left_at = null;
$$;

-- The bot was removed from a group, or added back to one StayPut knows.
create function stayput.telegram_chat_membership(p_chat text, p_present boolean,
                                                 p_now timestamptz) returns void
language sql set search_path = ''
as $$
  update stayput.telegram_chats
     set left_at = case when p_present then null else p_now end
   where chat_id = p_chat;
$$;

-- A group Telegram turned into a supergroup gets a new id: the connection follows it.
create function stayput.migrate_telegram_chat(p_from text, p_to text) returns void
language sql set search_path = ''
as $$
  update stayput.telegram_chats set chat_id = p_to
   where chat_id = p_from
     and not exists (select 1 from stayput.telegram_chats where chat_id = p_to);
$$;

create function stayput.disconnect_telegram_chat(p_company text, p_chat text) returns boolean
language plpgsql set search_path = ''
as $$
begin
  delete from stayput.telegram_chats where chat_id = p_chat and company_id = p_company;
  return found;
end
$$;

-- A message in a connected Telegram group, by a person (the Worker skips bots).
create function stayput.record_telegram_message(p_chat text, p_from text, p_message_id text,
                                                p_at timestamptz) returns boolean
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
  return stayput.record_platform_activity(v_company, 'telegram', p_from, 'telegram_message',
                                          p_chat || ':' || p_message_id, p_at,
                                          jsonb_build_object('chat_id', p_chat));
end
$$;

-- As in 0005; a Discord channel that no longer exists (404) also stops being followed.
create or replace function stayput.sync_error(p_company text, p_stream text, p_now timestamptz,
                                              p_status integer, p_message text) returns void
language plpgsql set search_path = ''
as $$
begin
  if p_status = 404 and p_stream like '%:%' then
    delete from stayput.sync_state where company_id = p_company and stream = p_stream;
    if p_stream like 'discord_messages:%' then
      update stayput.discord_guilds
         set channel_ids = array_remove(channel_ids, split_part(p_stream, ':', 2))
       where company_id = p_company and split_part(p_stream, ':', 2) = any (channel_ids);
    end if;
    return;
  end if;
  insert into stayput.sync_state (company_id, stream) values (p_company, p_stream)
  on conflict do nothing;
  update stayput.sync_state
     set last_error = left(p_status || ' ' || coalesce(p_message, ''), 300),
         last_error_at = p_now,
         last_run_at = p_now,
         cursor = case when p_status in (403, 404) then null else cursor end,
         pass_until = case when p_status in (403, 404) then null else pass_until end,
         pass_newest = case when p_status in (403, 404) then null else pass_newest end,
         last_pass_at = case when p_status in (403, 404) then p_now else last_pass_at end
   where company_id = p_company and stream = p_stream;
end
$$;

-- As in 0005, plus Discord's messages (kind `discord_messages`, scope: the channel).
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
      return stayput.record_platform_activity(
        p_company, 'discord', d -> 'author' ->> 'id', 'discord_message', d ->> 'id',
        stayput.whop_time(d ->> 'timestamp'), jsonb_build_object('channel_id', p_scope));
    else
      raise exception 'unknown kind %', p_kind;
  end case;
end
$$;

-- As in 0005, plus Discord's lists: an array, newest first, whose next page is before its last
-- message, and dated by `timestamp`.
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
  if jsonb_typeof(p_page) = 'array' then
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

-- As in 0005, Telegram's messages counted with the others.
create or replace function stayput.refresh_activity_stats(p_company text, p_since timestamptz,
                                                          p_now timestamptz) returns void
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_day date;
begin
  select timezone into v_tz from stayput.companies where id = p_company;
  v_tz := coalesce(v_tz, 'UTC');
  v_day := (p_since at time zone v_tz)::date;
  delete from stayput.member_stats_daily where company_id = p_company and day >= v_day;
  insert into stayput.member_stats_daily (company_id, member_id, day, messages, reactions,
                                          lessons_completed, forum_posts, stayput_actions)
  select company_id, member_id, (occurred_at at time zone v_tz)::date,
         count(*) filter (where type in ('message', 'discord_message', 'telegram_message')),
         count(*) filter (where type = 'reaction'),
         count(*) filter (where type = 'lesson_completed'),
         count(*) filter (where type = 'forum_post'),
         count(*) filter (where type in ('stayput_open', 'goal_update'))
    from stayput.activity_events
   where company_id = p_company and (occurred_at at time zone v_tz)::date >= v_day
   group by company_id, member_id, (occurred_at at time zone v_tz)::date;

  with touched as (
    select distinct member_id from stayput.activity_events
     where company_id = p_company and occurred_at >= p_since
  ), counts as (
    select e.member_id, extract(hour from e.occurred_at at time zone v_tz)::integer as h,
           count(*)::integer as n
      from stayput.activity_events e join touched using (member_id)
     where e.company_id = p_company and e.occurred_at >= p_now - interval '90 days'
     group by 1, 2
  )
  insert into stayput.activity_hours (company_id, member_id, hours, updated_at)
  select p_company, t.member_id,
         array_agg(coalesce(c.n, 0) order by g.h), p_now
    from touched t
   cross join generate_series(0, 23) as g(h)
    left join counts c on c.member_id = t.member_id and c.h = g.h
   group by t.member_id
  on conflict (company_id, member_id) do update
    set hours = excluded.hours, updated_at = excluded.updated_at;
end
$$;

-- How many Discord and Telegram accounts wrote in the last 7 days without a member who linked
-- them (pending_activity is the Worker's own): the creator view shows it to encourage linking.
-- For the company's team only.
create function stayput.unlinked_authors(p_company text)
returns table (platform text, accounts integer)
language sql stable security definer set search_path = ''
as $$
  select split_part(p.user_id, ':', 1), count(distinct p.user_id)::integer
    from stayput.pending_activity p
   where p.company_id = p_company and stayput.is_company_admin(p_company)
     and (p.user_id like 'discord:%' or p.user_id like 'telegram:%')
   group by 1
$$;

revoke execute on all functions in schema stayput from public;
grant execute on function stayput.unlinked_authors(text) to stayput_user;
