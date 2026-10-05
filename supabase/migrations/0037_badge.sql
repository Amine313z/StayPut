-- The « Verified retention » badge (SPEC Phase 6.11): on or off for each community
-- (company_settings.options.public_badge, off by default since 0001). Once on, /badge/:id.svg
-- shows the share of its members who joined in the last 12 months still there after 90 days (the
-- weekly analyses, cohort_stats), and /verify/:id says how it was counted.

create function stayput.save_badge_setting(p_company text, p_enabled boolean)
returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('public_badge', p_enabled)
   where company_id = p_company;
end
$$;

revoke all on function stayput.save_badge_setting(text, boolean) from public;
