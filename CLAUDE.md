# CLAUDE.md — StayPut

Guidance for Claude Code in this repository.

## Working with the founder (always)

- Talk to the founder in **French**.
- **Every manual action is explained step by step, in detail**: the exact URL to open, the
  menu and the button to click (with their position on the screen), what to type or paste,
  and what the screen should show afterwards. Never "go to the settings": say which settings,
  how to reach them, and what to do there. When a step can be prefilled (for example a
  `https://claude.ai/code?prompt=…&repositories=…&environment=…` link for a new session),
  give the prefilled link.
- Act as the senior full-stack engineer (the founder's words): when something blocks, look for
  the solution yourself (documentation, API, sandbox) before handing the founder an errand
  (searching a dashboard, writing to support). Only ask for what truly needs them: a click in
  an account only they can reach, a decision, a secret stored in the environment.
- Never ask for a secret (API key, password, connection string) in the chat. Secrets go in
  the cloud environment's variables (environment menu in the session title bar → Edit →
  Environment variables); a new session picks them up.
- Work phase by phase as `SPEC.md` describes, and stop at the end of each phase with the
  summary its section 6 asks for.

## The project

- `SPEC.md`: the specification (in French), including the decisions taken since (see the
  dated notes, e.g. 5.9 « Offre Alumni »).
- `docs/whop-api-verification.md`: Phase 0, every Whop endpoint, webhook and permission
  StayPut needs, checked against the Whop documentation and the sandbox.
- `DECISIONS.md`: every non-obvious technical choice, with its reason.
- Code, identifiers, comments and commits in **English** (`SPEC.md`, rule 5); README and
  DECISIONS in French, for the founder.

## Status

- **Phase 0** (Whop API check): validated on 2026-09-30. Invitations answer `403`; the Alumni
  offer enters through the free variant's `purchase_url`, carried by Whop's native « User
  left » message (`SPEC.md` 5.9).
- **Phase 1** (foundations): done and deployed on 2026-09-30 at
  `https://stayput.chezbenz18.workers.dev` (Worker `stayput` on the founder's Cloudflare account,
  Hyperdrive `stayput-db`, migrations 0001–0004 applied to the Supabase project `stayput`);
  `/health` answers `ok`. Whop sandbox app `app_rjFkp2xKgjfPxY` and its webhook
  `hook_M3uOKxSzLzx8u` created through the API (README.md, « L'app Whop du sandbox »);
  `WHOP_API_KEY` (accepted by Whop) and `WHOP_WEBHOOK_SECRET` stored and deployed; app installed
  in « StayPut Test ». Whop's sandbox cannot display app views, so StayPut also opens outside
  the iframe with « Sign in with Whop » (sandbox only, 2026-10-01): the founder signed in and the
  creator view opened for `biz_2whAzkbCRpcGqQ` (access checked with Whop, company recorded in the
  database). Hyperdrive now uses Supabase's direct connection. Phase 1 validated by the founder
  on 2026-10-01.
- **Phase 2** (data collection), in progress: the founder granted the 19 read permissions
  (checked through `GET /apps/{id}`); migration 0005 files Whop's pages and webhook deliveries
  in SQL; `src/sync.ts` reads each company's lists by passes (cron every 10 minutes, 40 Whop
  calls per run, background sync when the dashboard opens, « Sync now »); the app webhook also
  receives `chat.message.created` and `chat.reaction.created` (set through the API). The creator
  view shows the sync status and the members. Deployed on 2026-10-01 (migrations 0005 and 0006;
  0006 ignores Whop's test deliveries, `biz_xxxxxxxxxxxxxx`, and syncs only companies whose team
  opened StayPut). 25 fake members (`seed…` ids) come from `scripts/seed-sandbox.ts` (workflow
  « Seed sandbox »); « Inspect » reports the database as counts and the app key's permissions.
  The founder re-approved the 19 permissions on 2026-10-01 (they were 0 of 19 before: added
  permissions need a re-approval per company); « Sync now » then read every list without error.
  Phase 2 stop report sent; waiting for validation. Then (founder's decision, 2026-10-01):
  Discord **and Telegram** as optional activity sources (migration 0007, `src/discord.ts`,
  `src/telegram.ts`, `src/integrations.ts`), each on once its secrets exist
  (`DISCORD_BOT_TOKEN` + `DISCORD_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`); and the dashboard
  redesign (tabs Overview / Members / Activity sources, `apps/web/src/ui/*`).
- **Phase 3** (detection), done, waiting for validation: migration 0008 (`member_risk`, daily
  `risk_scores`, cohorts and lessons, settings), `packages/core` `risk.ts` / `analyses.ts` (pure,
  tested edge cases), `apps/worker/src/risk.ts` (hourly `scoreMembers` job, after each sync,
  after new settings), routes `/insights` and `/settings/risk`, tabs Analyses and Settings.
  Deployed on 2026-10-01 (0008 applied, `/health` ok); the sandbox's fake members were removed
  and seeded again (titled lessons, one inactive newcomer), and the « Seed sandbox » workflow's
  `report` action prints them by score with their reasons (the Phase 3 stop list).
- **Checking production from a session**: `*.workers.dev` and the database are out of reach, so
  run the « Inspect » workflow (`actions_run_trigger`, `inspect.yml`) and read its job log;
  Whop's side: `GET /webhooks/{id}/deliveries` and `POST /webhooks/{id}/test` with
  `WHOP_SANDBOX_API_KEY` (a test delivery is answered `{"received":true}` when all is well).
- **Deploying**: the `Deploy` workflow (`.github/workflows/deploy.yml`, `workflow_dispatch`),
  started from GitHub's Actions tab or through the GitHub API (`actions_run_trigger`, workflow
  `deploy.yml`, ref `main`). It migrates the database, creates Hyperdrive if needed, publishes
  the Worker and fails unless `/health` answers `"status":"ok"` within 3 minutes. The first
  publication took about 8 minutes to answer on workers.dev (404 `error code: 1042`, then
  timeouts): re-run the workflow if a new address is still coming up.

## Commands

```bash
npm run check        # typecheck + lint + format + every test: before each commit
npm test             # Vitest (packages/*, apps/worker, apps/web); the database runs in PGlite
npm run build        # apps/web/dist, the static files the Worker serves
npm run bundle -w @stayput/worker   # the Worker exactly as `wrangler deploy` uploads it
npm run db:bundle    # after adding a migration: supabase/install.sql + schema-version.ts
```

## Architecture and rules

- **One Worker** (`apps/worker`, Hono) serves the React build as static assets and answers
  `/api/*`, `/webhooks/*`, `/health`, `/badge/*`, `/v/*` itself (`run_worker_first` in
  `wrangler.toml`): same origin, so Whop's `x-whop-user-token` reaches the API.
- **Auth**: every `/api` route goes through `authenticate` (iframe token verified with the JWKS
  of `WHOP_ENV`), then `accessTo` (Whop's access check, cached 5 min per instance). Creator
  routes need `admin` on the `biz_…`; member routes need access to the `exp_…`.
  **Sandbox only**: without an iframe token, a `__Host-stayput_session` cookie from « Sign in
  with Whop » (`/auth/login` → `/auth/callback`, OAuth PKCE on `sandbox-api.whop.com/oauth`,
  `src/session.ts`) identifies the user instead, because Whop's sandbox cannot display app views
  (DECISIONS.md, 2026-10-01). Access is still checked with Whop. Changing `/api` requests from
  such a browser need the `x-stayput-csrf` header.
- **Database**: schema `stayput` (not exposed by Supabase's Data API). The Worker writes as
  the owner; reads for a user go through `withUser` (role `stayput_user` + `stayput.user_id`),
  so RLS applies. Keep the `company_id` filter in every query anyway.
- **Migrations** (`supabase/migrations/NNNN_*.sql`, never edit an applied one): every table
  enables RLS and gets a `stayput_user` read policy (or is listed in `SERVER_ONLY` in
  `apps/worker/test/schema.test.ts` with a reason); every table with `company_id` references
  `companies` with `on delete cascade`; references between two company tables are composite
  (`(company_id, x_id)`); a migration that creates functions ends with
  `revoke execute on all functions in schema stayput from public`. Then `npm run db:bundle`.
- **jsonb parameters**: pass JSON text as `$n::text::jsonb` (postgres.js would otherwise
  encode a JS string as a JSON string scalar; PGlite hides the difference).
- **Clock**: business code takes `now` as a parameter (`deps.now()`, `JobContext.now`), never
  `new Date()`.
- **Free plan limits**: 10 ms CPU per invocation, 50 subrequests, 5 crons. Heavy work goes to
  SQL; sync advances by small batches with a cursor.
- **Sync** (`apps/worker/src/sync.ts`, DECISIONS.md « Phase 2 »): `STREAMS` lists every Whop
  list; `planPass` decides what is due; each page goes **raw** to `stayput.sync_page` (never
  `JSON.parse` a page in the Worker); the sync client has `maxRetries: 0` and each call costs one
  unit of `budget`; `syncIfFree` holds the company lease (`claim_sync` / `release_sync`).
  Webhook deliveries are stored, answered, then filed in the background
  (`process_webhook_event`); the cron replays failures. Activity of an unknown user waits in
  `pending_activity`. Statistics: `refresh_stats` after new activity (`stats_dirty_since`).
- **Discord / Telegram** (DECISIONS.md, 2026-10-01): Discord channels are scoped streams
  (`discord_messages:<channel>`, `source: 'discord'`, read with `ctx.discord` every 3 hours, after
  Whop, in the same budget); members are linked by the primary Discord of their Whop profile
  (`link_member_discord`, 10 profiles per run). Telegram arrives by webhook
  (`/webhooks/telegram`, secret derived from the bot token, webhook set by the Worker at the
  first link request); groups are linked by a signed `startgroup` token, members link their own
  Telegram from the member view (signed `start` token, `link_telegram_member`). Only author and
  time are ever stored.
- **Background work** in a request: `inBackground(c, label, work)` (own database client,
  `waitUntil`); tests pass an execution context and await it (`settle()` in app.test.ts).
- **Frontend**: no text in components, everything through `t()` from `packages/i18n` (English
  reference, French typed on it; `no-hardcoded-text.test.ts`); colors only as tokens in
  `apps/web/src/styles.css` (`contrast.test.ts` checks WCAG AA in both themes; a new token pair
  goes into its `PAIRS`). Building blocks in `apps/web/src/ui/` (Button, Card, Badge/Notice,
  Stat, NavTabs, EmptyState, Avatar, brand marks, ExternalButton); icons from `lucide-react`;
  font Inter served by StayPut. The creator view loads its data once (`CreatorView`, read by
  the sections with `useCreatorData()`). Links that leave StayPut (Discord, Telegram) go through
  `ExternalButton`: inside Whop's frame it asks Whop to open them (`src/external.ts`).
- **Risk score** (DECISIONS.md « Phase 3 »): `risk_features` gathers each member as one compact
  JSON array (order in migration 0008 and `FeatureRow` in `src/risk.ts`: change both together);
  `computeRisk` decides; `save_risk_scores` keeps. Reasons are stored as codes with figures and
  worded by `reasonText` (`apps/web/src/risk-text.ts`): a new reason code needs its i18n keys
  and a case there. Two rules come before the weights (`computeRisk`): a scheduled cancellation
  is 100 and « Leaving »; a failed or overdue payment is high risk at least, said first. The
  reasons never repeat nor contradict each other (`consistent`). A level is never shown by color alone (`LEVELS`: tone, icon,
  name); the bars use the `--risk-*` tokens.

## Environment notes

- The cloud environment « StayPut » is shared by every session (SAHA included). Its **setup
  script must stay empty**: a line there that is not a shell command (a domain name, a key)
  makes every new session fail at startup (« Setup script failed »). Keys belong in its
  environment variables (`WHOP_SANDBOX_API_KEY=…`, one per line).
- Cloud sessions go through an HTTP proxy: Node's built-in `fetch` needs
  `NODE_USE_ENV_PROXY=1` to use it (otherwise the proxy answers 403 "Host not in allowlist").
- `*.workers.dev` is not reachable from cloud sessions (the proxy answers 403): the live Worker
  is checked by the last step of the `Deploy` workflow (its log prints each `/health` answer).
- The Whop hosts (`docs.whop.com`, `api.whop.com`, `sandbox-api.whop.com`) are allowed in the
  environment's network settings; `developers.cloudflare.com` and `supabase.com` are not (use
  web search, or the docs shipped in npm packages).
- `WHOP_SANDBOX_API_KEY` (an account key of the sandbox account « StayPut Test »,
  `biz_2whAzkbCRpcGqQ`) can create and configure apps (`POST /apps`, `PATCH /apps/{id}`) and
  webhooks (`POST /webhooks`, `resource_id` = the app). App permissions cannot be set with a key
  (`developer:update_app_authorization` needs a user session): the founder sets them in the
  dashboard. A create response carries secrets (`webhook_secret`): never print it; the dashboard
  shows it again to the founder.
- To re-run the Phase 0 sandbox check:
  `NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs <test e-mail> --cleanup` (reads
  `WHOP_SANDBOX_API_KEY`, never print it).
