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
