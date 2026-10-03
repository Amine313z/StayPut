-- The first-run welcome (brief v4 §10): four steps the first time a community opens StayPut
-- (welcome, Discord or Telegram, automatic or manual, the first audit), then never again, on any
-- device and for anyone on its team. Recorded like the steps of « Getting started » (0028): the
-- first time only, once the creator went through it or closed it.

alter table stayput.company_settings add column welcomed_at timestamptz;

-- A step done: 'guardrails', 'reviewed' or 'welcomed'. The first time stays.
create or replace function stayput.getting_started_done(p_company text, p_step text, p_now timestamptz)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if p_step = 'guardrails' then
    update stayput.company_settings
       set guardrails_saved_at = coalesce(guardrails_saved_at, p_now)
     where company_id = p_company;
  elsif p_step = 'reviewed' then
    update stayput.company_settings
       set at_risk_reviewed_at = coalesce(at_risk_reviewed_at, p_now)
     where company_id = p_company;
  elsif p_step = 'welcomed' then
    update stayput.company_settings
       set welcomed_at = coalesce(welcomed_at, p_now)
     where company_id = p_company;
  else
    return false;
  end if;
  return found;
end
$$;
