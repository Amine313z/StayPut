-- StayPut's plans (decision of 2026-10-10): Free, Pro, Scale, and 20 founders. The level belongs
-- to the community: Scale when the company's owner has access to StayPut's Scale product on Whop,
-- else Pro when to its Pro product, else Free (packages/core/src/plans.ts says what each opens).
-- Prices, trials and discounts are Whop's: none is kept here. Nothing in this migration deletes
-- or changes a community's data: a community back on Free keeps everything, its automations and
-- follow-ups only wait.

-- 1. Whose access gives the level: the company's owner, as Whop's company says it (owner_user).
alter table stayput.companies
  add column owner_user_id text check (owner_user_id ~ '^user_[A-Za-z0-9]+$');

-- 2. Each community's level as last known. Read again from Whop after `fresh_until` (5 minutes),
--    at once after a membership webhook (`fresh_until` emptied); when Whop does not answer, the
--    last known level stays (`failed_at`). `companies.plan` follows it, for the SPEC's schema.
create table stayput.company_plans (
  company_id text primary key references stayput.companies (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'pro', 'scale')),
  source text not null default 'none' check (source in ('whop', 'founder_fallback', 'none')),
  owner_user_id text check (owner_user_id ~ '^user_[A-Za-z0-9]+$'),
  -- The owner's StayPut membership behind the level (Whop's), when known.
  membership_id text check (membership_id ~ '^mem_[A-Za-z0-9]+$'),
  plan_id text check (plan_id ~ '^plan_[A-Za-z0-9]+$'),
  -- Whop's trial under way: when it ends (the first charge).
  trial_ends_at timestamptz,
  checked_at timestamptz,
  fresh_until timestamptz,
  failed_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  -- The automatic mode was turned to manual because the level no longer opens it (Scale's
  -- autopilot): turned back on when the level does again.
  autopilot_paused boolean not null default false,
  changed_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger company_plans_touch before update on stayput.company_plans
  for each row execute function stayput.touch_updated_at();
alter table stayput.company_plans enable row level security;

-- The level the Worker last stored for a community. None stored: plans are off (no products
-- configured), or the community was never read; it keeps everything then. Plans on, the Worker
-- reads each community before the hourly actions and the Monday reports (jobs.ts), and stores
-- Free for one Whop never answered for.
create function stayput.company_tier(p_company text) returns text
language sql stable set search_path = ''
as $$
  select coalesce((select p.tier from stayput.company_plans p where p.company_id = p_company),
                  'scale')
$$;

-- 3. StayPut's own memberships as Whop tells them (its membership webhooks, and the readings of
--    the owner's access): which plan, whether a trial runs and until when. By user: a membership
--    is a person's, the communities they own have its level.
create table stayput.app_memberships (
  id text primary key check (id ~ '^mem_[A-Za-z0-9]+$'),
  user_id text not null check (user_id ~ '^user_[A-Za-z0-9]+$'),
  product_id text check (product_id ~ '^prod_[A-Za-z0-9]+$'),
  plan_id text check (plan_id ~ '^plan_[A-Za-z0-9]+$'),
  status text not null check (status ~ '^[a-z_]{1,40}$'),
  renewal_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null
);
create index app_memberships_user on stayput.app_memberships (user_id);
alter table stayput.app_memberships enable row level security;

-- 4. Free's manual actions (Message, Pause, Offer), counted per community and month, in the
--    community's time zone: a new month starts from zero.
create table stayput.manual_action_counts (
  company_id text not null references stayput.companies (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  used integer not null default 0 check (used >= 0),
  primary key (company_id, month)
);
alter table stayput.manual_action_counts enable row level security;

create function stayput.action_month(p_company text, p_now timestamptz) returns date
language sql stable set search_path = ''
as $$
  select date_trunc('month', p_now at time zone coalesce(
           (select c.timezone from stayput.companies c where c.id = p_company), 'UTC'))::date
$$;

-- Takes `p_count` of this month's manual actions when `p_limit` leaves room for all of them, at
-- once (two clicks at the same time never pass the limit together). `{ ok, used, limit }`.
create function stayput.take_manual_actions(p_company text, p_count integer, p_limit integer,
                                            p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_month date := stayput.action_month(p_company, p_now);
  v_used integer;
begin
  if p_count < 1 then
    raise exception 'take_manual_actions: a count of 1 or more';
  end if;
  insert into stayput.manual_action_counts (company_id, month, used)
  values (p_company, v_month, 0)
  on conflict (company_id, month) do nothing;
  update stayput.manual_action_counts set used = used + p_count
   where company_id = p_company and month = v_month and used + p_count <= p_limit
  returning used into v_used;
  if v_used is null then
    select used into v_used from stayput.manual_action_counts
     where company_id = p_company and month = v_month;
    return jsonb_build_object('ok', false, 'used', v_used, 'limit', p_limit);
  end if;
  return jsonb_build_object('ok', true, 'used', v_used, 'limit', p_limit);
end
$$;

-- Gives back what was taken for actions that could not be made (a member gone, an offer open).
create function stayput.give_back_manual_actions(p_company text, p_count integer,
                                                 p_now timestamptz) returns integer
language sql set search_path = ''
as $$
  update stayput.manual_action_counts set used = greatest(used - p_count, 0)
   where company_id = p_company and month = stayput.action_month(p_company, p_now)
  returning used
$$;

-- This month's count.
create function stayput.manual_actions_used(p_company text, p_now timestamptz) returns integer
language sql stable set search_path = ''
as $$
  select coalesce((select n.used from stayput.manual_action_counts n
                    where n.company_id = p_company
                      and n.month = stayput.action_month(p_company, p_now)), 0)
$$;

-- 5. The founders' registry: 20 places. It opens nothing (the founders' plan on Whop does): it
--    says who was invited, shows the founders' banner and its reminders, and catches a company
--    that bought the founders' plan without being invited (a link that leaked): `flagged`. Not
--    tied to companies: a founder can be invited before installing StayPut, and the registry
--    outlives an uninstall.
create table stayput.founders (
  company_id text primary key check (company_id ~ '^biz_[A-Za-z0-9]+$'),
  invited_at timestamptz not null,
  status text not null default 'invited' check (status in ('invited', 'subscribed', 'flagged')),
  note text check (char_length(note) <= 500),
  updated_at timestamptz not null default now()
);
create trigger founders_touch before update on stayput.founders
  for each row execute function stayput.touch_updated_at();
alter table stayput.founders enable row level security;

-- Invites a community, while places are left (invited and subscribed count; flagged do not).
-- `{ ok, left }`, or `{ ok: false, error: 'full' | 'exists' }`.
create function stayput.invite_founder(p_company text, p_note text, p_places integer,
                                       p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_taken integer;
begin
  -- One invitation at a time: two never take the last place together.
  lock table stayput.founders in share row exclusive mode;
  if exists (select 1 from stayput.founders f where f.company_id = p_company) then
    return jsonb_build_object('ok', false, 'error', 'exists');
  end if;
  select count(*) into v_taken from stayput.founders f where f.status <> 'flagged';
  if v_taken >= p_places then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;
  insert into stayput.founders (company_id, invited_at, note)
  values (p_company, p_now, nullif(btrim(left(p_note, 500)), ''));
  return jsonb_build_object('ok', true, 'left', p_places - v_taken - 1);
end
$$;

-- The founders' plan was bought for this community: `subscribed` when it was invited, else
-- `flagged` (added to the registry as such). Returns the status.
create function stayput.note_founder_plan(p_company text, p_now timestamptz) returns text
language plpgsql set search_path = ''
as $$
declare
  v_status text;
begin
  insert into stayput.founders (company_id, invited_at, status, note)
  values (p_company, p_now, 'flagged', 'Bought the founders'' plan without an invitation')
  on conflict (company_id) do update
    set status = case stayput.founders.status when 'invited' then 'subscribed'
                                               else stayput.founders.status end
  returning status into v_status;
  return v_status;
end
$$;

-- 6. Free communities: StayPut's automatic actions wait (no new one is planned: the Worker; and
--    those already scheduled are not run: below), the creator's own still leave. Nothing is
--    deleted: back on Pro or Scale, they run. As in 0016, with the level.
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
         and (a.approved_by is distinct from 'auto' or stayput.company_tier(c.id) <> 'free')
       order by a.send_at
       limit p_limit) x;
$$;

-- The Monday report is Pro's and Scale's. As in 0035, with the level.
create or replace function stayput.weekly_reports_due(p_now timestamptz, p_limit integer)
returns table (company_id text, week_start date, zone text, locale text)
language sql stable set search_path = ''
as $$
  select c.id, (l.local::date - 7), c.timezone, c.locale
    from stayput.companies c
    left join stayput.company_settings s on s.company_id = c.id
   cross join lateral (select p_now at time zone c.timezone as local) l
   where c.status = 'active' and not c.is_demo
     and coalesce((s.options ->> 'weekly_report')::boolean, true)
     and stayput.company_tier(c.id) <> 'free'
     and extract(isodow from l.local) = 1 and extract(hour from l.local) >= 8
     and c.installed_at < (l.local::date::timestamp at time zone c.timezone)
     and not exists (
       select 1 from stayput.weekly_reports r
        where r.company_id = c.id and r.week_start = l.local::date - 7
          and (r.sent_at is not null or r.attempts >= 3))
   order by c.id
   limit p_limit
$$;

revoke all on function stayput.company_tier(text) from public;
revoke all on function stayput.action_month(text, timestamptz) from public;
revoke all on function stayput.take_manual_actions(text, integer, integer, timestamptz)
  from public;
revoke all on function stayput.give_back_manual_actions(text, integer, timestamptz) from public;
revoke all on function stayput.manual_actions_used(text, timestamptz) from public;
revoke all on function stayput.invite_founder(text, text, integer, timestamptz) from public;
revoke all on function stayput.note_founder_plan(text, timestamptz) from public;
revoke all on function stayput.due_actions(timestamptz, integer) from public;
revoke all on function stayput.weekly_reports_due(timestamptz, integer) from public;
revoke execute on all functions in schema stayput from public;
