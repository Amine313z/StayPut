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
