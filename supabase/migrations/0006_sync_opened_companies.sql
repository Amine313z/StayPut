-- Two lessons of the first deployment of Phase 2 (2026-10-01).
--
-- 1. Whop's "test webhook" sends made-up data: its company is `biz_xxxxxxxxxxxxxx`. Filed like a
--    real delivery, it created that company, which the sync would then have read every hour.
--    Such placeholder companies are now ignored, and the one created is removed.
-- 2. The sync reads a company once its team has opened StayPut (SPEC Phase 2, 2: the backfill
--    starts at the first visit). Webhooks of a company that installed the app are still filed
--    before that, at no cost; reading Whop's lists for it waits for the visit.

-- Whop's placeholder company, in its test deliveries.
create function stayput.is_placeholder_company(p_company text) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(p_company ~ '^biz_x+$', false) $$;

create or replace function stayput.process_webhook_event(p_id text, p_now timestamptz)
returns text
language plpgsql set search_path = ''
as $$
declare
  e stayput.webhook_events;
  d jsonb;
  v_status text := 'processed';
begin
  select * into e from stayput.webhook_events where id = p_id for update skip locked;
  if not found or e.status in ('processed', 'ignored') then
    return coalesce(e.status, 'missing');
  end if;
  d := e.payload -> 'data';
  begin
    if e.company_id is null or stayput.is_placeholder_company(e.company_id) then
      v_status := 'ignored';
    else
      perform stayput.ensure_company(e.company_id, p_now);
      if e.type like 'membership.%' then
        perform stayput.upsert_membership(e.company_id, d);
      elsif e.type like 'payment.%' then
        perform stayput.upsert_payment(e.company_id, d);
      elsif e.type in ('member.created', 'member.updated') then
        perform stayput.upsert_member(e.company_id, d);
      elsif e.type = 'course_lesson_interaction.completed' then
        perform stayput.ingest_item(e.company_id, 'lesson_interactions', null,
                                    d || '{"completed": true}');
      elsif e.type = 'chat.message.created' then
        perform stayput.ingest_item(e.company_id, 'messages',
                                    coalesce(d ->> 'channel_id', d -> 'channel' ->> 'id'), d);
      elsif e.type = 'chat.reaction.created' then
        perform stayput.ingest_item(e.company_id, 'reactions', null, d);
      else
        v_status := 'ignored';
      end if;
    end if;
    update stayput.webhook_events
       set status = v_status, attempts = attempts + 1, last_error = null, processed_at = p_now
     where id = p_id;
  exception when others then
    v_status := 'failed';
    update stayput.webhook_events
       set status = 'failed', attempts = attempts + 1, last_error = left(sqlerrm, 500)
     where id = p_id;
  end;
  return v_status;
end
$$;

-- Due companies, as in 0005, among those whose team opened StayPut.
create or replace function stayput.companies_to_sync(p_now timestamptz,
                                                     p_interval_seconds integer,
                                                     p_limit integer) returns setof text
language sql stable set search_path = ''
as $$
  select c.id
    from stayput.companies c
    left join stayput.company_sync s on s.company_id = c.id
   where c.status = 'active' and not c.is_demo
     and exists (select 1 from stayput.company_admins a where a.company_id = c.id)
     and (s.lease_until is null or s.lease_until <= p_now)
     and (s.last_synced_at is null
          or s.last_synced_at <= p_now - make_interval(secs => p_interval_seconds)
          or exists (select 1 from stayput.sync_state t
                      where t.company_id = c.id
                        and (t.cursor is not null or t.last_run_at is null)))
   order by s.last_synced_at nulls first, c.id
   limit p_limit
$$;

-- The test delivery of 2026-10-01 and what it created.
delete from stayput.companies where stayput.is_placeholder_company(id);
delete from stayput.webhook_events where stayput.is_placeholder_company(company_id);

revoke execute on all functions in schema stayput from public;
