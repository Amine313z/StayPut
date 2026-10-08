-- « Message » on a member: words the creator writes themselves, sent word for word as a Whop
-- notification (DECISIONS.md, 2026-10-08). Not a follow-up of StayPut's: the follow-up caps
-- (one every 5 days, 4 a month) do not hold it back, but it counts in the member's history
-- (`message_kind` 'service'), so that no follow-up of StayPut's comes on its heels. The other
-- guardrails hold: the stops, « never contact », the quiet hours (it waits for their end), test
-- mode (simulated). Three a day per member at most, against a double send or a slip.
create function stayput.create_creator_note(p_company text, p_member text, p_title text,
                                            p_body text, p_user text, p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member stayput.members;
  v_action uuid;
  v_settings jsonb;
begin
  select * into v_member from stayput.members
   where company_id = p_company and id = p_member
     for update;
  if not found or v_member.status <> 'joined' or coalesce(v_member.access_level, '') = 'admin'
  then
    return jsonb_build_object('error', 'not_a_member');
  end if;
  if v_member.do_not_contact then
    return jsonb_build_object('error', 'do_not_contact');
  end if;
  if (select count(*) from stayput.actions a
       where a.company_id = p_company and a.member_id = p_member and a.type = 'creator_note'
         and a.created_at > p_now - interval '24 hours'
         and a.status not in ('cancelled', 'blocked_by_guardrail', 'failed')) >= 3 then
    return jsonb_build_object('error', 'too_many_notes');
  end if;
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               content, send_at, approved_at, approved_by, created_at)
  values (p_company, p_member, 'creator_note', 'approved', 'creator', 'service',
          jsonb_build_object('title', p_title, 'body', p_body, 'from', p_user),
          p_now, p_now, p_user, p_now)
  returning id into v_action;
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  select jsonb_build_object('timezone', c.timezone, 'quietHoursStart', s.quiet_hours_start,
                            'quietHoursEnd', s.quiet_hours_end, 'dryRun', s.dry_run)
    into v_settings
    from stayput.companies c join stayput.company_settings s on s.company_id = c.id
   where c.id = p_company;
  return jsonb_build_object('actionId', v_action) || coalesce(v_settings, '{}'::jsonb);
end
$$;

revoke all on function stayput.create_creator_note(text, text, text, text, text, timestamptz)
  from public;
revoke execute on all functions in schema stayput from public;
