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
