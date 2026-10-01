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
