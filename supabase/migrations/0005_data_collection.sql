-- Phase 2, data collection: what Whop sends (webhooks) and what StayPut reads (sync) lands in
-- members, memberships, payments and activity_events through the functions below. The Worker
-- hands them Whop's raw JSON: parsing and mapping happen here, in SQL, so that the Worker stays
-- under the free plan's 10 ms of CPU per run (DECISIONS.md). Emails and phone numbers that Whop
-- returns are never stored.

-- What the members list tells about a member, and their last action in the community.
alter table stayput.members
  add column access_level text check (access_level in ('no_access', 'admin', 'customer')),
  add column last_action_at timestamptz;

alter table stayput.memberships add column canceled_at timestamptz;

-- Whop's ids of a payment's membership and member, kept while StayPut does not know them (a
-- webhook can arrive before them): the link is made when they arrive.
alter table stayput.payments
  add column whop_membership_id text check (whop_membership_id ~ '^mem_[A-Za-z0-9]+$'),
  add column whop_member_id text check (whop_member_id ~ '^mber_[A-Za-z0-9]+$');
create index payments_unlinked_membership on stayput.payments (company_id, whop_membership_id)
  where membership_id is null;
create index payments_unlinked_member on stayput.payments (company_id, whop_member_id)
  where member_id is null;

-- Whop variants ("plans" in ids): the price behind each membership, for the revenue at risk.
create table stayput.plans (
  id text primary key check (id ~ '^plan_[A-Za-z0-9]+$'),
  company_id text not null references stayput.companies (id) on delete cascade,
  product_id text check (product_id ~ '^prod_[A-Za-z0-9]+$'),
  plan_type text,
  initial_price numeric(12, 2) check (initial_price >= 0),
  renewal_price numeric(12, 2) check (renewal_price >= 0),
  currency text,
  billing_period_days integer check (billing_period_days > 0),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

-- Where each synchronization stream of a company stands. A stream is one Whop list (`members`,
-- `payments`…) or one list per channel, forum or course (`messages:<channel id>`), read in
-- passes: a pass reads pages from the top of the list, over several runs when it must (the
-- cursor), down to what an earlier pass already read, or to the end.
create table stayput.sync_state (
  company_id text not null references stayput.companies (id) on delete cascade,
  stream text not null,
  -- The pass under way: Whop's cursor of its next page; the time it reads back to (null: the end
  -- of the list); whether it reads the whole list; the newest item it has met.
  cursor text,
  pass_until timestamptz,
  pass_complete boolean not null default false,
  pass_newest timestamptz,
  -- The newest item of the passes that ended: the next pass reads back to it, not further.
  high_water timestamptz,
  -- The first pass (the backfill: 90 days, the whole list for members and memberships) ended.
  backfill_done boolean not null default false,
  last_pass_at timestamptz,
  last_complete_pass_at timestamptz,
  last_run_at timestamptz,
  -- HTTP status and message of the last failure (403: a permission the creator did not grant).
  last_error text,
  last_error_at timestamptz,
  primary key (company_id, stream)
);

-- The synchronization of a company as a whole: one run at a time (the lease), the companies
-- that waited longest first, and the statistics to recompute.
create table stayput.company_sync (
  company_id text primary key references stayput.companies (id) on delete cascade,
  lease_until timestamptz,
  last_synced_at timestamptz,
  -- Activity from this time on changed since member_stats_daily was computed.
  stats_dirty_since timestamptz
);

-- Activity of a user StayPut does not know as a member yet (an event ahead of the members list):
-- moved to activity_events when the member arrives, forgotten after 7 days.
create table stayput.pending_activity (
  company_id text not null references stayput.companies (id) on delete cascade,
  user_id text not null check (user_id ~ '^user_[A-Za-z0-9]+$'),
  type text not null check (type in (
    'message', 'reaction', 'lesson_completed', 'forum_post', 'support_ticket_opened',
    'support_ticket_resolved')),
  occurred_at timestamptz not null,
  external_id text not null,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  received_at timestamptz not null default now(),
  primary key (company_id, type, external_id)
);
create index pending_activity_user on stayput.pending_activity (company_id, user_id);

alter table stayput.plans enable row level security;
alter table stayput.sync_state enable row level security;
alter table stayput.company_sync enable row level security;
alter table stayput.pending_activity enable row level security;
create policy creator_read on stayput.plans for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.sync_state for select to stayput_user
  using (stayput.is_company_admin(company_id));
-- company_sync and pending_activity are the Worker's own: no policy, no grant.
grant select on stayput.plans, stayput.sync_state to stayput_user;

-- A Whop timestamp: ISO 8601 text, or seconds since the epoch on older payloads.
create function stayput.whop_time(value text) returns timestamptz
language sql stable set search_path = ''
as $$
  select case
    when value is null or value = '' then null
    when value ~ '^[0-9]+(\.[0-9]+)?$' then to_timestamp(value::double precision)
    else value::timestamptz
  end
$$;

-- A Whop amount: a Money object ({"amount": "10.00"}), a number, or a numeric string.
create function stayput.whop_amount(value jsonb) returns numeric
language sql immutable set search_path = ''
as $$
  select case jsonb_typeof(value)
    when 'object' then (value ->> 'amount')::numeric
    when 'number' then (value #>> '{}')::numeric
    when 'string' then nullif(value #>> '{}', '')::numeric
  end
$$;

-- The company exists for StayPut as soon as Whop sends something about it (SPEC Phase 2, 2):
-- an installed app hears from a company before its team opens the dashboard.
create function stayput.ensure_company(p_company text, p_now timestamptz) returns void
language sql set search_path = ''
as $$
  insert into stayput.companies (id, installed_at) values (p_company, p_now)
  on conflict (id) do nothing;
  insert into stayput.company_settings (company_id) values (p_company)
  on conflict (company_id) do nothing;
$$;

-- Activity from `p_since` on changed: refresh_stats recomputes the statistics from there. The
-- row stays locked until the transaction ends, so refresh_stats never misses activity written
-- while it runs (it waits for it).
create function stayput.mark_stats_dirty(p_company text, p_since timestamptz) returns void
language plpgsql set search_path = ''
as $$
begin
  if p_since is null then
    return;
  end if;
  insert into stayput.company_sync as s (company_id, stats_dirty_since)
  values (p_company, p_since)
  on conflict (company_id) do update
    set stats_dirty_since = least(s.stats_dirty_since, excluded.stats_dirty_since);
end
$$;

-- A member (GET /members, member.* webhooks). A member not joined yet ("drafted"), or with no
-- user (the app's own account), is skipped.
create function stayput.upsert_member(p_company text, m jsonb) returns boolean
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
  insert into stayput.members as t (id, company_id, user_id, display_name, joined_at,
                                    cohort_month, status, access_level, last_action_at)
  values (v_id, p_company, v_user,
          coalesce(nullif(m -> 'user' ->> 'name', ''), m -> 'user' ->> 'username'),
          v_joined, date_trunc('month', v_joined at time zone 'UTC')::date, v_status,
          nullif(m ->> 'access_level', ''),
          stayput.whop_time(coalesce(m ->> 'most_recent_action_at', m ->> 'last_accessed_at')))
  on conflict (id) do update set
    display_name = coalesce(excluded.display_name, t.display_name),
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

-- A variant (GET /variants): its prices, for the memberships that use it.
create function stayput.upsert_plan(p_company text, v jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_id text := v ->> 'id';
  v_product text := coalesce(v -> 'product' ->> 'id', v ->> 'product_id');
begin
  if coalesce(v_id, '') !~ '^plan_[A-Za-z0-9]+$' then
    return false;
  end if;
  insert into stayput.plans as t (id, company_id, product_id, plan_type, initial_price,
                                  renewal_price, currency, billing_period_days)
  values (v_id, p_company,
          case when v_product ~ '^prod_[A-Za-z0-9]+$' then v_product end,
          v ->> 'plan_type',
          greatest(stayput.whop_amount(v -> 'initial_price'), 0),
          greatest(stayput.whop_amount(v -> 'renewal_price'), 0),
          lower(v ->> 'currency'),
          nullif((v ->> 'billing_period')::numeric::integer, 0))
  on conflict (id) do update set
    product_id = coalesce(excluded.product_id, t.product_id),
    plan_type = excluded.plan_type,
    initial_price = excluded.initial_price,
    renewal_price = excluded.renewal_price,
    currency = excluded.currency,
    billing_period_days = excluded.billing_period_days,
    updated_at = now()
  where t.company_id = excluded.company_id;
  -- Memberships read before their variant get its price now.
  update stayput.memberships ms set
    price = coalesce(ms.price, case when p.plan_type = 'one_time' then p.initial_price
                                    else p.renewal_price end),
    currency = coalesce(ms.currency, p.currency),
    billing_period_days = coalesce(ms.billing_period_days, p.billing_period_days)
  from stayput.plans p
  where p.id = v_id and p.company_id = p_company and ms.company_id = p_company
    and ms.plan_id = v_id and ms.price is null;
  return true;
end
$$;

-- A membership (GET /memberships, membership.* webhooks).
create function stayput.upsert_membership(p_company text, m jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_id text := m ->> 'id';
  v_user text := coalesce(m ->> 'user_id', m -> 'user' ->> 'id');
  v_product text := coalesce(m ->> 'product_id', m -> 'product' ->> 'id');
  v_plan text := coalesce(m ->> 'plan_id', m -> 'plan' ->> 'id');
  v_member text;
  p stayput.plans;
begin
  if coalesce(v_id, '') !~ '^mem_[A-Za-z0-9]+$' or coalesce(v_product, '') !~ '^prod_[A-Za-z0-9]+$'
     or coalesce(v_plan, '') !~ '^plan_[A-Za-z0-9]+$' or m ->> 'status' is null then
    return false;
  end if;
  if coalesce(v_user, '') !~ '^user_[A-Za-z0-9]+$' then
    v_user := null;
  end if;
  select id into v_member from stayput.members
   where company_id = p_company and user_id = v_user;
  select * into p from stayput.plans where company_id = p_company and id = v_plan;
  insert into stayput.memberships as t (id, company_id, member_id, user_id, product_id, plan_id,
                                        price, currency, billing_period_days, status,
                                        cancel_at_period_end, current_period_end, canceled_at,
                                        whop_created_at)
  values (v_id, p_company, v_member, v_user, v_product, v_plan,
          case when p.plan_type = 'one_time' then p.initial_price else p.renewal_price end,
          p.currency,
          coalesce(nullif((m ->> 'billing_period_days')::integer, 0), p.billing_period_days),
          m ->> 'status',
          coalesce((m ->> 'cancel_at_period_end')::boolean, false),
          stayput.whop_time(coalesce(m ->> 'current_period_end', m ->> 'renewal_period_end')),
          stayput.whop_time(m ->> 'canceled_at'),
          stayput.whop_time(m ->> 'created_at'))
  on conflict (id) do update set
    member_id = coalesce(excluded.member_id, t.member_id),
    user_id = coalesce(excluded.user_id, t.user_id),
    plan_id = excluded.plan_id,
    price = coalesce(excluded.price, t.price),
    currency = coalesce(excluded.currency, t.currency),
    billing_period_days = coalesce(excluded.billing_period_days, t.billing_period_days),
    status = excluded.status,
    cancel_at_period_end = excluded.cancel_at_period_end,
    current_period_end = coalesce(excluded.current_period_end, t.current_period_end),
    canceled_at = excluded.canceled_at,
    whop_created_at = coalesce(t.whop_created_at, excluded.whop_created_at)
  where t.company_id = excluded.company_id;
  if not exists (select 1 from stayput.memberships where company_id = p_company and id = v_id)
  then
    return false;
  end if;
  -- Payments read before this membership are attached to it now.
  update stayput.payments set membership_id = v_id, member_id = coalesce(member_id, v_member)
   where company_id = p_company and membership_id is null and whop_membership_id = v_id;
  return true;
end
$$;

-- A payment (GET /payments, payment.* webhooks). `status` keeps Whop's sub-status when there is
-- one (succeeded, failed, past_due…), which says what happened to the charge.
create function stayput.upsert_payment(p_company text, p jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_id text := p ->> 'id';
  v_whop_membership text := coalesce(p ->> 'membership_id', p -> 'membership' ->> 'id');
  v_whop_member text := coalesce(p ->> 'member_id', p -> 'member' ->> 'id');
  v_user text := coalesce(p ->> 'user_id', p -> 'user' ->> 'id');
  v_promo text := coalesce(p ->> 'promo_code_id', p -> 'promo_code' ->> 'id');
  v_recovery text := p ->> 'recovery_url';
  v_decline text := case jsonb_typeof(p -> 'decline_code')
                      when 'string' then p ->> 'decline_code'
                      when 'object' then p -> 'decline_code' ->> 'code'
                    end;
  v_membership text;
  v_member text;
  v_membership_member text;
begin
  if coalesce(v_id, '') !~ '^pay_[A-Za-z0-9]+$' then
    return false;
  end if;
  if coalesce(v_whop_membership, '') !~ '^mem_[A-Za-z0-9]+$' then
    v_whop_membership := null;
  end if;
  if coalesce(v_whop_member, '') !~ '^mber_[A-Za-z0-9]+$' then
    v_whop_member := null;
  end if;
  select id, member_id into v_membership, v_membership_member from stayput.memberships
   where company_id = p_company and id = v_whop_membership;
  select id into v_member from stayput.members
   where company_id = p_company
     and (id = v_whop_member or (v_whop_member is null and user_id = v_user))
   limit 1;
  v_member := coalesce(v_member, v_membership_member);
  insert into stayput.payments as t (id, company_id, membership_id, member_id, amount, currency,
                                     status, failure_reason, recovery_url, retryable,
                                     next_payment_attempt_at, promo_code_id, paid_at,
                                     whop_created_at, whop_membership_id, whop_member_id)
  values (v_id, p_company, v_membership, v_member,
          greatest(coalesce(stayput.whop_amount(p -> 'total'),
                            stayput.whop_amount(p -> 'final_amount'),
                            stayput.whop_amount(p -> 'subtotal'), 0), 0),
          lower(coalesce(p ->> 'currency', p -> 'total' ->> 'currency', 'usd')),
          coalesce(nullif(p ->> 'substatus', ''), p ->> 'status', 'unknown'),
          coalesce(nullif(p ->> 'failure_message', ''), v_decline),
          case when v_recovery ~ '^https://' then v_recovery end,
          (p ->> 'retryable')::boolean,
          stayput.whop_time(p ->> 'next_payment_attempt_at'),
          case when v_promo ~ '^promo_[A-Za-z0-9]+$' then v_promo end,
          stayput.whop_time(p ->> 'paid_at'),
          coalesce(stayput.whop_time(p ->> 'created_at'), now()),
          v_whop_membership, v_whop_member)
  on conflict (id) do update set
    membership_id = coalesce(excluded.membership_id, t.membership_id),
    member_id = coalesce(excluded.member_id, t.member_id),
    amount = excluded.amount,
    currency = excluded.currency,
    status = excluded.status,
    failure_reason = coalesce(excluded.failure_reason, t.failure_reason),
    -- The recovery link only comes with a single payment (webhook or GET /payments/{id}).
    recovery_url = coalesce(excluded.recovery_url, t.recovery_url),
    retryable = coalesce(excluded.retryable, t.retryable),
    next_payment_attempt_at = excluded.next_payment_attempt_at,
    promo_code_id = coalesce(excluded.promo_code_id, t.promo_code_id),
    paid_at = coalesce(excluded.paid_at, t.paid_at),
    whop_membership_id = coalesce(excluded.whop_membership_id, t.whop_membership_id),
    whop_member_id = coalesce(excluded.whop_member_id, t.whop_member_id)
  where t.company_id = excluded.company_id;
  return true;
end
$$;

-- One activity of a member (message, reaction, post, lesson, ticket), stored once per source
-- id, never with its content. Returns whether the author is a member StayPut knows: someone it
-- does not know yet waits in pending_activity (upsert_member moves it), never in this table.
create function stayput.record_activity(p_company text, p_type text, p_user text,
                                        p_external text, p_at timestamptz,
                                        p_metadata jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_metadata jsonb := jsonb_strip_nulls(coalesce(p_metadata, '{}'));
  v_inserted integer;
begin
  if coalesce(p_user, '') !~ '^user_[A-Za-z0-9]+$' or p_external is null or p_at is null then
    return false;
  end if;
  select id into v_member from stayput.members where company_id = p_company and user_id = p_user;
  if v_member is null then
    insert into stayput.pending_activity (company_id, user_id, type, occurred_at, external_id,
                                          metadata)
    values (p_company, p_user, p_type, p_at, p_external, v_metadata)
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

-- A support channel as Whop lists it now: open, or resolved. Whop gives no opening date, so an
-- opening is dated by the last message seen at the time, and counted once per episode (the
-- first one, then one after each resolution StayPut recorded).
create function stayput.record_support_channel(p_company text, d jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_channel text := d ->> 'id';
  v_user text := d -> 'customer_user' ->> 'id';
  v_last timestamptz := stayput.whop_time(d ->> 'last_message_at');
  v_resolved timestamptz := stayput.whop_time(d ->> 'resolved_at');
  v_metadata jsonb := jsonb_build_object('channel_id', v_channel);
  v_previous timestamptz;
begin
  if v_channel is null then
    return false;
  end if;
  if v_resolved is not null and (v_last is null or v_last <= v_resolved) then
    perform stayput.record_activity(p_company, 'support_ticket_opened', v_user,
                                    v_channel || ':first', coalesce(v_last, v_resolved),
                                    v_metadata);
    return stayput.record_activity(p_company, 'support_ticket_resolved', v_user,
                                   v_channel || ':' || (d ->> 'resolved_at'), v_resolved,
                                   v_metadata);
  end if;
  select max(e.occurred_at) into v_previous
    from stayput.activity_events e
    join stayput.members m on m.company_id = e.company_id and m.id = e.member_id
   where e.company_id = p_company and m.user_id = v_user
     and e.type = 'support_ticket_resolved' and e.metadata ->> 'channel_id' = v_channel;
  return stayput.record_activity(
    p_company, 'support_ticket_opened', v_user,
    v_channel || ':' || coalesce(to_char(v_previous at time zone 'UTC',
                                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'first'),
    coalesce(v_last, v_resolved, now()), v_metadata);
end
$$;

-- One item of a Whop list or webhook, by kind. `scope` is the channel, forum or course the
-- list was read for. Returns whether something was stored (or will be, for activity of a member
-- not known yet).
create function stayput.ingest_item(p_company text, p_kind text, p_scope text, d jsonb)
returns boolean
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
    else
      raise exception 'unknown kind %', p_kind;
  end case;
end
$$;

-- One page of a Whop list, as received: stores its items and returns what the sync needs next
-- (the cursor, and how old the page goes). A listing of chat channels, forums or courses opens
-- one stream per channel, forum (its experience) or course found.
create function stayput.ingest_page(p_company text, p_kind text, p_scope text, p_page jsonb)
returns jsonb
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
  if jsonb_typeof(p_page -> 'data') is distinct from 'array' then
    raise exception 'not a page of a Whop list';
  end if;
  for item in select value from jsonb_array_elements(p_page -> 'data') loop
    v_count := v_count + 1;
    v_at := stayput.whop_time(coalesce(item ->> 'created_at', item ->> 'last_message_at'));
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

-- One page of a stream, then where the stream stands (apps/worker/src/sync.ts plans the
-- passes). `p_start`: the page opens a pass, which reads back to `p_until` (null: to the end)
-- and, with `p_complete`, counts as a reading of the whole list. `p_stop` says how a page shows
-- the pass has caught up: 'oldest' for a list sorted newest first (its oldest item reaches
-- `until`), 'newest' for one only roughly so (its newest item does), 'end' never before the end.
-- Returns the cursor of the next page, null when the pass is over.
create function stayput.sync_page(p_company text, p_stream text, p_kind text, p_scope text,
                                  p_page jsonb, p_now timestamptz, p_start boolean,
                                  p_until timestamptz, p_complete boolean, p_stop text)
returns text
language plpgsql set search_path = ''
as $$
declare
  r jsonb := stayput.ingest_page(p_company, p_kind, p_scope, p_page);
  s stayput.sync_state;
  v_next text := r ->> 'end_cursor';
  -- How far back this page goes. A page sorted oldest first never ends a pass early: what
  -- follows it is newer.
  v_reached timestamptz := case when (r ->> 'ascending')::boolean then null
                                when p_stop = 'oldest' then (r ->> 'oldest_at')::timestamptz
                                when p_stop = 'newest' then (r ->> 'newest_at')::timestamptz end;
begin
  insert into stayput.sync_state (company_id, stream) values (p_company, p_stream)
  on conflict do nothing;
  select * into s from stayput.sync_state
   where company_id = p_company and stream = p_stream for update;
  if p_start then
    s.pass_until := p_until;
    s.pass_complete := coalesce(p_complete, false);
    s.pass_newest := null;
  end if;
  s.pass_newest := greatest(s.pass_newest, (r ->> 'newest_at')::timestamptz);
  if (r ->> 'has_next_page')::boolean and v_next is not null
     and not coalesce(v_reached <= s.pass_until, false) then
    update stayput.sync_state
       set cursor = v_next, pass_until = s.pass_until, pass_complete = s.pass_complete,
           pass_newest = s.pass_newest, last_run_at = p_now, last_error = null,
           last_error_at = null
     where company_id = p_company and stream = p_stream;
    return v_next;
  end if;
  update stayput.sync_state
     set cursor = null, pass_until = null, pass_complete = false, pass_newest = null,
         high_water = greatest(high_water, s.pass_newest),
         backfill_done = true,
         last_pass_at = p_now,
         last_complete_pass_at = case when s.pass_complete then p_now
                                      else last_complete_pass_at end,
         last_run_at = p_now, last_error = null, last_error_at = null
   where company_id = p_company and stream = p_stream;
  return null;
end
$$;

-- Whop refused or failed a page of a stream. A permission the creator did not grant (403) or a
-- list that is gone (404) ends the pass: the stream waits for its next one. A channel, forum or
-- course that is gone loses its stream. Anything else (5xx, network) keeps the cursor: the next
-- run retries the same page.
create function stayput.sync_error(p_company text, p_stream text, p_now timestamptz,
                                   p_status integer, p_message text) returns void
language plpgsql set search_path = ''
as $$
begin
  if p_status = 404 and p_stream like '%:%' then
    delete from stayput.sync_state where company_id = p_company and stream = p_stream;
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

-- The companies whose synchronization is due, those that waited longest first: never synced,
-- synced more than `p_interval_seconds` ago, or with a pass under way or a stream never read.
create function stayput.companies_to_sync(p_now timestamptz, p_interval_seconds integer,
                                          p_limit integer) returns setof text
language sql stable set search_path = ''
as $$
  select c.id
    from stayput.companies c
    left join stayput.company_sync s on s.company_id = c.id
   where c.status = 'active' and not c.is_demo
     and (s.lease_until is null or s.lease_until <= p_now)
     and (s.last_synced_at is null
          or s.last_synced_at <= p_now - make_interval(secs => p_interval_seconds)
          or exists (select 1 from stayput.sync_state t
                      where t.company_id = c.id
                        and (t.cursor is not null or t.last_run_at is null)))
   order by s.last_synced_at nulls first, c.id
   limit p_limit
$$;

-- Takes the company's synchronization for `p_lease_seconds`, unless another run holds it, or it
-- ran less than `p_min_interval_seconds` ago. Only active companies that are not demos.
create function stayput.claim_sync(p_company text, p_now timestamptz, p_lease_seconds integer,
                                   p_min_interval_seconds integer) returns boolean
language plpgsql set search_path = ''
as $$
begin
  if not exists (select 1 from stayput.companies
                  where id = p_company and status = 'active' and not is_demo) then
    return false;
  end if;
  insert into stayput.company_sync (company_id) values (p_company) on conflict do nothing;
  update stayput.company_sync
     set lease_until = p_now + make_interval(secs => p_lease_seconds)
   where company_id = p_company
     and (lease_until is null or lease_until <= p_now)
     and (last_synced_at is null
          or last_synced_at <= p_now - make_interval(secs => p_min_interval_seconds));
  return found;
end
$$;

create function stayput.release_sync(p_company text, p_now timestamptz) returns void
language sql set search_path = ''
as $$
  update stayput.company_sync set lease_until = null, last_synced_at = p_now
   where company_id = p_company;
$$;

-- A stored webhook delivery into the tables (SPEC Phase 2, 1). Run in the background after the
-- 200, and again by the cron while it failed (at most 5 attempts). Returns the status.
create function stayput.process_webhook_event(p_id text, p_now timestamptz) returns text
language plpgsql set search_path = ''
as $$
declare
  e stayput.webhook_events;
  d jsonb;
  v_status text := 'processed';
begin
  select * into e from stayput.webhook_events where id = p_id for update skip locked;
  if not found or e.status in ('processed', 'ignored') then
    return coalesce(e.status, 'missing');
  end if;
  d := e.payload -> 'data';
  begin
    if e.company_id is null then
      v_status := 'ignored';
    else
      perform stayput.ensure_company(e.company_id, p_now);
      if e.type like 'membership.%' then
        perform stayput.upsert_membership(e.company_id, d);
      elsif e.type like 'payment.%' then
        perform stayput.upsert_payment(e.company_id, d);
      elsif e.type in ('member.created', 'member.updated') then
        perform stayput.upsert_member(e.company_id, d);
      elsif e.type = 'course_lesson_interaction.completed' then
        perform stayput.ingest_item(e.company_id, 'lesson_interactions', null,
                                    d || '{"completed": true}');
      elsif e.type = 'chat.message.created' then
        perform stayput.ingest_item(e.company_id, 'messages',
                                    coalesce(d ->> 'channel_id', d -> 'channel' ->> 'id'), d);
      elsif e.type = 'chat.reaction.created' then
        perform stayput.ingest_item(e.company_id, 'reactions', null, d);
      else
        v_status := 'ignored';
      end if;
    end if;
    update stayput.webhook_events
       set status = v_status, attempts = attempts + 1, last_error = null, processed_at = p_now
     where id = p_id;
  exception when others then
    v_status := 'failed';
    update stayput.webhook_events
       set status = 'failed', attempts = attempts + 1, last_error = left(sqlerrm, 500)
     where id = p_id;
  end;
  return v_status;
end
$$;

-- Deliveries still to process (or to retry), oldest first.
create function stayput.pending_webhook_events(p_limit integer) returns setof text
language sql stable set search_path = ''
as $$
  select id from stayput.webhook_events
   where status in ('received', 'failed') and attempts < 5
   order by received_at
   limit p_limit
$$;

-- The cron's replay: deliveries received more than a minute ago (the fresher ones are being
-- processed in the background) and not processed yet, or failed. Returns how many per status.
create function stayput.process_pending_webhooks(p_limit integer, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_id text;
  v_status text;
  v_counts jsonb := '{}';
begin
  for v_id in
    select id from stayput.webhook_events
     where status in ('received', 'failed') and attempts < 5
       and received_at <= p_now - interval '1 minute'
     order by received_at
     limit p_limit
  loop
    v_status := stayput.process_webhook_event(v_id, p_now);
    v_counts := v_counts
      || jsonb_build_object(v_status, coalesce((v_counts ->> v_status)::integer, 0) + 1);
  end loop;
  return v_counts;
end
$$;

-- member_stats_daily and activity_hours from activity_events (SPEC Phase 2, 4), from `p_since`
-- on, in the company's time zone. activity_hours covers the last 90 days.
create function stayput.refresh_activity_stats(p_company text, p_since timestamptz,
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
         count(*) filter (where type in ('message', 'discord_message')),
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

-- Recomputes the statistics of every company whose activity changed (or of `p_company` only),
-- from the oldest change on. Returns how many companies it refreshed.
create function stayput.refresh_stats(p_now timestamptz, p_company text default null)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_company text;
  v_since timestamptz;
  v_count integer := 0;
begin
  for v_company in
    select company_id from stayput.company_sync
     where stats_dirty_since is not null and (p_company is null or company_id = p_company)
     order by company_id
  loop
    -- Waits for the transactions still writing this company's activity, then holds them off.
    select stats_dirty_since into v_since from stayput.company_sync
     where company_id = v_company for update;
    if v_since is not null then
      perform stayput.refresh_activity_stats(v_company, v_since, p_now);
      update stayput.company_sync set stats_dirty_since = null where company_id = v_company;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- Activity of users who never became members: forgotten after 7 days. Returns how many rows.
create function stayput.purge_pending_activity(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from stayput.pending_activity where received_at < p_now - interval '7 days';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on all functions in schema stayput from public;
