-- Settings › General (SPEC Phase 6.12): the team, and the community's data, exported (read under
-- RLS by the Worker, nothing to add here) or deleted.

-- The team members who opened StayPut, and when last: company_admins is the Worker's alone, this
-- shows it to a member of that team only.
create function stayput.team_access(p_company text)
returns table (user_id text, opened_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select a.user_id, a.verified_at
    from stayput.company_admins a
   where a.company_id = p_company and stayput.is_company_admin(p_company)
   order by a.verified_at desc, a.user_id
$$;

-- Everything StayPut keeps about a community, deleted at its team's request: its row and, by
-- cascade, every table tied to it (schema.test.ts checks each one cascades); the deliveries Whop
-- sent for it besides, which keep its id without a foreign key. True when the community existed.
create function stayput.delete_company_data(p_company text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  delete from stayput.webhook_events where company_id = p_company;
  delete from stayput.companies where id = p_company;
  return found;
end
$$;

revoke all on function stayput.team_access(text) from public;
grant execute on function stayput.team_access(text) to stayput_user;
revoke all on function stayput.delete_company_data(text) from public;
