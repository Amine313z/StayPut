-- A niche of its own for sports betting communities, many on Whop (the founder, 2026-10-10):
-- the two lists of niches the schema keeps take it. Its risk presets and its goals live in
-- packages/core (NICHE_PRESETS, NICHE_GOALS).
alter table stayput.companies drop constraint companies_niche_check;
alter table stayput.companies add constraint companies_niche_check check (niche in (
  'trading', 'sports_betting', 'fitness', 'online_business', 'coaching', 'ecommerce',
  'personal_development', 'other'));

alter table stayput.benchmarks drop constraint benchmarks_niche_check;
alter table stayput.benchmarks add constraint benchmarks_niche_check check (niche in (
  'trading', 'sports_betting', 'fitness', 'online_business', 'coaching', 'ecommerce',
  'personal_development', 'other'));
