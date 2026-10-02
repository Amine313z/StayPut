-- The dashboard's home (SPEC Phase 6): the money StayPut saved, and the creator's own actions.
--
-- 1. SPEC Phase 6.4, the money saved. The decision is packages/core (attribution.ts, tested);
-- the database gathers each company's facts and keeps what was decided in `saves` (migration
-- 0003), one payment counted once. Server side only: the hourly job runs both.

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
                               'affiliate_invite', 'alumni_followup', 'high_risk_message',
                               'creator_message'])
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
       where sh.type in ('high_risk_message', 'creator_message') and f.at is not null),
      '{}'::jsonb),
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


-- The community's logo, read from Whop with its name (refreshCompanyName): the dashboard shows
-- it next to the name (served by StayPut, /api/creator/:companyId/logo).
alter table stayput.companies
  add column logo_url text check (logo_url ~ '^https://' and char_length(logo_url) <= 2000);

-- 2. The creator's own actions from the dashboard (« Message », « Pause », « Offer »), through
-- StayPut's pipeline like every other one: the guardrails, the test mode, the journal. A message
-- is approved by the creator's click itself. An offer becomes the action that applies it only
-- once the member accepts it in their space (SPEC rule 8: their membership is touched only with
-- their consent), within 7 days.
create table stayput.creator_offers (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  member_id text not null,
  membership_id text not null,
  kind text not null check (kind in ('pause_offer', 'promo_offer')),
  -- What it gives, fixed when it is made: {"days": 30} or {"percentOff": 20, "months": 3}.
  terms jsonb not null check (jsonb_typeof(terms) = 'object'),
  created_by text not null check (created_by ~ '^user_[A-Za-z0-9]+$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  outcome text not null default 'open' check (outcome in ('open', 'accepted', 'declined')),
  decided_at timestamptz,
  -- The action that applied it, once accepted.
  action_id uuid,
  unique (company_id, id),
  foreign key (company_id, member_id)
    references stayput.members (company_id, id) on delete cascade,
  foreign key (company_id, membership_id)
    references stayput.memberships (company_id, id) on delete cascade,
  foreign key (company_id, action_id)
    references stayput.actions (company_id, id) on delete set null (action_id)
);
create index creator_offers_member
  on stayput.creator_offers (company_id, member_id, created_at desc);
alter table stayput.creator_offers enable row level security;
create policy creator_read on stayput.creator_offers for select to stayput_user
  using (stayput.is_company_admin(company_id));
grant select on stayput.creator_offers to stayput_user;

-- « Message »: a word from the creator to these members, approved by the click. Never to the
-- team, a member who left or one on the « never contact » list; once a day per member at most.
create function stayput.creator_messages(p_company text, p_members text, p_user text,
                                         p_now timestamptz) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               dedupe_key, approved_at, approved_by)
  select p_company, m.id, 'creator_message', 'approved', 'creator', 'relance',
         'creator_message:' || m.id || ':' || to_char(p_now at time zone 'UTC', 'YYYY-MM-DD'),
         p_now, p_user
    from stayput.members m
   where m.company_id = p_company and m.id = any (string_to_array(p_members, ','))
     and m.status = 'joined' and coalesce(m.access_level, '') <> 'admin'
     and not m.do_not_contact
  on conflict (company_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- « Pause » or « Offer »: an offer to one member, in the creator's offer settings, with the
-- message that tells them (approved by the click, through the guardrails). One open offer per
-- member at a time.
create function stayput.create_creator_offer(p_company text, p_member text, p_kind text,
                                             p_user text, p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member stayput.members;
  v_membership text;
  v_terms jsonb;
  v_offer uuid;
begin
  if p_kind not in ('pause_offer', 'promo_offer') then
    return jsonb_build_object('error', 'invalid_kind');
  end if;
  select * into v_member from stayput.members where company_id = p_company and id = p_member;
  if not found or v_member.status <> 'joined' or coalesce(v_member.access_level, '') = 'admin'
  then
    return jsonb_build_object('error', 'not_a_member');
  end if;
  if v_member.do_not_contact then
    return jsonb_build_object('error', 'do_not_contact');
  end if;
  select ms.id into v_membership from stayput.memberships ms
   where ms.company_id = p_company and ms.member_id = p_member
     and ms.status in ('trialing', 'active', 'past_due', 'canceling')
   order by ms.current_period_end desc nulls last, ms.id
   limit 1;
  if v_membership is null then
    return jsonb_build_object('error', 'no_membership');
  end if;
  if exists (select 1 from stayput.creator_offers o
              where o.company_id = p_company and o.member_id = p_member
                and o.outcome = 'open' and o.expires_at > p_now) then
    return jsonb_build_object('error', 'offer_open');
  end if;
  select case when p_kind = 'pause_offer' then jsonb_build_object('days', s.pause_days)
              else jsonb_build_object('percentOff', s.promo_percent, 'months', s.promo_months)
         end
    into v_terms
    from stayput.company_settings s where s.company_id = p_company;
  insert into stayput.creator_offers (company_id, member_id, membership_id, kind, terms,
                                      created_by, created_at, expires_at)
  values (p_company, p_member, v_membership, p_kind, v_terms, p_user, p_now,
          p_now + interval '7 days')
  returning id into v_offer;
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               subject_id, dedupe_key, content, approved_at, approved_by)
  values (p_company, p_member, 'creator_offer', 'approved', 'creator', 'relance', v_offer::text,
          'creator_offer:' || v_offer,
          jsonb_build_object('offerId', v_offer, 'kind', p_kind, 'terms', v_terms), p_now, p_user);
  return jsonb_build_object('offerId', v_offer, 'kind', p_kind, 'terms', v_terms);
end
$$;

-- The member's side: their latest offer, open or decided in the last 7 days, with what came of
-- it once accepted. Server side: the Worker checked with Whop that the user may open the space.
create function stayput.member_creator_offer(p_company text, p_user text, p_now timestamptz)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'id', o.id, 'kind', o.kind, 'terms', o.terms, 'expiresAt', o.expires_at,
           'outcome', case when o.outcome = 'open' and o.expires_at <= p_now then 'expired'
                           else o.outcome end,
           'action', (select jsonb_build_object('status', a.status, 'result', a.result,
                                                'error', a.error_log -> -1 ->> 'error')
                        from stayput.actions a
                       where a.company_id = o.company_id and a.id = o.action_id))
    from stayput.creator_offers o
    join stayput.members m on m.company_id = o.company_id and m.id = o.member_id
   where o.company_id = p_company and m.user_id = p_user
     and ((o.outcome = 'open' and o.expires_at > p_now)
          or o.decided_at > p_now - interval '7 days')
   order by o.created_at desc
   limit 1
$$;

-- The member accepts the offer, or declines it. Accepted, it becomes the action that applies it
-- (approved: the creator made it, the member consented), through the guardrails. A pause keeps
-- the membership (a paused membership that ends would mean nothing); a code is for a checkout.
create function stayput.decide_creator_offer(p_company text, p_user text, p_offer uuid,
                                             p_accept boolean, p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_offer stayput.creator_offers;
  v_action uuid;
begin
  select o.* into v_offer
    from stayput.creator_offers o
    join stayput.members m on m.company_id = o.company_id and m.id = o.member_id
   where o.company_id = p_company and o.id = p_offer and m.user_id = p_user
     for update of o;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_offer.outcome <> 'open' then
    return jsonb_build_object('error', 'already_decided');
  end if;
  if v_offer.expires_at <= p_now then
    return jsonb_build_object('error', 'expired');
  end if;
  if p_accept then
    -- Now: the member is there, waiting to see it applied.
    insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                 subject_id, dedupe_key, content, send_at, approved_at,
                                 approved_by)
    values (p_company, v_offer.member_id, v_offer.kind, 'approved', 'creator_offer', 'none',
            v_offer.membership_id, v_offer.kind || ':creator:' || v_offer.id,
            v_offer.terms || jsonb_build_object('keep', v_offer.kind = 'pause_offer'), p_now,
            p_now, v_offer.created_by)
    returning id into v_action;
  end if;
  update stayput.creator_offers
     set outcome = case when p_accept then 'accepted' else 'declined' end,
         decided_at = p_now, action_id = v_action
   where company_id = p_company and id = p_offer;
  return jsonb_build_object('outcome', case when p_accept then 'accepted' else 'declined' end,
                            'actionId', v_action);
end
$$;

revoke all on function stayput.attribution_facts(text, timestamptz) from public;
revoke all on function stayput.record_saves(text, jsonb) from public;
revoke all on function stayput.creator_messages(text, text, text, timestamptz) from public;
revoke all on function stayput.create_creator_offer(text, text, text, text, timestamptz)
  from public;
revoke all on function stayput.member_creator_offer(text, text, timestamptz) from public;
revoke all on function stayput.decide_creator_offer(text, text, uuid, boolean, timestamptz)
  from public;
revoke execute on all functions in schema stayput from public;
