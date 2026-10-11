-- The private beta's requests (decision of 2026-10-11): a community not invited yet whose team
-- opens StayPut (it installed it through a link) is noted here, so that the founder sees it in
-- Settings › Admin and invites it in one click; the creator is asked for nothing. Only which
-- community, its name, who opened it and when: nothing else of it is read or kept until it is
-- invited (StayPut's session, which records it and starts the synchronization, is not reached,
-- and its webhooks are acknowledged without being kept). The row goes when it is invited.
create table stayput.access_requests (
  company_id text primary key check (company_id ~ '^biz_[A-Za-z0-9]+$'),
  -- The community's name as Whop gives it, when read.
  name text check (char_length(name) <= 200),
  -- The team member who opened StayPut last.
  user_id text not null check (user_id ~ '^user_[A-Za-z0-9]+$'),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  -- Its visits: the dashboard's calls less than a minute apart count once.
  visits integer not null default 1 check (visits >= 1)
);
alter table stayput.access_requests enable row level security;

-- Notes a request, or one more visit. Returns whether its name is to be read from Whop: a new
-- visit of a community StayPut has no name for.
create function stayput.note_access_request(p_company text, p_user text, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
declare
  v_last timestamptz;
  v_name text;
  v_new_visit boolean;
begin
  insert into stayput.access_requests (company_id, user_id, first_seen_at, last_seen_at)
  values (p_company, p_user, p_now, p_now)
  on conflict (company_id) do nothing;
  if found then
    return true;
  end if;
  select last_seen_at, name into v_last, v_name
    from stayput.access_requests where company_id = p_company for update;
  v_new_visit := v_last < p_now - interval '1 minute';
  update stayput.access_requests
     set user_id = p_user,
         last_seen_at = greatest(v_last, p_now),
         visits = visits + case when v_new_visit then 1 else 0 end
   where company_id = p_company;
  return v_new_visit and v_name is null;
end
$$;

revoke all on function stayput.note_access_request(text, text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
