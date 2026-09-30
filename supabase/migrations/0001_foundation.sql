-- StayPut, foundation: the schema, the role reads run under, companies, members, memberships,
-- payments, and the server-side bookkeeping tables.
--
-- Everything lives in the schema `stayput`, which Supabase's Data API (PostgREST) does not
-- expose: the public `anon` key reaches none of it. The Worker connects as the owner for
-- background work (sync, webhooks, cron) and switches to the role `stayput_user`, inside a
-- transaction, for reads made on behalf of a Whop user; RLS then decides which rows exist for
-- that user (DECISIONS.md, 2026-09-30).

create schema if not exists stayput;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'stayput_user') then
    create role stayput_user nologin;
  end if;
end $$;
-- The migrating role (postgres on Supabase) is the one the Worker connects as: it must be able
-- to SET ROLE stayput_user.
grant stayput_user to current_user;
grant usage on schema stayput to stayput_user;

-- The Whop user a transaction acts for, set by the Worker with
-- set_config('stayput.user_id', …, true). Null outside such a transaction.
create function stayput.current_user_id() returns text
language sql stable
as $$ select nullif(current_setting('stayput.user_id', true), '') $$;

create function stayput.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Companies (Whop accounts) that installed StayPut.
create table stayput.companies (
  id text primary key check (id ~ '^biz_[A-Za-z0-9]+$'),
  name text,
  niche text not null default 'other' check (niche in (
    'trading', 'fitness', 'online_business', 'coaching', 'ecommerce',
    'personal_development', 'other')),
  locale text not null default 'en' check (locale in ('en', 'fr')),
  plan text not null default 'free' check (plan in ('free', 'pro', 'scale', 'performance')),
  mode text not null default 'manual' check (mode in ('auto', 'manual')),
  timezone text not null default 'UTC',
  status text not null default 'active' check (status in ('active', 'uninstalled')),
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  is_demo boolean not null default false,
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'uninstalled') = (uninstalled_at is not null))
);
create trigger companies_touch before update on stayput.companies
  for each row execute function stayput.touch_updated_at();

-- One row per company. Defaults are the SPEC's (Phase 3 score, Phase 4 guardrails).
create table stayput.company_settings (
  company_id text primary key references stayput.companies (id) on delete cascade,
  weight_recency numeric(4, 3) not null default 0.30,
  weight_frequency numeric(4, 3) not null default 0.25,
  weight_progress numeric(4, 3) not null default 0.20,
  weight_payment numeric(4, 3) not null default 0.15,
  weight_friction numeric(4, 3) not null default 0.10,
  recency_threshold_days smallint not null default 14
    check (recency_threshold_days between 1 and 90),
  medium_risk_from smallint not null default 40,
  high_risk_from smallint not null default 70,
  max_messages_per_5_days smallint not null default 1 check (max_messages_per_5_days >= 0),
  max_messages_per_month smallint not null default 4 check (max_messages_per_month >= 0),
  max_payment_retries smallint not null default 2 check (max_payment_retries between 0 and 2),
  monthly_promo_cap smallint not null default 10 check (monthly_promo_cap >= 0),
  max_free_days_per_quarter smallint not null default 14
    check (max_free_days_per_quarter between 0 and 14),
  quiet_hours_start smallint not null default 22 check (quiet_hours_start between 0 and 23),
  quiet_hours_end smallint not null default 8 check (quiet_hours_end between 0 and 23),
  default_send_hour smallint not null default 19 check (default_send_hour between 0 and 23),
  dry_run boolean not null default false,
  kill_switch boolean not null default false,
  active_templates jsonb not null default '{}' check (jsonb_typeof(active_templates) = 'object'),
  options jsonb not null default
    '{"buddies": false, "earned_days": false, "public_badge": false,
      "benchmarks_opt_in": false, "rescue_challenges": false}'
    check (jsonb_typeof(options) = 'object'),
  updated_at timestamptz not null default now(),
  check (least(weight_recency, weight_frequency, weight_progress, weight_payment,
               weight_friction) >= 0),
  -- The app brings the weights back to a sum of 1 before saving them.
  check (abs(weight_recency + weight_frequency + weight_progress + weight_payment
             + weight_friction - 1) < 0.001),
  check (0 < medium_risk_from and medium_risk_from < high_risk_from and high_risk_from <= 100)
);
create trigger company_settings_touch before update on stayput.company_settings
  for each row execute function stayput.touch_updated_at();

-- Whop users whose admin access to a company the Worker checked with Whop. RLS lets a user see
-- a company's rows only while this check is recent.
create table stayput.company_admins (
  company_id text not null references stayput.companies (id) on delete cascade,
  user_id text not null check (user_id ~ '^user_[A-Za-z0-9]+$'),
  verified_at timestamptz not null,
  primary key (company_id, user_id)
);

-- A Whop member is one user in one company (`mber_…`).
create table stayput.members (
  id text primary key check (id ~ '^mber_[A-Za-z0-9]+$'),
  company_id text not null references stayput.companies (id) on delete cascade,
  user_id text not null check (user_id ~ '^user_[A-Za-z0-9]+$'),
  display_name text,
  joined_at timestamptz,
  cohort_month date check (extract(day from cohort_month) = 1),
  discord_user_id text,
  status text not null default 'joined' check (status in ('joined', 'left')),
  -- The « never contact » list: no action of any kind targets this member.
  do_not_contact boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, user_id)
);
create index members_company_status on stayput.members (company_id, status);
create trigger members_touch before update on stayput.members
  for each row execute function stayput.touch_updated_at();

create table stayput.memberships (
  id text primary key check (id ~ '^mem_[A-Za-z0-9]+$'),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text,
  user_id text check (user_id ~ '^user_[A-Za-z0-9]+$'),
  product_id text not null check (product_id ~ '^prod_[A-Za-z0-9]+$'),
  plan_id text not null check (plan_id ~ '^plan_[A-Za-z0-9]+$'),
  price numeric(12, 2) check (price >= 0),
  currency text,
  -- Days between renewals; null for a one-time purchase.
  billing_period_days integer check (billing_period_days > 0),
  -- Whop's status as is (active, trialing, past_due, canceling, canceled, expired…).
  status text not null,
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  paused boolean not null default false,
  pause_resumes_at timestamptz,
  whop_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index memberships_company_member on stayput.memberships (company_id, member_id);
create index memberships_company_status on stayput.memberships (company_id, status);
create trigger memberships_touch before update on stayput.memberships
  for each row execute function stayput.touch_updated_at();

create table stayput.payments (
  id text primary key check (id ~ '^pay_[A-Za-z0-9]+$'),
  company_id text not null references stayput.companies (id) on delete cascade,
  membership_id text,
  member_id text,
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null,
  status text not null,
  failure_reason text,
  -- 3D Secure: the Whop page where the member confirms the payment.
  recovery_url text check (recovery_url ~ '^https://'),
  retryable boolean,
  next_payment_attempt_at timestamptz,
  promo_code_id text check (promo_code_id ~ '^promo_[A-Za-z0-9]+$'),
  paid_at timestamptz,
  whop_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, membership_id)
    references stayput.memberships (company_id, id) on delete set null (membership_id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index payments_company_membership on stayput.payments (company_id, membership_id);
create index payments_company_created on stayput.payments (company_id, whop_created_at);
create trigger payments_touch before update on stayput.payments
  for each row execute function stayput.touch_updated_at();

-- Every Whop delivery, stored before it is processed: idempotency (the webhook-id is the key)
-- and replay. No foreign key: a delivery may name a company that has not opened StayPut yet.
create table stayput.webhook_events (
  id text primary key,
  company_id text,
  type text not null,
  payload jsonb not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'ignored')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  received_at timestamptz not null,
  processed_at timestamptz
);
create index webhook_events_pending on stayput.webhook_events (received_at)
  where status in ('received', 'failed');
create index webhook_events_company on stayput.webhook_events (company_id);

-- Every sensitive action: who, what, when, why. company_id is null for app-wide ones.
create table stayput.audit_log (
  id bigint generated always as identity primary key,
  company_id text references stayput.companies (id) on delete cascade,
  actor text not null,
  action text not null,
  target jsonb not null default '{}',
  reason text,
  created_at timestamptz not null default now()
);
create index audit_log_company_created on stayput.audit_log (company_id, created_at desc);

create table stayput.billing (
  company_id text not null references stayput.companies (id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  plan text not null check (plan in ('free', 'pro', 'scale', 'performance')),
  member_count integer not null default 0 check (member_count >= 0),
  performance_amount numeric(12, 2) not null default 0 check (performance_amount >= 0),
  currency text not null default 'usd',
  status text not null default 'open' check (status in ('open', 'invoiced', 'paid', 'waived')),
  updated_at timestamptz not null default now(),
  primary key (company_id, period_month)
);
create trigger billing_touch before update on stayput.billing
  for each row execute function stayput.touch_updated_at();

-- RLS helpers. SECURITY DEFINER so that a policy can read company_admins / members, which
-- stayput_user cannot read directly.

-- The current user is a team member of `company`, checked with Whop within the last day.
create function stayput.is_company_admin(company text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from stayput.company_admins a
    where a.company_id = company
      and a.user_id = stayput.current_user_id()
      and a.verified_at > now() - interval '1 day')
$$;

-- `member` of `company` is the current user.
create function stayput.is_member_self(company text, member text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from stayput.members m
    where m.company_id = company and m.id = member
      and m.user_id = stayput.current_user_id())
$$;

-- PostgreSQL lets PUBLIC execute every new function, and a per-schema ALTER DEFAULT PRIVILEGES
-- cannot take that back: every migration that creates a function ends with this revoke
-- (schema.test.ts checks it), then grants what stayput_user needs.
revoke execute on all functions in schema stayput from public;
grant execute on function stayput.current_user_id(), stayput.is_company_admin(text),
  stayput.is_member_self(text, text) to stayput_user;

alter table stayput.companies enable row level security;
alter table stayput.company_settings enable row level security;
alter table stayput.company_admins enable row level security;
alter table stayput.members enable row level security;
alter table stayput.memberships enable row level security;
alter table stayput.payments enable row level security;
alter table stayput.webhook_events enable row level security;
alter table stayput.audit_log enable row level security;
alter table stayput.billing enable row level security;

create policy creator_read on stayput.companies for select to stayput_user
  using (stayput.is_company_admin(id));
create policy creator_read on stayput.company_settings for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.members for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.members for select to stayput_user
  using (user_id = stayput.current_user_id());
create policy creator_read on stayput.memberships for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.memberships for select to stayput_user
  using (user_id = stayput.current_user_id());
create policy creator_read on stayput.payments for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.audit_log for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.billing for select to stayput_user
  using (stayput.is_company_admin(company_id));
-- company_admins and webhook_events: server only, no policy.

grant select on stayput.companies, stayput.company_settings, stayput.members,
  stayput.memberships, stayput.payments, stayput.audit_log, stayput.billing to stayput_user;
