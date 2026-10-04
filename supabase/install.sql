-- StayPut: the whole database schema, for a new Supabase project or to update one.
-- Generated from supabase/migrations (0001_foundation.sql to 0035_weekly_reports.sql) by `npm run db:bundle`:
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

-- ==========================================================================================
-- 0006_sync_opened_companies.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0006_sync_opened_companies.sql') then
    raise notice 'already applied: 0006_sync_opened_companies.sql';
    return;
  end if;
  execute $migration$
-- Two lessons of the first deployment of Phase 2 (2026-10-01).
--
-- 1. Whop's "test webhook" sends made-up data: its company is `biz_xxxxxxxxxxxxxx`. Filed like a
--    real delivery, it created that company, which the sync would then have read every hour.
--    Such placeholder companies are now ignored, and the one created is removed.
-- 2. The sync reads a company once its team has opened StayPut (SPEC Phase 2, 2: the backfill
--    starts at the first visit). Webhooks of a company that installed the app are still filed
--    before that, at no cost; reading Whop's lists for it waits for the visit.

-- Whop's placeholder company, in its test deliveries.
create function stayput.is_placeholder_company(p_company text) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(p_company ~ '^biz_x+$', false) $$;

create or replace function stayput.process_webhook_event(p_id text, p_now timestamptz)
returns text
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
    if e.company_id is null or stayput.is_placeholder_company(e.company_id) then
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

-- Due companies, as in 0005, among those whose team opened StayPut.
create or replace function stayput.companies_to_sync(p_now timestamptz,
                                                     p_interval_seconds integer,
                                                     p_limit integer) returns setof text
language sql stable set search_path = ''
as $$
  select c.id
    from stayput.companies c
    left join stayput.company_sync s on s.company_id = c.id
   where c.status = 'active' and not c.is_demo
     and exists (select 1 from stayput.company_admins a where a.company_id = c.id)
     and (s.lease_until is null or s.lease_until <= p_now)
     and (s.last_synced_at is null
          or s.last_synced_at <= p_now - make_interval(secs => p_interval_seconds)
          or exists (select 1 from stayput.sync_state t
                      where t.company_id = c.id
                        and (t.cursor is not null or t.last_run_at is null)))
   order by s.last_synced_at nulls first, c.id
   limit p_limit
$$;

-- The test delivery of 2026-10-01 and what it created.
delete from stayput.companies where stayput.is_placeholder_company(id);
delete from stayput.webhook_events where stayput.is_placeholder_company(company_id);

revoke execute on all functions in schema stayput from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0006_sync_opened_companies.sql');
end $install$;

-- ==========================================================================================
-- 0007_discord_telegram.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0007_discord_telegram.sql') then
    raise notice 'already applied: 0007_discord_telegram.sql';
    return;
  end if;
  execute $migration$
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
$migration$;
  insert into stayput.schema_migrations (name) values ('0007_discord_telegram.sql');
end $install$;

-- ==========================================================================================
-- 0008_risk_detection.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0008_risk_detection.sql') then
    raise notice 'already applied: 0008_risk_detection.sql';
    return;
  end if;
  execute $migration$
-- Detection (SPEC Phase 3). Every hour, Postgres gathers the figures of each member
-- (risk_features), the Worker computes the score with the pure functions of packages/core
-- (src/risk.ts), and Postgres keeps the result: the current score of each member (member_risk)
-- and one score a day for the history (risk_scores). Every week, cohorts and lessons are counted
-- here (analysis_features) and judged by packages/core (src/analyses.ts).

-- The current score of each member of the community (team excluded), replaced every hour.
create table stayput.member_risk (
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  score smallint not null check (score between 0 and 100),
  level text not null check (level in ('low', 'medium', 'high', 'scheduled_departure')),
  -- {recency, frequency, progress, payment, friction}, each between 0 and 1.
  sub_scores jsonb not null check (jsonb_typeof(sub_scores) = 'object'),
  -- The two main reasons as codes and figures, worded by the dashboard.
  reasons jsonb not null default '[]' check (jsonb_typeof(reasons) = 'array'),
  -- Joined 3 to 7 days ago and did nothing since: the activation radar.
  inactive_newcomer boolean not null default false,
  -- Since when the member is at this level, and the level before (Phase 4 acts on changes).
  level_since timestamptz not null,
  previous_level text check (previous_level in ('low', 'medium', 'high', 'scheduled_departure')),
  computed_at timestamptz not null,
  primary key (company_id, member_id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade
);
create index member_risk_company_score on stayput.member_risk (company_id, score desc);
create index member_risk_company_computed on stayput.member_risk (company_id, computed_at);

alter table stayput.member_risk enable row level security;
-- Never the member: no risk score is ever visible to them (SPEC 5.3).
create policy creator_read on stayput.member_risk for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.member_risk to stayput_user;

-- The history keeps one score a day per member (the day's last) rather than one an hour.
alter table stayput.risk_scores add column day date;
update stayput.risk_scores set day = (computed_at at time zone 'UTC')::date;
alter table stayput.risk_scores alter column day set not null;
-- save_risk_scores gives the day in the company's time zone; anything else falls on today (UTC).
alter table stayput.risk_scores alter column day set default current_date;
create unique index risk_scores_member_day on stayput.risk_scores (company_id, member_id, day);

-- Departures counted at each horizon only among members who joined long enough ago.
alter table stayput.cohort_stats
  add column eligible_30 integer not null default 0 check (eligible_30 >= 0),
  add column eligible_60 integer not null default 0 check (eligible_60 >= 0),
  add column eligible_90 integer not null default 0 check (eligible_90 >= 0),
  -- The first horizon at which the cohort leaves 1.5 times more than the creator's average.
  add column alert_horizon smallint check (alert_horizon in (30, 60, 90));

-- Per lesson: how many members reached it, and how many stalled right after it.
alter table stayput.lesson_dropoff_stats
  add column stalled integer not null default 0 check (stalled >= 0);

-- When the weekly analyses last ran for the company.
alter table stayput.company_sync add column analyses_at timestamptz;

-- What a member does that counts as activity (support tickets are friction, not activity).
create function stayput.engagement_types() returns text[]
language sql immutable set search_path = ''
as $$
  select array['message', 'reaction', 'lesson_completed', 'forum_post', 'stayput_open',
               'goal_update', 'discord_message', 'telegram_message']
$$;

-- Milliseconds since the epoch: the Worker compares numbers, it never parses a date.
create function stayput.epoch_ms(p_at timestamptz) returns bigint
language sql immutable set search_path = ''
as $$
  select (extract(epoch from p_at) * 1000)::bigint
$$;

-- The figures of up to `p_limit` members whose score is due (never computed, or 50 minutes
-- ago), and the company's settings. Members of the community only, team excluded. One JSON
-- document, compact: the Worker parses it once (packages/core, RiskInputs):
-- [id, joinedAt, lastActivityAt, activity7d, activityPrev28d, lastProgressAt, lastLessonTitle,
--  payment, cancelAtPeriodEnd, cancelAt, openTicketSince, reactions14d, reactionsPrev14d,
--  activeSinceJoin].
create function stayput.risk_features(p_company text, p_now timestamptz, p_limit integer)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_settings jsonb;
  v_members jsonb;
begin
  select coalesce(c.timezone, 'UTC') into v_tz from stayput.companies c where c.id = p_company;
  if v_tz is null then
    return jsonb_build_object('settings', null, 'members', '[]'::jsonb);
  end if;
  v_today := (p_now at time zone v_tz)::date;
  select jsonb_build_object(
           'weights', jsonb_build_object(
             'recency', s.weight_recency::float8, 'frequency', s.weight_frequency::float8,
             'progress', s.weight_progress::float8, 'payment', s.weight_payment::float8,
             'friction', s.weight_friction::float8),
           'recencyThresholdDays', s.recency_threshold_days,
           'mediumFrom', s.medium_risk_from,
           'highFrom', s.high_risk_from,
           -- Courses read from Whop, or lessons and goals on record: progress counts.
           'tracksProgress',
             exists (select 1 from stayput.sync_state t
                      where t.company_id = p_company and t.stream like 'lesson_interactions:%')
             or exists (select 1 from stayput.activity_events e
                         where e.company_id = p_company
                           and e.type in ('lesson_completed', 'goal_update')
                           and e.external_id is not null))
    into v_settings
    from stayput.company_settings s where s.company_id = p_company;
  v_settings := coalesce(v_settings, jsonb_build_object(
    'weights', jsonb_build_object('recency', 0.3, 'frequency', 0.25, 'progress', 0.2,
                                  'payment', 0.15, 'friction', 0.1),
    'recencyThresholdDays', 14, 'mediumFrom', 40, 'highFrom', 70, 'tracksProgress', false));

  with due as (
    select m.id, m.joined_at, m.last_action_at
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
       and (r.computed_at is null or r.computed_at <= p_now - interval '50 minutes')
     order by r.computed_at nulls first, m.id
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_array(
           d.id,
           stayput.epoch_ms(d.joined_at),
           stayput.epoch_ms(greatest(last_event.at, d.last_action_at)),
           coalesce(stats.activity_7d, 0),
           coalesce(stats.activity_prev_28d, 0),
           stayput.epoch_ms(progress.at),
           progress.title,
           case
             when payment.failed or exists (
               select 1 from stayput.memberships ms
                where ms.company_id = p_company and ms.member_id = d.id
                  and ms.status = 'past_due') then 'failed'
             when payment.action_required then 'action_required'
             else 'ok'
           end,
           cancel.at is not null,
           stayput.epoch_ms(cancel.at),
           stayput.epoch_ms(ticket.since),
           coalesce(stats.reactions_14d, 0),
           coalesce(stats.reactions_prev_14d, 0),
           coalesce(joined.active, false)
         ) order by d.id), '[]'::jsonb)
    into v_members
    from due d
    left join lateral (
      select e.occurred_at as at from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type = any (stayput.engagement_types())
       order by e.occurred_at desc limit 1) last_event on true
    left join lateral (
      select sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day > v_today - 7)::integer
               as activity_7d,
             sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day <= v_today - 7)::integer
               as activity_prev_28d,
             sum(s.reactions) filter (where s.day > v_today - 14)::integer as reactions_14d,
             sum(s.reactions) filter (where s.day <= v_today - 14 and s.day > v_today - 28)::integer
               as reactions_prev_14d
        from stayput.member_stats_daily s
       where s.company_id = p_company and s.member_id = d.id and s.day > v_today - 35) stats
      on true
    left join lateral (
      select e.occurred_at as at, e.metadata ->> 'lesson_title' as title
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type in ('lesson_completed', 'goal_update')
       order by e.occurred_at desc limit 1) progress on true
    left join lateral (
      select p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
               as failed,
             p.recovery_url is not null
               and p.status = any (array['open', 'pending', 'incomplete', 'requires_action',
                                         'requires_capture']) as action_required
        from stayput.payments p
       where p.company_id = p_company and p.member_id = d.id
       order by p.whop_created_at desc limit 1) payment on true
    left join lateral (
      select min(ms.current_period_end) as at
        from stayput.memberships ms
       where ms.company_id = p_company and ms.member_id = d.id
         and ms.status = any (array['trialing', 'active', 'past_due', 'canceling', 'completed'])
         and (ms.cancel_at_period_end or ms.status = 'canceling')
      having count(*) > 0) cancel on true
    left join lateral (
      -- A support conversation whose last event is the member's, not a resolution.
      select min(t.occurred_at) as since from (
        select distinct on (e.metadata ->> 'channel_id') e.type, e.occurred_at
          from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type in ('support_ticket_opened', 'support_ticket_resolved')
         order by e.metadata ->> 'channel_id', e.occurred_at desc) t
       where t.type = 'support_ticket_opened') ticket on true
    left join lateral (
      select exists (
        select 1 from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type = any (stayput.engagement_types())
           and e.occurred_at >= d.joined_at) as active) joined on true;

  return jsonb_build_object('settings', v_settings, 'members', v_members);
end
$$;

-- The scores the Worker computed: [id, score, level, [recency, frequency, progress, payment,
-- friction], reasons, inactiveNewcomer]. The current score replaces the previous one (its level
-- change is remembered), the day's history keeps the last. Members who left or joined the team
-- lose their score. Returns how many were saved.
create function stayput.save_risk_scores(p_company text, p_scores jsonb, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_saved integer;
begin
  select coalesce(timezone, 'UTC') into v_tz from stayput.companies where id = p_company;
  if v_tz is null then
    return 0;
  end if;
  with input as (
    select s ->> 0 as member_id,
           (s ->> 1)::smallint as score,
           s ->> 2 as level,
           jsonb_build_object('recency', s -> 3 -> 0, 'frequency', s -> 3 -> 1,
                              'progress', s -> 3 -> 2, 'payment', s -> 3 -> 3,
                              'friction', s -> 3 -> 4) as sub_scores,
           coalesce(s -> 4, '[]'::jsonb) as reasons,
           coalesce((s ->> 5)::boolean, false) as newcomer
      from jsonb_array_elements(p_scores) s
  ), kept as (
    select i.* from input i
      join stayput.members m on m.company_id = p_company and m.id = i.member_id
     where m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
  ), current as (
    insert into stayput.member_risk as r (company_id, member_id, score, level, sub_scores,
                                          reasons, inactive_newcomer, level_since,
                                          previous_level, computed_at)
    select p_company, member_id, score, level, sub_scores, reasons, newcomer, p_now, null, p_now
      from kept
    on conflict (company_id, member_id) do update set
      score = excluded.score,
      level = excluded.level,
      sub_scores = excluded.sub_scores,
      reasons = excluded.reasons,
      inactive_newcomer = excluded.inactive_newcomer,
      previous_level = case when r.level <> excluded.level then r.level else r.previous_level end,
      level_since = case when r.level <> excluded.level then excluded.computed_at
                         else r.level_since end,
      computed_at = excluded.computed_at
    returning member_id, score, level, sub_scores, reasons
  )
  insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores, reasons,
                                   computed_at, day)
  select p_company, member_id, score, level, sub_scores, reasons, p_now,
         (p_now at time zone v_tz)::date
    from current
  on conflict (company_id, member_id, day) do update set
    score = excluded.score,
    level = excluded.level,
    sub_scores = excluded.sub_scores,
    reasons = excluded.reasons,
    computed_at = excluded.computed_at;
  get diagnostics v_saved = row_count;

  delete from stayput.member_risk r
   using stayput.members m
   where r.company_id = p_company and m.company_id = r.company_id and m.id = r.member_id
     and (m.status <> 'joined' or coalesce(m.access_level, '') = 'admin');
  return v_saved;
end
$$;

-- The companies with scores or weekly analyses due, those that waited longest first. Only
-- companies whose team opened StayPut, never a demo.
create function stayput.companies_to_score(p_now timestamptz, p_limit integer)
returns setof text
language sql stable set search_path = ''
as $$
  select c.id
    from stayput.companies c
    left join stayput.company_sync s on s.company_id = c.id
   where c.status = 'active' and not c.is_demo
     and exists (select 1 from stayput.company_admins a where a.company_id = c.id)
     and (exists (
            select 1 from stayput.members m
              left join stayput.member_risk r on r.company_id = m.company_id
                                             and r.member_id = m.id
             where m.company_id = c.id and m.status = 'joined'
               and coalesce(m.access_level, '') <> 'admin'
               and (r.computed_at is null or r.computed_at <= p_now - interval '50 minutes'))
          or s.analyses_at is null or s.analyses_at <= p_now - interval '7 days')
   order by (select min(r.computed_at) from stayput.member_risk r where r.company_id = c.id)
            nulls first, c.id
   limit p_limit
$$;

-- The weekly analyses are due: never run, or a week ago.
create function stayput.analyses_due(p_company text, p_now timestamptz) returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((select s.analyses_at is null or s.analyses_at <= p_now - interval '7 days'
                     from stayput.company_sync s where s.company_id = p_company), true)
$$;

-- What the weekly analyses judge (packages/core, src/analyses.ts):
-- cohorts: per month of arrival, the members, and per horizon (30, 60, 90 days) those who
-- joined long enough ago and those of them who left within that many days;
-- lessons: per lesson, the members who completed it, and those for whom it is the last lesson
-- completed and who stalled (left, or no activity for 14 days).
-- A departure is dated by the end of the member's last membership, else their last update.
create function stayput.analysis_features(p_company text, p_now timestamptz) returns jsonb
language sql stable set search_path = ''
as $$
  with people as (
    select m.id, m.joined_at, m.cohort_month, m.status,
           case when m.status = 'left' then coalesce(
             (select max(ms.current_period_end) from stayput.memberships ms
               where ms.company_id = m.company_id and ms.member_id = m.id
                 and ms.current_period_end <= p_now),
             m.updated_at) end as left_at,
           greatest(m.last_action_at, (
             select max(e.occurred_at) from stayput.activity_events e
              where e.company_id = m.company_id and e.member_id = m.id
                and e.type = any (stayput.engagement_types()))) as last_activity_at
      from stayput.members m
     where m.company_id = p_company and coalesce(m.access_level, '') <> 'admin'
  ), cohorts as (
    select jsonb_build_object(
             'month', to_char(p.cohort_month, 'YYYY-MM-DD'),
             'members', count(*),
             'eligible', jsonb_build_object(
               '30', count(*) filter (where p.joined_at <= p_now - interval '30 days'),
               '60', count(*) filter (where p.joined_at <= p_now - interval '60 days'),
               '90', count(*) filter (where p.joined_at <= p_now - interval '90 days')),
             'left', jsonb_build_object(
               '30', count(*) filter (where p.joined_at <= p_now - interval '30 days'
                                        and p.left_at <= p.joined_at + interval '30 days'),
               '60', count(*) filter (where p.joined_at <= p_now - interval '60 days'
                                        and p.left_at <= p.joined_at + interval '60 days'),
               '90', count(*) filter (where p.joined_at <= p_now - interval '90 days'
                                        and p.left_at <= p.joined_at + interval '90 days'))
           ) as cohort
      from people p
     where p.cohort_month is not null and p.joined_at is not null
     group by p.cohort_month
  ), completions as (
    select e.member_id, e.metadata ->> 'lesson_id' as lesson_id,
           coalesce(e.metadata ->> 'course_id', '') as course_id,
           e.metadata ->> 'lesson_title' as title, e.occurred_at
      from stayput.activity_events e
     where e.company_id = p_company and e.type = 'lesson_completed'
       and e.metadata ->> 'lesson_id' is not null
  ), last_lesson as (
    select distinct on (member_id) member_id, lesson_id
      from completions order by member_id, occurred_at desc
  ), lessons as (
    select jsonb_build_object(
             'lessonId', c.lesson_id,
             'courseId', max(c.course_id),
             'title', max(c.title),
             'reached', count(distinct c.member_id),
             'stalled', count(distinct c.member_id) filter (
               where l.lesson_id = c.lesson_id
                 and (p.status = 'left'
                      or coalesce(p.last_activity_at, p.joined_at)
                         <= p_now - interval '14 days'))) as lesson
      from completions c
      join people p on p.id = c.member_id
      left join last_lesson l on l.member_id = c.member_id
     group by c.lesson_id
  )
  select jsonb_build_object(
    'cohorts', coalesce((select jsonb_agg(cohort order by cohort ->> 'month') from cohorts),
                        '[]'::jsonb),
    'lessons', coalesce((select jsonb_agg(lesson order by lesson ->> 'lessonId') from lessons),
                        '[]'::jsonb))
$$;

-- What the weekly analyses concluded: cohorts and lessons replace the previous week's.
create function stayput.save_analyses(p_company text, p_cohorts jsonb, p_lessons jsonb,
                                      p_now timestamptz) returns void
language plpgsql set search_path = ''
as $$
begin
  delete from stayput.cohort_stats where company_id = p_company;
  insert into stayput.cohort_stats (company_id, cohort_month, members, left_by_30, left_by_60,
                                    left_by_90, eligible_30, eligible_60, eligible_90, alert,
                                    alert_horizon, computed_at)
  select p_company, (c ->> 'month')::date, (c ->> 'members')::integer,
         (c -> 'left' ->> '30')::integer, (c -> 'left' ->> '60')::integer,
         (c -> 'left' ->> '90')::integer, (c -> 'eligible' ->> '30')::integer,
         (c -> 'eligible' ->> '60')::integer, (c -> 'eligible' ->> '90')::integer,
         c ->> 'alertHorizon' is not null, (c ->> 'alertHorizon')::smallint, p_now
    from jsonb_array_elements(coalesce(p_cohorts, '[]'::jsonb)) c;

  delete from stayput.lesson_dropoff_stats where company_id = p_company;
  insert into stayput.lesson_dropoff_stats (company_id, lesson_id, course_id, lesson_title,
                                            members_concerned, stalled, dropoff_rate,
                                            course_average_rate, flagged, computed_at)
  select p_company, l ->> 'lessonId', l ->> 'courseId', l ->> 'title',
         (l ->> 'reached')::integer, (l ->> 'stalled')::integer,
         round(least(1, greatest(0, (l ->> 'rate')::numeric)), 4),
         round(least(1, greatest(0, (l ->> 'courseAverage')::numeric)), 4),
         coalesce((l ->> 'flagged')::boolean, false), p_now
    from jsonb_array_elements(coalesce(p_lessons, '[]'::jsonb)) l;

  insert into stayput.company_sync (company_id, analyses_at) values (p_company, p_now)
  on conflict (company_id) do update set analyses_at = excluded.analyses_at;
end
$$;

-- The creator's detection settings: the niche, the five weights (the Worker brings them to a
-- sum of 1), the recency threshold and the two level thresholds. Every score of the company is
-- then due again, so that the dashboard shows the new settings at the next computation.
create function stayput.save_risk_settings(p_company text, p_niche text, p_weights jsonb,
                                           p_recency_days integer, p_medium_from integer,
                                           p_high_from integer, p_now timestamptz) returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.companies set niche = p_niche where id = p_company;
  if not found then
    raise exception 'unknown company %', p_company;
  end if;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set
    weight_recency = (p_weights ->> 'recency')::numeric,
    weight_frequency = (p_weights ->> 'frequency')::numeric,
    weight_progress = (p_weights ->> 'progress')::numeric,
    weight_payment = (p_weights ->> 'payment')::numeric,
    weight_friction = (p_weights ->> 'friction')::numeric,
    recency_threshold_days = p_recency_days,
    medium_risk_from = p_medium_from,
    high_risk_from = p_high_from
  where company_id = p_company;
  update stayput.member_risk set computed_at = least(computed_at, p_now - interval '1 hour')
   where company_id = p_company;
end
$$;

-- The daily history is kept 400 days (a year compared with the one before).
create function stayput.purge_risk_history(p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from stayput.risk_scores where computed_at < p_now - interval '400 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- When the weekly analyses last ran, for the team only (company_sync is the Worker's own table):
-- the dashboard tells « analyzed 2 days ago » even when there was nothing to report.
create function stayput.analyses_at(p_company text) returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select s.analyses_at from stayput.company_sync s
   where s.company_id = p_company and stayput.is_company_admin(p_company)
$$;

revoke execute on all functions in schema stayput from public;
grant execute on function stayput.unlinked_authors(text) to stayput_user;
grant execute on function stayput.analyses_at(text) to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0008_risk_detection.sql');
end $install$;

-- ==========================================================================================
-- 0009_actions.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0009_actions.sql') then
    raise notice 'already applied: 0009_actions.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 4: the actions. The triggers read the state StayPut keeps (a payment waiting for its
-- 3D Secure check, a failed payment, a scheduled cancellation, a score turned high, a new member
-- who has not started) rather than single events, and only recent state: installing StayPut
-- never acts on last month. Each action is planned once (its dedupe key); the Worker approves
-- it (automatic mode) or the creator does (manual mode), it goes through the guardrails
-- (packages/core, actions.ts), is scheduled, then run by the hourly cron, its result kept.

-- 1. The actions, for that cycle.
alter table stayput.actions drop constraint actions_status_check;
alter table stayput.actions add constraint actions_status_check check (status in (
  'proposed', 'approved', 'scheduled', 'sent', 'simulated', 'failed', 'cancelled',
  'blocked_by_guardrail'));
alter table stayput.actions
  -- The trigger's occurrence, so that it is planned once: `payment_retry:pay_…:1`.
  add column dedupe_key text,
  -- What the action is about: the payment or the membership.
  add column subject_id text,
  -- relance, service or none (MESSAGE_KINDS in packages/core): what the message caps count.
  add column message_kind text not null default 'none'
    check (message_kind in ('relance', 'service', 'none')),
  add column approved_at timestamptz,
  -- The creator who approved it, or 'auto' in automatic mode.
  add column approved_by text check (approved_by = 'auto' or approved_by ~ '^user_[A-Za-z0-9]+$'),
  -- Sending attempts: a Whop outage is tried again, a few times.
  add column attempts smallint not null default 0;
create unique index actions_dedupe on stayput.actions (company_id, dedupe_key)
  where dedupe_key is not null;
create index actions_company_status on stayput.actions (company_id, status, created_at desc);

-- 2. The stop for the whole app (SPEC Phase 4): one row, server side only.
create table stayput.app_settings (
  id boolean primary key default true check (id),
  kill_switch boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into stayput.app_settings default values;
alter table stayput.app_settings enable row level security;

-- 3. StayPut's experience in the company: Whop notifications go through it (only the users who
-- can open it receive them). Learned when a member opens StayPut.
alter table stayput.companies
  add column experience_id text check (experience_id ~ '^exp_[A-Za-z0-9]+$');

-- 4. The triggers. Team members and members who left are never targeted; the « never contact »
-- list is the guardrails' (the action is kept, blocked, with the reason).
create function stayput.plan_actions(p_company text, p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_planned integer := 0;
  v_count integer;
begin
  if not exists (select 1 from stayput.companies
                  where id = p_company and status = 'active' and not is_demo) then
    return 0;
  end if;

  -- A payment waiting for its 3D Secure check (as risk_features reads it): the member gets the
  -- way to confirm it.
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select p.company_id, p.member_id, 'payment_action_notice', 'payment_requires_action', p.id,
         'service', 'payment_action_notice:' || p.id, p_now,
         jsonb_build_object('payment_id', p.id)
    from stayput.payments p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   where p.company_id = p_company and p.recovery_url is not null
     and p.status = any (array['open', 'pending', 'incomplete', 'requires_action',
                               'requires_capture'])
     and p.whop_created_at > p_now - interval '3 days'
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- A failed payment: the member is asked to update their payment method…
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select p.company_id, p.member_id, 'payment_failed_notice', 'payment_failed', p.id, 'service',
         'payment_failed_notice:' || p.id, p_now, jsonb_build_object('payment_id', p.id)
    from stayput.payments p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   where p.company_id = p_company
     and p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
     and p.whop_created_at > p_now - interval '3 days'
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- …and Whop is asked to charge it again 24 h, then 72 h after it failed, only when Whop can
  -- retry it and plans no retry of its own (decision of 30/09/2026). The second once the first
  -- was made.
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select p.company_id, p.member_id, 'payment_retry', 'payment_failed', p.id, 'none',
         'payment_retry:' || p.id || ':' || attempt.n,
         p.whop_created_at + make_interval(hours => attempt.hours),
         jsonb_build_object('payment_id', p.id, 'attempt', attempt.n)
    from stayput.payments p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   cross join (values (1, 24), (2, 72)) as attempt (n, hours)
   where p.company_id = p_company
     and p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
     and p.retryable and p.next_payment_attempt_at is null
     and p.whop_created_at > p_now - make_interval(hours => attempt.hours + 24)
     and (attempt.n = 1 or exists (
           select 1 from stayput.actions a
            where a.company_id = p.company_id
              and a.dedupe_key = 'payment_retry:' || p.id || ':1'
              and a.status in ('sent', 'simulated')))
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- A cancellation at period end: the one-click departure survey, once per period.
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select ms.company_id, ms.member_id, 'exit_survey', 'cancel_at_period_end', ms.id, 'service',
         'exit_survey:' || ms.id || ':' || to_char(ms.current_period_end, 'YYYY-MM-DD'), p_now,
         jsonb_build_object('membership_id', ms.id, 'period_end', ms.current_period_end)
    from stayput.memberships ms
    join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
   where ms.company_id = p_company
     and (ms.cancel_at_period_end or ms.status = 'canceling')
     and ms.status = any (array['trialing', 'active', 'past_due', 'canceling'])
     and ms.current_period_end > p_now
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- A score that turned high in the last two days: a personal message at the golden hour (the
  -- Worker sets the time).
  insert into stayput.actions (company_id, member_id, type, trigger, message_kind, dedupe_key,
                               content)
  select r.company_id, r.member_id, 'high_risk_message', 'score_high', 'relance',
         'high_risk_message:' || r.member_id || ':' || to_char(r.level_since, 'YYYY-MM-DD'),
         jsonb_build_object('score', r.score)
    from stayput.member_risk r
    join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
   where r.company_id = p_company and r.level = 'high'
     and r.previous_level is distinct from 'high'
     and r.level_since > p_now - interval '2 days'
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- The activation radar: welcome once a new member who has not started.
  insert into stayput.actions (company_id, member_id, type, trigger, message_kind, dedupe_key,
                               send_at)
  select r.company_id, r.member_id, 'welcome_message', 'activation_radar', 'relance',
         'welcome_message:' || r.member_id, p_now
    from stayput.member_risk r
    join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
   where r.company_id = p_company and r.inactive_newcomer
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_planned + v_count;
end
$$;

-- 5. What the Worker needs to pass a company's actions through the guardrails: the settings,
-- and for each action ready to be scheduled (proposed in automatic mode, approved otherwise)
-- the member's history and, for a follow-up, their activity by hour over 30 days (the golden
-- hour), in the company's time zone.
create function stayput.actions_to_schedule(p_company text, p_now timestamptz, p_limit integer)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'mode', c.mode,
    'timezone', c.timezone,
    'globalKillSwitch', (select a.kill_switch from stayput.app_settings a),
    'settings', jsonb_build_object(
      'maxMessagesPer5Days', s.max_messages_per_5_days,
      'maxMessagesPerMonth', s.max_messages_per_month,
      'maxPaymentRetries', s.max_payment_retries,
      'monthlyPromoCap', s.monthly_promo_cap,
      'maxFreeDaysPerQuarter', s.max_free_days_per_quarter,
      'quietHoursStart', s.quiet_hours_start,
      'quietHoursEnd', s.quiet_hours_end,
      'defaultSendHour', s.default_send_hour,
      'dryRun', s.dry_run,
      'killSwitch', s.kill_switch),
    'promosLast30', (
      select count(*) from stayput.actions a
       where a.company_id = c.id and a.type = 'promo_offer' and a.status = 'sent'
         and a.sent_at > p_now - interval '30 days'),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id,
               'type', a.type,
               'memberId', a.member_id,
               'sendAt', a.send_at,
               'freeDays', (a.content ->> 'days')::integer,
               'doNotContact', m.do_not_contact,
               'messages', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'at', coalesce(o.sent_at, o.send_at), 'kind', o.message_kind))
                   from stayput.actions o
                  where o.company_id = a.company_id and o.member_id = a.member_id
                    and o.id <> a.id and o.message_kind <> 'none'
                    and o.status in ('scheduled', 'sent', 'simulated')
                    and coalesce(o.sent_at, o.send_at)
                        between p_now - interval '35 days' and p_now + interval '35 days'),
                 '[]'),
               'paymentRetries', (
                 select count(*) from stayput.actions o
                  where o.company_id = a.company_id and o.type = 'payment_retry'
                    and o.subject_id = a.subject_id and o.id <> a.id
                    and o.status in ('scheduled', 'sent', 'simulated')),
               'activePromo', exists (
                 select 1 from stayput.actions o
                  where o.company_id = a.company_id and o.member_id = a.member_id
                    and o.type = 'promo_offer' and o.status = 'sent'
                    and (o.result ->> 'expires_at')::timestamptz > p_now),
               'freeDaysLast90', (
                 select coalesce(sum((o.content ->> 'days')::integer), 0)
                   from stayput.actions o
                  where o.company_id = a.company_id and o.member_id = a.member_id
                    and o.type = 'extend_offer' and o.status = 'sent'
                    and o.sent_at > p_now - interval '90 days'),
               'hours', case when a.message_kind = 'relance' and a.send_at is null then (
                 select jsonb_agg(coalesce(h.n, 0) order by g.hour)
                   from generate_series(0, 23) as g (hour)
                   left join (
                     select extract(hour from e.occurred_at at time zone c.timezone)::integer
                              as hour, count(*) as n
                       from stayput.activity_events e
                      where e.company_id = a.company_id and e.member_id = a.member_id
                        and e.occurred_at > p_now - interval '30 days'
                      group by 1) h on h.hour = g.hour)
               end)
             order by a.created_at)
        from (select * from stayput.actions a
               where a.company_id = c.id
                 and (a.status = 'approved' or (a.status = 'proposed' and c.mode = 'auto'))
               order by a.created_at
               limit p_limit) a
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id),
      '[]'))
    from stayput.companies c
    join stayput.company_settings s on s.company_id = c.id
   where c.id = p_company;
$$;

-- What the guardrails decided: scheduled (at a time), blocked (with the reason), each action
-- only from the state it was read in. Returns how many changed.
create function stayput.apply_schedule(p_company text, p_decisions jsonb, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  update stayput.actions a
     set status = d.status,
         send_at = coalesce(d.send_at, a.send_at),
         blocked_reason = d.reason,
         approved_at = coalesce(a.approved_at, p_now),
         approved_by = coalesce(a.approved_by, 'auto')
    from jsonb_to_recordset(p_decisions) as d (id uuid, status text, send_at timestamptz,
                                               reason text)
   where a.company_id = p_company and a.id = d.id
     and a.status in ('proposed', 'approved')
     and d.status in ('scheduled', 'blocked_by_guardrail')
     and (d.status = 'scheduled') = (d.reason is null);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- 6. The actions whose time has come, across companies, with all their run needs: the stops,
-- the member, the payment, the words of the message (template values) and the company's
-- language, templates and experience. Oldest first.
create function stayput.due_actions(p_now timestamptz, p_limit integer) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(x.action order by x.send_at), '[]')
    from (
      select a.send_at, jsonb_build_object(
               'id', a.id,
               'companyId', a.company_id,
               'type', a.type,
               'attempts', a.attempts,
               'content', a.content,
               'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
               'killSwitch', s.kill_switch,
               'dryRun', s.dry_run,
               'locale', c.locale,
               'experienceId', c.experience_id,
               'templates', s.active_templates,
               'member', jsonb_build_object(
                 'userId', m.user_id,
                 'doNotContact', m.do_not_contact,
                 'joined', m.status = 'joined'),
               'payment', (
                 select jsonb_build_object(
                          'id', p.id, 'status', p.status, 'retryable', p.retryable,
                          'nextAttemptAt', p.next_payment_attempt_at,
                          'recoveryUrl', p.recovery_url)
                   from stayput.payments p
                  where p.company_id = a.company_id and p.id = a.subject_id),
               'membership', (
                 select jsonb_build_object(
                          'id', ms.id,
                          'canceling', (ms.cancel_at_period_end or ms.status = 'canceling')
                                       and ms.current_period_end > p_now)
                   from stayput.memberships ms
                  where ms.company_id = a.company_id and ms.id = a.subject_id),
               'values', jsonb_build_object(
                 'first_name', nullif(split_part(coalesce(m.display_name, ''), ' ', 1), ''),
                 'creator_name', c.name,
                 'days_inactive', (
                   select floor(extract(epoch from p_now - coalesce(max(e.occurred_at),
                                                                     m.joined_at)) / 86400)::integer
                     from stayput.activity_events e
                    where e.company_id = a.company_id and e.member_id = a.member_id),
                 'last_lesson', (
                   select e.metadata ->> 'lesson_title'
                     from stayput.activity_events e
                    where e.company_id = a.company_id and e.member_id = a.member_id
                      and e.type = 'lesson_completed'
                    order by e.occurred_at desc limit 1))) as action
        from stayput.actions a
        join stayput.companies c on c.id = a.company_id
        join stayput.company_settings s on s.company_id = a.company_id
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
       where a.status = 'scheduled' and a.send_at <= p_now
         and c.status = 'active' and not c.is_demo
       order by a.send_at
       limit p_limit) x;
$$;

-- An action ran (sent, simulated in test mode), failed for good, was cancelled or blocked at the
-- last moment, or is tried again later (`p_retry_at`, still scheduled). The error, if any, is
-- added to its log.
create function stayput.finish_action(p_id uuid, p_status text, p_result jsonb, p_error text,
                                      p_reason text, p_retry_at timestamptz, p_now timestamptz)
returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.actions
     set status = case when p_retry_at is not null then 'scheduled' else p_status end,
         send_at = coalesce(p_retry_at, send_at),
         sent_at = case when p_status in ('sent', 'simulated') then p_now else sent_at end,
         result = coalesce(p_result, result),
         blocked_reason = case when p_status = 'blocked_by_guardrail' then p_reason end,
         attempts = attempts + 1,
         error_log = case when p_error is null then error_log
                          else error_log || jsonb_build_array(
                                 jsonb_build_object('at', p_now, 'error', left(p_error, 500)))
                     end
   where id = p_id and status = 'scheduled';
end
$$;

-- The experience a member opened StayPut from: where notifications to the company's members go.
create function stayput.remember_experience(p_company text, p_experience text) returns void
language sql set search_path = ''
as $$
  update stayput.companies set experience_id = p_experience
   where id = p_company and experience_id is distinct from p_experience
     and p_experience ~ '^exp_[A-Za-z0-9]+$';
$$;

revoke all on function stayput.plan_actions(text, timestamptz) from public;
revoke all on function stayput.actions_to_schedule(text, timestamptz, integer) from public;
revoke all on function stayput.apply_schedule(text, jsonb, timestamptz) from public;
revoke all on function stayput.due_actions(timestamptz, integer) from public;
revoke all on function stayput.finish_action(uuid, text, jsonb, text, text, timestamptz,
                                             timestamptz) from public;
revoke all on function stayput.remember_experience(text, text) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0009_actions.sql');
end $install$;

-- ==========================================================================================
-- 0010_action_controls.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0010_action_controls.sql') then
    raise notice 'already applied: 0010_action_controls.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 4, the creator's hand on the actions: approve them in manual mode (one, or all),
-- cancel one, set the mode, the test mode, the stop, the guardrails and the messages, and keep a
-- member on the « never contact » list. The Worker calls these after checking with Whop that
-- the user administers the company; the creator reads the actions under RLS.

-- The words a message about a member uses (the template variables of packages/core): read for a
-- run, and for the previews the creator approves.
create function stayput.message_values(p_company text, p_member text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'first_name', nullif(split_part(coalesce(m.display_name, ''), ' ', 1), ''),
    'creator_name', c.name,
    'days_inactive', (
      select floor(extract(epoch from p_now - coalesce(max(e.occurred_at), m.joined_at))
                   / 86400)::integer
        from stayput.activity_events e
       where e.company_id = m.company_id and e.member_id = m.id),
    'last_lesson', (
      select e.metadata ->> 'lesson_title'
        from stayput.activity_events e
       where e.company_id = m.company_id and e.member_id = m.id and e.type = 'lesson_completed'
       order by e.occurred_at desc limit 1))
    from stayput.members m
    join stayput.companies c on c.id = m.company_id
   where m.company_id = p_company and m.id = p_member;
$$;

-- The run's needs, as in 0009, with the words read by message_values.
create or replace function stayput.due_actions(p_now timestamptz, p_limit integer) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(x.action order by x.send_at), '[]')
    from (
      select a.send_at, jsonb_build_object(
               'id', a.id,
               'companyId', a.company_id,
               'type', a.type,
               'attempts', a.attempts,
               'content', a.content,
               'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
               'killSwitch', s.kill_switch,
               'dryRun', s.dry_run,
               'locale', c.locale,
               'experienceId', c.experience_id,
               'templates', s.active_templates,
               'member', jsonb_build_object(
                 'userId', m.user_id,
                 'doNotContact', m.do_not_contact,
                 'joined', m.status = 'joined'),
               'payment', (
                 select jsonb_build_object(
                          'id', p.id, 'status', p.status, 'retryable', p.retryable,
                          'nextAttemptAt', p.next_payment_attempt_at,
                          'recoveryUrl', p.recovery_url)
                   from stayput.payments p
                  where p.company_id = a.company_id and p.id = a.subject_id),
               'membership', (
                 select jsonb_build_object(
                          'id', ms.id,
                          'canceling', (ms.cancel_at_period_end or ms.status = 'canceling')
                                       and ms.current_period_end > p_now)
                   from stayput.memberships ms
                  where ms.company_id = a.company_id and ms.id = a.subject_id),
               'values', stayput.message_values(a.company_id, a.member_id, p_now)) as action
        from stayput.actions a
        join stayput.companies c on c.id = a.company_id
        join stayput.company_settings s on s.company_id = a.company_id
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
       where a.status = 'scheduled' and a.send_at <= p_now
         and c.status = 'active' and not c.is_demo
       order by a.send_at
       limit p_limit) x;
$$;

-- Manual mode: the creator approves proposed actions (the ones named, or all of them). The next
-- pass through the guardrails schedules them. Returns how many were approved.
create function stayput.approve_actions(p_company text, p_ids text, p_user text,
                                        p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  update stayput.actions
     set status = 'approved', approved_at = p_now, approved_by = p_user
   where company_id = p_company and status = 'proposed'
     and (p_ids is null or id::text = any (string_to_array(p_ids, ',')));
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- The creator cancels an action that has not run yet. False when it already ran or is not the
-- company's.
create function stayput.cancel_action(p_company text, p_id uuid, p_user text, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.actions
     set status = 'cancelled',
         result = jsonb_build_object('reason', 'cancelled_by_creator', 'by', p_user,
                                     'at', p_now)
   where company_id = p_company and id = p_id
     and status in ('proposed', 'approved', 'scheduled');
  return found;
end
$$;

-- The action settings: the mode, the language of the messages, the test mode, the stop, the
-- guardrails (within the SPEC's limits, which the table checks) and the creator's templates.
create function stayput.save_action_settings(p_company text, p_settings jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.companies
     set mode = p_settings ->> 'mode', locale = p_settings ->> 'locale'
   where id = p_company;
  if not found then
    raise exception 'unknown company %', p_company;
  end if;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set
    dry_run = (p_settings ->> 'dryRun')::boolean,
    kill_switch = (p_settings ->> 'killSwitch')::boolean,
    quiet_hours_start = (p_settings ->> 'quietHoursStart')::smallint,
    quiet_hours_end = (p_settings ->> 'quietHoursEnd')::smallint,
    default_send_hour = (p_settings ->> 'defaultSendHour')::smallint,
    max_messages_per_5_days = (p_settings ->> 'maxMessagesPer5Days')::smallint,
    max_messages_per_month = (p_settings ->> 'maxMessagesPerMonth')::smallint,
    max_payment_retries = (p_settings ->> 'maxPaymentRetries')::smallint,
    monthly_promo_cap = (p_settings ->> 'monthlyPromoCap')::smallint,
    max_free_days_per_quarter = (p_settings ->> 'maxFreeDaysPerQuarter')::smallint,
    active_templates = coalesce(p_settings -> 'templates', '{}')
  where company_id = p_company;
end
$$;

-- The « never contact » list, member by member. False when the member is not the company's.
create function stayput.set_do_not_contact(p_company text, p_member text, p_value boolean)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.members set do_not_contact = p_value
   where company_id = p_company and id = p_member;
  return found;
end
$$;

revoke all on function stayput.message_values(text, text, timestamptz) from public;
revoke all on function stayput.approve_actions(text, text, text, timestamptz) from public;
revoke all on function stayput.cancel_action(text, uuid, text, timestamptz) from public;
revoke all on function stayput.save_action_settings(text, jsonb) from public;
revoke all on function stayput.set_do_not_contact(text, text, boolean) from public;
-- The previews of the actions list are read as the creator (under RLS).
grant execute on function stayput.message_values(text, text, timestamptz) to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0010_action_controls.sql');
end $install$;

-- ==========================================================================================
-- 0011_company_timezone.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0011_company_timezone.sql') then
    raise notice 'already applied: 0011_company_timezone.sql';
    return;
  end if;
  execute $migration$
-- SPEC 5.2 and Phase 4: the quiet hours, the golden hour and the default hour are the creator's
-- local hours. companies.timezone has said 'UTC' since 0001, a default nobody chose: the
-- creator's browser now tells the zone on their first visit, and the creator changes it in the
-- action settings. Because the zone or the hours may change after an action was scheduled, the
-- run checks the quiet hours again when an action's time comes.

-- When the company's zone was set (by the creator's browser or by the creator); null while it
-- is still StayPut's default.
alter table stayput.companies add column timezone_set_at timestamptz;

-- The company's time zone. With p_only_if_unset (the zone a creator's browser reports), only
-- while the company has none of its own yet. Returns the zone in effect afterwards, or null when
-- Postgres does not know p_timezone (nothing changes then).
create function stayput.set_company_timezone(p_company text, p_timezone text,
                                             p_only_if_unset boolean, p_now timestamptz)
returns text
language plpgsql set search_path = ''
as $$
declare
  v_previous text;
  v_unset boolean;
begin
  select c.timezone, c.timezone_set_at is null into v_previous, v_unset
    from stayput.companies c
   where c.id = p_company
     for update;
  if not found then
    raise exception 'unknown company %', p_company;
  end if;
  if p_only_if_unset and not v_unset then
    return v_previous;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    return null;
  end if;
  update stayput.companies set timezone = p_timezone, timezone_set_at = p_now
   where id = p_company;
  -- The days and hours of activity are local ones: counted again in the new zone.
  if p_timezone is distinct from v_previous then
    perform stayput.mark_stats_dirty(p_company, p_now - interval '90 days');
  end if;
  return p_timezone;
end
$$;

-- The run's needs, as in 0010, with the zone and the quiet hours they are checked against.
create or replace function stayput.due_actions(p_now timestamptz, p_limit integer) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(x.action order by x.send_at), '[]')
    from (
      select a.send_at, jsonb_build_object(
               'id', a.id,
               'companyId', a.company_id,
               'type', a.type,
               'attempts', a.attempts,
               'content', a.content,
               'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
               'killSwitch', s.kill_switch,
               'dryRun', s.dry_run,
               'locale', c.locale,
               'timezone', c.timezone,
               'quietHoursStart', s.quiet_hours_start,
               'quietHoursEnd', s.quiet_hours_end,
               'experienceId', c.experience_id,
               'templates', s.active_templates,
               'member', jsonb_build_object(
                 'userId', m.user_id,
                 'doNotContact', m.do_not_contact,
                 'joined', m.status = 'joined'),
               'payment', (
                 select jsonb_build_object(
                          'id', p.id, 'status', p.status, 'retryable', p.retryable,
                          'nextAttemptAt', p.next_payment_attempt_at,
                          'recoveryUrl', p.recovery_url)
                   from stayput.payments p
                  where p.company_id = a.company_id and p.id = a.subject_id),
               'membership', (
                 select jsonb_build_object(
                          'id', ms.id,
                          'canceling', (ms.cancel_at_period_end or ms.status = 'canceling')
                                       and ms.current_period_end > p_now)
                   from stayput.memberships ms
                  where ms.company_id = a.company_id and ms.id = a.subject_id),
               'values', stayput.message_values(a.company_id, a.member_id, p_now)) as action
        from stayput.actions a
        join stayput.companies c on c.id = a.company_id
        join stayput.company_settings s on s.company_id = a.company_id
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
       where a.status = 'scheduled' and a.send_at <= p_now
         and c.status = 'active' and not c.is_demo
       order by a.send_at
       limit p_limit) x;
$$;

-- A message whose time came during the quiet hours waits for their end. Not an attempt: nothing
-- was tried. False when the action no longer waits.
create function stayput.postpone_action(p_id uuid, p_send_at timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.actions set send_at = p_send_at
   where id = p_id and status = 'scheduled' and send_at < p_send_at;
  return found;
end
$$;

revoke all on function stayput.set_company_timezone(text, text, boolean, timestamptz) from public;
revoke all on function stayput.postpone_action(uuid, timestamptz) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0011_company_timezone.sql');
end $install$;

-- ==========================================================================================
-- 0012_platform_accounts.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0012_platform_accounts.sql') then
    raise notice 'already applied: 0012_platform_accounts.sql';
    return;
  end if;
  execute $migration$
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
$migration$;
  insert into stayput.schema_migrations (name) values ('0012_platform_accounts.sql');
end $install$;

-- ==========================================================================================
-- 0013_team_accounts.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0013_team_accounts.sql') then
    raise notice 'already applied: 0013_team_accounts.sql';
    return;
  end if;
  execute $migration$
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
$migration$;
  insert into stayput.schema_migrations (name) values ('0013_team_accounts.sql');
end $install$;

-- ==========================================================================================
-- 0014_platform_activity.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0014_platform_activity.sql') then
    raise notice 'already applied: 0014_platform_activity.sql';
    return;
  end if;
  execute $migration$
-- What StayPut sees on Discord and Telegram (the founder, 2026-10-01: « comment avoir un suivi de
-- Discord et Telegram sur StayPut si rien n'est affiché ? »). Over the last 30 days, in the
-- creator's time zone: the messages per platform and per day, who wrote them (members, the team,
-- guests, accounts not tied yet), the most active members, and each server and group. For the
-- company's team only; counts and names, never what was written.
create function stayput.platform_activity(p_company text, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), days as (
    select ((p_now at time zone z.tz)::date - g)::date as day
      from zone z, generate_series(0, 29) g
  ), messages as (
    select case e.type when 'discord_message' then 'discord' else 'telegram' end as platform,
           e.member_id, null::text as account_id, e.occurred_at, e.metadata
      from stayput.activity_events e
     where e.company_id = p_company and e.type in ('discord_message', 'telegram_message')
       and e.occurred_at > p_now - interval '31 days'
    union all
    select split_part(p.user_id, ':', 1), null, split_part(p.user_id, ':', 2), p.occurred_at,
           p.metadata
      from stayput.pending_activity p
     where p.company_id = p_company and p.user_id ~ '^(discord|telegram):'
       and p.occurred_at > p_now - interval '31 days'
  ), authored as (
    select m.platform, m.occurred_at, m.metadata,
           m.member_id,
           coalesce(m.member_id, m.platform || ':' || m.account_id) as author,
           case when mem.access_level = 'admin' then 'team'
                when m.member_id is not null then 'member'
                when pa.dismissed_as = 'team' then 'team'
                when pa.dismissed_as = 'guest' then 'guest'
                else 'unlinked' end as kind,
           (m.occurred_at at time zone (select tz from zone))::date as day
      from messages m
      left join stayput.members mem on mem.company_id = p_company and mem.id = m.member_id
      left join stayput.platform_accounts pa
        on pa.company_id = p_company and pa.platform = m.platform and pa.account_id = m.account_id
  ), recent as (
    select * from authored where day >= (select min(day) from days)
  ), places as (
    select r.platform,
           case r.platform
             when 'telegram' then r.metadata ->> 'chat_id'
             else coalesce((select g.guild_id from stayput.discord_guilds g
                             where g.company_id = p_company
                               and r.metadata ->> 'channel_id' = any (g.channel_ids)
                             limit 1), '')
           end as place,
           r.occurred_at
      from recent r
  ), top_members as (
    select r.member_id, count(*) filter (where r.platform = 'discord') as discord,
           count(*) filter (where r.platform = 'telegram') as telegram,
           count(*) as total, max(r.occurred_at) as last_at
      from recent r
     where r.kind = 'member'
     group by r.member_id
     order by count(*) desc, max(r.occurred_at) desc
     limit 5
  )
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'from', (select min(day) from days),
    'to', (select max(day) from days),
    'platforms', (
      select jsonb_agg(jsonb_build_object(
               'platform', p.platform,
               'messages', (select count(*) from recent r where r.platform = p.platform),
               'authors', (select count(distinct r.author) from recent r
                            where r.platform = p.platform),
               'members', (select count(distinct r.author) from recent r
                            where r.platform = p.platform and r.kind = 'member'),
               'team', (select count(distinct r.author) from recent r
                         where r.platform = p.platform and r.kind = 'team'),
               'guests', (select count(distinct r.author) from recent r
                           where r.platform = p.platform and r.kind = 'guest'),
               'unlinked', (select count(distinct r.author) from recent r
                             where r.platform = p.platform and r.kind = 'unlinked'),
               'lastAt', (select max(r.occurred_at) from recent r where r.platform = p.platform),
               'daily', (select jsonb_agg(coalesce(n.messages, 0) order by d.day)
                           from days d
                           left join (select r.day, count(*) as messages from recent r
                                       where r.platform = p.platform group by r.day) n
                             on n.day = d.day))
             order by p.platform)
        from (values ('discord'), ('telegram')) p (platform)),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', x.platform, 'id', nullif(x.place, ''),
               'name', case x.platform
                         when 'telegram' then (select t.title from stayput.telegram_chats t
                                                where t.chat_id = x.place
                                                  and t.company_id = p_company)
                         else (select g.name from stayput.discord_guilds g
                                where g.guild_id = x.place and g.company_id = p_company)
                       end,
               'messages', x.messages, 'lastAt', x.last_at)
             order by x.messages desc, x.last_at desc)
        from (select pl.platform, pl.place, count(*) as messages,
                     max(pl.occurred_at) as last_at
                from places pl group by pl.platform, pl.place
                order by count(*) desc limit 10) x), '[]'),
    'topMembers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.member_id, 'name', mem.display_name, 'discord', t.discord,
               'telegram', t.telegram, 'lastAt', t.last_at)
             order by t.total desc, t.last_at desc)
        from top_members t
        join stayput.members mem on mem.company_id = p_company and mem.id = t.member_id), '[]'))
  end
$$;

revoke all on function stayput.platform_activity(text, timestamptz) from public;
grant execute on function stayput.platform_activity(text, timestamptz) to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0014_platform_activity.sql');
end $install$;

-- ==========================================================================================
-- 0015_live_discord.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0015_live_discord.sql') then
    raise notice 'already applied: 0015_live_discord.sql';
    return;
  end if;
  execute $migration$
-- The creator watches what StayPut sees on Discord and Telegram, without reloading the page (the
-- founder, 2026-10-01). Telegram sends each message as it comes; Discord sends nothing, so while
-- the page is open StayPut reads the company's Discord channels again, at most once a minute.
-- That read holds the same lease as a synchronization (two runs never read a channel at once),
-- but leaves last_synced_at alone: Whop's lists keep their own cadence.

-- The company's lease, taken when free. False when another run holds it, or for a company that
-- is not active (or the demo).
create function stayput.claim_lease(p_company text, p_now timestamptz, p_lease_seconds integer)
returns boolean
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
     and (lease_until is null or lease_until <= p_now);
  return found;
end
$$;

-- The lease given back, the last synchronization left as it was.
create function stayput.release_lease(p_company text) returns void
language sql set search_path = ''
as $$
  update stayput.company_sync set lease_until = null where company_id = p_company;
$$;

revoke all on function stayput.claim_lease(text, timestamptz, integer) from public;
revoke all on function stayput.release_lease(text) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0015_live_discord.sql');
end $install$;

-- ==========================================================================================
-- 0016_exit_offers.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0016_exit_offers.sql') then
    raise notice 'already applied: 0016_exit_offers.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 4, the member's side. A member who scheduled their cancellation answers the
-- departure survey in StayPut's member view, in one click, and gets the offer that answers their
-- reason (packages/core, offers.ts); a member whose payment needs them gets the link to settle it.
-- The creator sets the offers; what a member accepts becomes an action, through the guardrails
-- and the creator's mode like every other, and their membership is kept only with their consent.

-- 1. The creator's offers.
alter table stayput.company_settings
  add column pause_days smallint not null default 30 check (pause_days between 7 and 90),
  add column promo_percent smallint not null default 20 check (promo_percent between 5 and 50),
  add column promo_months smallint not null default 3 check (promo_months between 1 and 12),
  add column extend_days smallint not null default 7 check (extend_days between 1 and 14),
  -- Their own words to a member without results; StayPut's when null.
  add column coaching_message text check (char_length(coaching_message) <= 400);

-- 2. The offer as the member saw it, and their consent to keep their membership.
alter table stayput.exit_surveys
  add column offer jsonb check (offer is null or jsonb_typeof(offer) = 'object'),
  add column keep_membership boolean;
create index exit_surveys_membership
  on stayput.exit_surveys (company_id, membership_id, created_at desc);

-- What the member view shows a member of a company (a Whop user): the cancellation they
-- scheduled and its survey, a payment that needs them, and what the offers and their guardrails
-- need. Server side: the Worker checked with Whop that the user may open the experience.
create function stayput.member_retention(p_company text, p_user text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  with m as (
    select * from stayput.members where company_id = p_company and user_id = p_user
  ), departing as (
    select ms.* from stayput.memberships ms, m
     where ms.company_id = p_company and ms.member_id = m.id
       and (ms.cancel_at_period_end or ms.status = 'canceling')
       and ms.current_period_end > p_now
       and ms.status not in ('canceled', 'expired', 'completed')
     order by ms.current_period_end desc
     limit 1
  ), survey as (
    select s.* from stayput.exit_surveys s, departing d
     where s.company_id = p_company and s.membership_id = d.id
       and s.created_at >= coalesce(d.canceled_at, p_now - interval '60 days')
     order by s.created_at desc
     limit 1
  ), pay as (
    select p.* from stayput.payments p, m
     where p.company_id = p_company and p.member_id = m.id
       and p.whop_created_at > p_now - interval '30 days'
     order by p.whop_created_at desc
     limit 1
  )
  select jsonb_build_object(
    'member', (select jsonb_build_object('id', m.id, 'doNotContact', m.do_not_contact,
                                         'joined', m.status = 'joined') from m),
    'company', (
      select jsonb_build_object(
               'name', c.name, 'mode', c.mode, 'timezone', c.timezone,
               'dryRun', s.dry_run, 'killSwitch', s.kill_switch,
               'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
               'offers', jsonb_build_object(
                 'pauseDays', s.pause_days, 'promoPercent', s.promo_percent,
                 'promoMonths', s.promo_months, 'extendDays', s.extend_days,
                 'coachingMessage', s.coaching_message),
               'guardrails', jsonb_build_object(
                 'maxMessagesPer5Days', s.max_messages_per_5_days,
                 'maxMessagesPerMonth', s.max_messages_per_month,
                 'maxPaymentRetries', s.max_payment_retries,
                 'monthlyPromoCap', s.monthly_promo_cap,
                 'maxFreeDaysPerQuarter', s.max_free_days_per_quarter,
                 'quietHoursStart', s.quiet_hours_start,
                 'quietHoursEnd', s.quiet_hours_end),
               'promosLast30', (
                 select count(*) from stayput.actions a
                  where a.company_id = c.id and a.type = 'promo_offer' and a.status = 'sent'
                    and a.sent_at > p_now - interval '30 days'))
        from stayput.companies c
        join stayput.company_settings s on s.company_id = c.id
       where c.id = p_company),
    'history', (
      select jsonb_build_object(
               'activePromo', exists (
                 select 1 from stayput.actions o
                  where o.company_id = p_company and o.member_id = m.id
                    and o.type = 'promo_offer' and o.status = 'sent'
                    and (o.result ->> 'expires_at')::timestamptz > p_now),
               'freeDaysLast90', (
                 select coalesce(sum((o.content ->> 'days')::integer), 0)
                   from stayput.actions o
                  where o.company_id = p_company and o.member_id = m.id
                    and o.type = 'extend_offer' and o.status = 'sent'
                    and o.sent_at > p_now - interval '90 days'))
        from m),
    'payment', (
      select jsonb_build_object(
               'id', p.id, 'status', p.status, 'amount', p.amount, 'currency', p.currency,
               'recoveryUrl', p.recovery_url,
               'membershipId', coalesce(p.membership_id, p.whop_membership_id))
        from pay p),
    'departure', (
      select jsonb_build_object('membershipId', d.id, 'endsAt', d.current_period_end)
        from departing d),
    'survey', (
      select jsonb_build_object(
               'id', s.id, 'reason', s.reason, 'offerType', s.offer_type, 'offer', s.offer,
               'outcome', s.outcome, 'keep', s.keep_membership,
               'action', (
                 select jsonb_build_object('status', a.status, 'result', a.result,
                                           'error', a.error_log -> -1 ->> 'error')
                   from stayput.actions a
                  where a.company_id = p_company and a.id = s.offer_action_id))
        from survey s))
$$;

-- The member's answer: the reason and the offer it brings (none when a guardrail stops it). One
-- survey per cancellation; the answer may change until the member accepts or declines the offer.
-- The notification asking for the survey, if it has not gone yet, no longer goes. Returns the
-- survey's id.
create function stayput.answer_exit_survey(p_company text, p_member text, p_membership text,
                                           p_reason text, p_offer_type text, p_offer jsonb,
                                           p_now timestamptz) returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_since timestamptz;
  v_id uuid;
begin
  select coalesce(ms.canceled_at, p_now - interval '60 days') into v_since
    from stayput.memberships ms
   where ms.company_id = p_company and ms.id = p_membership and ms.member_id = p_member;
  if not found then
    raise exception 'no membership % of member % here', p_membership, p_member;
  end if;
  select s.id into v_id from stayput.exit_surveys s
   where s.company_id = p_company and s.membership_id = p_membership
     and s.created_at >= v_since
   order by s.created_at desc
   limit 1;
  if v_id is null then
    insert into stayput.exit_surveys (company_id, member_id, membership_id, reason, offer_type,
                                      offer, created_at, answered_at)
    values (p_company, p_member, p_membership, p_reason, p_offer_type, p_offer, p_now, p_now)
    returning id into v_id;
  else
    update stayput.exit_surveys
       set reason = p_reason, offer_type = p_offer_type, offer = p_offer, answered_at = p_now
     where id = v_id and outcome = 'pending';
  end if;
  -- Answered: the notification asking for it no longer goes, nor is planned later (its key,
  -- as plan_actions makes it, is taken).
  update stayput.actions
     set status = 'cancelled', result = jsonb_build_object('reason', 'survey_answered')
   where company_id = p_company and type = 'exit_survey' and subject_id = p_membership
     and status in ('proposed', 'approved', 'scheduled');
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, status, result, content, created_at)
  select ms.company_id, ms.member_id, 'exit_survey', 'cancel_at_period_end', ms.id, 'service',
         'exit_survey:' || ms.id || ':' || to_char(ms.current_period_end, 'YYYY-MM-DD'),
         'cancelled', jsonb_build_object('reason', 'survey_answered'),
         jsonb_build_object('membership_id', ms.id, 'period_end', ms.current_period_end), p_now
    from stayput.memberships ms
   where ms.company_id = p_company and ms.id = p_membership
     and ms.current_period_end is not null
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  return v_id;
end
$$;

-- The member accepts the offer (it becomes an action, `proposed`: the creator's mode and the
-- guardrails decide when it runs) or declines it. `p_keep`: the member ticked « keep my
-- membership ». Returns the action, null when declined or already decided.
create function stayput.decide_exit_offer(p_company text, p_survey uuid, p_accept boolean,
                                          p_keep boolean, p_now timestamptz) returns uuid
language plpgsql set search_path = ''
as $$
declare
  s stayput.exit_surveys;
  v_action uuid;
begin
  select * into s from stayput.exit_surveys
   where company_id = p_company and id = p_survey
     for update;
  if not found or s.outcome <> 'pending' then
    return null;
  end if;
  if not p_accept or s.offer_type is null then
    update stayput.exit_surveys set outcome = 'declined' where id = p_survey;
    return null;
  end if;
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, content,
                               send_at, message_kind, dedupe_key, created_at)
  values (p_company, s.member_id, s.offer_type, 'exit_survey', s.membership_id,
          coalesce(s.offer, '{}') || jsonb_build_object('keep', p_keep, 'reason', s.reason),
          p_now, 'none', 'offer:' || s.id, p_now)
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_action;
  update stayput.exit_surveys
     set outcome = 'accepted', keep_membership = p_keep, offer_action_id = v_action
   where id = p_survey;
  return v_action;
end
$$;

-- The offers' settings, with the others (save_action_settings keeps its own).
create function stayput.save_offer_settings(p_company text, p_offers jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.company_settings set
    pause_days = (p_offers ->> 'pauseDays')::smallint,
    promo_percent = (p_offers ->> 'promoPercent')::smallint,
    promo_months = (p_offers ->> 'promoMonths')::smallint,
    extend_days = (p_offers ->> 'extendDays')::smallint,
    coaching_message = nullif(btrim(p_offers ->> 'coachingMessage'), '')
  where company_id = p_company;
end
$$;

-- What running one action needs (as due_actions in 0011, with the membership's product, currency
-- and end: an offer runs on it), or null unless it is scheduled and its time has come. The Worker
-- runs a member's accepted offer at once with it, the cron the due ones.
create function stayput.due_action(p_id uuid, p_now timestamptz) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'id', a.id,
           'companyId', a.company_id,
           'createdAt', a.created_at,
           'type', a.type,
           'attempts', a.attempts,
           'content', a.content,
           'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
           'killSwitch', s.kill_switch,
           'dryRun', s.dry_run,
           'locale', c.locale,
           'timezone', c.timezone,
           'quietHoursStart', s.quiet_hours_start,
           'quietHoursEnd', s.quiet_hours_end,
           'experienceId', c.experience_id,
           'templates', s.active_templates,
           'member', jsonb_build_object(
             'userId', m.user_id,
             'doNotContact', m.do_not_contact,
             'joined', m.status = 'joined'),
           'payment', (
             select jsonb_build_object(
                      'id', p.id, 'status', p.status, 'retryable', p.retryable,
                      'nextAttemptAt', p.next_payment_attempt_at,
                      'recoveryUrl', p.recovery_url)
               from stayput.payments p
              where p.company_id = a.company_id and p.id = a.subject_id),
           'membership', (
             select jsonb_build_object(
                      'id', ms.id,
                      'canceling', (ms.cancel_at_period_end or ms.status = 'canceling')
                                   and ms.current_period_end > p_now,
                      'ended', ms.status in ('canceled', 'expired', 'completed')
                               or ms.current_period_end <= p_now,
                      'productId', ms.product_id,
                      'currency', ms.currency,
                      'periodEnd', ms.current_period_end)
               from stayput.memberships ms
              where ms.company_id = a.company_id and ms.id = a.subject_id),
           'values', stayput.message_values(a.company_id, a.member_id, p_now))
    from stayput.actions a
    join stayput.companies c on c.id = a.company_id
    join stayput.company_settings s on s.company_id = a.company_id
    join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
   where a.id = p_id and a.status = 'scheduled' and a.send_at <= p_now
     and c.status = 'active' and not c.is_demo;
$$;

-- The run's needs, the oldest first.
create or replace function stayput.due_actions(p_now timestamptz, p_limit integer) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(stayput.due_action(x.id, p_now) order by x.send_at), '[]')
    from (
      select a.id, a.send_at
        from stayput.actions a
        join stayput.companies c on c.id = a.company_id
        join stayput.company_settings s on s.company_id = a.company_id
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
       where a.status = 'scheduled' and a.send_at <= p_now
         and c.status = 'active' and not c.is_demo
       order by a.send_at
       limit p_limit) x;
$$;

revoke all on function stayput.member_retention(text, text, timestamptz) from public;
revoke all on function stayput.answer_exit_survey(text, text, text, text, text, jsonb, timestamptz)
  from public;
revoke all on function stayput.decide_exit_offer(text, uuid, boolean, boolean, timestamptz)
  from public;
revoke all on function stayput.save_offer_settings(text, jsonb) from public;
revoke all on function stayput.due_action(uuid, timestamptz) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0016_exit_offers.sql');
end $install$;

-- ==========================================================================================
-- 0017_platform_people.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0017_platform_people.sql') then
    raise notice 'already applied: 0017_platform_people.sql';
    return;
  end if;
  execute $migration$
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
$migration$;
  insert into stayput.schema_migrations (name) values ('0017_platform_people.sql');
end $install$;

-- ==========================================================================================
-- 0018_alumni_offer.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0018_alumni_offer.sql') then
    raise notice 'already applied: 0018_alumni_offer.sql';
    return;
  end if;
  execute $migration$
-- SPEC 5.9, the Alumni offer, first part. A former member stays in touch for free: a hidden
-- product with a free hidden variant, whose link is how they enter (Whop's invitation answers 403
-- to this account: docs/whop-api-verification.md, section 8), gives access to one StayPut
-- experience, through which the follow-ups at J+7, J+30 and J+60 will go (second part). StayPut
-- creates the offer for the creator, keeps track of who enters and leaves it, and keeps its
-- members out of the risk score: they no longer pay, nothing must call them back as if they did.

-- 1. The company's Alumni offer on Whop. Created step by step (product, variant, experience,
-- attached): what is set is done, and trying again finishes the rest with the same ids.
create table stayput.alumni_offers (
  company_id text primary key references stayput.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  product_id text check (product_id ~ '^prod_[A-Za-z0-9]+$'),
  plan_id text check (plan_id ~ '^plan_[A-Za-z0-9]+$'),
  -- The variant's direct link: how a former member enters.
  url text check (url ~ '^https://'),
  experience_id text check (experience_id ~ '^exp_[A-Za-z0-9]+$'),
  created_by text check (created_by ~ '^user_[A-Za-z0-9]+$'),
  created_at timestamptz not null,
  -- The experience is attached to the product: the offer is ready.
  completed_at timestamptz
);
alter table stayput.alumni_offers enable row level security;
create policy creator_read on stayput.alumni_offers for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.alumni_offers to stayput_user;

-- One step of the creation done: the ids Whop gave so far (`p_step` jsonb: productId, planId,
-- url, experienceId, completed). Returns the offer as it stands.
create function stayput.save_alumni_offer(p_company text, p_name text, p_user text,
                                          p_step jsonb, p_now timestamptz)
returns stayput.alumni_offers
language plpgsql set search_path = ''
as $$
declare
  v_offer stayput.alumni_offers;
begin
  insert into stayput.alumni_offers as o (company_id, name, product_id, plan_id, url,
                                          experience_id, created_by, created_at, completed_at)
  values (p_company, p_name, p_step ->> 'productId', p_step ->> 'planId', p_step ->> 'url',
          p_step ->> 'experienceId', p_user, p_now,
          case when coalesce((p_step ->> 'completed')::boolean, false) then p_now end)
  on conflict (company_id) do update set
    product_id = coalesce(o.product_id, excluded.product_id),
    plan_id = coalesce(o.plan_id, excluded.plan_id),
    url = coalesce(o.url, excluded.url),
    experience_id = coalesce(o.experience_id, excluded.experience_id),
    completed_at = coalesce(o.completed_at, excluded.completed_at)
  returning * into v_offer;
  return v_offer;
end
$$;

-- 2. Who enters and leaves the Alumni, as their memberships of its product come and go (the
-- webhooks and the synchronization write them). A former member is among the alumni once they no
-- longer pay (no paid membership running, or only ones set to end) and their Alumni access runs;
-- gone when it ends; returned when they pay again. A paying member who takes the link out of
-- curiosity is not an alumnus until their paid membership ends.
create function stayput.alumni_live_statuses() returns text[]
language sql immutable set search_path = ''
as $$ select array['trialing', 'active', 'past_due', 'canceling', 'completed'] $$;

-- Among the alumni (again): J+7, J+30 and J+60 count from the end of their last paid membership,
-- a cancellation set for the end of its period counting from that end. Never later than
-- `p_seen`, when StayPut saw them gone: a membership ended early (a refund) still shows the end of
-- its period.
create function stayput.enter_alumni(p_company text, p_member text, p_product text,
                                     p_membership text, p_entered timestamptz,
                                     p_seen timestamptz)
returns void
language plpgsql set search_path = ''
as $$
declare
  v_departed timestamptz;
  v_scheduled boolean;
begin
  select max(case when ms.status = any (stayput.alumni_live_statuses())
                  then ms.current_period_end
                  else coalesce(ms.current_period_end, ms.canceled_at, ms.updated_at) end),
         bool_or(ms.status = any (stayput.alumni_live_statuses()))
    into v_departed, v_scheduled
    from stayput.memberships ms
   where ms.company_id = p_company and ms.member_id = p_member and ms.product_id <> p_product;
  if not coalesce(v_scheduled, false) then
    v_departed := least(v_departed, p_seen);
  end if;
  insert into stayput.alumni_members as a (company_id, member_id, alumni_membership_id,
                                           entry_mode, departed_at, entered_at, status)
  values (p_company, p_member, p_membership, 'link', coalesce(v_departed, p_seen), p_entered,
          'entered')
  on conflict (company_id, member_id) do update set
    alumni_membership_id = excluded.alumni_membership_id,
    entered_at = coalesce(a.entered_at, excluded.entered_at),
    -- Gone again after coming back: a new departure. Otherwise the first one stays.
    departed_at = case when a.status = 'returned' then excluded.departed_at
                       else a.departed_at end,
    status = 'entered',
    left_alumni_at = null;
  -- No longer a paying member: no score, so neither a golden-hour message nor a welcome.
  delete from stayput.member_risk where company_id = p_company and member_id = p_member;
end
$$;

create function stayput.track_alumni() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_product text;
  v_paying boolean;
  v_alumni stayput.memberships;
begin
  if new.member_id is null then
    return new;
  end if;
  select o.product_id into v_product from stayput.alumni_offers o
   where o.company_id = new.company_id;
  if v_product is null then
    return new;
  end if;
  -- Paying: a paid membership running and not set to end.
  v_paying := exists (
    select 1 from stayput.memberships ms
     where ms.company_id = new.company_id and ms.member_id = new.member_id
       and ms.product_id <> v_product and ms.status = any (stayput.alumni_live_statuses())
       and ms.status <> 'canceling' and not ms.cancel_at_period_end);
  if new.product_id = v_product then
    if new.status <> all (stayput.alumni_live_statuses()) then
      -- Gone from the Alumni: never called back.
      update stayput.alumni_members
         set status = 'left', left_alumni_at = coalesce(new.canceled_at, now())
       where company_id = new.company_id and member_id = new.member_id and status = 'entered';
    elsif not v_paying then
      perform stayput.enter_alumni(new.company_id, new.member_id, v_product, new.id,
                                   coalesce(new.whop_created_at, now()),
                                   coalesce(new.whop_created_at, now()));
    end if;
  elsif v_paying then
    -- Paying again: the Alumni brought them back, or they did not leave after all.
    update stayput.alumni_members set status = 'returned'
     where company_id = new.company_id and member_id = new.member_id
       and status in ('invited', 'entered', 'left');
  else
    -- Their paid membership is over or set to end: among the alumni if their Alumni access runs
    -- and they were not already (an alumnus gone again after coming back, or who took the link
    -- while still paying).
    select ms.* into v_alumni from stayput.memberships ms
     where ms.company_id = new.company_id and ms.member_id = new.member_id
       and ms.product_id = v_product and ms.status = any (stayput.alumni_live_statuses())
     order by ms.whop_created_at desc nulls last
     limit 1;
    if found and not exists (
      select 1 from stayput.alumni_members a
       where a.company_id = new.company_id and a.member_id = new.member_id
         and a.status in ('entered', 'left')) then
      perform stayput.enter_alumni(new.company_id, new.member_id, v_product, v_alumni.id,
                                   coalesce(v_alumni.whop_created_at, now()), now());
    end if;
  end if;
  return new;
end
$$;
create trigger memberships_alumni
  after insert or update of status, product_id, member_id on stayput.memberships
  for each row execute function stayput.track_alumni();

-- 3. As in 0008, without the members in the Alumni: they no longer pay.
create or replace function stayput.risk_features(p_company text, p_now timestamptz, p_limit integer)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_settings jsonb;
  v_members jsonb;
begin
  select coalesce(c.timezone, 'UTC') into v_tz from stayput.companies c where c.id = p_company;
  if v_tz is null then
    return jsonb_build_object('settings', null, 'members', '[]'::jsonb);
  end if;
  v_today := (p_now at time zone v_tz)::date;
  select jsonb_build_object(
           'weights', jsonb_build_object(
             'recency', s.weight_recency::float8, 'frequency', s.weight_frequency::float8,
             'progress', s.weight_progress::float8, 'payment', s.weight_payment::float8,
             'friction', s.weight_friction::float8),
           'recencyThresholdDays', s.recency_threshold_days,
           'mediumFrom', s.medium_risk_from,
           'highFrom', s.high_risk_from,
           -- Courses read from Whop, or lessons and goals on record: progress counts.
           'tracksProgress',
             exists (select 1 from stayput.sync_state t
                      where t.company_id = p_company and t.stream like 'lesson_interactions:%')
             or exists (select 1 from stayput.activity_events e
                         where e.company_id = p_company
                           and e.type in ('lesson_completed', 'goal_update')
                           and e.external_id is not null))
    into v_settings
    from stayput.company_settings s where s.company_id = p_company;
  v_settings := coalesce(v_settings, jsonb_build_object(
    'weights', jsonb_build_object('recency', 0.3, 'frequency', 0.25, 'progress', 0.2,
                                  'payment', 0.15, 'friction', 0.1),
    'recencyThresholdDays', 14, 'mediumFrom', 40, 'highFrom', 70, 'tracksProgress', false));

  with due as (
    select m.id, m.joined_at, m.last_action_at
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
       and not exists (select 1 from stayput.alumni_members a
                        where a.company_id = m.company_id and a.member_id = m.id
                          and a.status = 'entered')
       and (r.computed_at is null or r.computed_at <= p_now - interval '50 minutes')
     order by r.computed_at nulls first, m.id
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_array(
           d.id,
           stayput.epoch_ms(d.joined_at),
           stayput.epoch_ms(greatest(last_event.at, d.last_action_at)),
           coalesce(stats.activity_7d, 0),
           coalesce(stats.activity_prev_28d, 0),
           stayput.epoch_ms(progress.at),
           progress.title,
           case
             when payment.failed or exists (
               select 1 from stayput.memberships ms
                where ms.company_id = p_company and ms.member_id = d.id
                  and ms.status = 'past_due') then 'failed'
             when payment.action_required then 'action_required'
             else 'ok'
           end,
           cancel.at is not null,
           stayput.epoch_ms(cancel.at),
           stayput.epoch_ms(ticket.since),
           coalesce(stats.reactions_14d, 0),
           coalesce(stats.reactions_prev_14d, 0),
           coalesce(joined.active, false)
         ) order by d.id), '[]'::jsonb)
    into v_members
    from due d
    left join lateral (
      select e.occurred_at as at from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type = any (stayput.engagement_types())
       order by e.occurred_at desc limit 1) last_event on true
    left join lateral (
      select sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day > v_today - 7)::integer
               as activity_7d,
             sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day <= v_today - 7)::integer
               as activity_prev_28d,
             sum(s.reactions) filter (where s.day > v_today - 14)::integer as reactions_14d,
             sum(s.reactions) filter (where s.day <= v_today - 14 and s.day > v_today - 28)::integer
               as reactions_prev_14d
        from stayput.member_stats_daily s
       where s.company_id = p_company and s.member_id = d.id and s.day > v_today - 35) stats
      on true
    left join lateral (
      select e.occurred_at as at, e.metadata ->> 'lesson_title' as title
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type in ('lesson_completed', 'goal_update')
       order by e.occurred_at desc limit 1) progress on true
    left join lateral (
      select p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
               as failed,
             p.recovery_url is not null
               and p.status = any (array['open', 'pending', 'incomplete', 'requires_action',
                                         'requires_capture']) as action_required
        from stayput.payments p
       where p.company_id = p_company and p.member_id = d.id
       order by p.whop_created_at desc limit 1) payment on true
    left join lateral (
      select min(ms.current_period_end) as at
        from stayput.memberships ms
       where ms.company_id = p_company and ms.member_id = d.id
         and ms.status = any (array['trialing', 'active', 'past_due', 'canceling', 'completed'])
         and (ms.cancel_at_period_end or ms.status = 'canceling')
      having count(*) > 0) cancel on true
    left join lateral (
      -- A support conversation whose last event is the member's, not a resolution.
      select min(t.occurred_at) as since from (
        select distinct on (e.metadata ->> 'channel_id') e.type, e.occurred_at
          from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type in ('support_ticket_opened', 'support_ticket_resolved')
         order by e.metadata ->> 'channel_id', e.occurred_at desc) t
       where t.type = 'support_ticket_opened') ticket on true
    left join lateral (
      select exists (
        select 1 from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type = any (stayput.engagement_types())
           and e.occurred_at >= d.joined_at) as active) joined on true;

  return jsonb_build_object('settings', v_settings, 'members', v_members);
end
$$;

-- What the Actions tab shows of the Alumni offer, for the company's team only: the offer as it
-- stands, and who entered, left and came back.
create function stayput.alumni_view(p_company text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'offer', (select jsonb_build_object('name', o.name, 'url', o.url,
                                        'experienceId', o.experience_id,
                                        'createdAt', o.created_at, 'completedAt', o.completed_at)
                from stayput.alumni_offers o where o.company_id = p_company),
    'entered', (select count(*) from stayput.alumni_members a
                 where a.company_id = p_company and a.status = 'entered'),
    'left', (select count(*) from stayput.alumni_members a
              where a.company_id = p_company and a.status = 'left'),
    'returned', (select count(*) from stayput.alumni_members a
                  where a.company_id = p_company and a.status = 'returned'))
  end
$$;

revoke all on function stayput.save_alumni_offer(text, text, text, jsonb, timestamptz)
  from public;
revoke all on function stayput.alumni_live_statuses() from public;
revoke all on function stayput.enter_alumni(text, text, text, text, timestamptz, timestamptz)
  from public;
revoke all on function stayput.track_alumni() from public;
revoke all on function stayput.alumni_view(text) from public;
-- Read as the creator: the view checks they administer the company.
grant execute on function stayput.alumni_view(text) to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0018_alumni_offer.sql');
end $install$;

-- ==========================================================================================
-- 0019_alumni_followups.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0019_alumni_followups.sql') then
    raise notice 'already applied: 0019_alumni_followups.sql';
    return;
  end if;
  execute $migration$
-- SPEC 5.9, the Alumni offer, second part: the follow-ups. J+7, J+30 and J+60 after their
-- departure, a former member in the Alumni gets a Whop notification through the Alumni space,
-- with news of the community and a single-use return code (valid 7 days, for the product they
-- left, not reserved to new customers). Each follow-up is an action like the others: the
-- creator's mode, the guardrails (spacing, monthly cap, quiet hours, « never contact », one code
-- at a time, the monthly cap of codes), the test mode. The member sees their code in StayPut's
-- view of the Alumni space, with the way back.

-- 1. The Alumni space is for former members only: StayPut never takes it for the community's
-- space, where the notifications to the paying members go (a former member or the team opening
-- StayPut there would otherwise send them all where the paying members cannot read them).
create or replace function stayput.remember_experience(p_company text, p_experience text)
returns void
language sql set search_path = ''
as $$
  update stayput.companies set experience_id = p_experience
   where id = p_company and experience_id is distinct from p_experience
     and p_experience ~ '^exp_[A-Za-z0-9]+$'
     and not exists (select 1 from stayput.alumni_offers o
                      where o.company_id = p_company and o.experience_id = p_experience);
$$;
update stayput.companies c set experience_id = null
 where exists (select 1 from stayput.alumni_offers o
                where o.company_id = c.id and o.experience_id = c.experience_id);

-- 2. The promo codes StayPut created for a company over 30 days, the departure survey's and the
-- Alumni's return codes alike: the creator's monthly cap counts them all.
create function stayput.promo_codes_last_30(p_company text, p_now timestamptz) returns integer
language sql stable set search_path = ''
as $$
  select count(*)::integer from stayput.actions a
   where a.company_id = p_company and a.type in ('promo_offer', 'alumni_followup')
     and a.status = 'sent' and a.result ->> 'code' is not null
     and a.sent_at > p_now - interval '30 days'
$$;

-- One of the member's codes has not expired: one at a time (SPEC Phase 4).
create function stayput.has_active_promo(p_company text, p_member text, p_now timestamptz)
returns boolean
language sql stable set search_path = ''
as $$
  select exists (
    select 1 from stayput.actions o
     where o.company_id = p_company and o.member_id = p_member
       and o.type in ('promo_offer', 'alumni_followup') and o.status = 'sent'
       and (o.result ->> 'expires_at')::timestamptz > p_now)
$$;

-- As in 0009, with the codes of both kinds.
create or replace function stayput.actions_to_schedule(p_company text, p_now timestamptz, p_limit integer)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'mode', c.mode,
    'timezone', c.timezone,
    'globalKillSwitch', (select a.kill_switch from stayput.app_settings a),
    'settings', jsonb_build_object(
      'maxMessagesPer5Days', s.max_messages_per_5_days,
      'maxMessagesPerMonth', s.max_messages_per_month,
      'maxPaymentRetries', s.max_payment_retries,
      'monthlyPromoCap', s.monthly_promo_cap,
      'maxFreeDaysPerQuarter', s.max_free_days_per_quarter,
      'quietHoursStart', s.quiet_hours_start,
      'quietHoursEnd', s.quiet_hours_end,
      'defaultSendHour', s.default_send_hour,
      'dryRun', s.dry_run,
      'killSwitch', s.kill_switch),
    'promosLast30', stayput.promo_codes_last_30(c.id, p_now),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id,
               'type', a.type,
               'memberId', a.member_id,
               'sendAt', a.send_at,
               'freeDays', (a.content ->> 'days')::integer,
               'doNotContact', m.do_not_contact,
               'messages', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'at', coalesce(o.sent_at, o.send_at), 'kind', o.message_kind))
                   from stayput.actions o
                  where o.company_id = a.company_id and o.member_id = a.member_id
                    and o.id <> a.id and o.message_kind <> 'none'
                    and o.status in ('scheduled', 'sent', 'simulated')
                    and coalesce(o.sent_at, o.send_at)
                        between p_now - interval '35 days' and p_now + interval '35 days'),
                 '[]'),
               'paymentRetries', (
                 select count(*) from stayput.actions o
                  where o.company_id = a.company_id and o.type = 'payment_retry'
                    and o.subject_id = a.subject_id and o.id <> a.id
                    and o.status in ('scheduled', 'sent', 'simulated')),
               'activePromo', stayput.has_active_promo(a.company_id, a.member_id, p_now),
               'freeDaysLast90', (
                 select coalesce(sum((o.content ->> 'days')::integer), 0)
                   from stayput.actions o
                  where o.company_id = a.company_id and o.member_id = a.member_id
                    and o.type = 'extend_offer' and o.status = 'sent'
                    and o.sent_at > p_now - interval '90 days'),
               'hours', case when a.message_kind = 'relance' and a.send_at is null then (
                 select jsonb_agg(coalesce(h.n, 0) order by g.hour)
                   from generate_series(0, 23) as g (hour)
                   left join (
                     select extract(hour from e.occurred_at at time zone c.timezone)::integer
                              as hour, count(*) as n
                       from stayput.activity_events e
                      where e.company_id = a.company_id and e.member_id = a.member_id
                        and e.occurred_at > p_now - interval '30 days'
                      group by 1) h on h.hour = g.hour)
               end)
             order by a.created_at)
        from (select * from stayput.actions a
               where a.company_id = c.id
                 and (a.status = 'approved' or (a.status = 'proposed' and c.mode = 'auto'))
               order by a.created_at
               limit p_limit) a
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id),
      '[]'))
    from stayput.companies c
    join stayput.company_settings s on s.company_id = c.id
   where c.id = p_company;
$$;

-- As in 0016, with the codes of both kinds.
create or replace function stayput.member_retention(p_company text, p_user text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  with m as (
    select * from stayput.members where company_id = p_company and user_id = p_user
  ), departing as (
    select ms.* from stayput.memberships ms, m
     where ms.company_id = p_company and ms.member_id = m.id
       and (ms.cancel_at_period_end or ms.status = 'canceling')
       and ms.current_period_end > p_now
       and ms.status not in ('canceled', 'expired', 'completed')
     order by ms.current_period_end desc
     limit 1
  ), survey as (
    select s.* from stayput.exit_surveys s, departing d
     where s.company_id = p_company and s.membership_id = d.id
       and s.created_at >= coalesce(d.canceled_at, p_now - interval '60 days')
     order by s.created_at desc
     limit 1
  ), pay as (
    select p.* from stayput.payments p, m
     where p.company_id = p_company and p.member_id = m.id
       and p.whop_created_at > p_now - interval '30 days'
     order by p.whop_created_at desc
     limit 1
  )
  select jsonb_build_object(
    'member', (select jsonb_build_object('id', m.id, 'doNotContact', m.do_not_contact,
                                         'joined', m.status = 'joined') from m),
    'company', (
      select jsonb_build_object(
               'name', c.name, 'mode', c.mode, 'timezone', c.timezone,
               'dryRun', s.dry_run, 'killSwitch', s.kill_switch,
               'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
               'offers', jsonb_build_object(
                 'pauseDays', s.pause_days, 'promoPercent', s.promo_percent,
                 'promoMonths', s.promo_months, 'extendDays', s.extend_days,
                 'coachingMessage', s.coaching_message),
               'guardrails', jsonb_build_object(
                 'maxMessagesPer5Days', s.max_messages_per_5_days,
                 'maxMessagesPerMonth', s.max_messages_per_month,
                 'maxPaymentRetries', s.max_payment_retries,
                 'monthlyPromoCap', s.monthly_promo_cap,
                 'maxFreeDaysPerQuarter', s.max_free_days_per_quarter,
                 'quietHoursStart', s.quiet_hours_start,
                 'quietHoursEnd', s.quiet_hours_end),
               'promosLast30', stayput.promo_codes_last_30(c.id, p_now))
        from stayput.companies c
        join stayput.company_settings s on s.company_id = c.id
       where c.id = p_company),
    'history', (
      select jsonb_build_object(
               'activePromo', stayput.has_active_promo(p_company, m.id, p_now),
               'freeDaysLast90', (
                 select coalesce(sum((o.content ->> 'days')::integer), 0)
                   from stayput.actions o
                  where o.company_id = p_company and o.member_id = m.id
                    and o.type = 'extend_offer' and o.status = 'sent'
                    and o.sent_at > p_now - interval '90 days'))
        from m),
    'payment', (
      select jsonb_build_object(
               'id', p.id, 'status', p.status, 'amount', p.amount, 'currency', p.currency,
               'recoveryUrl', p.recovery_url,
               'membershipId', coalesce(p.membership_id, p.whop_membership_id))
        from pay p),
    'departure', (
      select jsonb_build_object('membershipId', d.id, 'endsAt', d.current_period_end)
        from departing d),
    'survey', (
      select jsonb_build_object(
               'id', s.id, 'reason', s.reason, 'offerType', s.offer_type, 'offer', s.offer,
               'outcome', s.outcome, 'keep', s.keep_membership,
               'action', (
                 select jsonb_build_object('status', a.status, 'result', a.result,
                                           'error', a.error_log -> -1 ->> 'error')
                   from stayput.actions a
                  where a.company_id = p_company and a.id = s.offer_action_id))
        from survey s))
$$;

-- 3. The follow-ups, planned once per departure and step. A step is planned while it is due and
-- the next one is far enough: a member who entered the Alumni late gets the latest step only,
-- never two follow-ups within the guardrails' spacing. The Worker sets the time (the golden
-- hour). The action's subject is the paid membership they left: its product and currency make
-- the return code.
create function stayput.plan_alumni_followups(p_company text, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, content)
  select al.company_id, al.member_id, 'alumni_followup', 'alumni', paid.id, 'relance',
         'alumni_followup:' || al.member_id || ':'
           || to_char(al.departed_at at time zone 'UTC', 'YYYY-MM-DD') || ':' || step.days,
         jsonb_build_object('step', step.days, 'departed_at', al.departed_at)
    from stayput.alumni_members al
    join stayput.alumni_offers o
      on o.company_id = al.company_id and o.completed_at is not null
     and o.experience_id is not null
    join stayput.companies c on c.id = al.company_id
    join stayput.members m on m.company_id = al.company_id and m.id = al.member_id
   cross join (values (7, 23), (30, 53), (60, 85)) as step (days, until_days)
    left join lateral (
      select ms.id from stayput.memberships ms
       where ms.company_id = al.company_id and ms.member_id = al.member_id
         and ms.product_id <> o.product_id
       order by coalesce(ms.current_period_end, ms.canceled_at, ms.updated_at) desc, ms.id
       limit 1) paid on true
   where al.company_id = p_company and al.status = 'entered'
     and c.status = 'active' and not c.is_demo
     and p_now >= al.departed_at + make_interval(days => step.days)
     and p_now < al.departed_at + make_interval(days => step.until_days)
     and m.status = 'joined' and m.access_level is distinct from 'admin'
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- 4. What running an action needs, as in 0016, with the plan of the membership (the way back)
-- and, for an Alumni follow-up, the member's place in the Alumni.
create or replace function stayput.due_action(p_id uuid, p_now timestamptz) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'id', a.id,
           'companyId', a.company_id,
           'createdAt', a.created_at,
           'type', a.type,
           'attempts', a.attempts,
           'content', a.content,
           -- What an earlier attempt kept (an Alumni follow-up's code, already made).
           'result', a.result,
           'globalKillSwitch', (select g.kill_switch from stayput.app_settings g),
           'killSwitch', s.kill_switch,
           'dryRun', s.dry_run,
           'locale', c.locale,
           'timezone', c.timezone,
           'quietHoursStart', s.quiet_hours_start,
           'quietHoursEnd', s.quiet_hours_end,
           'experienceId', c.experience_id,
           'templates', s.active_templates,
           'member', jsonb_build_object(
             'userId', m.user_id,
             'doNotContact', m.do_not_contact,
             'joined', m.status = 'joined'),
           'payment', (
             select jsonb_build_object(
                      'id', p.id, 'status', p.status, 'retryable', p.retryable,
                      'nextAttemptAt', p.next_payment_attempt_at,
                      'recoveryUrl', p.recovery_url)
               from stayput.payments p
              where p.company_id = a.company_id and p.id = a.subject_id),
           'membership', (
             select jsonb_build_object(
                      'id', ms.id,
                      'canceling', (ms.cancel_at_period_end or ms.status = 'canceling')
                                   and ms.current_period_end > p_now,
                      'ended', ms.status in ('canceled', 'expired', 'completed')
                               or ms.current_period_end <= p_now,
                      'productId', ms.product_id,
                      'planId', ms.plan_id,
                      'currency', ms.currency,
                      'periodEnd', ms.current_period_end)
               from stayput.memberships ms
              where ms.company_id = a.company_id and ms.id = a.subject_id),
           'values', stayput.message_values(a.company_id, a.member_id, p_now),
           -- An Alumni follow-up: whether the member is still among the alumni, the space it
           -- goes through, and the return code's discount as the creator sets it now.
           'alumni', case when a.type = 'alumni_followup' then (
             select jsonb_build_object('status', al.status, 'experienceId', o.experience_id,
                                       'percentOff', s.promo_percent, 'months', s.promo_months)
               from stayput.alumni_members al
               left join stayput.alumni_offers o on o.company_id = al.company_id
              where al.company_id = a.company_id and al.member_id = a.member_id) end)
    from stayput.actions a
    join stayput.companies c on c.id = a.company_id
    join stayput.company_settings s on s.company_id = a.company_id
    join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
   where a.id = p_id and a.status = 'scheduled' and a.send_at <= p_now
     and c.status = 'active' and not c.is_demo;
$$;

-- 5. What StayPut's view of the Alumni space shows a former member: their return code while it
-- holds (one StayPut created, not one simulated in test mode) and the plan they left, their way
-- back. Null for anyone not among the alumni.
create function stayput.member_alumni(p_company text, p_user text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'code', f.result ->> 'code',
           'expiresAt', f.result ->> 'expires_at',
           'percentOff', (f.result ->> 'percent_off')::integer,
           'months', (f.result ->> 'months')::integer,
           'planId', paid.plan_id)
    from stayput.members m
    join stayput.alumni_members al
      on al.company_id = m.company_id and al.member_id = m.id and al.status = 'entered'
    join stayput.alumni_offers o on o.company_id = m.company_id
    left join lateral (
      select a.result from stayput.actions a
       where a.company_id = m.company_id and a.member_id = m.id
         and a.type = 'alumni_followup' and a.status = 'sent'
         and (a.result ->> 'expires_at')::timestamptz > p_now
       order by a.sent_at desc
       limit 1) f on true
    left join lateral (
      select ms.plan_id from stayput.memberships ms
       where ms.company_id = m.company_id and ms.member_id = m.id
         and ms.product_id <> o.product_id
       order by coalesce(ms.current_period_end, ms.canceled_at, ms.updated_at) desc, ms.id
       limit 1) paid on true
   where m.company_id = p_company and m.user_id = p_user
$$;

revoke all on function stayput.promo_codes_last_30(text, timestamptz) from public;
revoke all on function stayput.has_active_promo(text, text, timestamptz) from public;
revoke all on function stayput.plan_alumni_followups(text, timestamptz) from public;
revoke all on function stayput.member_alumni(text, text, timestamptz) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0019_alumni_followups.sql');
end $install$;

-- ==========================================================================================
-- 0020_member_goals.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0020_member_goals.sql') then
    raise notice 'already applied: 0020_member_goals.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, the member space, first part: the member's goal (one under way at a time), the
-- results they record, the milestones on the way (25, 50, 75 and 100 % of the distance from the
-- start to the target, whichever way it goes) and the first badges (first result, seven days in
-- a row, each milestone). Each opening of the space is an activity (stayput_open), each goal
-- set and result recorded one too (goal_update): what StayPut sees of a member when Whop shows
-- nothing (SPEC Phase 5, point 10). The Worker calls these after checking with Whop the
-- member's access to the experience; the creator reads the rows under RLS.

-- How the member records results: where they stand (`total`: a weight, a monthly revenue), or
-- what they did since the last time (`add`: two more clients).
alter table stayput.goals
  add column entry text not null default 'total' check (entry in ('total', 'add'));

-- Where the member stands: the start until the first result, then the last one (for `add`, the
-- sum of the entries). Kept on the goal, so that two entries at once never lose one.
alter table stayput.goals add column current_value numeric(14, 2);
update stayput.goals g
   set current_value = coalesce(
         (select r.value from stayput.results r
           where r.company_id = g.company_id and r.goal_id = g.id
           order by r.recorded_at desc, r.id desc limit 1),
         g.start_value);
alter table stayput.goals alter column current_value set not null;
-- A new goal starts where the member stands.
create function stayput.goal_current_default() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.current_value := coalesce(new.current_value, new.start_value);
  return new;
end
$$;
create trigger goals_current_default before insert on stayput.goals
  for each row execute function stayput.goal_current_default();

-- One goal under way per member: a new one ends the previous.
create unique index goals_one_active on stayput.goals (company_id, member_id)
  where status = 'active';

-- The goals the creator proposes to members (packages/core GoalProposal); null: their niche's
-- (packages/core NICHE_GOALS, in each member's language).
alter table stayput.company_settings
  add column goal_proposals jsonb
    check (goal_proposals is null or jsonb_typeof(goal_proposals) = 'array');

-- An opening of the space by a user StayPut does not know yet waits like their other activity,
-- until their membership is read (upsert_member moves it).
alter table stayput.pending_activity drop constraint pending_activity_type_check;
alter table stayput.pending_activity add constraint pending_activity_type_check check (type in (
  'message', 'reaction', 'lesson_completed', 'forum_post', 'support_ticket_opened',
  'support_ticket_resolved', 'discord_message', 'telegram_message', 'stayput_open'));

-- Where `p_current` stands from the start to the target, 0 to 100, never beyond: the progress the
-- member sees and the milestones they reach.
create function stayput.goal_progress(p_start numeric, p_target numeric, p_current numeric)
returns integer
language sql immutable set search_path = ''
as $$
  select case
           when p_target = p_start then 0
           else greatest(0, least(100, floor((p_current - p_start) * 100
                                             / (p_target - p_start))))::integer
         end
$$;

-- A badge for a member, once ever: the codes it gave (none when they had it already).
create function stayput.award_badge(p_company text, p_member text, p_badge text,
                                    p_at timestamptz, p_context jsonb)
returns text[]
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.member_badges (company_id, member_id, badge_code, awarded_at, context)
  values (p_company, p_member, p_badge, p_at, coalesce(p_context, '{}'))
  on conflict do nothing;
  return case when found then array[p_badge] else '{}'::text[] end;
end
$$;

-- Seven days in a row in the member space (opened, or a goal or result recorded), days of the
-- company's time zone: the assiduity badge.
create function stayput.award_streak(p_company text, p_member text, p_now timestamptz)
returns text[]
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_days integer;
begin
  if exists (select 1 from stayput.member_badges b
              where b.company_id = p_company and b.member_id = p_member
                and b.badge_code = 'streak_7_days') then
    return '{}';
  end if;
  select c.timezone into v_tz from stayput.companies c where c.id = p_company;
  v_tz := coalesce(v_tz, 'UTC');
  v_today := (p_now at time zone v_tz)::date;
  select count(distinct (e.occurred_at at time zone v_tz)::date) into v_days
    from stayput.activity_events e
   where e.company_id = p_company and e.member_id = p_member
     and e.type in ('stayput_open', 'goal_update')
     and e.occurred_at > p_now - interval '8 days' and e.occurred_at <= p_now
     and (e.occurred_at at time zone v_tz)::date > v_today - 7;
  if v_days < 7 then
    return '{}';
  end if;
  return stayput.award_badge(p_company, p_member, 'streak_7_days', p_now, '{}');
end
$$;

-- The member opened their space: one activity per day of the company's time zone (opening it
-- ten times a day is still one day of activity), and the badges this day brings.
create function stayput.record_open(p_company text, p_user text, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_member text;
begin
  select c.timezone into v_tz from stayput.companies c where c.id = p_company;
  if not found then
    return jsonb_build_object('badges', '[]'::jsonb);
  end if;
  perform stayput.record_activity(
    p_company, 'stayput_open', p_user,
    'open:' || p_user || ':' || to_char((p_now at time zone v_tz)::date, 'YYYY-MM-DD'),
    p_now, '{}');
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return jsonb_build_object('badges', '[]'::jsonb);
  end if;
  return jsonb_build_object('badges', to_jsonb(stayput.award_streak(p_company, v_member, p_now)));
end
$$;

-- The member's goal (packages/core GoalInput, checked by the Worker): the one under way ends
-- (abandoned; a goal reached stays reached). Null when StayPut does not know the member yet.
create function stayput.set_goal(p_company text, p_user text, p_goal jsonb, p_now timestamptz)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_goal uuid;
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  update stayput.goals set status = 'abandoned'
   where company_id = p_company and member_id = v_member and status = 'active';
  insert into stayput.goals (company_id, member_id, title, category, start_value, target_value,
                             current_value, unit, entry, target_date, status, created_at)
  values (p_company, v_member, p_goal ->> 'title', p_goal ->> 'category',
          (p_goal ->> 'start')::numeric, (p_goal ->> 'target')::numeric,
          (p_goal ->> 'start')::numeric, p_goal ->> 'unit', p_goal ->> 'entry',
          (p_goal ->> 'targetDate')::date, 'active', p_now)
  returning id into v_goal;
  perform stayput.record_activity(p_company, 'goal_update', p_user, 'goal:' || v_goal, p_now,
                                  jsonb_build_object('goal_id', v_goal));
  return v_goal;
end
$$;

-- A result on the member's goal under way: where they stand now (`total`), or what they add
-- (`add`). The milestones it reaches, the badges it brings, and the goal reached at 100 %. Null
-- when the goal is not theirs, not under way, or the sum would not fit.
create function stayput.record_result(p_company text, p_user text, p_goal uuid, p_value numeric,
                                      p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_goal stayput.goals;
  v_value numeric;
  v_result uuid;
  v_progress integer;
  v_percent integer;
  v_milestones integer[] := '{}';
  v_badges text[] := '{}';
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  -- Locked: a second entry at the same moment adds to this one, never beside it.
  select g.* into v_goal from stayput.goals g
   where g.company_id = p_company and g.member_id = v_member and g.id = p_goal
     and g.status = 'active'
     for update;
  if not found then
    return null;
  end if;
  v_value := round(case when v_goal.entry = 'add' then v_goal.current_value + p_value
                        else p_value end, 2);
  if abs(v_value) > 100000000000 then
    return null;
  end if;
  update stayput.goals set current_value = v_value where id = p_goal;
  insert into stayput.results (company_id, member_id, goal_id, value, recorded_at)
  values (p_company, v_member, p_goal, v_value, p_now)
  returning id into v_result;
  perform stayput.record_activity(p_company, 'goal_update', p_user, 'result:' || v_result, p_now,
                                  jsonb_build_object('goal_id', p_goal));

  v_badges := v_badges || stayput.award_badge(p_company, v_member, 'first_result', p_now,
                                              jsonb_build_object('goal_id', p_goal));
  v_progress := stayput.goal_progress(v_goal.start_value, v_goal.target_value, v_value);
  foreach v_percent in array array[25, 50, 75, 100] loop
    exit when v_progress < v_percent;
    insert into stayput.milestones (company_id, member_id, goal_id, percent, reached_at)
    values (p_company, v_member, p_goal, v_percent, p_now)
    on conflict (goal_id, percent) do nothing;
    if found then
      v_milestones := v_milestones || v_percent;
      v_badges := v_badges || stayput.award_badge(p_company, v_member, 'milestone_' || v_percent,
                                                  p_now, jsonb_build_object('goal_id', p_goal));
    end if;
  end loop;
  v_badges := v_badges || stayput.award_streak(p_company, v_member, p_now);
  if v_progress >= 100 then
    update stayput.goals set status = 'achieved' where id = p_goal;
  end if;
  return jsonb_build_object(
    'resultId', v_result,
    'value', v_value::float8,
    'progress', v_progress,
    'milestones', to_jsonb(v_milestones),
    'badges', to_jsonb(v_badges),
    'achieved', v_progress >= 100);
end
$$;

-- What the member space shows (packages/core MemberSpaceView, completed by the Worker): the goal
-- under way, or else the last one reached, its milestones and ten latest results, the member's
-- badges, and the goals the creator proposes (null: the niche's).
create function stayput.member_space(p_company text, p_user text)
returns jsonb
language sql stable set search_path = ''
as $$
  with m as (
    select m.id from stayput.members m where m.company_id = p_company and m.user_id = p_user
  ), g as (
    select g.* from stayput.goals g, m
     where g.company_id = p_company and g.member_id = m.id
       and g.status in ('active', 'achieved')
     order by g.status = 'active' desc, g.created_at desc, g.id
     limit 1
  )
  select jsonb_build_object(
    'known', exists (select 1 from m),
    'niche', (select c.niche from stayput.companies c where c.id = p_company),
    'proposals', (select s.goal_proposals from stayput.company_settings s
                   where s.company_id = p_company),
    'goal', (
      select jsonb_build_object(
               'id', g.id,
               'title', g.title,
               'category', coalesce(g.category, 'other'),
               'unit', g.unit,
               'entry', g.entry,
               'start', g.start_value::float8,
               'target', g.target_value::float8,
               'current', g.current_value::float8,
               'progress', stayput.goal_progress(g.start_value, g.target_value, g.current_value),
               'targetDate', g.target_date,
               'status', g.status,
               'createdAt', g.created_at,
               'milestones', coalesce((
                 select jsonb_agg(jsonb_build_object('percent', ms.percent,
                                                     'reachedAt', ms.reached_at)
                                  order by ms.percent)
                   from stayput.milestones ms
                  where ms.company_id = p_company and ms.goal_id = g.id), '[]'::jsonb))
        from g),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'value', r.value::float8,
                                          'recordedAt', r.recorded_at)
                       order by r.recorded_at desc, r.id desc)
        from (select r.* from stayput.results r, g
               where r.company_id = p_company and r.goal_id = g.id
               order by r.recorded_at desc, r.id desc
               limit 10) r), '[]'::jsonb),
    'badges', coalesce((
      select jsonb_agg(jsonb_build_object('code', b.badge_code, 'awardedAt', b.awarded_at)
                       order by b.awarded_at, b.badge_code)
        from stayput.member_badges b, m
       where b.company_id = p_company and b.member_id = m.id), '[]'::jsonb))
$$;

-- The goals the creator proposes; null goes back to the niche's.
create function stayput.save_goal_proposals(p_company text, p_proposals jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  if p_proposals is not null and jsonb_typeof(p_proposals) <> 'array' then
    raise exception 'goal proposals must be an array';
  end if;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set goal_proposals = p_proposals where company_id = p_company;
end
$$;

-- The words a message about a member uses (0010), with their goal under way and how far they
-- are: « 40 % » in French, « 40% » in English.
create or replace function stayput.message_values(p_company text, p_member text,
                                                  p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'first_name', nullif(split_part(coalesce(m.display_name, ''), ' ', 1), ''),
    'creator_name', c.name,
    'days_inactive', (
      select floor(extract(epoch from p_now - coalesce(max(e.occurred_at), m.joined_at))
                   / 86400)::integer
        from stayput.activity_events e
       where e.company_id = m.company_id and e.member_id = m.id),
    'last_lesson', (
      select e.metadata ->> 'lesson_title'
        from stayput.activity_events e
       where e.company_id = m.company_id and e.member_id = m.id and e.type = 'lesson_completed'
       order by e.occurred_at desc limit 1),
    'goal', g.title,
    'progress', case
                  when g.id is null then null
                  else stayput.goal_progress(g.start_value, g.target_value, g.current_value)
                       || case when c.locale = 'fr' then chr(160) || '%' else '%' end
                end)
    from stayput.members m
    join stayput.companies c on c.id = m.company_id
    left join lateral (
      select g.id, g.title, g.start_value, g.target_value, g.current_value
        from stayput.goals g
       where g.company_id = m.company_id and g.member_id = m.id and g.status = 'active'
       limit 1) g on true
   where m.company_id = p_company and m.id = p_member;
$$;

revoke all on function stayput.goal_current_default() from public;
revoke all on function stayput.goal_progress(numeric, numeric, numeric) from public;
revoke all on function stayput.award_badge(text, text, text, timestamptz, jsonb) from public;
revoke all on function stayput.award_streak(text, text, timestamptz) from public;
revoke all on function stayput.record_open(text, text, timestamptz) from public;
revoke all on function stayput.set_goal(text, text, jsonb, timestamptz) from public;
revoke all on function stayput.record_result(text, text, uuid, numeric, timestamptz) from public;
revoke all on function stayput.member_space(text, text) from public;
revoke all on function stayput.save_goal_proposals(text, jsonb) from public;
-- The previews of the actions list read message_values as the creator (under RLS).
grant execute on function stayput.goal_progress(numeric, numeric, numeric) to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0020_member_goals.sql');
end $install$;

-- ==========================================================================================
-- 0021_goal_proofs.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0021_goal_proofs.sql') then
    raise notice 'already applied: 0021_goal_proofs.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, point 3: a screenshot backs a result. The member's browser reads the numbers on
-- it (Tesseract.js) and sends the image's SHA-256 and those numbers, never the image itself. The
-- result is `justified` when the number recorded is among them (the Worker checks it: then
-- only does it pass the proof here); a screenshot backs one result only, the same image again
-- leaves the result declared. The first proof brings the badge « First proof ».

-- One result per screenshot, in a company.
create unique index proofs_image_once on stayput.proofs (company_id, image_sha256)
  where image_sha256 is not null;

-- A result on the member's goal under way (0020), with the screenshot that backs it: `proof` in
-- the answer says `justified`, `duplicate` (the screenshot backed another result already), or
-- null (none).
create function stayput.record_result(p_company text, p_user text, p_goal uuid, p_value numeric,
                                      p_now timestamptz, p_proof jsonb)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_goal stayput.goals;
  v_value numeric;
  v_result uuid;
  v_progress integer;
  v_percent integer;
  v_milestones integer[] := '{}';
  v_badges text[] := '{}';
  v_proof text;
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  -- Locked: a second entry at the same moment adds to this one, never beside it.
  select g.* into v_goal from stayput.goals g
   where g.company_id = p_company and g.member_id = v_member and g.id = p_goal
     and g.status = 'active'
     for update;
  if not found then
    return null;
  end if;
  v_value := round(case when v_goal.entry = 'add' then v_goal.current_value + p_value
                        else p_value end, 2);
  if abs(v_value) > 100000000000 then
    return null;
  end if;
  update stayput.goals set current_value = v_value where id = p_goal;
  insert into stayput.results (company_id, member_id, goal_id, value, recorded_at)
  values (p_company, v_member, p_goal, v_value, p_now)
  returning id into v_result;
  perform stayput.record_activity(p_company, 'goal_update', p_user, 'result:' || v_result, p_now,
                                  jsonb_build_object('goal_id', p_goal));

  v_badges := v_badges || stayput.award_badge(p_company, v_member, 'first_result', p_now,
                                              jsonb_build_object('goal_id', p_goal));
  -- The screenshot backs this result, unless it already backed another one.
  if p_proof is not null then
    insert into stayput.proofs (company_id, member_id, result_id, level, ocr_values,
                                image_sha256, created_at)
    values (p_company, v_member, v_result, 'justified',
            jsonb_build_object('numbers', coalesce(p_proof -> 'numbers', '[]'::jsonb),
                               'matched', p_value),
            p_proof ->> 'sha256', p_now)
    on conflict (company_id, image_sha256) where image_sha256 is not null do nothing;
    if found then
      v_proof := 'justified';
      v_badges := v_badges || stayput.award_badge(p_company, v_member, 'first_proof', p_now,
                                                  jsonb_build_object('goal_id', p_goal));
    else
      v_proof := 'duplicate';
    end if;
  end if;
  v_progress := stayput.goal_progress(v_goal.start_value, v_goal.target_value, v_value);
  foreach v_percent in array array[25, 50, 75, 100] loop
    exit when v_progress < v_percent;
    insert into stayput.milestones (company_id, member_id, goal_id, percent, reached_at)
    values (p_company, v_member, p_goal, v_percent, p_now)
    on conflict (goal_id, percent) do nothing;
    if found then
      v_milestones := v_milestones || v_percent;
      v_badges := v_badges || stayput.award_badge(p_company, v_member, 'milestone_' || v_percent,
                                                  p_now, jsonb_build_object('goal_id', p_goal));
    end if;
  end loop;
  v_badges := v_badges || stayput.award_streak(p_company, v_member, p_now);
  if v_progress >= 100 then
    update stayput.goals set status = 'achieved' where id = p_goal;
  end if;
  return jsonb_build_object(
    'resultId', v_result,
    'value', v_value::float8,
    'progress', v_progress,
    'milestones', to_jsonb(v_milestones),
    'badges', to_jsonb(v_badges),
    'achieved', v_progress >= 100,
    'proof', v_proof);
end
$$;

-- 0020's, for the Worker deployed before this migration: a result without a screenshot.
create or replace function stayput.record_result(p_company text, p_user text, p_goal uuid,
                                                 p_value numeric, p_now timestamptz)
returns jsonb
language sql set search_path = ''
as $$
  select stayput.record_result(p_company, p_user, p_goal, p_value, p_now, null::jsonb)
$$;

-- The member space (0020), each result with the level of its proof (null: declared).
create or replace function stayput.member_space(p_company text, p_user text)
returns jsonb
language sql stable set search_path = ''
as $$
  with m as (
    select m.id from stayput.members m where m.company_id = p_company and m.user_id = p_user
  ), g as (
    select g.* from stayput.goals g, m
     where g.company_id = p_company and g.member_id = m.id
       and g.status in ('active', 'achieved')
     order by g.status = 'active' desc, g.created_at desc, g.id
     limit 1
  )
  select jsonb_build_object(
    'known', exists (select 1 from m),
    'niche', (select c.niche from stayput.companies c where c.id = p_company),
    'proposals', (select s.goal_proposals from stayput.company_settings s
                   where s.company_id = p_company),
    'goal', (
      select jsonb_build_object(
               'id', g.id,
               'title', g.title,
               'category', coalesce(g.category, 'other'),
               'unit', g.unit,
               'entry', g.entry,
               'start', g.start_value::float8,
               'target', g.target_value::float8,
               'current', g.current_value::float8,
               'progress', stayput.goal_progress(g.start_value, g.target_value, g.current_value),
               'targetDate', g.target_date,
               'status', g.status,
               'createdAt', g.created_at,
               'milestones', coalesce((
                 select jsonb_agg(jsonb_build_object('percent', ms.percent,
                                                     'reachedAt', ms.reached_at)
                                  order by ms.percent)
                   from stayput.milestones ms
                  where ms.company_id = p_company and ms.goal_id = g.id), '[]'::jsonb))
        from g),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'value', r.value::float8,
                                          'recordedAt', r.recorded_at,
                                          'proof', (select p.level from stayput.proofs p
                                                     where p.company_id = p_company
                                                       and p.result_id = r.id
                                                     order by p.created_at limit 1))
                       order by r.recorded_at desc, r.id desc)
        from (select r.* from stayput.results r, g
               where r.company_id = p_company and r.goal_id = g.id
               order by r.recorded_at desc, r.id desc
               limit 10) r), '[]'::jsonb),
    'badges', coalesce((
      select jsonb_agg(jsonb_build_object('code', b.badge_code, 'awardedAt', b.awarded_at)
                       order by b.awarded_at, b.badge_code)
        from stayput.member_badges b, m
       where b.company_id = p_company and b.member_id = m.id), '[]'::jsonb))
$$;

revoke all on function stayput.record_result(text, text, uuid, numeric, timestamptz, jsonb)
  from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0021_goal_proofs.sql');
end $install$;

-- ==========================================================================================
-- 0022_earned_days.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0022_earned_days.sql') then
    raise notice 'already applied: 0022_earned_days.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, point 5, the earned days: when the creator turns them on (company_settings
-- .options.earned_days, off by default), a milestone a member reaches gives free days on their
-- membership: 3 at 50 %, 7 at 100 % by default, the creator's numbers otherwise. Once per member
-- and milestone (the first time they reach it while the earned days are on), so that a goal made
-- easy on purpose cannot be repeated for more days. The days are an `extend_offer` action
-- (trigger `milestone`):
-- the guardrails count them with the departure survey's free days (14 a quarter at most), test
-- mode simulates them, manual mode waits for the creator.

alter table stayput.company_settings
  add column earned_days_50 smallint not null default 3 check (earned_days_50 between 0 and 14),
  add column earned_days_100 smallint not null default 7 check (earned_days_100 between 0 and 14);

-- The days the milestones `p_percents` bring the member, as actions to schedule: one per
-- milestone the creator rewards, on the membership the member pays now. The actions made, each
-- with its days (none when the earned days are off, the member has no live membership, or
-- already had them for that milestone).
create function stayput.plan_earned_days(p_company text, p_user text, p_goal uuid,
                                         p_percents integer[], p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_membership text;
  v_on boolean;
  v_at50 integer;
  v_at100 integer;
  v_percent integer;
  v_days integer;
  v_action uuid;
  v_actions jsonb := '[]';
begin
  select coalesce((s.options ->> 'earned_days')::boolean, false), s.earned_days_50,
         s.earned_days_100
    into v_on, v_at50, v_at100
    from stayput.company_settings s
    join stayput.companies c on c.id = s.company_id
   where s.company_id = p_company and c.status = 'active' and not c.is_demo;
  if not coalesce(v_on, false) then
    return v_actions;
  end if;
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user and m.status = 'joined';
  if v_member is null then
    return v_actions;
  end if;
  -- The membership the member pays now (a cancellation scheduled keeps it live until its end).
  select ms.id into v_membership from stayput.memberships ms
   where ms.company_id = p_company and ms.member_id = v_member
     and ms.status in ('active', 'trialing', 'canceling')
     and coalesce(ms.current_period_end, p_now + interval '1 day') > p_now
   order by ms.current_period_end desc nulls last, ms.id
   limit 1;
  if v_membership is null then
    return v_actions;
  end if;
  foreach v_percent in array coalesce(p_percents, '{}') loop
    v_days := case v_percent when 50 then v_at50 when 100 then v_at100 else 0 end;
    continue when v_days <= 0;
    -- The milestone must be reached on this goal of the member's.
    continue when not exists (
      select 1 from stayput.milestones ms
       where ms.company_id = p_company and ms.member_id = v_member and ms.goal_id = p_goal
         and ms.percent = v_percent);
    insert into stayput.actions (company_id, member_id, type, trigger, subject_id, content,
                                 send_at, message_kind, dedupe_key, created_at)
    values (p_company, v_member, 'extend_offer', 'milestone', v_membership,
            jsonb_build_object('days', v_days, 'percent', v_percent, 'goal_id', p_goal,
                               'membership_id', v_membership),
            p_now, 'none', 'earned_days:' || v_member || ':' || v_percent, p_now)
    on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing
    returning id into v_action;
    if v_action is not null then
      v_actions := v_actions || jsonb_build_object('id', v_action, 'days', v_days);
    end if;
  end loop;
  return v_actions;
end
$$;

-- What the member space shows of the earned days: the ones the creator offers now (null when
-- off), and the ones the member received (sent, not simulated).
create function stayput.member_rewards(p_company text, p_user text)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'offered', (
      select case when coalesce((s.options ->> 'earned_days')::boolean, false)
                  then jsonb_build_object('at50', s.earned_days_50, 'at100', s.earned_days_100)
             end
        from stayput.company_settings s
       where s.company_id = p_company),
    'received', coalesce((
      select jsonb_agg(jsonb_build_object('percent', (a.content ->> 'percent')::integer,
                                          'days', (a.content ->> 'days')::integer,
                                          'at', a.sent_at)
                       order by a.sent_at)
        from stayput.actions a
        join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
       where a.company_id = p_company and m.user_id = p_user
         and a.type = 'extend_offer' and a.trigger = 'milestone' and a.status = 'sent'),
      '[]'::jsonb))
$$;

-- The earned days as the creator sets them.
create function stayput.save_earned_days(p_company text, p_enabled boolean, p_at50 integer,
                                         p_at100 integer)
returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('earned_days', p_enabled),
         earned_days_50 = p_at50,
         earned_days_100 = p_at100
   where company_id = p_company;
end
$$;

revoke all on function stayput.plan_earned_days(text, text, uuid, integer[], timestamptz)
  from public;
revoke all on function stayput.member_rewards(text, text) from public;
revoke all on function stayput.save_earned_days(text, boolean, integer, integer) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0022_earned_days.sql');
end $install$;

-- ==========================================================================================
-- 0023_announcements.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0023_announcements.sql') then
    raise notice 'already applied: 0023_announcements.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, point 4: a member's milestone announced in the community's chat, when the creator
-- chose where (a Whop chat channel, a Discord channel, a Telegram group) and the member asks for
-- it, after seeing the exact words. An action like the others (`milestone_announcement`): the
-- stops, « never contact », test mode and manual mode apply. Once per goal and milestone. Only
-- the member's first name, the goal's title and the milestone: never their numbers.

-- Where the announcements go (packages/core AnnounceDestination: platform, id, the channel's
-- name and where it is, kept for the member view); null: none.
alter table stayput.company_settings
  add column announce_to jsonb check (
    announce_to is null
    or (jsonb_typeof(announce_to) = 'object'
        and announce_to ->> 'platform' in ('whop', 'discord', 'telegram')
        and announce_to ->> 'id' is not null));

create function stayput.save_announce_to(p_company text, p_destination jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings set announce_to = p_destination where company_id = p_company;
end
$$;

-- What the member space needs to offer the sharing: the community's language, the member's first
-- name as the announcement writes it, and where it goes. Null when the creator chose nowhere.
create function stayput.member_announce(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select case when s.announce_to is null then null else jsonb_build_object(
           'locale', c.locale,
           'firstName', (
             select nullif(split_part(coalesce(m.display_name, ''), ' ', 1), '')
               from stayput.members m
              where m.company_id = p_company and m.user_id = p_user),
           'place', coalesce(s.announce_to ->> 'name', s.announce_to ->> 'id')) end
    from stayput.company_settings s
    join stayput.companies c on c.id = s.company_id
   where s.company_id = p_company;
$$;

-- The member asks for a milestone of their goal to be announced: the action, with where it goes
-- and what it says (the goal's title, the milestone); the words are written when it runs, in
-- the community's language. `{"id": …}`, `{"duplicate": true}` when this milestone was shared
-- already, null when there is nowhere to announce, the goal is not theirs, or the milestone is
-- not reached.
create function stayput.share_milestone(p_company text, p_user text, p_goal uuid,
                                        p_percent integer, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_to jsonb;
  v_title text;
  v_action uuid;
begin
  select s.announce_to into v_to from stayput.company_settings s
    join stayput.companies c on c.id = s.company_id
   where s.company_id = p_company and c.status = 'active' and not c.is_demo;
  if v_to is null then
    return null;
  end if;
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user and m.status = 'joined';
  if v_member is null then
    return null;
  end if;
  select g.title into v_title from stayput.goals g
   where g.company_id = p_company and g.member_id = v_member and g.id = p_goal
     and exists (select 1 from stayput.milestones ms
                  where ms.company_id = p_company and ms.goal_id = g.id
                    and ms.percent = p_percent);
  if v_title is null then
    return null;
  end if;
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, content,
                               send_at, message_kind, dedupe_key, created_at)
  values (p_company, v_member, 'milestone_announcement', 'member_request', p_goal::text,
          jsonb_build_object('platform', v_to ->> 'platform', 'channel_id', v_to ->> 'id',
                             'channel', coalesce(v_to ->> 'name', v_to ->> 'id'),
                             'goal_id', p_goal, 'goal_title', v_title, 'percent', p_percent),
          p_now, 'none', 'announce:' || p_goal || ':' || p_percent, p_now)
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_action;
  if v_action is null then
    return jsonb_build_object('duplicate', true);
  end if;
  return jsonb_build_object('id', v_action);
end
$$;

revoke all on function stayput.save_announce_to(text, jsonb) from public;
revoke all on function stayput.member_announce(text, text) from public;
revoke all on function stayput.share_milestone(text, text, uuid, integer, timestamptz)
  from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0023_announcements.sql');
end $install$;

-- ==========================================================================================
-- 0024_testimonials.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0024_testimonials.sql') then
    raise notice 'already applied: 0024_testimonials.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, points 6 and 7: the testimonial card and its public page /v/:proofId. The member
-- makes a card of one of their results: its proof (the screenshot's, or a declared one made then)
-- becomes public with only what they agreed to show, frozen at that moment (a later change of
-- name or goal never alters a page others saw). They can take it down at any time.

-- One proof per result: the screenshot's, or the declared one a card makes.
create unique index proofs_one_per_result on stayput.proofs (company_id, result_id)
  where result_id is not null;

-- The member makes (or makes again) the card of a result of theirs: what the public page shows,
-- its proof's id and level. Null when the result is not theirs.
create function stayput.make_testimonial(p_company text, p_user text, p_result uuid,
                                         p_show_name boolean, p_affiliate text,
                                         p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_name text;
  v_display jsonb;
  v_proof uuid;
  v_level text;
begin
  select m.id, nullif(trim(coalesce(m.display_name, '')), ''),
         jsonb_build_object(
           'published', true,
           'community', c.name,
           'locale', c.locale,
           'goal', g.title,
           'unit', g.unit,
           'entry', g.entry,
           'start', g.start_value::float8,
           'target', g.target_value::float8,
           'value', r.value::float8,
           'progress', stayput.goal_progress(g.start_value, g.target_value, r.value),
           'recordedAt', r.recorded_at,
           -- Its day in the community's time zone: the card and its page show the same date.
           'day', to_char(r.recorded_at at time zone c.timezone, 'YYYY-MM-DD'),
           'publishedAt', p_now)
    into v_member, v_name, v_display
    from stayput.results r
    join stayput.goals g on g.company_id = r.company_id and g.id = r.goal_id
    join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
    join stayput.companies c on c.id = r.company_id
   where r.company_id = p_company and r.id = p_result and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  -- Only what the member agreed to: their name when they ticked it, their own link.
  v_display := v_display
    || jsonb_build_object('name', case when p_show_name then v_name end,
                          'affiliateUrl', p_affiliate);
  -- The result's proof (its screenshot's) shows it; a result without one gets a declared proof.
  -- One statement: two cards asked at the same moment make one proof.
  insert into stayput.proofs (company_id, member_id, result_id, level, public_display,
                              created_at)
  values (p_company, v_member, p_result, 'declared', v_display, p_now)
  on conflict (company_id, result_id) where result_id is not null
  do update set public_display = excluded.public_display
  returning id, level into v_proof, v_level;
  return jsonb_build_object('id', v_proof, 'level', v_level, 'display', v_display);
end
$$;

-- The member takes their card's page down: nothing public is left of it.
create function stayput.unpublish_testimonial(p_company text, p_user text, p_proof uuid)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.proofs p set public_display = '{}'
   where p.company_id = p_company and p.id = p_proof
     and p.member_id = (select m.id from stayput.members m
                         where m.company_id = p_company and m.user_id = p_user);
  return found;
end
$$;

-- The member's cards online, the newest first.
create function stayput.member_cards(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'proofId', p.id, 'resultId', p.result_id, 'level', p.level,
           'display', p.public_display)
         order by p.public_display ->> 'publishedAt' desc), '[]'::jsonb)
    from stayput.proofs p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   where p.company_id = p_company and m.user_id = p_user
     and (p.public_display ->> 'published')::boolean is true;
$$;

-- The public page of a proof: what its member agreed to show, while their community uses
-- StayPut. Null for anything else (a proof never published, taken down, or unknown).
create function stayput.public_proof(p_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'level', p.level, 'display', p.public_display)
    from stayput.proofs p
    join stayput.companies c on c.id = p.company_id
   where p.id = p_id and c.status = 'active'
     and (p.public_display ->> 'published')::boolean is true;
$$;

revoke all on function stayput.make_testimonial(text, text, uuid, boolean, text, timestamptz)
  from public;
revoke all on function stayput.unpublish_testimonial(text, text, uuid) from public;
revoke all on function stayput.member_cards(text, text) from public;
revoke all on function stayput.public_proof(uuid) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0024_testimonials.sql');
end $install$;

-- ==========================================================================================
-- 0025_buddies.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0025_buddies.sql') then
    raise notice 'already applied: 0025_buddies.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, point 8: the buddies. When the creator turns them on (company_settings.options
-- .buddies, off by default), each newcomer (joined less than 7 days ago) is paired with a
-- veteran: a member for more than 30 days whose risk is low, of the same goal category when one
-- is free, with at most 3 active pairs. Newcomers the activation radar flags come first. Both
-- get an introduction (a Whop notification at their golden hour: an action like the others,
-- through the guardrails, simulated in test mode, waiting for the creator in manual mode). After
-- 30 days, a newcomer still there earns the veteran the Mentor badge. Either of them may ask
-- not to be paired; the « never contact » list is never paired.

-- When the member asked not to be paired (null: they may be).
alter table stayput.members add column buddy_optout_at timestamptz;

-- How a pair ended: done after 30 days (completed), or cut short (ended) and why.
alter table stayput.buddy_pairs
  add column ended_at timestamptz,
  add column end_reason text
    check (end_reason in ('newcomer_left', 'veteran_left', 'optout', 'do_not_contact')),
  add constraint buddy_pairs_ended check ((status = 'active') = (ended_at is null)),
  add constraint buddy_pairs_reason check ((status = 'ended') = (end_reason is not null));

-- The category a member's goal is in (the one under way, else the last reached), for pairing
-- alike; null without one, or for « other », which pairs nobody alike.
create function stayput.member_goal_category(p_company text, p_member text) returns text
language sql stable set search_path = ''
as $$
  select nullif(coalesce(g.category, 'other'), 'other')
    from stayput.goals g
   where g.company_id = p_company and g.member_id = p_member
     and g.status in ('active', 'achieved')
   order by g.status = 'active' desc, g.created_at desc, g.id
   limit 1
$$;

-- A pair cut short: its introductions not sent yet no longer go.
create function stayput.end_buddy_pair(p_company text, p_pair uuid, p_reason text,
                                       p_now timestamptz)
returns void
language plpgsql set search_path = ''
as $$
begin
  update stayput.buddy_pairs
     set status = 'ended', ended_at = p_now, end_reason = p_reason
   where company_id = p_company and id = p_pair and status = 'active';
  update stayput.actions
     set status = 'cancelled', result = jsonb_build_object('reason', 'pair_ended', 'at', p_now)
   where company_id = p_company and type in ('buddy_intro', 'mentor_intro')
     and subject_id = p_pair::text and status in ('proposed', 'approved', 'scheduled');
end
$$;

-- The hourly pairing of a company: the pairs that end, those 30 days old (the Mentor badge),
-- then the new pairs while the creator has the buddies on, each with its two introductions.
-- Returns the introductions planned.
create function stayput.plan_buddies(p_company text, p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_pair record;
  v_newcomer record;
  v_veteran record;
  v_pair_id uuid;
  v_planned integer := 0;
begin
  -- One run at a time per company: a veteran's pairs are counted, then added to.
  perform 1 from stayput.companies c
   where c.id = p_company and c.status = 'active' and not c.is_demo
     for update;
  if not found then
    return 0;
  end if;

  -- Gone, asked not to be paired, or on the « never contact » list: the pair ends.
  for v_pair in
    select p.id,
           case
             when n.status <> 'joined' then 'newcomer_left'
             when v.status <> 'joined' then 'veteran_left'
             when n.buddy_optout_at is not null or v.buddy_optout_at is not null then 'optout'
             when n.do_not_contact or v.do_not_contact then 'do_not_contact'
           end as reason
      from stayput.buddy_pairs p
      join stayput.members n on n.company_id = p.company_id and n.id = p.newcomer_member_id
      join stayput.members v on v.company_id = p.company_id and v.id = p.veteran_member_id
     where p.company_id = p_company and p.status = 'active'
  loop
    continue when v_pair.reason is null;
    perform stayput.end_buddy_pair(p_company, v_pair.id, v_pair.reason, p_now);
  end loop;

  -- 30 days on, the newcomer is still there: the veteran is a mentor.
  for v_pair in
    update stayput.buddy_pairs p
       set status = 'completed', ended_at = p_now
     where p.company_id = p_company and p.status = 'active'
       and p.paired_at <= p_now - interval '30 days'
    returning p.id, p.newcomer_member_id, p.veteran_member_id
  loop
    perform stayput.award_badge(p_company, v_pair.veteran_member_id, 'mentor', p_now,
                                jsonb_build_object('pair_id', v_pair.id,
                                                   'newcomer_id', v_pair.newcomer_member_id));
  end loop;

  if not coalesce((select (s.options ->> 'buddies')::boolean from stayput.company_settings s
                    where s.company_id = p_company), false) then
    return 0;
  end if;

  -- The newcomers without a buddy, those who have not started first, then the earliest.
  for v_newcomer in
    select m.id, nullif(split_part(coalesce(m.display_name, ''), ' ', 1), '') as first_name,
           stayput.member_goal_category(m.company_id, m.id) as category
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and m.access_level is distinct from 'admin'
       and not m.do_not_contact and m.buddy_optout_at is null
       and m.joined_at > p_now - interval '7 days' and m.joined_at <= p_now
       and not exists (select 1 from stayput.buddy_pairs p
                        where p.company_id = m.company_id and p.newcomer_member_id = m.id
                          and p.status in ('active', 'completed'))
     order by coalesce(r.inactive_newcomer, false) desc, m.joined_at, m.id
  loop
    -- A veteran with room: of the same category when one is, then the least taken, the most
    -- engaged, the longest there. At most one new pair every 5 days (the guardrails let one
    -- introduction through in that time), never the same pair twice.
    select v.id, nullif(split_part(coalesce(v.display_name, ''), ' ', 1), '') as first_name
      into v_veteran
      from stayput.members v
      join stayput.member_risk r
        on r.company_id = v.company_id and r.member_id = v.id and r.level = 'low'
      cross join lateral (
        select count(*) as active from stayput.buddy_pairs p
         where p.company_id = v.company_id and p.veteran_member_id = v.id
           and p.status = 'active') taken
     where v.company_id = p_company and v.status = 'joined'
       and v.access_level is distinct from 'admin'
       and not v.do_not_contact and v.buddy_optout_at is null
       and v.joined_at <= p_now - interval '30 days'
       and taken.active < 3
       and not exists (select 1 from stayput.buddy_pairs p
                        where p.company_id = v.company_id and p.veteran_member_id = v.id
                          and (p.paired_at > p_now - interval '5 days'
                               or p.newcomer_member_id = v_newcomer.id))
     order by (stayput.member_goal_category(v.company_id, v.id) = v_newcomer.category) is true
                desc,
              taken.active, r.score, v.joined_at, v.id
     limit 1;
    continue when v_veteran.id is null;

    insert into stayput.buddy_pairs (company_id, newcomer_member_id, veteran_member_id,
                                     paired_at)
    values (p_company, v_newcomer.id, v_veteran.id, p_now)
    returning id into v_pair_id;
    -- Each learns the other's first name; the Worker sets the time (the golden hour).
    insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                                 dedupe_key, content)
    values
      (p_company, v_newcomer.id, 'buddy_intro', 'buddy_pair', v_pair_id::text, 'relance',
       'buddy_intro:' || v_pair_id,
       jsonb_build_object('pair_id', v_pair_id, 'buddy_id', v_veteran.id,
                          'buddy_name', v_veteran.first_name)),
      (p_company, v_veteran.id, 'mentor_intro', 'buddy_pair', v_pair_id::text, 'relance',
       'mentor_intro:' || v_pair_id,
       jsonb_build_object('pair_id', v_pair_id, 'buddy_id', v_newcomer.id,
                          'buddy_name', v_newcomer.first_name));
    v_planned := v_planned + 2;
  end loop;
  return v_planned;
end
$$;

-- What the member space shows of the member's buddies: each one paired with them now (the
-- other's name, since when they are a member, their goal category when it is the member's),
-- and whether they asked not to be paired. Null for someone StayPut does not know.
create function stayput.member_buddies(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'optedOut', m.buddy_optout_at is not null,
           'partners', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'pairId', p.id,
                      -- What the other one is to the member.
                      'role', case when p.newcomer_member_id = m.id then 'veteran'
                                   else 'newcomer' end,
                      'name', o.display_name,
                      'joinedAt', o.joined_at,
                      'pairedAt', p.paired_at,
                      'sameCategory',
                        case when mine.category = stayput.member_goal_category(o.company_id, o.id)
                             then mine.category end)
                    order by p.paired_at, p.id)
               from stayput.buddy_pairs p
               join stayput.members o
                 on o.company_id = p.company_id
                and o.id = case when p.newcomer_member_id = m.id then p.veteran_member_id
                                else p.newcomer_member_id end
              where p.company_id = m.company_id and p.status = 'active'
                and m.id in (p.newcomer_member_id, p.veteran_member_id)), '[]'::jsonb))
    from stayput.members m
    cross join lateral (
      select stayput.member_goal_category(m.company_id, m.id) as category) mine
   where m.company_id = p_company and m.user_id = p_user
$$;

-- The member asks not to be paired (their pairs end), or may be again.
create function stayput.set_buddy_optout(p_company text, p_user text, p_optout boolean,
                                         p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_pair uuid;
begin
  update stayput.members m
     set buddy_optout_at = case when p_optout then coalesce(m.buddy_optout_at, p_now) end
   where m.company_id = p_company and m.user_id = p_user
  returning m.id into v_member;
  if v_member is null then
    return false;
  end if;
  if p_optout then
    for v_pair in
      select p.id from stayput.buddy_pairs p
       where p.company_id = p_company and p.status = 'active'
         and v_member in (p.newcomer_member_id, p.veteran_member_id)
    loop
      perform stayput.end_buddy_pair(p_company, v_pair, 'optout', p_now);
    end loop;
  end if;
  return true;
end
$$;

-- The creator turns the buddies on or off (the pairs under way go on to their end).
create function stayput.save_buddies(p_company text, p_enabled boolean) returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('buddies', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.member_goal_category(text, text) from public;
revoke all on function stayput.end_buddy_pair(text, uuid, text, timestamptz) from public;
revoke all on function stayput.plan_buddies(text, timestamptz) from public;
revoke all on function stayput.member_buddies(text, text) from public;
revoke all on function stayput.set_buddy_optout(text, text, boolean, timestamptz) from public;
revoke all on function stayput.save_buddies(text, boolean) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0025_buddies.sql');
end $install$;

-- ==========================================================================================
-- 0026_rescue_challenges.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0026_rescue_challenges.sql') then
    raise notice 'already applied: 0026_rescue_challenges.sql';
    return;
  end if;
  execute $migration$
-- SPEC Phase 5, point 9 (and the Phase 4 trigger): the rescue challenges. When the creator turns
-- them on (company_settings.options.rescue_challenges, off by default), a member inactive for 14
-- days becomes a challenge the community's members see in their space, anonymized: « Help a
-- member who stalled: answer their last message », with a link to that message where the
-- platform gives one (Discord, a Telegram supergroup). A member takes it up; if the stalled
-- member comes back, those who took it up before earn the « Rescuer » badge. A challenge ends
-- after 14 days, or when its member leaves or goes on the « never contact » list.

-- Where to answer the stalled member, frozen when the challenge is made: the platform, the place
-- (a server's or group's name), the link to the message when there is one, and its time.
alter table stayput.rescue_challenges
  add column last_message jsonb not null default '{}'
    check (jsonb_typeof(last_message) = 'object');
create index rescue_challenges_open on stayput.rescue_challenges (company_id, status, created_at);

-- The member's last message in the community (Whop chat, Discord, Telegram), within 90 days,
-- as a challenge shows it; null without one.
create function stayput.last_public_message(p_company text, p_member text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select case e.type
           when 'discord_message' then jsonb_build_object(
             'platform', 'discord',
             'place', g.name,
             'url', case when g.guild_id is not null then
                      'https://discord.com/channels/' || g.guild_id || '/'
                      || (e.metadata ->> 'channel_id') || '/' || e.external_id end,
             'at', e.occurred_at)
           when 'telegram_message' then jsonb_build_object(
             'platform', 'telegram',
             'place', tc.title,
             -- A supergroup's message has a link its members can open; a small group's has none.
             'url', case when e.metadata ->> 'chat_id' like '-100%' then
                      'https://t.me/c/' || substr(e.metadata ->> 'chat_id', 5) || '/'
                      || split_part(e.external_id, ':', 2) end,
             'at', e.occurred_at)
           else jsonb_build_object('platform', 'whop', 'place', null, 'url', null,
                                   'at', e.occurred_at)
         end
    from stayput.activity_events e
    left join stayput.discord_guilds g
      on e.type = 'discord_message' and g.company_id = e.company_id
     and e.metadata ->> 'channel_id' = any (g.channel_ids)
    left join stayput.telegram_chats tc
      on e.type = 'telegram_message' and tc.company_id = e.company_id
     and tc.chat_id = e.metadata ->> 'chat_id'
   where e.company_id = p_company and e.member_id = p_member
     and e.type in ('message', 'discord_message', 'telegram_message')
     and e.occurred_at > p_now - interval '90 days' and e.occurred_at <= p_now
   order by e.occurred_at desc, e.id desc
   limit 1
$$;

-- The hourly round of a company's challenges: those that end (14 days, their member gone or on
-- the « never contact » list), those whose member came back (the Rescuer badge for whoever took
-- it up before), then the new ones while the creator has them on: at most 10 open, the members
-- who stalled most recently first (the easiest to bring back). Returns the challenges made.
create function stayput.plan_rescues(p_company text, p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_challenge record;
  v_open integer;
  v_made integer := 0;
begin
  perform 1 from stayput.companies c
   where c.id = p_company and c.status = 'active' and not c.is_demo
     for update;
  if not found then
    return 0;
  end if;

  -- The member came back: any activity of theirs after the challenge was made.
  for v_challenge in
    select r.id, back.at
      from stayput.rescue_challenges r
      cross join lateral (
        select min(e.occurred_at) as at from stayput.activity_events e
         where e.company_id = r.company_id and e.member_id = r.target_member_id
           and e.occurred_at > r.created_at and e.occurred_at <= p_now) back
     where r.company_id = p_company and r.status = 'open' and back.at is not null
  loop
    update stayput.rescue_challenges set status = 'resolved', resolved_at = v_challenge.at
     where id = v_challenge.id;
    update stayput.rescue_challenge_participants p set reengaged_target = true
     where p.company_id = p_company and p.challenge_id = v_challenge.id
       and p.joined_at <= v_challenge.at;
    perform stayput.award_badge(p_company, p.member_id, 'rescuer', p_now,
                                jsonb_build_object('challenge_id', v_challenge.id))
       from stayput.rescue_challenge_participants p
      where p.company_id = p_company and p.challenge_id = v_challenge.id
        and p.reengaged_target;
  end loop;

  -- Two weeks without coming back, gone, or never to be contacted: the challenge ends.
  update stayput.rescue_challenges r
     set status = 'expired', resolved_at = p_now
    from stayput.members m
   where r.company_id = p_company and r.status = 'open'
     and m.company_id = r.company_id and m.id = r.target_member_id
     and (r.created_at <= p_now - interval '14 days' or m.status <> 'joined'
          or m.do_not_contact);

  if not coalesce((select (s.options ->> 'rescue_challenges')::boolean
                     from stayput.company_settings s where s.company_id = p_company), false) then
    return 0;
  end if;

  select count(*) into v_open from stayput.rescue_challenges r
   where r.company_id = p_company and r.status = 'open';
  insert into stayput.rescue_challenges (company_id, target_member_id, status, created_at,
                                         last_message)
  select p_company, y.id, 'open', p_now, y.last_message
    from (
      -- The last message is read only for the members who stalled (within 90 days: an older
      -- one is no conversation to answer).
      select x.id, x.last_active,
             stayput.last_public_message(p_company, x.id, p_now) as last_message
        from (
          select m.id,
                 (select max(e.occurred_at) from stayput.activity_events e
                   where e.company_id = m.company_id and e.member_id = m.id) as last_active
            from stayput.members m
           where m.company_id = p_company and m.status = 'joined'
             and m.access_level is distinct from 'admin' and not m.do_not_contact
             and m.joined_at <= p_now - interval '14 days'
             -- One challenge a month at most for the same member.
             and not exists (select 1 from stayput.rescue_challenges r
                              where r.company_id = m.company_id and r.target_member_id = m.id
                                and r.created_at > p_now - interval '30 days')) x
       where x.last_active <= p_now - interval '14 days'
         and x.last_active > p_now - interval '90 days') y
   where y.last_message is not null
   order by y.last_active desc, y.id
   limit greatest(10 - v_open, 0);
  get diagnostics v_made = row_count;
  return v_made;
end
$$;

-- The challenges a member sees: the open ones of their community, never their own, the least
-- taken up first, then whose member stalled most recently, 5 at most; with what they took up,
-- and how many members they brought back.
-- Null for someone StayPut does not know, or while the creator has the challenges off.
create function stayput.member_rescues(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'challenges', coalesce((
             select jsonb_agg(c.item order by c.helpers, c.at desc, c.id)
               from (
                 select r.id, (r.last_message ->> 'at')::timestamptz as at,
                        (select count(*) from stayput.rescue_challenge_participants p
                          where p.company_id = r.company_id and p.challenge_id = r.id) as helpers,
                        jsonb_build_object(
                          'id', r.id,
                          'platform', r.last_message ->> 'platform',
                          'place', r.last_message ->> 'place',
                          'url', r.last_message ->> 'url',
                          'lastMessageAt', r.last_message ->> 'at',
                          'createdAt', r.created_at,
                          'helpers', (select count(*) from stayput.rescue_challenge_participants p
                                       where p.company_id = r.company_id
                                         and p.challenge_id = r.id),
                          'joined', exists (select 1 from stayput.rescue_challenge_participants p
                                             where p.company_id = r.company_id
                                               and p.challenge_id = r.id
                                               and p.member_id = m.id)) as item
                   from stayput.rescue_challenges r
                  where r.company_id = m.company_id and r.status = 'open'
                    and r.target_member_id <> m.id
                  order by helpers, at desc, r.id
                  limit 5) c), '[]'::jsonb),
           'rescued', (select count(*) from stayput.rescue_challenge_participants p
                        where p.company_id = m.company_id and p.member_id = m.id
                          and p.reengaged_target))
    from stayput.members m
    join stayput.company_settings s on s.company_id = m.company_id
   where m.company_id = p_company and m.user_id = p_user
     and coalesce((s.options ->> 'rescue_challenges')::boolean, false)
$$;

-- The member takes a challenge up: an open one of their community, not about them.
create function stayput.join_rescue(p_company text, p_user text, p_challenge uuid,
                                    p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_member text;
begin
  select m.id into v_member from stayput.members m
   where m.company_id = p_company and m.user_id = p_user and m.status = 'joined';
  if v_member is null or not exists (
       select 1 from stayput.rescue_challenges r
        where r.company_id = p_company and r.id = p_challenge and r.status = 'open'
          and r.target_member_id <> v_member) then
    return false;
  end if;
  insert into stayput.rescue_challenge_participants (company_id, challenge_id, member_id,
                                                     joined_at)
  values (p_company, p_challenge, v_member, p_now)
  on conflict (challenge_id, member_id) do nothing;
  return true;
end
$$;

-- The creator turns the challenges on or off (the open ones go on to their end).
create function stayput.save_rescues(p_company text, p_enabled boolean) returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('rescue_challenges', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.last_public_message(text, text, timestamptz) from public;
revoke all on function stayput.plan_rescues(text, timestamptz) from public;
revoke all on function stayput.member_rescues(text, text) from public;
revoke all on function stayput.join_rescue(text, text, uuid, timestamptz) from public;
revoke all on function stayput.save_rescues(text, boolean) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0026_rescue_challenges.sql');
end $install$;

-- ==========================================================================================
-- 0027_dashboard.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0027_dashboard.sql') then
    raise notice 'already applied: 0027_dashboard.sql';
    return;
  end if;
  execute $migration$
-- The dashboard's home (SPEC Phase 6): the money StayPut saved, and the creator's own actions.
--
-- 1. SPEC Phase 6.4, the money saved. The decision is packages/core (attribution.ts, tested);
-- the database gathers each company's facts and keeps what was decided in `saves` (migration
-- 0003), one payment counted once. Server side only: the hourly job runs both.

-- What attributeSaves needs: what StayPut carried out over the last 120 days (sent: a simulated
-- action saves nothing), the payments that came in since and were not counted yet (of these
-- members, or with one of StayPut's codes), each message's first activity of the member in the
-- 14 days after it (opening StayPut's space aside: that is reading the message), and the billing
-- period of their memberships. Times are milliseconds since the epoch.
create function stayput.attribution_facts(p_company text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  with acts as (
    select a.id, a.member_id, a.type, a.sent_at, a.subject_id, a.result
      from stayput.actions a
     where a.company_id = p_company and a.status = 'sent' and a.sent_at is not null
       and a.sent_at > p_now - interval '120 days'
       and a.type = any (array['payment_retry', 'payment_failed_notice', 'payment_action_notice',
                               'pause_offer', 'promo_offer', 'extend_offer', 'coaching_offer',
                               'affiliate_invite', 'alumni_followup', 'high_risk_message',
                               'creator_message'])
  ), shaped as (
    select a.id, a.member_id, a.type, a.sent_at,
           coalesce(p.membership_id, s.membership_id) as membership_id,
           case when a.type like 'payment\_%' then a.subject_id end as payment_id,
           s.answered_at as accepted_at,
           coalesce(a.result ->> 'kept' = 'true', false) as kept,
           a.result ->> 'promo_code_id' as promo_code_id
      from acts a
      left join stayput.payments p
        on a.type like 'payment\_%' and p.company_id = p_company and p.id = a.subject_id
      left join stayput.exit_surveys s
        on s.company_id = p_company and s.offer_action_id = a.id
  )
  select jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sh.id, 'memberId', sh.member_id, 'type', sh.type,
               'sentAt', stayput.epoch_ms(sh.sent_at), 'membershipId', sh.membership_id,
               'paymentId', sh.payment_id,
               'acceptedAt', case when sh.accepted_at is not null
                                  then stayput.epoch_ms(sh.accepted_at) end,
               'kept', sh.kept, 'promoCodeId', sh.promo_code_id)
             order by sh.sent_at)
        from shaped sh), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'memberId', p.member_id, 'membershipId', p.membership_id,
               'status', p.status, 'amount', p.amount::float8, 'currency', upper(p.currency),
               'paidAt', stayput.epoch_ms(p.paid_at), 'promoCodeId', p.promo_code_id)
             order by p.paid_at)
        from stayput.payments p
       where p.company_id = p_company and p.paid_at is not null
         and p.paid_at > (select min(sh.sent_at) from shaped sh)
         and not exists (select 1 from stayput.saves v where v.payment_id = p.id)
         and (p.member_id in (select sh.member_id from shaped sh)
              or p.promo_code_id in (select sh.promo_code_id from shaped sh
                                      where sh.promo_code_id is not null))), '[]'::jsonb),
    'firstActivityAfter', coalesce((
      select jsonb_object_agg(sh.id, stayput.epoch_ms(f.at))
        from shaped sh
        cross join lateral (
          select min(e.occurred_at) as at from stayput.activity_events e
           where e.company_id = p_company and e.member_id = sh.member_id
             and e.occurred_at > sh.sent_at
             and e.occurred_at <= sh.sent_at + interval '14 days'
             and e.type = any (stayput.engagement_types()) and e.type <> 'stayput_open') f
       where sh.type in ('high_risk_message', 'creator_message') and f.at is not null),
      '{}'::jsonb),
    'periodDays', coalesce((
      select jsonb_object_agg(ms.id, ms.billing_period_days)
        from stayput.memberships ms
       where ms.company_id = p_company and ms.billing_period_days is not null
         and ms.member_id in (select sh.member_id from shaped sh)), '{}'::jsonb))
$$;

-- What attributeSaves decided, kept: a payment already counted is left as it was, and a save of
-- a member or an action of another company is refused.
create function stayput.record_saves(p_company text, p_saves jsonb) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into stayput.saves (company_id, member_id, action_id, save_type, category, amount,
                             currency, payment_id, proof, saved_at)
  select p_company, s ->> 'memberId', (s ->> 'actionId')::uuid, s ->> 'type', s ->> 'category',
         (s ->> 'amount')::numeric, s ->> 'currency', s ->> 'paymentId', s -> 'proof',
         to_timestamp((s ->> 'savedAt')::float8 / 1000)
    from jsonb_array_elements(p_saves) s
   where exists (select 1 from stayput.actions a
                  where a.company_id = p_company and a.id = (s ->> 'actionId')::uuid
                    and a.member_id = s ->> 'memberId')
     and exists (select 1 from stayput.payments p
                  where p.company_id = p_company and p.id = s ->> 'paymentId')
  on conflict (payment_id) where payment_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;


-- The community's logo, read from Whop with its name (refreshCompanyName): the dashboard shows
-- it next to the name (served by StayPut, /api/creator/:companyId/logo).
alter table stayput.companies
  add column logo_url text check (logo_url ~ '^https://' and char_length(logo_url) <= 2000);

-- 2. The creator's own actions from the dashboard (« Message », « Pause », « Offer »), through
-- StayPut's pipeline like every other one: the guardrails, the test mode, the journal. A message
-- is approved by the creator's click itself. An offer becomes the action that applies it only
-- once the member accepts it in their space (SPEC rule 8: their membership is touched only with
-- their consent), within 7 days.
create table stayput.creator_offers (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  membership_id text not null,
  kind text not null check (kind in ('pause_offer', 'promo_offer')),
  -- What it gives, fixed when it is made: {"days": 30} or {"percentOff": 20, "months": 3}.
  terms jsonb not null check (jsonb_typeof(terms) = 'object'),
  created_by text not null check (created_by ~ '^user_[A-Za-z0-9]+$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  outcome text not null default 'open' check (outcome in ('open', 'accepted', 'declined')),
  decided_at timestamptz,
  -- The action that applied it, once accepted.
  action_id uuid,
  unique (company_id, id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, membership_id)
    references stayput.memberships (company_id, id) on delete cascade,
  foreign key (company_id, action_id)
    references stayput.actions (company_id, id) on delete set null (action_id)
);
create index creator_offers_member
  on stayput.creator_offers (company_id, member_id, created_at desc);
alter table stayput.creator_offers enable row level security;
create policy creator_read on stayput.creator_offers for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.creator_offers to stayput_user;

-- « Message »: a word from the creator to these members, approved by the click. Never to the
-- team, a member who left or one on the « never contact » list; once a day per member at most.
create function stayput.creator_messages(p_company text, p_members text, p_user text,
                                         p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               dedupe_key, approved_at, approved_by)
  select p_company, m.id, 'creator_message', 'approved', 'creator', 'relance',
         'creator_message:' || m.id || ':' || to_char(p_now at time zone 'UTC', 'YYYY-MM-DD'),
         p_now, p_user
    from stayput.members m
   where m.company_id = p_company and m.id = any (string_to_array(p_members, ','))
     and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
     and not m.do_not_contact
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- « Pause » or « Offer »: an offer to one member, in the creator's offer settings, with the
-- message that tells them (approved by the click, through the guardrails). One open offer per
-- member at a time.
create function stayput.create_creator_offer(p_company text, p_member text, p_kind text,
                                             p_user text, p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member stayput.members;
  v_membership text;
  v_terms jsonb;
  v_offer uuid;
begin
  if p_kind not in ('pause_offer', 'promo_offer') then
    return jsonb_build_object('error', 'invalid_kind');
  end if;
  select * into v_member from stayput.members where company_id = p_company and id = p_member;
  if not found or v_member.status <> 'joined' or coalesce(v_member.access_level, '') = 'admin'
  then
    return jsonb_build_object('error', 'not_a_member');
  end if;
  if v_member.do_not_contact then
    return jsonb_build_object('error', 'do_not_contact');
  end if;
  select ms.id into v_membership from stayput.memberships ms
   where ms.company_id = p_company and ms.member_id = p_member
     and ms.status in ('trialing', 'active', 'past_due', 'canceling')
   order by ms.current_period_end desc nulls last, ms.id
   limit 1;
  if v_membership is null then
    return jsonb_build_object('error', 'no_membership');
  end if;
  if exists (select 1 from stayput.creator_offers o
              where o.company_id = p_company and o.member_id = p_member
                and o.outcome = 'open' and o.expires_at > p_now) then
    return jsonb_build_object('error', 'offer_open');
  end if;
  select case when p_kind = 'pause_offer' then jsonb_build_object('days', s.pause_days)
              else jsonb_build_object('percentOff', s.promo_percent, 'months', s.promo_months)
         end
    into v_terms
    from stayput.company_settings s where s.company_id = p_company;
  insert into stayput.creator_offers (company_id, member_id, membership_id, kind, terms,
                                      created_by, created_at, expires_at)
  values (p_company, p_member, v_membership, p_kind, v_terms, p_user, p_now,
          p_now + interval '7 days')
  returning id into v_offer;
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               subject_id, dedupe_key, content, approved_at, approved_by)
  values (p_company, p_member, 'creator_offer', 'approved', 'creator', 'relance', v_offer::text,
          'creator_offer:' || v_offer,
          jsonb_build_object('offerId', v_offer, 'kind', p_kind, 'terms', v_terms), p_now, p_user);
  return jsonb_build_object('offerId', v_offer, 'kind', p_kind, 'terms', v_terms);
end
$$;

-- The member's side: their latest offer, open or decided in the last 7 days, with what came of
-- it once accepted. Server side: the Worker checked with Whop that the user may open the space.
create function stayput.member_creator_offer(p_company text, p_user text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'id', o.id, 'kind', o.kind, 'terms', o.terms, 'expiresAt', o.expires_at,
           'outcome', case when o.outcome = 'open' and o.expires_at <= p_now then 'expired'
                           else o.outcome end,
           'action', (select jsonb_build_object('status', a.status, 'result', a.result,
                                                'error', a.error_log -> -1 ->> 'error')
                        from stayput.actions a
                       where a.company_id = o.company_id and a.id = o.action_id))
    from stayput.creator_offers o
    join stayput.members m on m.company_id = o.company_id and m.id = o.member_id
   where o.company_id = p_company and m.user_id = p_user
     and ((o.outcome = 'open' and o.expires_at > p_now)
          or o.decided_at > p_now - interval '7 days')
   order by o.created_at desc
   limit 1
$$;

-- The member accepts the offer, or declines it. Accepted, it becomes the action that applies it
-- (approved: the creator made it, the member consented), through the guardrails. A pause keeps
-- the membership (a paused membership that ends would mean nothing); a code is for a checkout.
create function stayput.decide_creator_offer(p_company text, p_user text, p_offer uuid,
                                             p_accept boolean, p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_offer stayput.creator_offers;
  v_action uuid;
begin
  select o.* into v_offer
    from stayput.creator_offers o
    join stayput.members m on m.company_id = o.company_id and m.id = o.member_id
   where o.company_id = p_company and o.id = p_offer and m.user_id = p_user
     for update of o;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_offer.outcome <> 'open' then
    return jsonb_build_object('error', 'already_decided');
  end if;
  if v_offer.expires_at <= p_now then
    return jsonb_build_object('error', 'expired');
  end if;
  if p_accept then
    -- Now: the member is there, waiting to see it applied.
    insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                 subject_id, dedupe_key, content, send_at, approved_at,
                                 approved_by)
    values (p_company, v_offer.member_id, v_offer.kind, 'approved', 'creator_offer', 'none',
            v_offer.membership_id, v_offer.kind || ':creator:' || v_offer.id,
            v_offer.terms || jsonb_build_object('keep', v_offer.kind = 'pause_offer'), p_now,
            p_now, v_offer.created_by)
    returning id into v_action;
  end if;
  update stayput.creator_offers
     set outcome = case when p_accept then 'accepted' else 'declined' end,
         decided_at = p_now, action_id = v_action
   where company_id = p_company and id = p_offer;
  return jsonb_build_object('outcome', case when p_accept then 'accepted' else 'declined' end,
                            'actionId', v_action);
end
$$;

revoke all on function stayput.attribution_facts(text, timestamptz) from public;
revoke all on function stayput.record_saves(text, jsonb) from public;
revoke all on function stayput.creator_messages(text, text, text, timestamptz) from public;
revoke all on function stayput.create_creator_offer(text, text, text, text, timestamptz)
  from public;
revoke all on function stayput.member_creator_offer(text, text, timestamptz) from public;
revoke all on function stayput.decide_creator_offer(text, text, uuid, boolean, timestamptz)
  from public;
revoke execute on all functions in schema stayput from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0027_dashboard.sql');
end $install$;

-- ==========================================================================================
-- 0028_getting_started.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0028_getting_started.sql') then
    raise notice 'already applied: 0028_getting_started.sql';
    return;
  end if;
  execute $migration$
-- The dashboard's « Getting started » card (the redesign brief, 2 October): four steps, the card
-- gone once all are done. Connecting Discord and turning an automation on are read from their own
-- tables; the other two are recorded when they happen, the first time only: the creator saved
-- their guardrails, and opened their members at risk.

alter table stayput.company_settings
  add column guardrails_saved_at timestamptz,
  add column at_risk_reviewed_at timestamptz;

-- A step of « Getting started » done: 'guardrails' or 'reviewed'. The first time stays.
create function stayput.getting_started_done(p_company text, p_step text, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if p_step = 'guardrails' then
    update stayput.company_settings
       set guardrails_saved_at = coalesce(guardrails_saved_at, p_now)
     where company_id = p_company;
  elsif p_step = 'reviewed' then
    update stayput.company_settings
       set at_risk_reviewed_at = coalesce(at_risk_reviewed_at, p_now)
     where company_id = p_company;
  else
    return false;
  end if;
  return found;
end
$$;

revoke all on function stayput.getting_started_done(text, text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0028_getting_started.sql');
end $install$;

-- ==========================================================================================
-- 0029_priority_actions.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0029_priority_actions.sql') then
    raise notice 'already applied: 0029_priority_actions.sql';
    return;
  end if;
  execute $migration$
-- The dashboard's action of the day (brief v3, 2 October): a failed payment or a member leaving
-- is never « nothing urgent ». « Retry now » asks Whop to charge again, at once, every failed
-- payment StayPut may retry, rather than at its planned hour (24 h, then 72 h after it failed,
-- 0009). The creator approved it with the click; each retry still goes through the guardrails
-- (two per payment at most, the stops, the « never contact » list) and is kept like any action.

-- The failed payments StayPut may retry now: the last payment of a member still here (the team
-- and the « never contact » list aside), failed, that Whop can retry and plans no retry of its
-- own, fewer than two retries of StayPut's made, none due within the hour. `planned`: a retry
-- already planned for later, to bring forward; else `attempt` is the one to add. Read by the
-- dashboard as the Whop user (RLS), and by stayput.retry_failed_payments.
create function stayput.payments_to_retry(p_company text, p_now timestamptz)
returns table (payment_id text, member_id text, amount numeric, currency text, planned uuid,
               attempt integer)
language sql stable set search_path = ''
as $$
  with latest as (
    select distinct on (p.member_id) p.id, p.member_id, p.amount, p.currency, p.status,
           p.retryable, p.next_payment_attempt_at
      from stayput.payments p
      join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
     where p.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin' and not m.do_not_contact
     order by p.member_id, p.whop_created_at desc, p.id
  )
  select l.id, l.member_id, l.amount, upper(l.currency), planned.id, done.n + 1
    from latest l
   cross join lateral (
     select count(*)::integer as n from stayput.actions o
      where o.company_id = p_company and o.type = 'payment_retry' and o.subject_id = l.id
        and o.status in ('sent', 'simulated')) done
    left join lateral (
     select o.id, o.send_at from stayput.actions o
      where o.company_id = p_company and o.type = 'payment_retry' and o.subject_id = l.id
        and o.status in ('proposed', 'approved', 'scheduled')
      order by o.created_at, o.id
      limit 1) planned on true
   where l.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
     and l.retryable and l.next_payment_attempt_at is null
     and done.n < 2
     and (planned.id is null or planned.send_at is null
          or planned.send_at > p_now + interval '1 hour')
     -- The next attempt was already stopped once (a guardrail, an error): not tried again here.
     and (planned.id is not null or not exists (
           select 1 from stayput.actions o
            where o.company_id = p_company
              and o.dedupe_key = 'payment_retry:' || l.id || ':' || (done.n + 1)))
$$;

-- « Retry now »: the retries planned for later are brought forward, the missing ones added, each
-- approved by the creator (p_user) and due now. Returns how many payments are being retried.
create function stayput.retry_failed_payments(p_company text, p_user text, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_moved integer;
  v_added integer;
begin
  update stayput.actions a
     set send_at = p_now,
         status = case when a.status = 'proposed' then 'approved' else a.status end,
         approved_at = coalesce(a.approved_at, p_now),
         approved_by = coalesce(a.approved_by, p_user)
    from stayput.payments_to_retry(p_company, p_now) r
   where a.company_id = p_company and a.id = r.planned;
  get diagnostics v_moved = row_count;
  insert into stayput.actions (company_id, member_id, type, status, trigger, subject_id,
                               message_kind, dedupe_key, send_at, content, approved_at,
                               approved_by)
  select p_company, r.member_id, 'payment_retry', 'approved', 'creator', r.payment_id, 'none',
         'payment_retry:' || r.payment_id || ':' || r.attempt, p_now,
         jsonb_build_object('payment_id', r.payment_id, 'attempt', r.attempt), p_now, p_user
    from stayput.payments_to_retry(p_company, p_now) r
   where r.planned is null
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_added = row_count;
  return v_moved + v_added;
end
$$;

revoke all on function stayput.payments_to_retry(text, timestamptz) from public;
grant execute on function stayput.payments_to_retry(text, timestamptz) to stayput_user;
revoke all on function stayput.retry_failed_payments(text, text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0029_priority_actions.sql');
end $install$;

-- ==========================================================================================
-- 0030_welcome.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0030_welcome.sql') then
    raise notice 'already applied: 0030_welcome.sql';
    return;
  end if;
  execute $migration$
-- The first-run welcome (brief v4 §10): four steps the first time a community opens StayPut
-- (welcome, Discord or Telegram, automatic or manual, the first audit), then never again, on any
-- device and for anyone on its team. Recorded like the steps of « Getting started » (0028): the
-- first time only, once the creator went through it or closed it.

alter table stayput.company_settings add column welcomed_at timestamptz;

-- A step done: 'guardrails', 'reviewed' or 'welcomed'. The first time stays.
create or replace function stayput.getting_started_done(p_company text, p_step text, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if p_step = 'guardrails' then
    update stayput.company_settings
       set guardrails_saved_at = coalesce(guardrails_saved_at, p_now)
     where company_id = p_company;
  elsif p_step = 'reviewed' then
    update stayput.company_settings
       set at_risk_reviewed_at = coalesce(at_risk_reviewed_at, p_now)
     where company_id = p_company;
  elsif p_step = 'welcomed' then
    update stayput.company_settings
       set welcomed_at = coalesce(welcomed_at, p_now)
     where company_id = p_company;
  else
    return false;
  end if;
  return found;
end
$$;
$migration$;
  insert into stayput.schema_migrations (name) values ('0030_welcome.sql');
end $install$;

-- ==========================================================================================
-- 0031_platform_messages_by.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0031_platform_messages_by.sql') then
    raise notice 'already applied: 0031_platform_messages_by.sql';
    return;
  end if;
  execute $migration$
-- Fix prompt v4.1, block 4: the messages of Integrations › Activity add up with the members'
-- own. Each platform also says its messages by who wrote them: the members' part is exactly what
-- their own 30 days add up to (each member's drawer); the rest is the team's, guests' and the
-- accounts' not tied yet. Nothing else changes in platform_activity (0014).
create or replace function stayput.platform_activity(p_company text, p_now timestamptz)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), days as (
    select ((p_now at time zone z.tz)::date - g)::date as day
      from zone z, generate_series(0, 29) g
  ), messages as (
    select case e.type when 'discord_message' then 'discord' else 'telegram' end as platform,
           e.member_id, null::text as account_id, e.occurred_at, e.metadata
      from stayput.activity_events e
     where e.company_id = p_company and e.type in ('discord_message', 'telegram_message')
       and e.occurred_at > p_now - interval '31 days'
    union all
    select split_part(p.user_id, ':', 1), null, split_part(p.user_id, ':', 2), p.occurred_at,
           p.metadata
      from stayput.pending_activity p
     where p.company_id = p_company and p.user_id ~ '^(discord|telegram):'
       and p.occurred_at > p_now - interval '31 days'
  ), authored as (
    select m.platform, m.occurred_at, m.metadata,
           m.member_id,
           coalesce(m.member_id, m.platform || ':' || m.account_id) as author,
           case when mem.access_level = 'admin' then 'team'
                when m.member_id is not null then 'member'
                when pa.dismissed_as = 'team' then 'team'
                when pa.dismissed_as = 'guest' then 'guest'
                else 'unlinked' end as kind,
           (m.occurred_at at time zone (select tz from zone))::date as day
      from messages m
      left join stayput.members mem on mem.company_id = p_company and mem.id = m.member_id
      left join stayput.platform_accounts pa
        on pa.company_id = p_company and pa.platform = m.platform and pa.account_id = m.account_id
  ), recent as (
    select * from authored where day >= (select min(day) from days)
  ), places as (
    select r.platform,
           case r.platform
             when 'telegram' then r.metadata ->> 'chat_id'
             else coalesce((select g.guild_id from stayput.discord_guilds g
                             where g.company_id = p_company
                               and r.metadata ->> 'channel_id' = any (g.channel_ids)
                             limit 1), '')
           end as place,
           r.occurred_at
      from recent r
  ), top_members as (
    select r.member_id, count(*) filter (where r.platform = 'discord') as discord,
           count(*) filter (where r.platform = 'telegram') as telegram,
           count(*) as total, max(r.occurred_at) as last_at
      from recent r
     where r.kind = 'member'
     group by r.member_id
     order by count(*) desc, max(r.occurred_at) desc
     limit 5
  )
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'from', (select min(day) from days),
    'to', (select max(day) from days),
    'platforms', (
      select jsonb_agg(jsonb_build_object(
               'platform', p.platform,
               'messages', (select count(*) from recent r where r.platform = p.platform),
               'messagesBy', jsonb_build_object(
                 'members', (select count(*) from recent r
                              where r.platform = p.platform and r.kind = 'member'),
                 'team', (select count(*) from recent r
                           where r.platform = p.platform and r.kind = 'team'),
                 'guests', (select count(*) from recent r
                             where r.platform = p.platform and r.kind = 'guest'),
                 'unlinked', (select count(*) from recent r
                               where r.platform = p.platform and r.kind = 'unlinked')),
               'authors', (select count(distinct r.author) from recent r
                            where r.platform = p.platform),
               'members', (select count(distinct r.author) from recent r
                            where r.platform = p.platform and r.kind = 'member'),
               'team', (select count(distinct r.author) from recent r
                         where r.platform = p.platform and r.kind = 'team'),
               'guests', (select count(distinct r.author) from recent r
                           where r.platform = p.platform and r.kind = 'guest'),
               'unlinked', (select count(distinct r.author) from recent r
                             where r.platform = p.platform and r.kind = 'unlinked'),
               'lastAt', (select max(r.occurred_at) from recent r where r.platform = p.platform),
               'daily', (select jsonb_agg(coalesce(n.messages, 0) order by d.day)
                           from days d
                           left join (select r.day, count(*) as messages from recent r
                                       where r.platform = p.platform group by r.day) n
                             on n.day = d.day))
             order by p.platform)
        from (values ('discord'), ('telegram')) p (platform)),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', x.platform, 'id', nullif(x.place, ''),
               'name', case x.platform
                         when 'telegram' then (select t.title from stayput.telegram_chats t
                                                where t.chat_id = x.place
                                                  and t.company_id = p_company)
                         else (select g.name from stayput.discord_guilds g
                                where g.guild_id = x.place and g.company_id = p_company)
                       end,
               'messages', x.messages, 'lastAt', x.last_at)
             order by x.messages desc, x.last_at desc)
        from (select pl.platform, pl.place, count(*) as messages,
                     max(pl.occurred_at) as last_at
                from places pl group by pl.platform, pl.place
                order by count(*) desc limit 10) x), '[]'),
    'topMembers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.member_id, 'name', mem.display_name, 'discord', t.discord,
               'telegram', t.telegram, 'lastAt', t.last_at)
             order by t.total desc, t.last_at desc)
        from top_members t
        join stayput.members mem on mem.company_id = p_company and mem.id = t.member_id), '[]'))
  end
$$;

revoke all on function stayput.platform_activity(text, timestamptz) from public;
grant execute on function stayput.platform_activity(text, timestamptz) to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0031_platform_messages_by.sql');
end $install$;

-- ==========================================================================================
-- 0032_rule_switches.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0032_rule_switches.sql') then
    raise notice 'already applied: 0032_rule_switches.sql';
    return;
  end if;
  execute $migration$
-- Fix prompt v4.1, block 7 (Automations › Rules, brief v4 §9.4): the creator turns each rule
-- on or off. A rule turned off plans nothing more; what it planned before stays where it is (the
-- queue shows it, the creator approves or skips it). The rules, as Automations › Rules names
-- them: payment_retry (Whop charges a failed payment again), payment_notice (the member is asked
-- to update their card, or to confirm a 3D Secure check), exit_survey (the departure survey),
-- check_in (a personal message when a score turns high), welcome (a newcomer who has not
-- started). Nothing else changes in plan_actions (0009).
alter table stayput.company_settings
  add column rules_off text[] not null default '{}'
  check (rules_off <@ array['payment_retry', 'payment_notice', 'exit_survey', 'check_in',
                            'welcome']::text[]);

-- Turns one rule on or off; answers the rules now off, in a stable order.
create function stayput.set_rule(p_company text, p_rule text, p_on boolean) returns text[]
language plpgsql set search_path = ''
as $$
declare
  v_off text[];
begin
  if p_rule <> all (array['payment_retry', 'payment_notice', 'exit_survey', 'check_in',
                          'welcome']) then
    raise exception 'unknown rule %', p_rule;
  end if;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set rules_off = case
           when p_on then array_remove(rules_off, p_rule)
           else array(select distinct r from unnest(rules_off || p_rule) r order by r)
         end
   where company_id = p_company
  returning rules_off into v_off;
  return v_off;
end
$$;

create or replace function stayput.plan_actions(p_company text, p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_planned integer := 0;
  v_count integer;
  -- The rules the creator turned off (Automations › Rules): they plan nothing.
  v_off text[];
begin
  if not exists (select 1 from stayput.companies
                  where id = p_company and status = 'active' and not is_demo) then
    return 0;
  end if;
  select s.rules_off into v_off
    from stayput.company_settings s where s.company_id = p_company;
  v_off := coalesce(v_off, '{}');

  -- A payment waiting for its 3D Secure check (as risk_features reads it): the member gets the
  -- way to confirm it.
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select p.company_id, p.member_id, 'payment_action_notice', 'payment_requires_action', p.id,
         'service', 'payment_action_notice:' || p.id, p_now,
         jsonb_build_object('payment_id', p.id)
    from stayput.payments p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   where p.company_id = p_company and p.recovery_url is not null
     and p.status = any (array['open', 'pending', 'incomplete', 'requires_action',
                               'requires_capture'])
     and p.whop_created_at > p_now - interval '3 days'
     and m.status = 'joined' and m.access_level is distinct from 'admin'
     and not ('payment_notice' = any (v_off))
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- A failed payment: the member is asked to update their payment method…
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select p.company_id, p.member_id, 'payment_failed_notice', 'payment_failed', p.id, 'service',
         'payment_failed_notice:' || p.id, p_now, jsonb_build_object('payment_id', p.id)
    from stayput.payments p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   where p.company_id = p_company
     and p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
     and p.whop_created_at > p_now - interval '3 days'
     and m.status = 'joined' and m.access_level is distinct from 'admin'
     and not ('payment_notice' = any (v_off))
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- …and Whop is asked to charge it again 24 h, then 72 h after it failed, only when Whop can
  -- retry it and plans no retry of its own (decision of 30/09/2026). The second once the first
  -- was made.
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select p.company_id, p.member_id, 'payment_retry', 'payment_failed', p.id, 'none',
         'payment_retry:' || p.id || ':' || attempt.n,
         p.whop_created_at + make_interval(hours => attempt.hours),
         jsonb_build_object('payment_id', p.id, 'attempt', attempt.n)
    from stayput.payments p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   cross join (values (1, 24), (2, 72)) as attempt (n, hours)
   where p.company_id = p_company
     and p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
     and p.retryable and p.next_payment_attempt_at is null
     and p.whop_created_at > p_now - make_interval(hours => attempt.hours + 24)
     and (attempt.n = 1 or exists (
           select 1 from stayput.actions a
            where a.company_id = p.company_id
              and a.dedupe_key = 'payment_retry:' || p.id || ':1'
              and a.status in ('sent', 'simulated')))
     and m.status = 'joined' and m.access_level is distinct from 'admin'
     and not ('payment_retry' = any (v_off))
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- A cancellation at period end: the one-click departure survey, once per period.
  insert into stayput.actions (company_id, member_id, type, trigger, subject_id, message_kind,
                               dedupe_key, send_at, content)
  select ms.company_id, ms.member_id, 'exit_survey', 'cancel_at_period_end', ms.id, 'service',
         'exit_survey:' || ms.id || ':' || to_char(ms.current_period_end, 'YYYY-MM-DD'), p_now,
         jsonb_build_object('membership_id', ms.id, 'period_end', ms.current_period_end)
    from stayput.memberships ms
    join stayput.members m on m.company_id = ms.company_id and m.id = ms.member_id
   where ms.company_id = p_company
     and (ms.cancel_at_period_end or ms.status = 'canceling')
     and ms.status = any (array['trialing', 'active', 'past_due', 'canceling'])
     and ms.current_period_end > p_now
     and m.status = 'joined' and m.access_level is distinct from 'admin'
     and not ('exit_survey' = any (v_off))
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- A score that turned high in the last two days: a personal message at the hour the member is
  -- usually online (the Worker sets the time).
  insert into stayput.actions (company_id, member_id, type, trigger, message_kind, dedupe_key,
                               content)
  select r.company_id, r.member_id, 'high_risk_message', 'score_high', 'relance',
         'high_risk_message:' || r.member_id || ':' || to_char(r.level_since, 'YYYY-MM-DD'),
         jsonb_build_object('score', r.score)
    from stayput.member_risk r
    join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
   where r.company_id = p_company and r.level = 'high'
     and r.previous_level is distinct from 'high'
     and r.level_since > p_now - interval '2 days'
     and m.status = 'joined' and m.access_level is distinct from 'admin'
     and not ('check_in' = any (v_off))
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_planned := v_planned + v_count;

  -- The activation radar: welcome once a new member who has not started.
  insert into stayput.actions (company_id, member_id, type, trigger, message_kind, dedupe_key,
                               send_at)
  select r.company_id, r.member_id, 'welcome_message', 'activation_radar', 'relance',
         'welcome_message:' || r.member_id, p_now
    from stayput.member_risk r
    join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
   where r.company_id = p_company and r.inactive_newcomer
     and m.status = 'joined' and m.access_level is distinct from 'admin'
     and not ('welcome' = any (v_off))
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_planned + v_count;
end
$$;

revoke all on function stayput.set_rule(text, text, boolean) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0032_rule_switches.sql');
end $install$;

-- ==========================================================================================
-- 0033_platform_dashboards.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0033_platform_dashboards.sql') then
    raise notice 'already applied: 0033_platform_dashboards.sql';
    return;
  end if;
  execute $migration$
-- Fix prompt v4.1, block 7 (brief v4 §9.6): Integrations › Discord and Integrations › Telegram,
-- each a dashboard of its own. What a creator sees there, read from what StayPut already keeps
-- (who wrote, where and when; never what): the members active and gone silent, the messages per
-- day (everyone, and the members at risk today), when the community writes (day × hour), each
-- channel, group and topic, the most active and the silent members. And the signals: what a
-- platform says of a member (gone quiet, writes less, left the server or group), each adding the
-- points the creator gives it to the risk score, off until they turn it on.

-- 1. Where messages were written, by name: a Discord server's channels as Discord last gave them
--    (the dashboard never asks Discord on the way), and the topics of a Telegram forum group.
alter table stayput.discord_guilds
  add column channel_names jsonb not null default '{}'
    check (jsonb_typeof(channel_names) = 'object'),
  add column channel_names_at timestamptz;

create table stayput.telegram_topics (
  company_id text not null references stayput.companies (id) on delete cascade,
  chat_id text not null,
  topic_id text not null check (topic_id ~ '^[0-9]{1,20}$'),
  -- The topic's name, from the message that created it or an edit; null until StayPut sees one.
  name text check (char_length(name) <= 200),
  seen_at timestamptz not null,
  primary key (company_id, chat_id, topic_id)
);
alter table stayput.telegram_topics enable row level security;
create policy creator_read on stayput.telegram_topics for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.telegram_topics to stayput_user;

-- The dashboards read a company's messages of one kind over 91 days.
create index activity_events_company_type_time
  on stayput.activity_events (company_id, type, occurred_at);

-- The text channels of a server, as Discord just listed them ([{id, name, category}]): their
-- names replace the ones kept. Returns how many are named, 0 for a server not the company's.
create function stayput.note_discord_channels(p_company text, p_guild text, p_channels jsonb,
                                              p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_names jsonb;
begin
  select coalesce(jsonb_object_agg(c ->> 'id', jsonb_strip_nulls(jsonb_build_object(
           'name', left(c ->> 'name', 100), 'category', left(c ->> 'category', 100)))), '{}')
    into v_names
    from jsonb_array_elements(case jsonb_typeof(p_channels)
                                when 'array' then p_channels else '[]' end) c
   where c ->> 'id' ~ '^[0-9]{5,25}$' and coalesce(c ->> 'name', '') <> '';
  update stayput.discord_guilds set channel_names = v_names, channel_names_at = p_now
   where guild_id = p_guild and company_id = p_company;
  if not found then
    return 0;
  end if;
  return (select count(*) from jsonb_object_keys(v_names));
end
$$;

-- A topic of a connected Telegram group: created or renamed (a service message), or named by
-- the creation message a topic's messages answer. False for a group not connected.
create function stayput.note_telegram_topic(p_chat text, p_topic text, p_name text,
                                            p_at timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_company text;
begin
  if coalesce(p_topic, '') !~ '^[0-9]{1,20}$' then
    return false;
  end if;
  select company_id into v_company from stayput.telegram_chats
   where chat_id = p_chat and left_at is null;
  if v_company is null then
    return false;
  end if;
  insert into stayput.telegram_topics as t (company_id, chat_id, topic_id, name, seen_at)
  values (v_company, p_chat, p_topic, nullif(left(btrim(coalesce(p_name, '')), 200), ''),
          coalesce(p_at, now()))
  on conflict (company_id, chat_id, topic_id) do update set
    name = coalesce(excluded.name, t.name),
    seen_at = greatest(t.seen_at, excluded.seen_at);
  return true;
end
$$;

-- As in 0017, and the topic a message was written in (a forum group's), when it has one.
create function stayput.record_telegram_message(p_chat text, p_from text, p_message_id text,
                                                p_at timestamptz, p_name text, p_username text,
                                                p_topic text) returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_company text;
  v_topic text := case when coalesce(p_topic, '') ~ '^[0-9]{1,20}$' then p_topic end;
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
  if v_topic is not null then
    insert into stayput.telegram_topics as t (company_id, chat_id, topic_id, seen_at)
    values (v_company, p_chat, v_topic, p_at)
    on conflict (company_id, chat_id, topic_id) do update set
      seen_at = greatest(t.seen_at, excluded.seen_at);
  end if;
  return stayput.record_platform_activity(v_company, 'telegram', p_from, 'telegram_message',
                                          p_chat || ':' || p_message_id, p_at,
                                          jsonb_build_object('chat_id', p_chat,
                                                             'topic_id', v_topic));
end
$$;

-- 2. The signals, per platform: {discord: {silent: {on, points}, drop: {…}, left: {…}},
--    telegram: {…}}; a platform not saved yet has StayPut's defaults (packages/core, risk.ts).
alter table stayput.company_settings
  add column platform_signals jsonb not null default '{}'
    check (jsonb_typeof(platform_signals) = 'object');

-- What a member's score was made of beyond its five factors: {base: the score before the
-- signals' points, discord: the signals that hold for them there (1 gone quiet, 2 writes less,
-- 4 left), telegram: the same, rule: 1 a departure scheduled, 2 a payment failed, 0 neither}. The
-- dashboards preview the scores other settings would give from it, without computing anything.
alter table stayput.member_risk
  add column signals jsonb not null default '{}' check (jsonb_typeof(signals) = 'object');

-- A platform's signals as the creator set them; every score is due again. Returns all of them.
create function stayput.set_platform_signals(p_company text, p_platform text, p_signals jsonb,
                                             p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_clean jsonb := '{}';
  v_signal text;
  v_value jsonb;
  v_points numeric;
  v_all jsonb;
begin
  if coalesce(p_platform, '') not in ('discord', 'telegram') then
    raise exception 'unknown platform %', p_platform;
  end if;
  foreach v_signal in array array['silent', 'drop', 'left'] loop
    v_value := p_signals -> v_signal;
    if coalesce(jsonb_typeof(v_value -> 'on'), '') <> 'boolean'
       or coalesce(jsonb_typeof(v_value -> 'points'), '') <> 'number' then
      raise exception 'invalid signal %', v_signal;
    end if;
    v_points := (v_value ->> 'points')::numeric;
    if v_points < 0 or v_points > 30 or v_points <> trunc(v_points) then
      raise exception 'invalid points for signal %', v_signal;
    end if;
    v_clean := v_clean || jsonb_build_object(v_signal, jsonb_build_object(
      'on', (v_value ->> 'on')::boolean, 'points', v_points::integer));
  end loop;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set platform_signals = platform_signals || jsonb_build_object(p_platform, v_clean)
   where company_id = p_company
  returning platform_signals into v_all;
  update stayput.member_risk set computed_at = least(computed_at, p_now - interval '1 hour')
   where company_id = p_company;
  return v_all;
end
$$;

-- 3. As in 0018, with the signals' settings, and each member's messages on Discord and Telegram:
--    [… as in 0008, discord7d, discordPrev28d, discordLastAt, discordLeftAt, telegram7d,
--    telegramPrev28d, telegramLastAt, telegramLeftAt]. A member left a platform when every
--    connected server or group StayPut saw their account in says they left.
create or replace function stayput.risk_features(p_company text, p_now timestamptz, p_limit integer)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_settings jsonb;
  v_members jsonb;
begin
  select coalesce(c.timezone, 'UTC') into v_tz from stayput.companies c where c.id = p_company;
  if v_tz is null then
    return jsonb_build_object('settings', null, 'members', '[]'::jsonb);
  end if;
  v_today := (p_now at time zone v_tz)::date;
  select jsonb_build_object(
           'weights', jsonb_build_object(
             'recency', s.weight_recency::float8, 'frequency', s.weight_frequency::float8,
             'progress', s.weight_progress::float8, 'payment', s.weight_payment::float8,
             'friction', s.weight_friction::float8),
           'recencyThresholdDays', s.recency_threshold_days,
           'mediumFrom', s.medium_risk_from,
           'highFrom', s.high_risk_from,
           -- Courses read from Whop, or lessons and goals on record: progress counts.
           'tracksProgress',
             exists (select 1 from stayput.sync_state t
                      where t.company_id = p_company and t.stream like 'lesson_interactions:%')
             or exists (select 1 from stayput.activity_events e
                         where e.company_id = p_company
                           and e.type in ('lesson_completed', 'goal_update')
                           and e.external_id is not null),
           'platformSignals', s.platform_signals)
    into v_settings
    from stayput.company_settings s where s.company_id = p_company;
  v_settings := coalesce(v_settings, jsonb_build_object(
    'weights', jsonb_build_object('recency', 0.3, 'frequency', 0.25, 'progress', 0.2,
                                  'payment', 0.15, 'friction', 0.1),
    'recencyThresholdDays', 14, 'mediumFrom', 40, 'highFrom', 70, 'tracksProgress', false,
    'platformSignals', '{}'::jsonb));

  with due as (
    select m.id, m.joined_at, m.last_action_at, m.discord_user_id, m.telegram_user_id
      from stayput.members m
      left join stayput.member_risk r on r.company_id = m.company_id and r.member_id = m.id
     where m.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
       and not exists (select 1 from stayput.alumni_members a
                        where a.company_id = m.company_id and a.member_id = m.id
                          and a.status = 'entered')
       and (r.computed_at is null or r.computed_at <= p_now - interval '50 minutes')
     order by r.computed_at nulls first, m.id
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_array(
           d.id,
           stayput.epoch_ms(d.joined_at),
           stayput.epoch_ms(greatest(last_event.at, d.last_action_at)),
           coalesce(stats.activity_7d, 0),
           coalesce(stats.activity_prev_28d, 0),
           stayput.epoch_ms(progress.at),
           progress.title,
           case
             when payment.failed or exists (
               select 1 from stayput.memberships ms
                where ms.company_id = p_company and ms.member_id = d.id
                  and ms.status = 'past_due') then 'failed'
             when payment.action_required then 'action_required'
             else 'ok'
           end,
           cancel.at is not null,
           stayput.epoch_ms(cancel.at),
           stayput.epoch_ms(ticket.since),
           coalesce(stats.reactions_14d, 0),
           coalesce(stats.reactions_prev_14d, 0),
           coalesce(joined.active, false),
           coalesce(discord.week, 0),
           coalesce(discord.before, 0),
           stayput.epoch_ms(discord.last_at),
           stayput.epoch_ms(discord_left.at),
           coalesce(telegram.week, 0),
           coalesce(telegram.before, 0),
           stayput.epoch_ms(telegram.last_at),
           stayput.epoch_ms(telegram_left.at)
         ) order by d.id), '[]'::jsonb)
    into v_members
    from due d
    left join lateral (
      select e.occurred_at as at from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type = any (stayput.engagement_types())
       order by e.occurred_at desc limit 1) last_event on true
    left join lateral (
      select sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day > v_today - 7)::integer
               as activity_7d,
             sum(s.messages + s.reactions + s.lessons_completed + s.forum_posts
                 + s.stayput_actions) filter (where s.day <= v_today - 7)::integer
               as activity_prev_28d,
             sum(s.reactions) filter (where s.day > v_today - 14)::integer as reactions_14d,
             sum(s.reactions) filter (where s.day <= v_today - 14 and s.day > v_today - 28)::integer
               as reactions_prev_14d
        from stayput.member_stats_daily s
       where s.company_id = p_company and s.member_id = d.id and s.day > v_today - 35) stats
      on true
    left join lateral (
      select e.occurred_at as at, e.metadata ->> 'lesson_title' as title
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id
         and e.type in ('lesson_completed', 'goal_update')
       order by e.occurred_at desc limit 1) progress on true
    left join lateral (
      select p.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
               as failed,
             p.recovery_url is not null
               and p.status = any (array['open', 'pending', 'incomplete', 'requires_action',
                                         'requires_capture']) as action_required
        from stayput.payments p
       where p.company_id = p_company and p.member_id = d.id
       order by p.whop_created_at desc limit 1) payment on true
    left join lateral (
      select min(ms.current_period_end) as at
        from stayput.memberships ms
       where ms.company_id = p_company and ms.member_id = d.id
         and ms.status = any (array['trialing', 'active', 'past_due', 'canceling', 'completed'])
         and (ms.cancel_at_period_end or ms.status = 'canceling')
      having count(*) > 0) cancel on true
    left join lateral (
      -- A support conversation whose last event is the member's, not a resolution.
      select min(t.occurred_at) as since from (
        select distinct on (e.metadata ->> 'channel_id') e.type, e.occurred_at
          from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type in ('support_ticket_opened', 'support_ticket_resolved')
         order by e.metadata ->> 'channel_id', e.occurred_at desc) t
       where t.type = 'support_ticket_opened') ticket on true
    left join lateral (
      select exists (
        select 1 from stayput.activity_events e
         where e.company_id = p_company and e.member_id = d.id
           and e.type = any (stayput.engagement_types())
           and e.occurred_at >= d.joined_at) as active) joined on true
    -- Their messages on each platform: this week's (the last 7 days of the company's calendar),
    -- the 4 weeks' before, and the last one of those 5 weeks.
    left join lateral (
      select count(*) filter (where (e.occurred_at at time zone v_tz)::date > v_today - 7)
               ::integer as week,
             count(*) filter (where (e.occurred_at at time zone v_tz)::date <= v_today - 7)
               ::integer as before,
             max(e.occurred_at) as last_at
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id and e.type = 'discord_message'
         and e.occurred_at > p_now - interval '36 days'
         and (e.occurred_at at time zone v_tz)::date > v_today - 35) discord on true
    left join lateral (
      select count(*) filter (where (e.occurred_at at time zone v_tz)::date > v_today - 7)
               ::integer as week,
             count(*) filter (where (e.occurred_at at time zone v_tz)::date <= v_today - 7)
               ::integer as before,
             max(e.occurred_at) as last_at
        from stayput.activity_events e
       where e.company_id = p_company and e.member_id = d.id and e.type = 'telegram_message'
         and e.occurred_at > p_now - interval '36 days'
         and (e.occurred_at at time zone v_tz)::date > v_today - 35) telegram on true
    left join lateral (
      select max(pp.left_at) as at
        from stayput.platform_presence pp
       where pp.company_id = p_company and pp.platform = 'discord'
         and pp.account_id = d.discord_user_id
         and pp.place_id in (select g.guild_id from stayput.discord_guilds g
                              where g.company_id = p_company)
      having bool_and(pp.left_at is not null)) discord_left on true
    left join lateral (
      select max(pp.left_at) as at
        from stayput.platform_presence pp
       where pp.company_id = p_company and pp.platform = 'telegram'
         and pp.account_id = d.telegram_user_id
         and pp.place_id in (select t.chat_id from stayput.telegram_chats t
                              where t.company_id = p_company and t.left_at is null)
      having bool_and(pp.left_at is not null)) telegram_left on true;

  return jsonb_build_object('settings', v_settings, 'members', v_members);
end
$$;

-- 4. As in 0008, and what each score was made of beyond its five factors (the 7th element:
--    {base, discord, telegram, rule}, see member_risk.signals).
create or replace function stayput.save_risk_scores(p_company text, p_scores jsonb,
                                                    p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_tz text;
  v_saved integer;
begin
  select coalesce(timezone, 'UTC') into v_tz from stayput.companies where id = p_company;
  if v_tz is null then
    return 0;
  end if;
  with input as (
    select s ->> 0 as member_id,
           (s ->> 1)::smallint as score,
           s ->> 2 as level,
           jsonb_build_object('recency', s -> 3 -> 0, 'frequency', s -> 3 -> 1,
                              'progress', s -> 3 -> 2, 'payment', s -> 3 -> 3,
                              'friction', s -> 3 -> 4) as sub_scores,
           coalesce(s -> 4, '[]'::jsonb) as reasons,
           coalesce((s ->> 5)::boolean, false) as newcomer,
           case jsonb_typeof(s -> 6) when 'object' then s -> 6 else '{}'::jsonb end as signals
      from jsonb_array_elements(p_scores) s
  ), kept as (
    select i.* from input i
      join stayput.members m on m.company_id = p_company and m.id = i.member_id
     where m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
  ), current as (
    insert into stayput.member_risk as r (company_id, member_id, score, level, sub_scores,
                                          reasons, inactive_newcomer, level_since,
                                          previous_level, computed_at, signals)
    select p_company, member_id, score, level, sub_scores, reasons, newcomer, p_now, null, p_now,
           signals
      from kept
    on conflict (company_id, member_id) do update set
      score = excluded.score,
      level = excluded.level,
      sub_scores = excluded.sub_scores,
      reasons = excluded.reasons,
      inactive_newcomer = excluded.inactive_newcomer,
      previous_level = case when r.level <> excluded.level then r.level else r.previous_level end,
      level_since = case when r.level <> excluded.level then excluded.computed_at
                         else r.level_since end,
      computed_at = excluded.computed_at,
      signals = excluded.signals
    returning member_id, score, level, sub_scores, reasons
  )
  insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores, reasons,
                                   computed_at, day)
  select p_company, member_id, score, level, sub_scores, reasons, p_now,
         (p_now at time zone v_tz)::date
    from current
  on conflict (company_id, member_id, day) do update set
    score = excluded.score,
    level = excluded.level,
    sub_scores = excluded.sub_scores,
    reasons = excluded.reasons,
    computed_at = excluded.computed_at;
  get diagnostics v_saved = row_count;

  delete from stayput.member_risk r
   using stayput.members m
   where r.company_id = p_company and m.company_id = r.company_id and m.id = r.member_id
     and (m.status <> 'joined' or coalesce(m.access_level, '') = 'admin');
  return v_saved;
end
$$;

-- 5. The dashboards. A platform's messages since a moment: who wrote them (a member, the team, a
--    guest, an account not tied yet) and where (a Discord channel; a Telegram group, then its
--    topic after a colon, empty outside topics). Read by the functions below only.
create function stayput.platform_messages(p_company text, p_platform text, p_since timestamptz)
returns table (member_id text, account_id text, occurred_at timestamptz, place text, kind text)
language sql stable set search_path = ''
as $$
  select m.member_id, m.account_id, m.occurred_at,
         case p_platform
           when 'discord' then coalesce(m.metadata ->> 'channel_id', '')
           else coalesce(m.metadata ->> 'chat_id', '') || ':'
                || coalesce(m.metadata ->> 'topic_id', '')
         end,
         case when mem.access_level = 'admin' then 'team'
              when m.member_id is not null then 'member'
              when pa.dismissed_as = 'team' then 'team'
              when pa.dismissed_as = 'guest' then 'guest'
              else 'unlinked' end
    from (
      select e.member_id, null::text as account_id, e.occurred_at, e.metadata
        from stayput.activity_events e
       where e.company_id = p_company and e.type = p_platform || '_message'
         and e.occurred_at > p_since
      union all
      select null, split_part(p.user_id, ':', 2), p.occurred_at, p.metadata
        from stayput.pending_activity p
       where p.company_id = p_company and p.user_id like p_platform || ':%'
         and p.occurred_at > p_since
    ) m
    left join stayput.members mem on mem.company_id = p_company and mem.id = m.member_id
    left join stayput.platform_accounts pa
      on pa.company_id = p_company and pa.platform = p_platform and pa.account_id = m.account_id
$$;

-- The places StayPut knows on a platform, by name: Discord's channels (`followed` when StayPut
-- reads them), Telegram's groups (`followed` while connected) and their topics. A group with
-- topics is a forum: its own place holds the messages written outside them (`general`).
create function stayput.platform_places(p_company text, p_platform text)
returns table (place text, kind text, name text, parent text, followed boolean)
language sql stable set search_path = ''
as $$
  select c.id, 'channel', g.channel_names -> c.id ->> 'name', g.name, c.id = any (g.channel_ids)
    from stayput.discord_guilds g
   cross join lateral (select jsonb_object_keys(g.channel_names) as id
                       union select unnest(g.channel_ids)) c
   where p_platform = 'discord' and g.company_id = p_company
  union all
  select t.chat_id || ':',
         case when exists (select 1 from stayput.telegram_topics o
                            where o.company_id = p_company and o.chat_id = t.chat_id)
              then 'general' else 'group' end,
         t.title, null, t.left_at is null
    from stayput.telegram_chats t
   where p_platform = 'telegram' and t.company_id = p_company
  union all
  select o.chat_id || ':' || o.topic_id, 'topic', o.name, t.title, t.left_at is null
    from stayput.telegram_topics o
    join stayput.telegram_chats t on t.chat_id = o.chat_id and t.company_id = o.company_id
   where p_platform = 'telegram' and o.company_id = p_company
$$;

-- Integrations › Discord or › Telegram (brief v4 §9.6), in the company's calendar, for its team
-- only: the three figures of the top (members active these 7 days, members gone silent, messages
-- over 30 days), the messages of each of the 30 days (everyone's, the members', the members' at
-- risk today), when they were written (day of the week × hour), each channel, group and topic
-- with its 3 most active members, the members most active and gone silent over 7, 14 and 30
-- days, and the signals: their settings, and the members' scores as made (member_risk.signals),
-- grouped, for the preview.
create function stayput.platform_dashboard(p_company text, p_platform text, p_now timestamptz)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), today as (
    select (p_now at time zone z.tz)::date as day, z.tz from zone z
  ), days as (
    select (t.day - g)::date as day from today t, generate_series(0, 29) g
  ), authored as (
    select m.*, (m.occurred_at at time zone t.tz) as local_at
      from stayput.platform_messages(p_company, p_platform, p_now - interval '91 days') m,
           today t
     where (m.occurred_at at time zone t.tz)::date > t.day - 90
  ), recent as (
    select a.*, a.local_at::date as day,
           coalesce(r.level in ('high', 'scheduled_departure'), false) as at_risk
      from authored a
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = a.member_id
     where a.local_at::date > (select day from today) - 30
  ), people as (
    -- The community's members who wrote there over 90 days, the team aside.
    select a.member_id,
           count(*) filter (where a.local_at::date > t.day - 7) as d7,
           count(*) filter (where a.local_at::date > t.day - 14) as d14,
           count(*) filter (where a.local_at::date > t.day - 30) as d30,
           count(*) as d90,
           max(a.occurred_at) as last_at,
           mem.display_name as name, r.score, r.level
      from authored a
      cross join today t
      join stayput.members mem on mem.company_id = p_company and mem.id = a.member_id
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = a.member_id
     where a.kind = 'member' and mem.status = 'joined'
     group by a.member_id, mem.display_name, r.score, r.level
  ), names as (
    select * from stayput.platform_places(p_company, p_platform)
  ), counts as (
    select r.place, count(*) as messages,
           count(distinct r.member_id) filter (where r.kind = 'member') as members,
           max(r.occurred_at) as last_at
      from recent r group by r.place
  ), leaders as (
    select x.place,
           jsonb_agg(jsonb_build_object('id', x.member_id, 'name', mem.display_name,
                                        'messages', x.n) order by x.n desc, x.member_id) as top
      from (select r.place, r.member_id, count(*) as n,
                   row_number() over (partition by r.place
                                      order by count(*) desc, r.member_id) as rank
              from recent r where r.kind = 'member' group by r.place, r.member_id) x
      join stayput.members mem on mem.company_id = p_company and mem.id = x.member_id
     where x.rank <= 3
     group by x.place
  ), places as (
    select coalesce(n.place, c.place) as place,
           coalesce(n.kind, case p_platform when 'discord' then 'channel' else 'group' end)
             as kind,
           n.name, n.parent,
           coalesce(c.messages, 0) as messages, coalesce(c.members, 0) as members, c.last_at
      from names n
      full join counts c on c.place = n.place
     where c.place is not null or (n.followed and n.kind <> 'topic')
  ), made as (
    -- The members' scores as made, for the preview of other settings.
    select coalesce((r.signals ->> 'base')::integer, r.score::integer) as base,
           coalesce((r.signals ->> 'discord')::integer, 0) as discord,
           coalesce((r.signals ->> 'telegram')::integer, 0) as telegram,
           coalesce((r.signals ->> 'rule')::integer,
                    case r.level when 'scheduled_departure' then 1 else 0 end) as rule,
           count(*) as n
      from stayput.member_risk r
      join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
     where r.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin'
     group by 1, 2, 3, 4
  ), lists as (
    select w.days,
           (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', a.member_id, 'name', a.name, 'messages', a.n, 'lastAt', a.last_at,
                      'score', a.score, 'level', a.level)
                    order by a.n desc, a.last_at desc, a.member_id), '[]')
              from (select pe.member_id, pe.name, pe.last_at, pe.score, pe.level,
                           case w.days when 7 then pe.d7 when 14 then pe.d14 else pe.d30 end as n
                      from people pe
                     where (case w.days when 7 then pe.d7 when 14 then pe.d14
                                        else pe.d30 end) > 0
                     order by n desc, pe.last_at desc, pe.member_id
                     limit 10) a) as active,
           (select count(*) from people pe
             where (case w.days when 7 then pe.d7 when 14 then pe.d14 else pe.d30 end) = 0)
             as silent_total,
           (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', s.member_id, 'name', s.name, 'messages', s.d90,
                      'lastAt', s.last_at, 'score', s.score, 'level', s.level)
                    order by s.score desc nulls last, s.last_at desc, s.member_id), '[]')
              from (select pe.* from people pe
                     where (case w.days when 7 then pe.d7 when 14 then pe.d14
                                        else pe.d30 end) = 0
                     order by pe.score desc nulls last, pe.last_at desc, pe.member_id
                     limit 10) s) as silent
      from (values (7), (14), (30)) w (days)
  )
  select case when stayput.is_company_admin(p_company)
                   and p_platform in ('discord', 'telegram') then jsonb_build_object(
    'platform', p_platform,
    'from', (select min(day) from days),
    'to', (select max(day) from days),
    'hero', jsonb_build_object(
      'activeMembers7d', (select count(*) from people where d7 > 0),
      'silentMembers7d', (select count(*) from people where d7 = 0),
      'messages30d', (select count(*) from recent),
      'memberMessages30d', (select count(*) from recent where kind = 'member')),
    'daily', (
      select jsonb_agg(jsonb_build_object(
               'day', d.day, 'messages', coalesce(n.messages, 0),
               'members', coalesce(n.members, 0), 'atRisk', coalesce(n.at_risk, 0))
             order by d.day)
        from days d
        left join (select r.day, count(*) as messages,
                          count(*) filter (where r.kind = 'member') as members,
                          count(*) filter (where r.kind = 'member' and r.at_risk) as at_risk
                     from recent r group by r.day) n on n.day = d.day),
    'heatmap', coalesce((
      select jsonb_agg(jsonb_build_object('dow', h.dow, 'hour', h.hour,
                                          'messages', h.messages, 'members', h.members)
                       order by h.dow, h.hour)
        from (select extract(isodow from r.local_at)::integer as dow,
                     extract(hour from r.local_at)::integer as hour,
                     count(*) as messages,
                     count(distinct r.member_id) filter (where r.kind = 'member') as members
                from recent r group by 1, 2) h), '[]'),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.place, 'kind', p.kind, 'name', p.name, 'parent', p.parent,
               'messages', p.messages, 'members', p.members, 'lastAt', p.last_at,
               'top', coalesce(t.top, '[]'))
             order by p.messages desc, p.name nulls last, p.place)
        from places p left join leaders t on t.place = p.place), '[]'),
    'active', (select jsonb_object_agg('d' || l.days, l.active) from lists l),
    'silent', (select jsonb_object_agg('d' || l.days, jsonb_build_object(
                        'total', l.silent_total, 'members', l.silent)) from lists l),
    'signals', jsonb_build_object(
      'settings', coalesce((select s.platform_signals from stayput.company_settings s
                             where s.company_id = p_company), '{}'),
      'mediumFrom', coalesce((select s.medium_risk_from from stayput.company_settings s
                               where s.company_id = p_company), 40),
      'highFrom', coalesce((select s.high_risk_from from stayput.company_settings s
                             where s.company_id = p_company), 70),
      'groups', coalesce((select jsonb_agg(jsonb_build_array(g.base, g.discord, g.telegram,
                                                             g.rule, g.n)
                                           order by g.base, g.discord, g.telegram, g.rule)
                            from made g), '[]')))
  end
$$;

-- A day of the chart, picked: its messages, each place with its 3 most active members, and the
-- members who wrote that day, the most first.
create function stayput.platform_day(p_company text, p_platform text, p_now timestamptz,
                                     p_day date) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), picked as (
    select m.*
      from stayput.platform_messages(p_company, p_platform, p_now - interval '32 days') m, zone z
     where (m.occurred_at at time zone z.tz)::date = p_day
  ), names as (
    select * from stayput.platform_places(p_company, p_platform)
  ), counts as (
    select p.place, count(*) as messages,
           count(distinct p.member_id) filter (where p.kind = 'member') as members,
           max(p.occurred_at) as last_at
      from picked p group by p.place
  ), leaders as (
    select x.place,
           jsonb_agg(jsonb_build_object('id', x.member_id, 'name', mem.display_name,
                                        'messages', x.n) order by x.n desc, x.member_id) as top
      from (select p.place, p.member_id, count(*) as n,
                   row_number() over (partition by p.place
                                      order by count(*) desc, p.member_id) as rank
              from picked p where p.kind = 'member' group by p.place, p.member_id) x
      join stayput.members mem on mem.company_id = p_company and mem.id = x.member_id
     where x.rank <= 3
     group by x.place
  ), people as (
    select p.member_id, count(*) as n, max(p.occurred_at) as last_at,
           mem.display_name as name, r.score, r.level
      from picked p
      join stayput.members mem on mem.company_id = p_company and mem.id = p.member_id
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = p.member_id
     where p.kind = 'member' and mem.status = 'joined'
     group by p.member_id, mem.display_name, r.score, r.level
  )
  select case when stayput.is_company_admin(p_company)
                   and p_platform in ('discord', 'telegram') then jsonb_build_object(
    'day', p_day,
    'messages', (select count(*) from picked),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.place,
               'kind', coalesce(n.kind, case p_platform when 'discord' then 'channel'
                                                        else 'group' end),
               'name', n.name, 'parent', n.parent, 'messages', c.messages,
               'members', c.members, 'lastAt', c.last_at, 'top', coalesce(t.top, '[]'))
             order by c.messages desc, n.name nulls last, c.place)
        from counts c
        left join names n on n.place = c.place
        left join leaders t on t.place = c.place), '[]'),
    'active', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.member_id, 'name', x.name,
                                          'messages', x.n, 'lastAt', x.last_at,
                                          'score', x.score, 'level', x.level)
                       order by x.n desc, x.last_at desc, x.member_id)
        from (select * from people order by n desc, last_at desc, member_id limit 20) x), '[]'))
  end
$$;

-- A cell of the heatmap, picked (a day of the week, 1 Monday to 7 Sunday, and an hour of the
-- company's calendar): over the 30 days, the members who wrote then, the most first, and how
-- many messages others wrote (the team, guests, accounts not tied yet).
create function stayput.platform_slot(p_company text, p_platform text, p_now timestamptz,
                                      p_dow integer, p_hour integer) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with zone as (
    select coalesce((select c.timezone from stayput.companies c where c.id = p_company), 'UTC')
             as tz
  ), today as (
    select (p_now at time zone z.tz)::date as day, z.tz from zone z
  ), picked as (
    select m.*
      from stayput.platform_messages(p_company, p_platform, p_now - interval '32 days') m,
           today t
     where (m.occurred_at at time zone t.tz)::date > t.day - 30
       and extract(isodow from m.occurred_at at time zone t.tz) = p_dow
       and extract(hour from m.occurred_at at time zone t.tz) = p_hour
  ), people as (
    select p.member_id, count(*) as n, max(p.occurred_at) as last_at,
           mem.display_name as name, r.score, r.level
      from picked p
      join stayput.members mem on mem.company_id = p_company and mem.id = p.member_id
      left join stayput.member_risk r on r.company_id = p_company and r.member_id = p.member_id
     where p.kind = 'member' and mem.status = 'joined'
     group by p.member_id, mem.display_name, r.score, r.level
  )
  select case when stayput.is_company_admin(p_company)
                   and p_platform in ('discord', 'telegram') then jsonb_build_object(
    'dow', p_dow,
    'hour', p_hour,
    'messages', (select count(*) from picked),
    'others', (select count(*) from picked p
                where p.member_id is null or p.member_id not in (select member_id from people)),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.member_id, 'name', x.name,
                                          'messages', x.n, 'lastAt', x.last_at,
                                          'score', x.score, 'level', x.level)
                       order by x.n desc, x.last_at desc, x.member_id)
        from (select * from people order by n desc, last_at desc, member_id limit 50) x), '[]'))
  end
$$;

-- Everyone on Discord and in Telegram, each platform in its own tab now: 500 people at most per
-- platform (a big server no longer hides the group's people), and each platform's total.
create or replace function stayput.platform_people(p_company text, p_now timestamptz) returns jsonb
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
    'totals', jsonb_build_object(
      'discord', (select count(*) from people where platform = 'discord'),
      'telegram', (select count(*) from people where platform = 'telegram')),
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
        from (select * from (
                select people.*, row_number() over (
                         partition by platform
                         order by last_at desc nulls last, here desc nulls last,
                                  joined_at desc nulls last, display_name, account_id) as rank
                  from people) ranked
               where rank <= 500) x), '[]'))
  end
$$;

revoke all on function stayput.note_discord_channels(text, text, jsonb, timestamptz) from public;
revoke all on function stayput.note_telegram_topic(text, text, text, timestamptz) from public;
revoke all on function stayput.record_telegram_message(text, text, text, timestamptz, text, text,
                                                       text) from public;
revoke all on function stayput.set_platform_signals(text, text, jsonb, timestamptz) from public;
revoke all on function stayput.platform_messages(text, text, timestamptz) from public;
revoke all on function stayput.platform_places(text, text) from public;
revoke all on function stayput.platform_dashboard(text, text, timestamptz) from public;
revoke all on function stayput.platform_day(text, text, timestamptz, date) from public;
revoke all on function stayput.platform_slot(text, text, timestamptz, integer, integer)
  from public;
-- Read as the creator: each checks they administer the company.
grant execute on function stayput.platform_dashboard(text, text, timestamptz) to stayput_user;
grant execute on function stayput.platform_day(text, text, timestamptz, date) to stayput_user;
grant execute on function stayput.platform_slot(text, text, timestamptz, integer, integer)
  to stayput_user;
$migration$;
  insert into stayput.schema_migrations (name) values ('0033_platform_dashboards.sql');
end $install$;

-- ==========================================================================================
-- 0034_discount_on_membership.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0034_discount_on_membership.sql') then
    raise notice 'already applied: 0034_discount_on_membership.sql';
    return;
  end if;
  execute $migration$
-- A member's discount goes on their membership (fix of 2026-10-04, after block 7): a member's
-- renewals pass no checkout where a code could be typed, so StayPut applies the code to the
-- membership itself (Whop's POST /memberships/{id}/apply_promo_code). A discount, like a pause,
-- then needs the membership to continue: accepting the creator's discount keeps it too, as
-- accepting their pause did. The Worker withdraws a cancellation only when one is scheduled
-- (actions.ts), and applies the discount before it: a member never stays at the full price.

create or replace function stayput.decide_creator_offer(p_company text, p_user text, p_offer uuid,
                                             p_accept boolean, p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_offer stayput.creator_offers;
  v_action uuid;
begin
  select o.* into v_offer
    from stayput.creator_offers o
    join stayput.members m on m.company_id = o.company_id and m.id = o.member_id
   where o.company_id = p_company and o.id = p_offer and m.user_id = p_user
     for update of o;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_offer.outcome <> 'open' then
    return jsonb_build_object('error', 'already_decided');
  end if;
  if v_offer.expires_at <= p_now then
    return jsonb_build_object('error', 'expired');
  end if;
  if p_accept then
    -- Now: the member is there, waiting to see it applied.
    insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                 subject_id, dedupe_key, content, send_at, approved_at,
                                 approved_by)
    values (p_company, v_offer.member_id, v_offer.kind, 'approved', 'creator_offer', 'none',
            v_offer.membership_id, v_offer.kind || ':creator:' || v_offer.id,
            v_offer.terms
              || jsonb_build_object('keep', v_offer.kind in ('pause_offer', 'promo_offer')),
            p_now, p_now, v_offer.created_by)
    returning id into v_action;
  end if;
  update stayput.creator_offers
     set outcome = case when p_accept then 'accepted' else 'declined' end,
         decided_at = p_now, action_id = v_action
   where company_id = p_company and id = p_offer;
  return jsonb_build_object('outcome', case when p_accept then 'accepted' else 'declined' end,
                            'actionId', v_action);
end
$$;
$migration$;
  insert into stayput.schema_migrations (name) values ('0034_discount_on_membership.sql');
end $install$;

-- ==========================================================================================
-- 0035_weekly_reports.sql
-- ==========================================================================================

do $install$
begin
  if exists (select 1 from stayput.schema_migrations where name = '0035_weekly_reports.sql') then
    raise notice 'already applied: 0035_weekly_reports.sql';
    return;
  end if;
  execute $migration$
-- The Monday report (SPEC Phase 6.9): every Monday from 8:00 in the community's time zone, the
-- week before (members saved and lost, money saved, why members left) and the week's priority,
-- sent to the community's team as a Whop notification. Each report is kept as made, with when
-- Whop took it: the dashboard lists them (Analytics › Reports), and a report is sent only once.
-- On by default; the team turns it off from that page (company_settings.options.weekly_report).

create table stayput.weekly_reports (
  company_id text not null references stayput.companies (id) on delete cascade,
  -- The Monday the reported week began, in the community's time zone.
  week_start date not null check (extract(isodow from week_start) = 1),
  -- packages/core WeeklyReport, as made on Monday morning.
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  created_at timestamptz not null,
  -- When Whop took the notification; while it did not, the attempts and Whop's last answer.
  sent_at timestamptz,
  attempts smallint not null default 0 check (attempts >= 0),
  error text check (char_length(error) <= 500),
  primary key (company_id, week_start)
);

alter table stayput.weekly_reports enable row level security;
create policy creator_read on stayput.weekly_reports for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.weekly_reports to stayput_user;

-- The communities whose report is due at p_now: Monday from 8:00 where they are, the report on,
-- installed before that Monday, that week's report neither sent nor given up (3 attempts, one an
-- hour). The demo communities never get one. The week reported is the one that just ended.
create function stayput.weekly_reports_due(p_now timestamptz, p_limit integer)
returns table (company_id text, week_start date, zone text, locale text)
language sql stable set search_path = ''
as $$
  select c.id, (l.local::date - 7), c.timezone, c.locale
    from stayput.companies c
    left join stayput.company_settings s on s.company_id = c.id
   cross join lateral (select p_now at time zone c.timezone as local) l
   where c.status = 'active' and not c.is_demo
     and coalesce((s.options ->> 'weekly_report')::boolean, true)
     and extract(isodow from l.local) = 1 and extract(hour from l.local) >= 8
     and c.installed_at < (l.local::date::timestamp at time zone c.timezone)
     and not exists (
       select 1 from stayput.weekly_reports r
        where r.company_id = c.id and r.week_start = l.local::date - 7
          and (r.sent_at is not null or r.attempts >= 3))
   order by c.id
   limit p_limit
$$;

-- The report on or off, as the team sets it.
create function stayput.save_weekly_report_setting(p_company text, p_enabled boolean)
returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('weekly_report', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.weekly_reports_due(timestamptz, integer) from public;
revoke all on function stayput.save_weekly_report_setting(text, boolean) from public;
$migration$;
  insert into stayput.schema_migrations (name) values ('0035_weekly_reports.sql');
end $install$;

commit;
