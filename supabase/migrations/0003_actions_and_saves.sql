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
