-- The Alumni's own figures (SPEC Phase 6.13 and 5.9): how many former members are in it, how many
-- came back, and the money those who came back paid since they entered it. A refunded or disputed
-- payment never counts (SPEC Phase 6.4).

-- What the Alumni page shows, for the company's team only: the offer as it stands, who entered,
-- left and came back, and what those who came back paid since they first entered the Alumni, by
-- currency, the largest first.
create or replace function stayput.alumni_view(p_company text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when stayput.is_company_admin(p_company) then jsonb_build_object(
    'offer', (select jsonb_build_object('name', o.name, 'url', o.url,
                                        'experienceId', o.experience_id,
                                        'createdAt', o.created_at, 'completedAt', o.completed_at)
                from stayput.alumni_offers o where o.company_id = p_company),
    'entered', (select count(*) from stayput.alumni_members a
                 where a.company_id = p_company and a.status = 'entered'),
    'left', (select count(*) from stayput.alumni_members a
              where a.company_id = p_company and a.status = 'left'),
    'returned', (select count(*) from stayput.alumni_members a
                  where a.company_id = p_company and a.status = 'returned'),
    'recovered', coalesce((
      select jsonb_agg(jsonb_build_object('currency', r.currency, 'amount', r.amount)
                       order by r.amount desc, r.currency)
        from (select p.currency, sum(p.amount) as amount
                from stayput.alumni_members a
                join stayput.payments p
                  on p.company_id = a.company_id and p.member_id = a.member_id
               where a.company_id = p_company and a.status = 'returned'
                 and p.status = any (array['succeeded', 'paid']) and p.amount > 0
                 and p.paid_at >= coalesce(a.entered_at, a.departed_at)
               group by p.currency) r), '[]'::jsonb))
  end
$$;
