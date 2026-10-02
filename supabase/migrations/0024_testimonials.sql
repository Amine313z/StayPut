-- SPEC Phase 5, points 6 and 7: the testimonial card and its public page /v/:proofId. The member
-- makes a card of one of their results: its proof (the screenshot's, or a declared one made then)
-- becomes public with only what they agreed to show, frozen at that moment (a later change of
-- name or goal never alters a page others saw). They can take it down at any time.

-- One proof per result: the screenshot's, or the declared one a card makes.
create unique index proofs_one_per_result on stayput.proofs (company_id, result_id)
  where result_id is not null;

-- The member makes (or makes again) the card of a result of theirs: what the public page shows,
-- its proof's id and level. Null when the result is not theirs.
create function stayput.make_testimonial(p_company text, p_user text, p_result uuid,
                                         p_show_name boolean, p_affiliate text,
                                         p_now timestamptz)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_member text;
  v_name text;
  v_display jsonb;
  v_proof uuid;
  v_level text;
begin
  select m.id, nullif(trim(coalesce(m.display_name, '')), ''),
         jsonb_build_object(
           'published', true,
           'community', c.name,
           'locale', c.locale,
           'goal', g.title,
           'unit', g.unit,
           'entry', g.entry,
           'start', g.start_value::float8,
           'target', g.target_value::float8,
           'value', r.value::float8,
           'progress', stayput.goal_progress(g.start_value, g.target_value, r.value),
           'recordedAt', r.recorded_at,
           -- Its day in the community's time zone: the card and its page show the same date.
           'day', to_char(r.recorded_at at time zone c.timezone, 'YYYY-MM-DD'),
           'publishedAt', p_now)
    into v_member, v_name, v_display
    from stayput.results r
    join stayput.goals g on g.company_id = r.company_id and g.id = r.goal_id
    join stayput.members m on m.company_id = r.company_id and m.id = r.member_id
    join stayput.companies c on c.id = r.company_id
   where r.company_id = p_company and r.id = p_result and m.user_id = p_user;
  if v_member is null then
    return null;
  end if;
  -- Only what the member agreed to: their name when they ticked it, their own link.
  v_display := v_display
    || jsonb_build_object('name', case when p_show_name then v_name end,
                          'affiliateUrl', p_affiliate);
  -- The result's proof (its screenshot's) shows it; a result without one gets a declared proof.
  -- One statement: two cards asked at the same moment make one proof.
  insert into stayput.proofs (company_id, member_id, result_id, level, public_display,
                              created_at)
  values (p_company, v_member, p_result, 'declared', v_display, p_now)
  on conflict (company_id, result_id) where result_id is not null
  do update set public_display = excluded.public_display
  returning id, level into v_proof, v_level;
  return jsonb_build_object('id', v_proof, 'level', v_level, 'display', v_display);
end
$$;

-- The member takes their card's page down: nothing public is left of it.
create function stayput.unpublish_testimonial(p_company text, p_user text, p_proof uuid)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  update stayput.proofs p set public_display = '{}'
   where p.company_id = p_company and p.id = p_proof
     and p.member_id = (select m.id from stayput.members m
                         where m.company_id = p_company and m.user_id = p_user);
  return found;
end
$$;

-- The member's cards online, the newest first.
create function stayput.member_cards(p_company text, p_user text) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'proofId', p.id, 'resultId', p.result_id, 'level', p.level,
           'display', p.public_display)
         order by p.public_display ->> 'publishedAt' desc), '[]'::jsonb)
    from stayput.proofs p
    join stayput.members m on m.company_id = p.company_id and m.id = p.member_id
   where p.company_id = p_company and m.user_id = p_user
     and (p.public_display ->> 'published')::boolean is true;
$$;

-- The public page of a proof: what its member agreed to show, while their community uses
-- StayPut. Null for anything else (a proof never published, taken down, or unknown).
create function stayput.public_proof(p_id uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'level', p.level, 'display', p.public_display)
    from stayput.proofs p
    join stayput.companies c on c.id = p.company_id
   where p.id = p_id and c.status = 'active'
     and (p.public_display ->> 'published')::boolean is true;
$$;

revoke all on function stayput.make_testimonial(text, text, uuid, boolean, text, timestamptz)
  from public;
revoke all on function stayput.unpublish_testimonial(text, text, uuid) from public;
revoke all on function stayput.member_cards(text, text) from public;
revoke all on function stayput.public_proof(uuid) from public;
