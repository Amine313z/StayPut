-- SPEC Phase 6.4: the money StayPut saved. The decision is packages/core (attribution.ts,
-- tested); the database gathers each company's facts and keeps what was decided in `saves`
-- (migration 0003), one payment counted once. Server side only: the hourly job runs both.

-- What attributeSaves needs: what StayPut carried out over the last 120 days (sent: a simulated
-- action saves nothing), the payments that came in since and were not counted yet (of these
-- members, or with one of StayPut's codes), each message's first activity of the member in the
-- 14 days after it (opening StayPut's space aside: that is reading the message), and the billing
-- period of their memberships. Times are milliseconds since the epoch.
create function stayput.attribution_facts(p_company text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  with acts as (
    select a.id, a.member_id, a.type, a.sent_at, a.subject_id, a.result
      from stayput.actions a
     where a.company_id = p_company and a.status = 'sent' and a.sent_at is not null
       and a.sent_at > p_now - interval '120 days'
       and a.type = any (array['payment_retry', 'payment_failed_notice', 'payment_action_notice',
                               'pause_offer', 'promo_offer', 'extend_offer', 'coaching_offer',
                               'affiliate_invite', 'alumni_followup', 'high_risk_message'])
  ), shaped as (
    select a.id, a.member_id, a.type, a.sent_at,
           coalesce(p.membership_id, s.membership_id) as membership_id,
           case when a.type like 'payment\_%' then a.subject_id end as payment_id,
           s.answered_at as accepted_at,
           coalesce(a.result ->> 'kept' = 'true', false) as kept,
           a.result ->> 'promo_code_id' as promo_code_id
      from acts a
      left join stayput.payments p
        on a.type like 'payment\_%' and p.company_id = p_company and p.id = a.subject_id
      left join stayput.exit_surveys s
        on s.company_id = p_company and s.offer_action_id = a.id
  )
  select jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sh.id, 'memberId', sh.member_id, 'type', sh.type,
               'sentAt', stayput.epoch_ms(sh.sent_at), 'membershipId', sh.membership_id,
               'paymentId', sh.payment_id,
               'acceptedAt', case when sh.accepted_at is not null
                                  then stayput.epoch_ms(sh.accepted_at) end,
               'kept', sh.kept, 'promoCodeId', sh.promo_code_id)
             order by sh.sent_at)
        from shaped sh), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'memberId', p.member_id, 'membershipId', p.membership_id,
               'status', p.status, 'amount', p.amount::float8, 'currency', upper(p.currency),
               'paidAt', stayput.epoch_ms(p.paid_at), 'promoCodeId', p.promo_code_id)
             order by p.paid_at)
        from stayput.payments p
       where p.company_id = p_company and p.paid_at is not null
         and p.paid_at > (select min(sh.sent_at) from shaped sh)
         and not exists (select 1 from stayput.saves v where v.payment_id = p.id)
         and (p.member_id in (select sh.member_id from shaped sh)
              or p.promo_code_id in (select sh.promo_code_id from shaped sh
                                      where sh.promo_code_id is not null))), '[]'::jsonb),
    'firstActivityAfter', coalesce((
      select jsonb_object_agg(sh.id, stayput.epoch_ms(f.at))
        from shaped sh
        cross join lateral (
          select min(e.occurred_at) as at from stayput.activity_events e
           where e.company_id = p_company and e.member_id = sh.member_id
             and e.occurred_at > sh.sent_at
             and e.occurred_at <= sh.sent_at + interval '14 days'
             and e.type = any (stayput.engagement_types()) and e.type <> 'stayput_open') f
       where sh.type = 'high_risk_message' and f.at is not null), '{}'::jsonb),
    'periodDays', coalesce((
      select jsonb_object_agg(ms.id, ms.billing_period_days)
        from stayput.memberships ms
       where ms.company_id = p_company and ms.billing_period_days is not null
         and ms.member_id in (select sh.member_id from shaped sh)), '{}'::jsonb))
$$;

-- What attributeSaves decided, kept: a payment already counted is left as it was, and a save of
-- a member or an action of another company is refused.
create function stayput.record_saves(p_company text, p_saves jsonb) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into stayput.saves (company_id, member_id, action_id, save_type, category, amount,
                             currency, payment_id, proof, saved_at)
  select p_company, s ->> 'memberId', (s ->> 'actionId')::uuid, s ->> 'type', s ->> 'category',
         (s ->> 'amount')::numeric, s ->> 'currency', s ->> 'paymentId', s -> 'proof',
         to_timestamp((s ->> 'savedAt')::float8 / 1000)
    from jsonb_array_elements(p_saves) s
   where exists (select 1 from stayput.actions a
                  where a.company_id = p_company and a.id = (s ->> 'actionId')::uuid
                    and a.member_id = s ->> 'memberId')
     and exists (select 1 from stayput.payments p
                  where p.company_id = p_company and p.id = s ->> 'paymentId')
  on conflict (payment_id) where payment_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function stayput.attribution_facts(text, timestamptz) from public;
revoke all on function stayput.record_saves(text, jsonb) from public;
revoke execute on all functions in schema stayput from public;
