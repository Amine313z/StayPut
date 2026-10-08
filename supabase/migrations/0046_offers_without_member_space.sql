-- Members have no StayPut space (founder, 2026-10-08): every message to a member goes through
-- the community's support chat with them (apps/worker/src/actions.ts), and an offer the creator
-- makes is never accepted in a space any more.
-- 1. A discount is given, not proposed: the offer is accepted when the creator makes it, and its
--    message applies it to the membership when it leaves (the action's subject is the
--    membership, `apply` in its content), then says so. A message the guardrails hold back
--    holds the discount back with it: the member is never given something unannounced.
-- 2. A pause is never imposed: its message proposes it, the member answers in the chat, and the
--    creator applies it from the member's sheet within the 7 days (stayput.apply_creator_offer).
create or replace function stayput.create_creator_offer(p_company text, p_member text,
                                                        p_kind text, p_user text,
                                                        p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member stayput.members;
  v_membership text;
  v_terms jsonb;
  v_offer uuid;
  v_given boolean := p_kind = 'promo_offer';
  v_action uuid;
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
  -- One at a time, for its week: a pause waiting for the member's yes, or a discount given.
  if exists (select 1 from stayput.creator_offers o
              where o.company_id = p_company and o.member_id = p_member
                and o.expires_at > p_now
                and (o.outcome = 'open' or o.kind = 'promo_offer')) then
    return jsonb_build_object('error', 'offer_open');
  end if;
  select case when p_kind = 'pause_offer' then jsonb_build_object('days', s.pause_days)
              else jsonb_build_object('percentOff', s.promo_percent, 'months', s.promo_months)
         end
    into v_terms
    from stayput.company_settings s where s.company_id = p_company;
  insert into stayput.creator_offers (company_id, member_id, membership_id, kind, terms,
                                      created_by, created_at, expires_at, outcome, decided_at)
  values (p_company, p_member, v_membership, p_kind, v_terms, p_user, p_now,
          p_now + interval '7 days', case when v_given then 'accepted' else 'open' end,
          case when v_given then p_now end)
  returning id into v_offer;
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               subject_id, dedupe_key, content, approved_at, approved_by)
  values (p_company, p_member, 'creator_offer', 'approved', 'creator', 'relance', v_membership,
          'creator_offer:' || v_offer,
          jsonb_build_object('offerId', v_offer, 'kind', p_kind, 'terms', v_terms,
                             'apply', v_given),
          p_now, p_user)
  returning id into v_action;
  if v_given then
    update stayput.creator_offers set action_id = v_action
     where company_id = p_company and id = v_offer;
  end if;
  return jsonb_build_object('offerId', v_offer, 'kind', p_kind, 'terms', v_terms,
                            'applied', v_given);
end
$$;

-- The pause a member said yes to in the chat, applied by the creator: what the member's own
-- acceptance did (0034), the creator's click standing for it.
create function stayput.apply_creator_offer(p_company text, p_offer uuid, p_user text,
                                            p_now timestamptz) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_offer stayput.creator_offers;
  v_action uuid;
begin
  select o.* into v_offer from stayput.creator_offers o
   where o.company_id = p_company and o.id = p_offer
     for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_offer.outcome <> 'open' then
    return jsonb_build_object('error', 'already_decided');
  end if;
  if v_offer.expires_at <= p_now then
    return jsonb_build_object('error', 'expired');
  end if;
  insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                               subject_id, dedupe_key, content, send_at, approved_at,
                               approved_by)
  values (p_company, v_offer.member_id, v_offer.kind, 'approved', 'creator_offer', 'none',
          v_offer.membership_id, v_offer.kind || ':creator:' || v_offer.id,
          v_offer.terms || jsonb_build_object('keep', true), p_now, p_now, p_user)
  returning id into v_action;
  update stayput.creator_offers
     set outcome = 'accepted', decided_at = p_now, action_id = v_action
   where company_id = p_company and id = p_offer;
  return jsonb_build_object('outcome', 'accepted', 'actionId', v_action);
end
$$;

-- A failed payment's message carries the link where the member settles it (they have no space
-- to find it in): due_action gives the payment's membership, whose Whop page is that link.
create or replace function stayput.due_action(p_id uuid, p_now timestamptz) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
           'id', a.id,
           'companyId', a.company_id,
           'createdAt', a.created_at,
           'type', a.type,
           'attempts', a.attempts,
           'content', a.content,
           -- What an earlier attempt kept (an Alumni follow-up's code, already made).
           'result', a.result,
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
                      'recoveryUrl', p.recovery_url,
                      -- Its membership: Whop's page for it, where the member updates their card.
                      'membershipId', coalesce(p.membership_id, p.whop_membership_id))
               from stayput.payments p
              where p.company_id = a.company_id and p.id = a.subject_id),
           'membership', (
             select jsonb_build_object(
                      'id', ms.id,
                      'canceling', (ms.cancel_at_period_end or ms.status = 'canceling')
                                   and ms.current_period_end > p_now,
                      'ended', ms.status in ('canceled', 'expired', 'completed')
                               or ms.current_period_end <= p_now,
                      'productId', ms.product_id,
                      'planId', ms.plan_id,
                      'currency', ms.currency,
                      'periodEnd', ms.current_period_end)
               from stayput.memberships ms
              where ms.company_id = a.company_id and ms.id = a.subject_id),
           'values', stayput.message_values(a.company_id, a.member_id, p_now),
           -- An Alumni follow-up: whether the member is still among the alumni, the space it
           -- goes through, and the return code's discount as the creator sets it now.
           'alumni', case when a.type = 'alumni_followup' then (
             select jsonb_build_object('status', al.status, 'experienceId', o.experience_id,
                                       'percentOff', s.promo_percent, 'months', s.promo_months)
               from stayput.alumni_members al
               left join stayput.alumni_offers o on o.company_id = al.company_id
              where al.company_id = a.company_id and al.member_id = a.member_id) end)
    from stayput.actions a
    join stayput.companies c on c.id = a.company_id
    join stayput.company_settings s on s.company_id = a.company_id
    join stayput.members m on m.company_id = a.company_id and m.id = a.member_id
   where a.id = p_id and a.status = 'scheduled' and a.send_at <= p_now
     and c.status = 'active' and not c.is_demo;
$$;

revoke all on function stayput.apply_creator_offer(text, uuid, text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
