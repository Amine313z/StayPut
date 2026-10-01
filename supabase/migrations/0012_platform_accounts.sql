-- Discord and Telegram authors StayPut could not tie to a member (the founder, 2026-10-01: a
-- member whose Whop account is not connected to Discord or Telegram stays invisible there). On
-- top of the Discord account linked on the Whop profile and the Telegram account a member links
-- from StayPut, an account now joins its member:
-- 1. by name, on its own: its username is the member's Whop username, or its full name (two
--    words at least) is the member's Whop name, and exactly one member matches;
-- 2. by the creator, in one click, with suggestions (the Sources tab);
-- and the activity of an account no member has yet waits 30 days instead of 7, so that tying it
-- later still brings the month. StayPut keeps the account's names for that, never what it wrote.

-- 1. The members' Whop usernames, and who tied each account: the weekly reading of Whop profiles
--    only undoes its own links, never the creator's or a name's.
alter table stayput.members
  add column username text check (char_length(username) <= 100),
  add column discord_link text check (discord_link in ('whop', 'name', 'creator')),
  add column telegram_link text check (telegram_link in ('member', 'name', 'creator'));
update stayput.members set discord_link = 'whop' where discord_user_id is not null;
update stayput.members set telegram_link = 'member' where telegram_user_id is not null;

-- 2. The accounts seen writing, with the names the creator knows them by.
create table stayput.platform_accounts (
  company_id text not null references stayput.companies (id) on delete cascade,
  platform text not null check (platform in ('discord', 'telegram')),
  account_id text not null,
  -- Discord's display name, Telegram's first and last names.
  display_name text check (char_length(display_name) <= 200),
  username text check (char_length(username) <= 100),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  -- A person decided about this account (the creator tied or untied it, its owner untied it):
  -- StayPut no longer ties it by name.
  decided_at timestamptz,
  -- The creator set it aside: no member (a guest, a friend), it leaves the list.
  dismissed_at timestamptz,
  primary key (company_id, platform, account_id),
  check ((platform = 'discord' and account_id ~ '^[0-9]{5,25}$')
         or (platform = 'telegram' and account_id ~ '^[0-9]{1,20}$'))
);
alter table stayput.platform_accounts enable row level security;
create policy creator_read on stayput.platform_accounts for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.platform_accounts to stayput_user;

-- The accounts already known: tied to a member, or waiting with their activity.
insert into stayput.platform_accounts (company_id, platform, account_id, first_seen_at,
                                       last_seen_at)
select company_id, 'discord', discord_user_id, now(), now()
  from stayput.members where discord_user_id is not null
union all
select company_id, 'telegram', telegram_user_id, now(), now()
  from stayput.members where telegram_user_id is not null
union all
select company_id, split_part(user_id, ':', 1), split_part(user_id, ':', 2), min(occurred_at),
       max(occurred_at)
  from stayput.pending_activity
 where user_id ~ '^(discord|telegram):'
 group by company_id, user_id
on conflict do nothing;

-- A name as people mean it, to compare two: lower case, no accent, no space nor punctuation.
-- « Chloé Dubois », « chloe.dubois » and « CHLOE DUBOIS » are one.
create function stayput.name_key(p_name text) returns text
language sql immutable set search_path = ''
as $$
  select nullif(regexp_replace(lower(translate(
           replace(replace(replace(replace(replace(coalesce(p_name, ''), 'ß', 'ss'), 'œ', 'oe'),
                                   'Œ', 'oe'), 'æ', 'ae'), 'Æ', 'ae'),
           'ÀàáÁâÂÃãÄäåÅĀāăĂĄąÇçĆćĉĈċĊčČďĎđĐÈèéÉêÊËëĒēĔĕĖėęĘěĚĝĜĞğġĠĢģĥĤħĦìÌíÍÎîïÏĩĨīĪĬĭįĮıIĴĵĶķĹĺĻļĽľŀĿłŁÑñńŃŅņŇňŉòÒÓóÔôõÕÖöøØōŌŏŎőŐŔŕŖŗřŘŚśŝŜşŞŠšţŢŤťŧŦÙùÚúûÛüÜũŨŪūŬŭŮůŰűųŲŵŴÝýŸÿŶŷŹźŻżžŽ',
           'aaaaaaaaaaaaaaaaaaccccccccccddddeeeeeeeeeeeeeeeeeegggggggghhhhiiiiiiiiiiiiiiiiiijjkkllllllllllnnnnnnnnnoooooooooooooooooorrrrrrssssssssttttttuuuuuuuuuuuuuuuuuuuuwwyyyyyyzzzzzz')),
         '[^a-z0-9]', '', 'g'), '')
$$;
create index members_username_key on stayput.members (company_id, stayput.name_key(username));
create index members_name_key on stayput.members (company_id, stayput.name_key(display_name));

-- An account joins its member: it leaves any other member of the company, and the activity
-- waiting under it is the member's now.
create function stayput.attach_account(p_company text, p_platform text, p_account text,
                                       p_member text, p_via text) returns void
language plpgsql set search_path = ''
as $$
declare
  v_moved timestamptz;
begin
  if p_platform = 'discord' then
    update stayput.members set discord_user_id = null, discord_link = null
     where company_id = p_company and discord_user_id = p_account and id <> p_member;
    update stayput.members set discord_user_id = p_account, discord_link = p_via
     where company_id = p_company and id = p_member;
  else
    update stayput.members set telegram_user_id = null, telegram_link = null
     where company_id = p_company and telegram_user_id = p_account and id <> p_member;
    update stayput.members set telegram_user_id = p_account, telegram_link = p_via
     where company_id = p_company and id = p_member;
  end if;
  with moved as (
    delete from stayput.pending_activity
     where company_id = p_company and user_id = p_platform || ':' || p_account
    returning type, occurred_at, external_id, metadata
  ), stored as (
    insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                         metadata)
    select p_company, p_member, type, occurred_at, external_id, metadata from moved
    on conflict (company_id, type, external_id) where external_id is not null do nothing
    returning occurred_at
  )
  select min(occurred_at) into v_moved from stored;
  perform stayput.mark_stats_dirty(p_company, v_moved);
end
$$;

-- The member an account surely is, by name: its username is the member's Whop username, or its
-- full name (two words at least) is the member's Whop name. Only for an account no member has,
-- that no person decided about, and when exactly one member of the community matches, who has
-- no account on that platform yet. Null otherwise: the creator then chooses.
create function stayput.account_match(p_company text, p_platform text, p_account text)
returns text
language sql stable set search_path = ''
as $$
  with account as (
    select stayput.name_key(pa.username) as username_key,
           case when pa.display_name ~ '\S\s+\S' then stayput.name_key(pa.display_name) end
             as name_key
      from stayput.platform_accounts pa
     where pa.company_id = p_company and pa.platform = p_platform and pa.account_id = p_account
       and pa.decided_at is null and pa.dismissed_at is null
       and not exists (
         select 1 from stayput.members m
          where m.company_id = p_company
            and case p_platform when 'discord' then m.discord_user_id
                                else m.telegram_user_id end = p_account)
  ), candidates as (
    select m.id from stayput.members m, account a
     where m.company_id = p_company and char_length(a.username_key) >= 3
       and stayput.name_key(m.username) = a.username_key
    union
    select m.id from stayput.members m, account a
     where m.company_id = p_company and char_length(a.name_key) >= 5
       and stayput.name_key(m.display_name) = a.name_key
  )
  select min(m.id)
    from candidates c
    join stayput.members m on m.company_id = p_company and m.id = c.id
   where m.status = 'joined'
  having count(*) = 1
     and bool_and(case p_platform when 'discord' then m.discord_user_id
                                  else m.telegram_user_id end is null)
$$;

-- An account seen writing: its names kept up to date and, when they are new, tied to the member
-- it surely is (account_match). `p_at` null: the names alone (read from Discord or Telegram).
create function stayput.note_account(p_company text, p_platform text, p_account text,
                                     p_name text, p_username text, p_at timestamptz)
returns void
language plpgsql set search_path = ''
as $$
declare
  v_name text := nullif(btrim(left(p_name, 200)), '');
  v_username text := nullif(btrim(left(p_username, 100)), '');
  v_before stayput.platform_accounts;
  v_member text;
begin
  if not ((p_platform = 'discord' and coalesce(p_account, '') ~ '^[0-9]{5,25}$')
          or (p_platform = 'telegram' and coalesce(p_account, '') ~ '^[0-9]{1,20}$')) then
    return;
  end if;
  select * into v_before from stayput.platform_accounts
   where company_id = p_company and platform = p_platform and account_id = p_account;
  insert into stayput.platform_accounts as t (company_id, platform, account_id, display_name,
                                             username, first_seen_at, last_seen_at)
  values (p_company, p_platform, p_account, v_name, v_username, coalesce(p_at, now()),
          coalesce(p_at, now()))
  on conflict (company_id, platform, account_id) do update set
    display_name = coalesce(excluded.display_name, t.display_name),
    username = coalesce(excluded.username, t.username),
    last_seen_at = case when p_at is null then t.last_seen_at
                        else greatest(t.last_seen_at, p_at) end;
  -- Nothing to go by, or nothing new about its names: the hourly pass tries again.
  if coalesce(v_name, v_username) is null
     or v_before.account_id is not null
        and coalesce(v_name, v_before.display_name) is not distinct from v_before.display_name
        and coalesce(v_username, v_before.username) is not distinct from v_before.username then
    return;
  end if;
  v_member := stayput.account_match(p_company, p_platform, p_account);
  if v_member is not null then
    perform stayput.attach_account(p_company, p_platform, p_account, v_member, 'name');
  end if;
end
$$;

-- The accounts no member has, tied by name where they surely are someone (a member who joined
-- since, a Whop username read since). Run hourly; returns how many it tied.
create function stayput.link_accounts_by_name(p_company text) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_account record;
  v_member text;
  v_count integer := 0;
begin
  for v_account in
    select pa.platform, pa.account_id from stayput.platform_accounts pa
     where pa.company_id = p_company and pa.decided_at is null and pa.dismissed_at is null
       and (pa.display_name is not null or pa.username is not null)
       and not exists (
         select 1 from stayput.members m
          where m.company_id = p_company
            and case pa.platform when 'discord' then m.discord_user_id
                                 else m.telegram_user_id end = pa.account_id)
     order by pa.last_seen_at desc
     limit 500
  loop
    v_member := stayput.account_match(p_company, v_account.platform, v_account.account_id);
    if v_member is not null then
      perform stayput.attach_account(p_company, v_account.platform, v_account.account_id,
                                     v_member, 'name');
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- The creator ties an account to a member (or moves it to another). False when either is not
-- the company's.
create function stayput.link_account(p_company text, p_platform text, p_account text,
                                     p_member text, p_now timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.platform_accounts set decided_at = p_now, dismissed_at = null
   where company_id = p_company and platform = p_platform and account_id = p_account;
  if not found
     or not exists (select 1 from stayput.members where company_id = p_company and id = p_member)
  then
    return false;
  end if;
  perform stayput.attach_account(p_company, p_platform, p_account, p_member, 'creator');
  return true;
end
$$;

-- The creator unties an account from its member: what it brought stays, nothing more counts for
-- the member, and StayPut no longer ties it by name. False when no member had it.
create function stayput.unlink_account(p_company text, p_platform text, p_account text,
                                       p_now timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_platform = 'discord' then
    update stayput.members set discord_user_id = null, discord_link = null
     where company_id = p_company and discord_user_id = p_account;
  else
    update stayput.members set telegram_user_id = null, telegram_link = null
     where company_id = p_company and telegram_user_id = p_account;
  end if;
  get diagnostics v_count = row_count;
  update stayput.platform_accounts set decided_at = p_now
   where company_id = p_company and platform = p_platform and account_id = p_account;
  return v_count > 0;
end
$$;

-- The creator sets an account aside (no member), or brings it back. False when unknown here.
create function stayput.dismiss_account(p_company text, p_platform text, p_account text,
                                        p_dismissed boolean, p_now timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.platform_accounts
     set dismissed_at = case when p_dismissed then p_now end, decided_at = p_now
   where company_id = p_company and platform = p_platform and account_id = p_account;
  return found;
end
$$;

-- What the Sources tab shows, for the company's team only: the accounts no member has, with the
-- messages waiting and up to 3 members they may be (`strong`: same username, or same full
-- name), and the accounts tied to a member, with who tied them.
create function stayput.platform_accounts_view(p_company text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with linked as (
    select m.id as member_id, m.display_name as member_name, 'discord' as platform,
           m.discord_user_id as account_id, m.discord_link as via
      from stayput.members m
     where m.company_id = p_company and m.discord_user_id is not null
    union all
    select m.id, m.display_name, 'telegram', m.telegram_user_id, m.telegram_link
      from stayput.members m
     where m.company_id = p_company and m.telegram_user_id is not null
  ), waiting as (
    select split_part(p.user_id, ':', 1) as platform, split_part(p.user_id, ':', 2) as account_id,
           count(*)::integer as messages, max(p.occurred_at) as last_at
      from stayput.pending_activity p
     where p.company_id = p_company and p.user_id ~ '^(discord|telegram):'
     group by 1, 2
  ), unlinked as (
    select pa.platform, pa.account_id, pa.display_name, pa.username,
           coalesce(w.messages, 0) as messages, coalesce(w.last_at, pa.last_seen_at) as last_at
      from stayput.platform_accounts pa
      left join waiting w on w.platform = pa.platform and w.account_id = pa.account_id
     where pa.company_id = p_company and pa.dismissed_at is null
       and not exists (select 1 from linked l
                        where l.platform = pa.platform and l.account_id = pa.account_id)
     order by coalesce(w.last_at, pa.last_seen_at) desc
     limit 100
  ), member_keys as (
    select m.id, m.display_name, stayput.name_key(m.username) as uk,
           stayput.name_key(m.display_name) as nk,
           stayput.name_key(split_part(btrim(m.display_name), ' ', 1)) as fk,
           m.discord_user_id is null as free_discord, m.telegram_user_id is null as free_telegram
      from stayput.members m
     where m.company_id = p_company and m.status = 'joined'
  ), account_keys as (
    select u.platform, u.account_id, stayput.name_key(u.username) as uk,
           stayput.name_key(u.display_name) as nk,
           stayput.name_key(split_part(btrim(u.display_name), ' ', 1)) as fk
      from unlinked u
  ), suggestions as (
    select a.platform, a.account_id, k.id as member_id, k.display_name,
           coalesce(bool_or(char_length(a.uk) >= 3 and a.uk in (k.uk, k.nk)
                            or char_length(a.nk) >= 5 and a.nk in (k.nk, k.uk)), false)
             as strong
      from account_keys a
      join member_keys k
        on char_length(a.uk) >= 3 and a.uk in (k.uk, k.nk)
        or char_length(a.nk) >= 3 and a.nk in (k.nk, k.uk)
        or char_length(a.fk) >= 3 and a.fk = k.fk
     where case a.platform when 'discord' then k.free_discord else k.free_telegram end
     group by 1, 2, 3, 4
  )
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'unlinked', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', u.platform, 'accountId', u.account_id, 'name', u.display_name,
               'username', u.username, 'messages', u.messages, 'lastAt', u.last_at,
               'suggestions', coalesce((
                 select jsonb_agg(jsonb_build_object('memberId', s.member_id,
                                                     'name', s.display_name,
                                                     'strong', s.strong)
                                  order by s.strong desc, s.display_name)
                   from (select * from suggestions s
                          where s.platform = u.platform and s.account_id = u.account_id
                          order by s.strong desc, s.display_name
                          limit 3) s), '[]'))
             order by u.last_at desc)
        from unlinked u), '[]'),
    'linked', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', l.platform, 'accountId', l.account_id, 'name', pa.display_name,
               'username', pa.username,
               'member', jsonb_build_object('id', l.member_id, 'name', l.member_name),
               'via', l.via)
             order by l.member_name nulls last, l.platform)
        from linked l
        left join stayput.platform_accounts pa
          on pa.company_id = p_company and pa.platform = l.platform
         and pa.account_id = l.account_id), '[]'))
  end
$$;

-- Accounts whose names StayPut does not know yet (seen before 0012, or a Discord message without
-- them): the Worker asks Discord or Telegram, with the group a Telegram account wrote in.
create function stayput.accounts_without_names(p_company text, p_limit integer)
returns table (platform text, account_id text, chat_id text)
language sql stable set search_path = ''
as $$
  select pa.platform, pa.account_id,
         (select p.metadata ->> 'chat_id' from stayput.pending_activity p
           where p.company_id = p_company and p.user_id = 'telegram:' || pa.account_id
           order by p.occurred_at desc limit 1)
    from stayput.platform_accounts pa
   where pa.company_id = p_company and pa.display_name is null and pa.username is null
     and pa.dismissed_at is null
   order by pa.last_seen_at desc
   limit p_limit
$$;

-- Messages of an account no member has: noted, then counted for its member when it has one.
-- As in 0007; the names come with Telegram's message.
create function stayput.record_telegram_message(p_chat text, p_from text, p_message_id text,
                                                p_at timestamptz, p_name text, p_username text)
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
  return stayput.record_platform_activity(v_company, 'telegram', p_from, 'telegram_message',
                                          p_chat || ':' || p_message_id, p_at,
                                          jsonb_build_object('chat_id', p_chat));
end
$$;

-- The Worker of before 0012, during a deployment: the same, without the names.
create or replace function stayput.record_telegram_message(p_chat text, p_from text,
                                                           p_message_id text, p_at timestamptz)
returns boolean
language sql set search_path = ''
as $$
  select stayput.record_telegram_message(p_chat, p_from, p_message_id, p_at, null, null);
$$;

-- As in 0007, a Discord author's names noted first (note_account).
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
    else
      raise exception 'unknown kind %', p_kind;
  end case;
end
$$;

-- As in 0005, with the member's Whop username (account_match).
create or replace function stayput.upsert_member(p_company text, m jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_id text := m ->> 'id';
  v_user text := coalesce(m -> 'user' ->> 'id', m ->> 'user_id');
  v_status text := m ->> 'status';
  v_joined timestamptz := stayput.whop_time(coalesce(m ->> 'joined_at', m ->> 'created_at'));
  v_moved timestamptz;
begin
  if coalesce(v_id, '') !~ '^mber_[A-Za-z0-9]+$' or coalesce(v_user, '') !~ '^user_[A-Za-z0-9]+$'
     or coalesce(v_status, '') not in ('joined', 'left') then
    return false;
  end if;
  insert into stayput.members as t (id, company_id, user_id, display_name, username, joined_at,
                                    cohort_month, status, access_level, last_action_at)
  values (v_id, p_company, v_user,
          coalesce(nullif(m -> 'user' ->> 'name', ''), m -> 'user' ->> 'username'),
          nullif(left(m -> 'user' ->> 'username', 100), ''),
          v_joined, date_trunc('month', v_joined at time zone 'UTC')::date, v_status,
          nullif(m ->> 'access_level', ''),
          stayput.whop_time(coalesce(m ->> 'most_recent_action_at', m ->> 'last_accessed_at')))
  on conflict (id) do update set
    display_name = coalesce(excluded.display_name, t.display_name),
    username = coalesce(excluded.username, t.username),
    joined_at = coalesce(excluded.joined_at, t.joined_at),
    cohort_month = coalesce(excluded.cohort_month, t.cohort_month),
    status = excluded.status,
    access_level = coalesce(excluded.access_level, t.access_level),
    last_action_at = greatest(excluded.last_action_at, t.last_action_at)
  where t.company_id = excluded.company_id;
  -- The id belongs to another company (never with real Whop ids): nothing more to do.
  if not exists (select 1 from stayput.members where company_id = p_company and id = v_id) then
    return false;
  end if;

  -- What was read before this member is attached to it now: memberships, payments, activity.
  update stayput.memberships set member_id = v_id
   where company_id = p_company and user_id = v_user and member_id is null;
  update stayput.payments p set member_id = v_id
   where p.company_id = p_company and p.member_id is null
     and (p.whop_member_id = v_id
          or exists (select 1 from stayput.memberships ms
                      where ms.company_id = p_company and ms.id = p.membership_id
                        and ms.member_id = v_id));
  with moved as (
    delete from stayput.pending_activity
     where company_id = p_company and user_id = v_user
    returning type, occurred_at, external_id, metadata
  ), stored as (
    insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                         metadata)
    select p_company, v_id, type, occurred_at, external_id, metadata from moved
    on conflict (company_id, type, external_id) where external_id is not null do nothing
    returning occurred_at
  )
  select min(occurred_at) into v_moved from stored;
  perform stayput.mark_stats_dirty(p_company, v_moved);
  return true;
end
$$;

-- As in 0007: the Discord account on the member's Whop profile. A link Whop made follows the
-- profile (undone when the member removes the account); the creator's and a name's stay.
create or replace function stayput.link_member_discord(p_company text, u jsonb, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_discord text;
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
  update stayput.members set discord_checked_at = p_now
   where company_id = p_company and id = v_member;
  if v_discord is null then
    update stayput.members set discord_user_id = null, discord_link = null
     where company_id = p_company and id = v_member and discord_link = 'whop';
    return false;
  end if;
  perform stayput.note_account(p_company, 'discord', v_discord, null, null, null);
  perform stayput.attach_account(p_company, 'discord', v_discord, v_member, 'whop');
  return true;
end
$$;

-- As in 0007: the Telegram account a member links from StayPut.
create or replace function stayput.link_telegram_member(p_company text, p_user text,
                                                        p_telegram text, p_now timestamptz)
returns text
language plpgsql set search_path = ''
as $$
declare
  v_member text;
begin
  if coalesce(p_telegram, '') !~ '^[0-9]{1,20}$' then
    raise exception 'not a Telegram user id: %', p_telegram;
  end if;
  select id into v_member from stayput.members
   where company_id = p_company and user_id = p_user;
  if v_member is null then
    return 'no_member';
  end if;
  perform stayput.note_account(p_company, 'telegram', p_telegram, null, null, null);
  update stayput.platform_accounts set decided_at = p_now, dismissed_at = null
   where company_id = p_company and platform = 'telegram' and account_id = p_telegram;
  perform stayput.attach_account(p_company, 'telegram', p_telegram, v_member, 'member');
  return 'linked';
end
$$;

-- As in 0007: the member unlinks their Telegram account; StayPut no longer ties it by name.
create or replace function stayput.unlink_telegram_member(p_company text, p_user text)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_account text;
begin
  select telegram_user_id into v_account from stayput.members
   where company_id = p_company and user_id = p_user and telegram_user_id is not null;
  if v_account is null then
    return false;
  end if;
  update stayput.members set telegram_user_id = null, telegram_link = null
   where company_id = p_company and user_id = p_user;
  update stayput.platform_accounts set decided_at = now()
   where company_id = p_company and platform = 'telegram' and account_id = v_account;
  return true;
end
$$;

-- As in 0007, without the accounts the creator set aside.
create or replace function stayput.unlinked_authors(p_company text)
returns table (platform text, accounts integer)
language sql stable security definer set search_path = ''
as $$
  select split_part(p.user_id, ':', 1), count(distinct p.user_id)::integer
    from stayput.pending_activity p
   where p.company_id = p_company and stayput.is_company_admin(p_company)
     and (p.user_id like 'discord:%' or p.user_id like 'telegram:%')
     and not exists (
       select 1 from stayput.platform_accounts pa
        where pa.company_id = p.company_id and pa.dismissed_at is not null
          and p.user_id = pa.platform || ':' || pa.account_id)
   group by 1
$$;

-- As in 0005: a Discord or Telegram account's activity waits 30 days for its member (a Whop
-- user's, 7); the names of an account no member has go after 30 quiet days.
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
                               else m.telegram_user_id end = pa.account_id);
  return v_count;
end
$$;

revoke all on function stayput.name_key(text) from public;
revoke all on function stayput.attach_account(text, text, text, text, text) from public;
revoke all on function stayput.account_match(text, text, text) from public;
revoke all on function stayput.note_account(text, text, text, text, text, timestamptz)
  from public;
revoke all on function stayput.link_accounts_by_name(text) from public;
revoke all on function stayput.link_account(text, text, text, text, timestamptz) from public;
revoke all on function stayput.unlink_account(text, text, text, timestamptz) from public;
revoke all on function stayput.dismiss_account(text, text, text, boolean, timestamptz)
  from public;
revoke all on function stayput.platform_accounts_view(text) from public;
revoke all on function stayput.accounts_without_names(text, integer) from public;
revoke all on function stayput.record_telegram_message(text, text, text, timestamptz, text, text)
  from public;
-- Read as the creator: the view checks they administer the company.
grant execute on function stayput.platform_accounts_view(text) to stayput_user;
