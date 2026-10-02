-- The dashboard's « Getting started » card (the redesign brief, 2 October): four steps, the card
-- gone once all are done. Connecting Discord and turning an automation on are read from their own
-- tables; the other two are recorded when they happen, the first time only: the creator saved
-- their guardrails, and opened their members at risk.

alter table stayput.company_settings
  add column guardrails_saved_at timestamptz,
  add column at_risk_reviewed_at timestamptz;

-- A step of « Getting started » done: 'guardrails' or 'reviewed'. The first time stays.
create function stayput.getting_started_done(p_company text, p_step text, p_now timestamptz)
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
  else
    return false;
  end if;
  return found;
end
$$;

revoke all on function stayput.getting_started_done(text, text, timestamptz) from public;
revoke execute on all functions in schema stayput from public;
