-- SPEC Phase 9: one database, one deployment. The sandbox and production each have their own
-- database (docs/production.md); the deployment that first migrates a database claims it here
-- (scripts/migrate.ts, STAYPUT_TARGET), and the other one is refused from then on, before any
-- migration runs. Production never writes into the sandbox's database, nor the reverse, whatever
-- address was pasted where.
alter table stayput.app_settings
  add column deployment_target text check (deployment_target in ('sandbox', 'production'));
