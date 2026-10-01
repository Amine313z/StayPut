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
