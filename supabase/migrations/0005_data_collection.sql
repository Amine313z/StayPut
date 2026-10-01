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

-- Where each synchronization stream of a company stands: a stream is one Whop list (members,
-- payments…) or one list per channel, forum or course (`messages:<channel id>`).
create table stayput.sync_state (
  company_id text not null references stayput.companies (id) on delete cascade,
  stream text not null,
  -- Whop's cursor for the next page of the backfill (90 days, or everything for members).
  cursor text,
  backfill_done boolean not null default false,
  -- The newest item seen: the hourly sync reads back to it, not further.
  high_water timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  -- HTTP status and message of the last failure (403: a permission the creator did not grant).
  last_error text,
  primary key (company_id, stream)
);

alter table stayput.plans enable row level security;
alter table stayput.sync_state enable row level security;
create policy creator_read on stayput.plans for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.sync_state for select to stayput_user
  using (stayput.is_company_admin(company_id));
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

-- A member (GET /members, member.* webhooks). A member not joined yet ("drafted") is skipped.
create function stayput.upsert_member(p_company text, m jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_id text := m ->> 'id';
  v_user text := coalesce(m -> 'user' ->> 'id', m ->> 'user_id');
  v_status text := m ->> 'status';
  v_joined timestamptz := stayput.whop_time(coalesce(m ->> 'joined_at', m ->> 'created_at'));
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
  -- Memberships read before this member are attached to it now.
  update stayput.memberships set member_id = v_id
   where company_id = p_company and user_id = v_user and member_id is null;
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
  where p.id = v_id and ms.company_id = p_company and ms.plan_id = v_id and ms.price is null;
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
  v_membership text := coalesce(p ->> 'membership_id', p -> 'membership' ->> 'id');
  v_member text := coalesce(p ->> 'member_id', p -> 'member' ->> 'id');
  v_user text := coalesce(p ->> 'user_id', p -> 'user' ->> 'id');
  v_promo text := coalesce(p ->> 'promo_code_id', p -> 'promo_code' ->> 'id');
  v_recovery text := p ->> 'recovery_url';
  v_decline text := case jsonb_typeof(p -> 'decline_code')
                      when 'string' then p ->> 'decline_code'
                      when 'object' then p -> 'decline_code' ->> 'code'
                    end;
begin
  if coalesce(v_id, '') !~ '^pay_[A-Za-z0-9]+$' then
    return false;
  end if;
  select id into v_membership from stayput.memberships
   where company_id = p_company and id = v_membership;
  select id into v_member from stayput.members
   where company_id = p_company and (id = v_member or (v_member is null and user_id = v_user))
   limit 1;
  insert into stayput.payments as t (id, company_id, membership_id, member_id, amount, currency,
                                     status, failure_reason, recovery_url, retryable,
                                     next_payment_attempt_at, promo_code_id, paid_at,
                                     whop_created_at)
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
          coalesce(stayput.whop_time(p ->> 'created_at'), now()))
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
    paid_at = coalesce(excluded.paid_at, t.paid_at)
  where t.company_id = excluded.company_id;
  return true;
end
$$;

-- One activity of a member (message, reaction, post, lesson, ticket), stored once per source
-- id. Nothing is written for someone who is not a member of the company (a team member who is
-- not a customer, or a member StayPut has not read yet). Never the content.
create function stayput.record_activity(p_company text, p_type text, p_user text,
                                        p_external text, p_at timestamptz,
                                        p_metadata jsonb) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
begin
  if p_user is null or p_external is null or p_at is null then
    return false;
  end if;
  select id into v_member from stayput.members where company_id = p_company and user_id = p_user;
  if v_member is null then
    return false;
  end if;
  insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                       metadata)
  values (p_company, v_member, p_type, p_at, p_external,
          jsonb_strip_nulls(coalesce(p_metadata, '{}')))
  on conflict (company_id, type, external_id) where external_id is not null do nothing;
  return true;
end
$$;

-- One item of a Whop list or webhook, by kind. `scope` is the channel, forum or course the
-- list was read for. Returns whether something was stored.
create function stayput.ingest_item(p_company text, p_kind text, p_scope text, d jsonb)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_user text := coalesce(d -> 'user' ->> 'id', d ->> 'user_id');
  v_at timestamptz := stayput.whop_time(d ->> 'created_at');
  v_stored boolean := false;
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
      v_user := d -> 'customer_user' ->> 'id';
      v_stored := stayput.record_activity(
        p_company, 'support_ticket_opened', v_user, d ->> 'id',
        coalesce(v_at, stayput.whop_time(d ->> 'last_message_at')), '{}');
      if d ->> 'resolved_at' is not null then
        v_stored := stayput.record_activity(
          p_company, 'support_ticket_resolved', v_user,
          (d ->> 'id') || ':' || (d ->> 'resolved_at'),
          stayput.whop_time(d ->> 'resolved_at'), '{}') or v_stored;
      end if;
      return v_stored;
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
-- (the cursor, how old the page goes, and the ids found by a listing such as chat channels).
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
  v_at timestamptz;
  v_ids jsonb := '[]';
begin
  for item in select value from jsonb_array_elements(coalesce(p_page -> 'data', '[]')) loop
    v_count := v_count + 1;
    v_at := stayput.whop_time(coalesce(item ->> 'created_at', item ->> 'last_message_at'));
    v_oldest := least(v_oldest, v_at);
    v_newest := greatest(v_newest, v_at);
    if p_kind in ('chat_channels', 'courses') then
      v_ids := v_ids || to_jsonb(item ->> 'id');
    elsif p_kind = 'forums' then
      v_ids := v_ids || to_jsonb(coalesce(item -> 'experience' ->> 'id', item ->> 'id'));
    elsif stayput.ingest_item(p_company, p_kind, p_scope, item) then
      v_stored := v_stored + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'count', v_count,
    'stored', v_stored,
    'ids', v_ids,
    'oldest_at', v_oldest,
    'newest_at', v_newest,
    'end_cursor', p_page -> 'page_info' ->> 'end_cursor',
    'has_next_page', coalesce((p_page -> 'page_info' ->> 'has_next_page')::boolean, false));
end
$$;

-- A stored webhook delivery into the tables (SPEC Phase 2, 1). Run in the background after the
-- 200, and again by the hourly cron while it failed (at most 5 attempts). Returns the status.
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

revoke execute on all functions in schema stayput from public;
