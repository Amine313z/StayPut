-- StayPut: the whole database schema, for a new Supabase project or to update one.
-- Generated from supabase/migrations (0001_foundation.sql to 0005_data_collection.sql) by `npm run db:bundle`:
-- do not edit.
--
-- Supabase -> SQL Editor -> New query -> paste this whole file -> Run. Only the migrations not
-- applied yet run (stayput.schema_migrations lists them), so paste it again after each update.
-- It runs in one transaction: on any error, nothing is applied.

begin;

create schema if not exists stayput;
create table if not exists stayput.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
alter table stayput.schema_migrations enable row level security;

-- ==========================================================================================
-- 0001_foundation.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0001_foundation.sql') then
    raise notice 'already applied: 0001_foundation.sql';
    return;
  end if;
  execute $migration$
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
$migration$;
  insert into stayput.schema_migrations (name) values ('0001_foundation.sql');
end $install$;

-- ==========================================================================================
-- 0002_activity_and_scores.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0002_activity_and_scores.sql') then
    raise notice 'already applied: 0002_activity_and_scores.sql';
    return;
  end if;
  execute $migration$
-- StayPut, detection data: activity, daily aggregates, activity hours, risk scores, and the
-- weekly analyses (cohorts, blocking lessons, anonymous benchmarks).

-- The large table: one row per thing a member did. Only type, author and date are kept, never
-- the content of a message (SPEC Phase 8).
create table stayput.activity_events (
  id bigint generated always as identity primary key,
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  type text not null check (type in (
    'message', 'reaction', 'lesson_completed', 'forum_post', 'support_ticket_opened',
    'support_ticket_resolved', 'stayput_open', 'goal_update', 'discord_message')),
  occurred_at timestamptz not null,
  -- The source's id (message, reaction, lesson interaction…): the same event is stored once.
  external_id text,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index activity_events_member_time
  on stayput.activity_events (company_id, member_id, occurred_at);
create unique index activity_events_source
  on stayput.activity_events (company_id, type, external_id) where external_id is not null;

-- Per member and per day, to compute frequencies without scanning activity_events.
create table stayput.member_stats_daily (
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  day date not null,
  messages integer not null default 0 check (messages >= 0),
  reactions integer not null default 0 check (reactions >= 0),
  lessons_completed integer not null default 0 check (lessons_completed >= 0),
  forum_posts integer not null default 0 check (forum_posts >= 0),
  stayput_actions integer not null default 0 check (stayput_actions >= 0),
  primary key (company_id, member_id, day),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);

-- 24 counters, one per hour of the creator's day: the member's golden hour.
create table stayput.activity_hours (
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  hours integer[] not null default array_fill(0, array[24])
    check (array_length(hours, 1) = 24 and 0 <= all (hours)),
  updated_at timestamptz not null default now(),
  primary key (company_id, member_id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);

-- One row per hourly computation (kept 90 days, then one per day).
create table stayput.risk_scores (
  id bigint generated always as identity primary key,
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  score smallint not null check (score between 0 and 100),
  level text not null check (level in ('low', 'medium', 'high', 'scheduled_departure')),
  -- {recency, frequency, progress, payment, friction}, each between 0 and 1.
  sub_scores jsonb not null check (jsonb_typeof(sub_scores) = 'object'),
  -- The two main reasons as codes and values ([{"code": "no_message", "days": 12}]), so that
  -- the dashboard shows them in the creator's language.
  reasons jsonb not null default '[]' check (jsonb_typeof(reasons) = 'array'),
  computed_at timestamptz not null,
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index risk_scores_member_time
  on stayput.risk_scores (company_id, member_id, computed_at desc);
create index risk_scores_company_time on stayput.risk_scores (company_id, computed_at desc);

-- Departure rate at 30, 60 and 90 days by month of arrival (weekly job).
create table stayput.cohort_stats (
  company_id text not null references stayput.companies (id) on delete cascade,
  cohort_month date not null check (extract(day from cohort_month) = 1),
  members integer not null check (members >= 0),
  left_by_30 integer not null default 0 check (left_by_30 >= 0),
  left_by_60 integer not null default 0 check (left_by_60 >= 0),
  left_by_90 integer not null default 0 check (left_by_90 >= 0),
  alert boolean not null default false,
  computed_at timestamptz not null,
  primary key (company_id, cohort_month)
);

-- Share of members whose last completed lesson is this one and who stalled or left.
create table stayput.lesson_dropoff_stats (
  company_id text not null references stayput.companies (id) on delete cascade,
  lesson_id text not null,
  course_id text not null,
  lesson_title text,
  members_concerned integer not null check (members_concerned >= 0),
  dropoff_rate numeric(5, 4) not null check (dropoff_rate between 0 and 1),
  course_average_rate numeric(5, 4) not null check (course_average_rate between 0 and 1),
  flagged boolean not null default false,
  computed_at timestamptz not null,
  primary key (company_id, lesson_id)
);

-- Anonymous aggregates by niche: no company_id, never identifiable data. RLS only shows a
-- figure that at least 5 companies contributed to.
create table stayput.benchmarks (
  niche text not null check (niche in (
    'trading', 'fitness', 'online_business', 'coaching', 'ecommerce',
    'personal_development', 'other')),
  period_month date not null check (extract(day from period_month) = 1),
  metric text not null check (metric in ('retention_30', 'retention_60', 'retention_90')),
  value numeric(6, 4) not null check (value between 0 and 1),
  contributors integer not null check (contributors >= 0),
  computed_at timestamptz not null,
  primary key (niche, period_month, metric)
);

alter table stayput.activity_events enable row level security;
alter table stayput.member_stats_daily enable row level security;
alter table stayput.activity_hours enable row level security;
alter table stayput.risk_scores enable row level security;
alter table stayput.cohort_stats enable row level security;
alter table stayput.lesson_dropoff_stats enable row level security;
alter table stayput.benchmarks enable row level security;

create policy creator_read on stayput.activity_events for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.member_stats_daily for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.activity_hours for select to stayput_user
  using (stayput.is_company_admin(company_id));
-- Never the member: no risk score is ever visible to them (SPEC 5.3).
create policy creator_read on stayput.risk_scores for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.cohort_stats for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.lesson_dropoff_stats for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy enough_contributors on stayput.benchmarks for select to stayput_user
  using (contributors >= 5);

grant select on stayput.activity_events, stayput.member_stats_daily, stayput.activity_hours,
  stayput.risk_scores, stayput.cohort_stats, stayput.lesson_dropoff_stats, stayput.benchmarks
  to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0002_activity_and_scores.sql');
end $install$;

-- ==========================================================================================
-- 0003_actions_and_saves.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0003_actions_and_saves.sql') then
    raise notice 'already applied: 0003_actions_and_saves.sql';
    return;
  end if;
  execute $migration$
-- StayPut, acting and proving: retention actions, saves (money saved), exit surveys and the
-- Alumni offer (SPEC Phase 4, 5.9, Phase 6).

-- Every action goes proposed -> approved -> scheduled -> sent, through the guardrails
-- (blocked_by_guardrail with its reason) and is journaled (result, error_log).
create table stayput.actions (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  -- payment_retry, recovery_link, exit_survey, pause_offer, promo_offer, extend_offer,
  -- golden_hour_message, welcome_message, alumni_followup… (grows with each phase).
  type text not null check (type ~ '^[a-z][a-z0-9_]*$'),
  status text not null default 'proposed' check (status in (
    'proposed', 'approved', 'scheduled', 'sent', 'failed', 'cancelled',
    'blocked_by_guardrail')),
  -- What triggered it: a webhook type, 'score_high', 'activation_radar'…
  trigger text not null,
  content jsonb not null default '{}' check (jsonb_typeof(content) = 'object'),
  send_at timestamptz,
  sent_at timestamptz,
  result jsonb,
  error_log jsonb not null default '[]' check (jsonb_typeof(error_log) = 'array'),
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  check ((status = 'blocked_by_guardrail') = (blocked_reason is not null)),
  check (status <> 'scheduled' or send_at is not null)
);
create index actions_member_created on stayput.actions (company_id, member_id, created_at desc);
-- The hourly cron's query: scheduled actions whose time has come.
create index actions_due on stayput.actions (send_at) where status = 'scheduled';
create trigger actions_touch before update on stayput.actions
  for each row execute function stayput.touch_updated_at();

-- Money saved, attributed to an action. A payment counts once, whatever the rule that found it.
create table stayput.saves (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  action_id uuid,
  save_type text not null check (save_type in (
    'payment_recovered', 'cancellation_reverted', 'pause_resumed', 'winback',
    'renewal_after_message')),
  category text not null check (category in ('direct', 'influenced')),
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null,
  payment_id text check (payment_id ~ '^pay_[A-Za-z0-9]+$'),
  -- The Whop events that prove it (ids), shown next to the amount.
  proof jsonb not null default '[]' check (jsonb_typeof(proof) = 'array'),
  saved_at timestamptz not null,
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, action_id)
    references stayput.actions (company_id, id) on delete set null (action_id)
);
create unique index saves_payment_once on stayput.saves (payment_id) where payment_id is not null;
create index saves_company_time on stayput.saves (company_id, saved_at desc);

create table stayput.exit_surveys (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  membership_id text,
  reason text check (reason in (
    'too_expensive', 'no_time', 'no_results', 'goal_reached', 'other')),
  comment text check (char_length(comment) <= 2000),
  -- The offer made for that reason (pause, promo, extend, message, affiliate) and its action.
  offer_type text,
  offer_action_id uuid,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, membership_id)
    references stayput.memberships (company_id, id) on delete set null (membership_id),
  foreign key (company_id, offer_action_id)
    references stayput.actions (company_id, id) on delete set null (offer_action_id)
);
create index exit_surveys_company_time on stayput.exit_surveys (company_id, created_at desc);

-- Former members in the free Alumni offer (SPEC 5.9). The member row is the same: a Whop member
-- is one user in one company, whatever the product.
create table stayput.alumni_members (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  alumni_membership_id text check (alumni_membership_id ~ '^mem_[A-Za-z0-9]+$'),
  entry_mode text check (entry_mode in ('invitation', 'link')),
  -- When the member left the paid product: J+7, J+30 and J+60 count from here.
  departed_at timestamptz not null,
  invited_at timestamptz,
  entered_at timestamptz,
  left_alumni_at timestamptz,
  status text not null check (status in ('invited', 'entered', 'left', 'returned')),
  -- The return codes sent: [{"promo_code_id": "promo_…", "sent_at": "…", "step": 7}].
  promo_codes jsonb not null default '[]' check (jsonb_typeof(promo_codes) = 'array'),
  unique (company_id, member_id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index alumni_members_company_status on stayput.alumni_members (company_id, status);

alter table stayput.actions enable row level security;
alter table stayput.saves enable row level security;
alter table stayput.exit_surveys enable row level security;
alter table stayput.alumni_members enable row level security;

create policy creator_read on stayput.actions for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.saves for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.exit_surveys for select to stayput_user
  using (stayput.is_company_admin(company_id));
-- The member sees the survey StayPut sent them (to answer it in the member view).
create policy member_self_read on stayput.exit_surveys for select to stayput_user
  using (stayput.is_member_self(company_id, member_id));
create policy creator_read on stayput.alumni_members for select to stayput_user
  using (stayput.is_company_admin(company_id));

grant select on stayput.actions, stayput.saves, stayput.exit_surveys, stayput.alumni_members
  to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0003_actions_and_saves.sql');
end $install$;

-- ==========================================================================================
-- 0004_member_space.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0004_member_space.sql') then
    raise notice 'already applied: 0004_member_space.sql';
    return;
  end if;
  execute $migration$
-- StayPut, the member space (SPEC Phase 5): goals, results, proofs, milestones, badges, buddies
-- and rescue challenges.

create table stayput.goals (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  title text not null check (char_length(title) between 1 and 200),
  -- Buddies are matched on the same category when possible.
  category text check (char_length(category) <= 60),
  start_value numeric(14, 2) not null default 0,
  target_value numeric(14, 2) not null,
  unit text not null check (char_length(unit) between 1 and 40),
  target_date date,
  status text not null default 'active' check (status in ('active', 'achieved', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (target_value <> start_value),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index goals_member on stayput.goals (company_id, member_id);
create trigger goals_touch before update on stayput.goals
  for each row execute function stayput.touch_updated_at();

create table stayput.results (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  goal_id uuid not null,
  value numeric(14, 2) not null,
  recorded_at timestamptz not null,
  unique (company_id, id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, goal_id) references stayput.goals (company_id, id) on delete cascade
);
create index results_goal_time on stayput.results (company_id, goal_id, recorded_at);

-- The proof of a result. The image never leaves the member's device unless they explicitly
-- agree: only its SHA-256 and the values read by OCR are stored.
create table stayput.proofs (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  result_id uuid,
  level text not null check (level in ('declared', 'justified', 'connected')),
  ocr_values jsonb not null default '{}' check (jsonb_typeof(ocr_values) = 'object'),
  image_sha256 text check (image_sha256 ~ '^[0-9a-f]{64}$'),
  image_stored boolean not null default false,
  -- What the member agreed to show on the public page /v/:proofId (display name…).
  public_display jsonb not null default '{}' check (jsonb_typeof(public_display) = 'object'),
  created_at timestamptz not null default now(),
  check (level <> 'justified' or image_sha256 is not null),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, result_id)
    references stayput.results (company_id, id) on delete set null (result_id)
);
create index proofs_member on stayput.proofs (company_id, member_id);

create table stayput.milestones (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  goal_id uuid not null,
  percent smallint not null check (percent in (25, 50, 75, 100)),
  reached_at timestamptz not null,
  unique (goal_id, percent),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, goal_id) references stayput.goals (company_id, id) on delete cascade
);

-- The badge catalog, the same for every company (titles and texts come from packages/i18n):
-- no company_id, no member data.
create table stayput.badges (
  code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  kind text not null check (kind in ('assiduity', 'milestone', 'mentor', 'rescue'))
);
insert into stayput.badges (code, kind) values
  ('streak_7_days', 'assiduity'),
  ('first_result', 'assiduity'),
  ('first_proof', 'assiduity'),
  ('milestone_25', 'milestone'),
  ('milestone_50', 'milestone'),
  ('milestone_75', 'milestone'),
  ('milestone_100', 'milestone'),
  ('mentor', 'mentor'),
  ('rescuer', 'rescue');

create table stayput.member_badges (
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  badge_code text not null references stayput.badges (code),
  awarded_at timestamptz not null,
  context jsonb not null default '{}' check (jsonb_typeof(context) = 'object'),
  primary key (company_id, member_id, badge_code),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);

-- A newcomer (< 7 days) paired with a veteran (> 30 days, low risk, at most 3 active pairs).
create table stayput.buddy_pairs (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  newcomer_member_id text not null,
  veteran_member_id text not null,
  paired_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'completed', 'ended')),
  check (newcomer_member_id <> veteran_member_id),
  foreign key (company_id, newcomer_member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, veteran_member_id)
    references stayput.members (company_id, id) on delete cascade
);
create unique index buddy_pairs_one_active_per_newcomer
  on stayput.buddy_pairs (company_id, newcomer_member_id) where status = 'active';
create index buddy_pairs_veteran on stayput.buddy_pairs (company_id, veteran_member_id)
  where status = 'active';

-- A challenge shown, anonymized, to active members: help a member who stalled.
create table stayput.rescue_challenges (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  target_member_id text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'expired')),
  created_at timestamptz not null,
  resolved_at timestamptz,
  unique (company_id, id),
  foreign key (company_id, target_member_id)
    references stayput.members (company_id, id) on delete cascade
);

create table stayput.rescue_challenge_participants (
  company_id text not null references stayput.companies (id) on delete cascade,
  challenge_id uuid not null,
  member_id text not null,
  joined_at timestamptz not null,
  reengaged_target boolean not null default false,
  primary key (challenge_id, member_id),
  foreign key (company_id, challenge_id)
    references stayput.rescue_challenges (company_id, id) on delete cascade,
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);

alter table stayput.goals enable row level security;
alter table stayput.results enable row level security;
alter table stayput.proofs enable row level security;
alter table stayput.milestones enable row level security;
alter table stayput.badges enable row level security;
alter table stayput.member_badges enable row level security;
alter table stayput.buddy_pairs enable row level security;
alter table stayput.rescue_challenges enable row level security;
alter table stayput.rescue_challenge_participants enable row level security;

create policy creator_read on stayput.goals for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.goals for select to stayput_user
  using (stayput.is_member_self(company_id, member_id));
create policy creator_read on stayput.results for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.results for select to stayput_user
  using (stayput.is_member_self(company_id, member_id));
create policy creator_read on stayput.proofs for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.proofs for select to stayput_user
  using (stayput.is_member_self(company_id, member_id));
create policy creator_read on stayput.milestones for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.milestones for select to stayput_user
  using (stayput.is_member_self(company_id, member_id));
create policy everyone_read on stayput.badges for select to stayput_user using (true);
create policy creator_read on stayput.member_badges for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.member_badges for select to stayput_user
  using (stayput.is_member_self(company_id, member_id));
create policy creator_read on stayput.buddy_pairs for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.buddy_pairs for select to stayput_user
  using (stayput.is_member_self(company_id, newcomer_member_id)
         or stayput.is_member_self(company_id, veteran_member_id));
-- Members never read rescue_challenges directly: it names the member in difficulty, and the
-- member view shows challenges anonymized (served by the Worker).
create policy creator_read on stayput.rescue_challenges for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy creator_read on stayput.rescue_challenge_participants for select to stayput_user
  using (stayput.is_company_admin(company_id));
create policy member_self_read on stayput.rescue_challenge_participants for select
  to stayput_user using (stayput.is_member_self(company_id, member_id));

grant select on stayput.goals, stayput.results, stayput.proofs, stayput.milestones,
  stayput.badges, stayput.member_badges, stayput.buddy_pairs, stayput.rescue_challenges,
  stayput.rescue_challenge_participants to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0004_member_space.sql');
end $install$;

-- ==========================================================================================
-- 0005_data_collection.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0005_data_collection.sql') then
    raise notice 'already applied: 0005_data_collection.sql';
    return;
  end if;
  execute $migration$
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
$migration$;
  insert into stayput.schema_migrations (name) values ('0005_data_collection.sql');
end $install$;

commit;
