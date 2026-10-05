-- Anonymous benchmarks (SPEC Phase 6.10): the retention of a niche's communities after 30, 60
-- and 90 days, for the communities that chose to share theirs (company_settings.options
-- .benchmarks_opt_in, off by default). Each community counts once: its members who joined in the
-- last 6 months (cohort_stats, the weekly analyses), at least 10 of them old enough for the
-- horizon. stayput.benchmarks keeps no company id, and RLS shows a figure only when 5 communities
-- or more made it (0002). Recomputed every week for the current month; a community that stops
-- sharing leaves this month's figures at the next refresh.

-- The current month's figures, made again from the communities sharing now.
create function stayput.refresh_benchmarks(p_now timestamptz)
returns integer
language plpgsql set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_now)::date;
  v_count integer;
begin
  delete from stayput.benchmarks where period_month = v_month;
  insert into stayput.benchmarks (niche, period_month, metric, value, contributors, computed_at)
  select r.niche, v_month, r.metric, round(least(1, greatest(0, avg(r.rate))), 4),
         count(*)::integer, p_now
    from (
      select c.niche, h.metric, 1 - sum(h.left_n)::numeric / nullif(sum(h.eligible), 0) as rate
        from stayput.companies c
        join stayput.company_settings s on s.company_id = c.id
        join stayput.cohort_stats k on k.company_id = c.id
       cross join lateral (values ('retention_30', k.left_by_30, k.eligible_30),
                                  ('retention_60', k.left_by_60, k.eligible_60),
                                  ('retention_90', k.left_by_90, k.eligible_90))
                          as h (metric, left_n, eligible)
       where c.status = 'active' and not c.is_demo
         and coalesce((s.options ->> 'benchmarks_opt_in')::boolean, false)
         and k.cohort_month >= (date_trunc('month', p_now) - interval '6 months')::date
       group by c.id, c.niche, h.metric
      having sum(h.eligible) >= 10
    ) r
   group by r.niche, r.metric;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Sharing on or off, as the team sets it.
create function stayput.save_benchmarks_setting(p_company text, p_opted boolean)
returns void
language plpgsql set search_path = ''
as $$
begin
  insert into stayput.company_settings (company_id) values (p_company) on conflict do nothing;
  update stayput.company_settings
     set options = options || jsonb_build_object('benchmarks_opt_in', p_opted)
   where company_id = p_company;
end
$$;

revoke all on function stayput.refresh_benchmarks(timestamptz) from public;
revoke all on function stayput.save_benchmarks_setting(text, boolean) from public;
