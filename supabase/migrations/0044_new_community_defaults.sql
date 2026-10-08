-- What a new community starts with (DECISIONS.md, 2026-10-08): New York's time, the founder's
-- choice. The quiet hours, the golden hour, the default sending hour and the Monday report are
-- read in it until the team picks another zone in the settings. It replaces UTC, and the zone of
-- the creator's browser the app used to report on the first visit (0011). Communities already
-- there keep theirs: only the default changes. (Test mode stays off: a new community starts in
-- manual mode, where nothing is sent until the team approves it.)
alter table stayput.companies alter column timezone set default 'America/New_York';
