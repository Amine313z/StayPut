-- The Alumni offer without a StayPut experience (2026-10-10): members have no StayPut space, and
-- the follow-ups go in the support chat like every message (0045, 0046). An offer is ready once
-- its free variant has its link; the follow-ups no longer wait for an experience that new offers
-- never get. An offer made before keeps its experience, unused.
create or replace function stayput.plan_alumni_followups(p_company text, p_now timestamptz)
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

revoke all on function stayput.plan_alumni_followups(text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
