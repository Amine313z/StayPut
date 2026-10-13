-- The message to whoever installs StayPut (decision of 2026-10-13): the first time a community
-- opens StayPut, the person who opened it gets a message in the support chat of the operator's
-- community (StayPut's own, OPERATOR_COMPANY_ID), where they can answer the founder; when Whop
-- will not open that chat, a Whop notification to the community's team says it instead. Once per
-- community: when it was taken, and how it reached them ('support_chat' or 'notification'). A
-- send that failed both ways gives the moment back (null), for the next opening to try again.
alter table stayput.company_settings
  add column install_message_at timestamptz,
  add column install_message_via text
    check (install_message_via in ('support_chat', 'notification'));

-- The communities StayPut already has installed it before there was a message: they never get
-- it (the moment of this migration, sent by no way).
update stayput.company_settings set install_message_at = now() where install_message_at is null;
