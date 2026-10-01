-- The creator watches what StayPut sees on Discord and Telegram, without reloading the page (the
-- founder, 2026-10-01). Telegram sends each message as it comes; Discord sends nothing, so while
-- the page is open StayPut reads the company's Discord channels again, at most once a minute.
-- That read holds the same lease as a synchronization (two runs never read a channel at once),
-- but leaves last_synced_at alone: Whop's lists keep their own cadence.

-- The company's lease, taken when free. False when another run holds it, or for a company that
-- is not active (or the demo).
create function stayput.claim_lease(p_company text, p_now timestamptz, p_lease_seconds integer)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if not exists (select 1 from stayput.companies
                  where id = p_company and status = 'active' and not is_demo) then
    return false;
  end if;
  insert into stayput.company_sync (company_id) values (p_company) on conflict do nothing;
  update stayput.company_sync
     set lease_until = p_now + make_interval(secs => p_lease_seconds)
   where company_id = p_company
     and (lease_until is null or lease_until <= p_now);
  return found;
end
$$;

-- The lease given back, the last synchronization left as it was.
create function stayput.release_lease(p_company text) returns void
language sql set search_path = ''
as $$
  update stayput.company_sync set lease_until = null where company_id = p_company;
$$;

revoke all on function stayput.claim_lease(text, timestamptz, integer) from public;
revoke all on function stayput.release_lease(text) from public;
