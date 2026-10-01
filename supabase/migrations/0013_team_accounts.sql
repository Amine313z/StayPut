-- The creator's own Discord and Telegram accounts, and their team's (the founder, 2026-10-01: « je
-- ne peux pas relier mon compte à moi »). The owner of a community is no member of it on Whop,
-- so no member is them: their accounts are set aside as the team's, which the list now says,
-- apart from a guest's. The accounts set aside are listed too, to bring one back.

alter table stayput.platform_accounts
  add column dismissed_as text check (dismissed_as in ('team', 'guest'));
update stayput.platform_accounts set dismissed_as = 'guest' where dismissed_at is not null;
alter table stayput.platform_accounts
  add constraint platform_accounts_dismissed_check
  check ((dismissed_at is null) = (dismissed_as is null));

-- The creator sets an account aside, as their team's or as a guest's (`p_as`), or brings it
-- back (`p_as` null). False when the account is unknown here.
create function stayput.dismiss_account(p_company text, p_platform text, p_account text,
                                        p_as text, p_now timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
begin
  if p_as is not null and p_as not in ('team', 'guest') then
    raise exception 'set aside as team or guest, not %', p_as;
  end if;
  update stayput.platform_accounts
     set dismissed_at = case when p_as is not null then p_now end, dismissed_as = p_as,
         decided_at = p_now
   where company_id = p_company and platform = p_platform and account_id = p_account;
  return found;
end
$$;

-- The Worker of 0012, during a deployment: a guest's.
create or replace function stayput.dismiss_account(p_company text, p_platform text,
                                                   p_account text, p_dismissed boolean,
                                                   p_now timestamptz) returns boolean
language sql set search_path = ''
as $$
  select stayput.dismiss_account(p_company, p_platform, p_account,
                                 case when p_dismissed then 'guest' end, p_now);
$$;

-- As in 0012, with the accounts set aside, and as whose.
create or replace function stayput.platform_accounts_view(p_company text) returns jsonb
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
         and pa.account_id = l.account_id), '[]'),
    'dismissed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', d.platform, 'accountId', d.account_id, 'name', d.display_name,
               'username', d.username, 'as', d.dismissed_as, 'at', d.dismissed_at)
             order by d.dismissed_at desc)
        from (select * from stayput.platform_accounts pa
               where pa.company_id = p_company and pa.dismissed_at is not null
               order by pa.dismissed_at desc
               limit 100) d), '[]'))
  end
$$;

revoke all on function stayput.dismiss_account(text, text, text, text, timestamptz) from public;
