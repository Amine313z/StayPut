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
