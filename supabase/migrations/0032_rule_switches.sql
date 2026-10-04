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
