-- StayPut: the whole database schema, for a new Supabase project or to update one.
-- Generated from supabase/migrations (0001_foundation.sql to 0004_member_space.sql) by `npm run db:bundle`:
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

commit;
