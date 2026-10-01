-- SPEC 5.2 and Phase 4: the quiet hours, the golden hour and the default hour are the creator's
-- local hours. companies.timezone has said 'UTC' since 0001, a default nobody chose: the
-- creator's browser now tells the zone on their first visit, and the creator changes it in the
-- action settings. Because the zone or the hours may change after an action was scheduled, the
-- run checks the quiet hours again when an action's time comes.

-- When the company's zone was set (by the creator's browser or by the creator); null while it
-- is still StayPut's default.
alter table stayput.companies add column timezone_set_at timestamptz;

-- The company's time zone. With p_only_if_unset (the zone a creator's browser reports), only
-- while the company has none of its own yet. Returns the zone in effect afterwards, or null when
-- Postgres does not know p_timezone (nothing changes then).
create function stayput.set_company_timezone(p_company text, p_timezone text,
                                             p_only_if_unset boolean, p_now timestamptz)
returns text
language plpgsql set search_path = ''
as $$
declare
  v_previous text;
  v_unset boolean;
begin
  select c.timezone, c.timezone_set_at is null into v_previous, v_unset
    from stayput.companies c
   where c.id = p_company
     for update;
  if not found then
    raise exception 'unknown company %', p_company;
  end if;
  if p_only_if_unset and not v_unset then
    return v_previous;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    return null;
  end if;
  update stayput.companies set timezone = p_timezone, timezone_set_at = p_now
   where id = p_company;
  -- The days and hours of activity are local ones: counted again in the new zone.
  if p_timezone is distinct from v_previous then
    perform stayput.mark_stats_dirty(p_company, p_now - interval '90 days');
  end if;
  return p_timezone;
end
$$;

-- The run's needs, as in 0010, with the zone and the quiet hours they are checked against.
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

-- A message whose time came during the quiet hours waits for their end. Not an attempt: nothing
-- was tried. False when the action no longer waits.
create function stayput.postpone_action(p_id uuid, p_send_at timestamptz) returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.actions set send_at = p_send_at
   where id = p_id and status = 'scheduled' and send_at < p_send_at;
  return found;
end
$$;

revoke all on function stayput.set_company_timezone(text, text, boolean, timestamptz) from public;
revoke all on function stayput.postpone_action(uuid, timestamptz) from public;
