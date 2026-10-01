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
