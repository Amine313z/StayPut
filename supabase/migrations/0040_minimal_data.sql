-- SPEC Phase 8.2 and 8.3, minimal data and people's rights:
-- 1. What Whop sends keeps none of its personal fields StayPut never reads (e-mails, phone
--    numbers, addresses, the text of messages), and goes after 7 days, 30 at the most.
-- 2. One member's data, deleted at the community's request; StayPut then never takes them in
--    again in that community, from Whop, Discord or Telegram (`erased_people`: fingerprints of
--    their ids, never the ids).
-- 3. A community whose access Whop withdrew (the app uninstalled): marked so once Whop has
--    refused everything for a day, then deleted 30 days after it lost access.

-- 1. Whop's deliveries --------------------------------------------------------------------------

-- The keys StayPut never keeps from Whop's JSON: what it never reads, and is personal.
create function stayput.is_personal_key(p_key text) returns boolean
language sql immutable set search_path = ''
as $$
  select p_key in ('email', 'phone', 'phone_number', 'content', 'rich_content', 'text', 'body',
                   'attachments', 'embeds', 'address', 'billing_address', 'shipping_address',
                   'ip', 'ip_address')
      or p_key like '%\_email' or p_key like '%\_phone' or p_key like '%\_phone\_number'
$$;

-- `p_value` without those keys, at any depth.
create function stayput.without_personal(p_value jsonb) returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_out jsonb;
  v_key text;
  v_item jsonb;
begin
  if jsonb_typeof(p_value) = 'object' then
    v_out := '{}';
    for v_key, v_item in select e.key, e.value from jsonb_each(p_value) e loop
      if not stayput.is_personal_key(v_key) then
        v_out := v_out || jsonb_build_object(v_key, stayput.without_personal(v_item));
      end if;
    end loop;
    return v_out;
  elsif jsonb_typeof(p_value) = 'array' then
    select coalesce(jsonb_agg(stayput.without_personal(a.value) order by a.n), '[]')
      into v_out
      from jsonb_array_elements(p_value) with ordinality as a(value, n);
    return v_out;
  end if;
  return p_value;
end
$$;

create function stayput.strip_webhook_payload() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.payload := stayput.without_personal(new.payload);
  return new;
end
$$;
create trigger webhook_events_minimal
  before insert or update of payload on stayput.webhook_events
  for each row execute function stayput.strip_webhook_payload();

-- What was kept before, the same way.
update stayput.webhook_events set payload = stayput.without_personal(payload);

create index webhook_events_received on stayput.webhook_events (received_at);

-- Every hour: a delivery done with (processed or ignored) goes after 7 days, time enough to look
-- into a doubt; any other after 30 (the replays give up after 5 attempts). Returns how many.
create function stayput.purge_webhook_events(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from stayput.webhook_events
   where (status in ('processed', 'ignored') and received_at < p_now - interval '7 days')
      or received_at < p_now - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- 2. One member's data -------------------------------------------------------------------------

create table stayput.erased_people (
  company_id text not null references stayput.companies (id) on delete cascade,
  -- Whose id the fingerprint is: a Whop user (user_…) or member (mber_…), a Discord or a
  -- Telegram account.
  kind text not null check (kind in ('user', 'member', 'discord', 'telegram')),
  -- SHA-256 of the id: StayPut recognizes the person without keeping who they were.
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  erased_at timestamptz not null,
  primary key (company_id, kind, fingerprint)
);
alter table stayput.erased_people enable row level security;
create policy creator_read on stayput.erased_people for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.erased_people to stayput_user;

create function stayput.fingerprint(p_id text) returns text
language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(p_id, 'UTF8')), 'hex') $$;

create function stayput.is_erased(p_company text, p_kind text, p_id text) returns boolean
language sql stable set search_path = ''
as $$
  select p_id is not null and exists (
    select 1 from stayput.erased_people e
     where e.company_id = p_company and e.kind = p_kind
       and e.fingerprint = stayput.fingerprint(p_id))
$$;

-- Before a row about a person comes in: none about someone erased (the row is skipped, the rest
-- of the reading goes on). Its owner's rights: whoever inserts, the fingerprints are read.
create function stayput.skip_erased() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'members' then
    if stayput.is_erased(new.company_id, 'user', new.user_id)
       or stayput.is_erased(new.company_id, 'member', new.id) then
      return null;
    end if;
  elsif tg_table_name = 'memberships' then
    if stayput.is_erased(new.company_id, 'user', new.user_id)
       or stayput.is_erased(new.company_id, 'member', new.member_id) then
      return null;
    end if;
  elsif tg_table_name = 'payments' then
    if stayput.is_erased(new.company_id, 'member', coalesce(new.member_id, new.whop_member_id))
    then
      return null;
    end if;
  elsif tg_table_name = 'pending_activity' then
    -- `user_…` for Whop; `discord:…` or `telegram:…` for an account no member is tied to.
    if stayput.is_erased(new.company_id,
                         case when new.user_id like 'discord:%' then 'discord'
                              when new.user_id like 'telegram:%' then 'telegram'
                              else 'user' end,
                         regexp_replace(new.user_id, '^(discord|telegram):', '')) then
      return null;
    end if;
  elsif tg_table_name in ('platform_accounts', 'platform_presence') then
    if stayput.is_erased(new.company_id, new.platform, new.account_id) then
      return null;
    end if;
  end if;
  return new;
end
$$;
create trigger members_not_erased before insert on stayput.members
  for each row execute function stayput.skip_erased();
create trigger memberships_not_erased before insert on stayput.memberships
  for each row execute function stayput.skip_erased();
create trigger payments_not_erased before insert on stayput.payments
  for each row execute function stayput.skip_erased();
create trigger pending_activity_not_erased before insert on stayput.pending_activity
  for each row execute function stayput.skip_erased();
create trigger platform_accounts_not_erased before insert on stayput.platform_accounts
  for each row execute function stayput.skip_erased();
create trigger platform_presence_not_erased before insert on stayput.platform_presence
  for each row execute function stayput.skip_erased();

-- Everything StayPut keeps about one member, deleted (the Worker checked the team member with
-- Whop, and the request named the member again); their ids' fingerprints kept so that they never
-- come back. True when there was such a member.
create function stayput.forget_member(p_company text, p_member text, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  m stayput.members;
begin
  select * into m from stayput.members where company_id = p_company and id = p_member;
  if not found then
    return false;
  end if;
  insert into stayput.erased_people (company_id, kind, fingerprint, erased_at)
  select p_company, k.kind, stayput.fingerprint(k.id), p_now
    from (values ('user', m.user_id), ('member', m.id), ('discord', m.discord_user_id),
                 ('telegram', m.telegram_user_id)) as k(kind, id)
   where k.id is not null
  on conflict do nothing;
  -- What is filed under their ids without pointing at the member row.
  delete from stayput.payments p
   where p.company_id = p_company
     and (p.whop_member_id = m.id
          or p.membership_id in (select ms.id from stayput.memberships ms
                                  where ms.company_id = p_company and ms.user_id = m.user_id));
  delete from stayput.memberships where company_id = p_company and user_id = m.user_id;
  delete from stayput.pending_activity
   where company_id = p_company
     and user_id in (m.user_id, 'discord:' || m.discord_user_id, 'telegram:' || m.telegram_user_id);
  delete from stayput.platform_accounts
   where company_id = p_company
     and ((platform = 'discord' and account_id = m.discord_user_id)
          or (platform = 'telegram' and account_id = m.telegram_user_id));
  delete from stayput.platform_presence
   where company_id = p_company
     and ((platform = 'discord' and account_id = m.discord_user_id)
          or (platform = 'telegram' and account_id = m.telegram_user_id));
  delete from stayput.webhook_events
   where company_id = p_company
     and (payload::text like '%"' || m.user_id || '"%' or payload::text like '%"' || m.id || '"%');
  -- The trail of what was done stays, without whom it was done to.
  update stayput.audit_log set target = '{"erased": true}'
   where company_id = p_company
     and (target::text like '%"' || m.id || '"%' or target::text like '%"' || m.user_id || '"%');
  -- The member, and through the cascades all that hangs on them.
  delete from stayput.members where company_id = p_company and id = p_member;
  return true;
end
$$;

-- 3. An uninstalled community ------------------------------------------------------------------

alter table stayput.companies
  -- Since when Whop refuses the app everything on the community (GET /permissions), and when the
  -- Worker last asked; cleared as soon as it grants something again, or the team opens StayPut.
  add column access_lost_at timestamptz,
  add column access_checked_at timestamptz;

-- The communities to ask Whop about: still active, and the last reading of their members was
-- refused (403); each asked at most every 6 hours.
create function stayput.access_suspects(p_now timestamptz, p_limit integer) returns setof text
language sql stable set search_path = ''
as $$
  select c.id
    from stayput.companies c
    join stayput.sync_state s on s.company_id = c.id and s.stream = 'members'
   where c.status = 'active' and not c.is_demo
     and s.last_error like '403%'
     and (c.access_checked_at is null or c.access_checked_at <= p_now - interval '6 hours')
   order by c.access_checked_at nulls first, c.id
   limit p_limit
$$;

-- What Whop answered: access granted (the refusal was something else) or not. Refused for a day
-- already: the community is uninstalled, from when access was lost. Returns its status.
create function stayput.record_access(p_company text, p_granted boolean, p_now timestamptz)
returns text
language plpgsql set search_path = ''
as $$
declare
  v_status text;
begin
  update stayput.companies
     set access_checked_at = p_now,
         access_lost_at = case when p_granted then null else coalesce(access_lost_at, p_now) end
   where id = p_company and not is_demo;
  update stayput.companies
     set status = 'uninstalled', uninstalled_at = access_lost_at
   where id = p_company and status = 'active' and not p_granted
     and access_lost_at <= p_now - interval '1 day';
  select status into v_status from stayput.companies where id = p_company;
  return v_status;
end
$$;

-- Every hour: the communities uninstalled more than 30 days ago, deleted whole (as « Delete all
-- data »). Returns their ids.
create function stayput.delete_uninstalled_companies(p_now timestamptz) returns setof text
language plpgsql set search_path = ''
as $$
declare
  v_id text;
begin
  for v_id in
    select id from stayput.companies
     where status = 'uninstalled' and not is_demo
       and uninstalled_at < p_now - interval '30 days'
     order by id
  loop
    perform stayput.delete_company_data(v_id);
    return next v_id;
  end loop;
end
$$;

revoke all on function stayput.is_personal_key(text) from public;
revoke all on function stayput.without_personal(jsonb) from public;
revoke all on function stayput.strip_webhook_payload() from public;
revoke all on function stayput.purge_webhook_events(timestamptz) from public;
revoke all on function stayput.fingerprint(text) from public;
revoke all on function stayput.is_erased(text, text, text) from public;
revoke all on function stayput.skip_erased() from public;
revoke all on function stayput.forget_member(text, text, timestamptz) from public;
revoke all on function stayput.access_suspects(timestamptz, integer) from public;
revoke all on function stayput.record_access(text, boolean, timestamptz) from public;
revoke all on function stayput.delete_uninstalled_companies(timestamptz) from public;
