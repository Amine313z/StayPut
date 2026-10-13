-- Help & support › Support (decision of 2026-10-13): what a community's team writes to StayPut's
-- founder from StayPut. Kept so that the founder sees every message in Settings › Admin, even
-- when Whop's notification or support chat did not carry it, and deleted with the community.
-- Server only: no policy, no grant (the Worker writes and reads it).
create table stayput.support_messages (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references stayput.companies (id) on delete cascade,
  -- Who on the team wrote it (the Whop user the iframe token named).
  user_id text not null check (user_id ~ '^user_[A-Za-z0-9]+$'),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null,
  -- How it reached the founder: the Whop notification to the team of StayPut's own community,
  -- and the copy in that community's support chat with the writer, where the founder answers.
  notified boolean not null default false,
  in_chat boolean not null default false
);
create index support_messages_recent on stayput.support_messages (created_at desc);
create index support_messages_company on stayput.support_messages (company_id, created_at desc);
alter table stayput.support_messages enable row level security;
