-- A member's discount goes on their membership (fix of 2026-10-04, after block 7): a member's
-- renewals pass no checkout where a code could be typed, so StayPut applies the code to the
-- membership itself (Whop's POST /memberships/{id}/apply_promo_code). A discount, like a pause,
-- then needs the membership to continue: accepting the creator's discount keeps it too, as
-- accepting their pause did. The Worker withdraws a cancellation only when one is scheduled
-- (actions.ts), and applies the discount before it: a member never stays at the full price.

create or replace function stayput.decide_creator_offer(p_company text, p_user text, p_offer uuid,
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
            v_offer.terms
              || jsonb_build_object('keep', v_offer.kind in ('pause_offer', 'promo_offer')),
            p_now, p_now, v_offer.created_by)
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
