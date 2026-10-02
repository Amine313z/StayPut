-- The dashboard's action of the day (brief v3, 2 October): a failed payment or a member leaving
-- is never « nothing urgent ». « Retry now » asks Whop to charge again, at once, every failed
-- payment StayPut may retry, rather than at its planned hour (24 h, then 72 h after it failed,
-- 0009). The creator approved it with the click; each retry still goes through the guardrails
-- (two per payment at most, the stops, the « never contact » list) and is kept like any action.

-- The failed payments StayPut may retry now: the last payment of a member still here (the team
-- and the « never contact » list aside), failed, that Whop can retry and plans no retry of its
-- own, fewer than two retries of StayPut's made, none due within the hour. `planned`: a retry
-- already planned for later, to bring forward; else `attempt` is the one to add. Read by the
-- dashboard as the Whop user (RLS), and by stayput.retry_failed_payments.
create function stayput.payments_to_retry(p_company text, p_now timestamptz)
returns table (payment_id text, member_id text, amount numeric, currency text, planned uuid,
               attempt integer)
language sql stable set search_path = ''
as $$
  with latest as (
    select distinct on (p.member_id) p.id, p.member_id, p.amount, p.currency, p.status,
           p.retryable, p.next_payment_attempt_at
      from stayput.payments p
      join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
     where p.company_id = p_company and m.status = 'joined'
       and coalesce(m.access_level, '') <> 'admin' and not m.do_not_contact
     order by p.member_id, p.whop_created_at desc, p.id
  )
  select l.id, l.member_id, l.amount, upper(l.currency), planned.id, done.n + 1
    from latest l
   cross join lateral (
     select count(*)::integer as n from stayput.actions o
      where o.company_id = p_company and o.type = 'payment_retry' and o.subject_id = l.id
        and o.status in ('sent', 'simulated')) done
    left join lateral (
     select o.id, o.send_at from stayput.actions o
      where o.company_id = p_company and o.type = 'payment_retry' and o.subject_id = l.id
        and o.status in ('proposed', 'approved', 'scheduled')
      order by o.created_at, o.id
      limit 1) planned on true
   where l.status = any (array['failed', 'past_due', 'uncollectible', 'unresolved'])
     and l.retryable and l.next_payment_attempt_at is null
     and done.n < 2
     and (planned.id is null or planned.send_at is null
          or planned.send_at > p_now + interval '1 hour')
     -- The next attempt was already stopped once (a guardrail, an error): not tried again here.
     and (planned.id is not null or not exists (
           select 1 from stayput.actions o
            where o.company_id = p_company
              and o.dedupe_key = 'payment_retry:' || l.id || ':' || (done.n + 1)))
$$;

-- « Retry now »: the retries planned for later are brought forward, the missing ones added, each
-- approved by the creator (p_user) and due now. Returns how many payments are being retried.
create function stayput.retry_failed_payments(p_company text, p_user text, p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_moved integer;
  v_added integer;
begin
  update stayput.actions a
     set send_at = p_now,
         status = case when a.status = 'proposed' then 'approved' else a.status end,
         approved_at = coalesce(a.approved_at, p_now),
         approved_by = coalesce(a.approved_by, p_user)
    from stayput.payments_to_retry(p_company, p_now) r
   where a.company_id = p_company and a.id = r.planned;
  get diagnostics v_moved = row_count;
  insert into stayput.actions (company_id, member_id, type, status, trigger, subject_id,
                               message_kind, dedupe_key, send_at, content, approved_at,
                               approved_by)
  select p_company, r.member_id, 'payment_retry', 'approved', 'creator', r.payment_id, 'none',
         'payment_retry:' || r.payment_id || ':' || r.attempt, p_now,
         jsonb_build_object('payment_id', r.payment_id, 'attempt', r.attempt), p_now, p_user
    from stayput.payments_to_retry(p_company, p_now) r
   where r.planned is null
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_added = row_count;
  return v_moved + v_added;
end
$$;

revoke all on function stayput.payments_to_retry(text, timestamptz) from public;
grant execute on function stayput.payments_to_retry(text, timestamptz) to stayput_user;
revoke all on function stayput.retry_failed_payments(text, text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
