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
- **Design v4** (brief « Complete redesign prompt (v4) », 2026-10-03, DECISIONS.md « Refonte du
  design, v4 »): ten steps, one stop with a screenshot after each; step 1 done (amounts always
  with symbol and cents, `$247.00` / `247,00 $`; every number in Satoshi via `.num` / `.metric*`;
  labels in sentence case; the UI language kept per community, `/demo` always English). The
  founder then ordered: the Whop-style balance and « Needs attention » (done), the Activity
  « Loading… » bug (done), the Guide, tour and welcome (§10–11, done: `src/guide.ts`,
  `components/guide/`, migration 0030 `welcomed_at`, routes `/mode` and
  `/getting-started/welcomed`; `/demo?welcome` shows the welcome), then Members (§9.3, done: a
  compact sortable table and a drawer per member, `src/members.ts` for the states and orders,
  `components/MemberTable.tsx` / `MemberDrawer.tsx`, read-only route `GET /members/:memberId`,
  no migration; the address keeps `filter`, `q`, `sort`, `dir` and the open `member`). Then the
  **fix prompt v4.1** (2026-10-03): seven blocks, one stop with a screenshot after each. Block 1
  (the spotlight) done: one `Spotlight` for the tour and « Show me », places marked
  `data-tour` on the exact element, a real cut-out, the tooltip on the side with room, steps 4–5
  on Automations › Rules (new first tab, the queue moved to `/actions/queue`) and Integrations ›
  Discord, the tour ending where it began; checked by `apps/web/e2e/spotlight.e2e.ts` (EN/FR,
  1280×720 and 1024×768) in CI and on the live site (Inspect, job `browser`). Block 2 (the
  balance chart) done: « Saved » adds up the displayed period from $0.00 (never down), « Oct 1 »
  marks the month's start, the tooltip gives the period's and the month's figures; days are the
  community's time zone everywhere (`@stayput/core` `zonedDay`, the translator's
  `calendarDate`/`calendarDay`), the demo takes the visitor's zone; the Worker's month figure
  now compares save currencies in capitals (it read $0.00 with Whop's lowercase `usd`). Block 3
  (Members) done: the member drawer is a `fixed` `right: 0` panel `min(420px, 100vw)` wide, the
  page locked behind any drawer or window (`ui/scrollLock.ts`, `html[data-scroll-lock]`) with
  `scrollbar-gutter: stable`; the search keeps its own text, writes `q` 250 ms after the last
  key, never takes the address's value while focused, and finds by name and Whop username
  (`matchesSearch`; `MemberRow.username`, no migration: StayPut stores no member e-mails); an
  empty search says « No member matches “zzz”. » with « Clear search and filters »; a « Needs
  attention » row opens the member and shows its icon actions only when hovered or focused
  (`IconTip`). Checked by `apps/web/e2e/members.e2e.ts` and `look.mjs`. Block 4 (demo data,
  one story) done: every demo date follows from the day a member joined and their plan
  (`billingOf` in `demo/world.ts`: a departure at the end of the period paid, a failed renewal
  on its day, « Unpaid since », a pause until it ends); a new member state « Paused · resumes
  Nov 2 » (`MemberRow.membership.pausedUntil`: Whop's `paused`, or StayPut's applied pause); a
  member gone says « ended on », never « renews »; « Score turned high » only for a member high
  that day; each History item says what came of it (`actionOutcome` in `@stayput/core`, used by
  the Worker's SQL and the demo: Recovered $X, Still failing, Paused until, Came back, No reply
  yet, Left), every demo save being a History action; approving moves the tab and « Approve
  all » together (`withMoves`, `useLayoutEffect`); Integrations › Activity says each
  platform's members' part (migration **0031** `platform_activity.messagesBy`). The page's
  diagonal streak was removed at the founder's request. Block 5 (demo safety) done: in /demo
  (`DemoMode` / `useDemo`, `src/demoMode.tsx`) every `ExternalButton` is a `<button
aria-disabled>` that opens nothing, with the « Disabled in the demo » tip (hover, focus, tap);
  Discord's and Telegram's add buttons show that way; the Alumni link is the example
  `https://whop.com/your-community/alumni` (« Example »). The founder chose to grey out only
  what leaves StayPut: the simulated actions (message, pause, offer, retry, approve) stay.
  Checked by `apps/web/e2e/demo-safety.e2e.ts` (no request to another host nor to `/api/`, no
  link out) and `look.mjs`. Block 6 (the words) done: « Sends at the hour they’re usually online »,
  « Sends in 2 hours », « Skip » (« Ignorer ») beside « Approve », no « golden hour » on screen
  (« Check-in message »), English quotes “ ”, English first among the messages' languages, the
  Guide titled « How StayPut works »; guarded by `packages/i18n/test/i18n.test.ts`. The founder
  asked (2026-10-04) to chain every remaining step with a short report after each, the prices
  (Phase 7) last. Block 7a (Automations, brief v4 §9.4) done: two tabs, Rules and Queue; the
  queue's filters To approve · Scheduled · History · Alumni offer live at
  `/actions/queue[/scheduled|/history|/alumni]` (the old `/actions/<filter>` redirect;
  `QueueTab`, SectionLayout keys its motion by tab). Rules: a switch per rule (migration
  **0032** `company_settings.rules_off` + `set_rule`, `plan_actions` skips a rule off; route `PUT
/api/creator/:companyId/rules/:rule {on}`, demo too), the mode on the page (`POST /mode`), the
  « Your limits » panel (read-only, edited in Settings › Automations), a folded preview per
  message tagged EN/FR (the creator's template or StayPut's, « Alex », the community's name),
  and with every rule off the three ready-made rules with one primary button. The queue has one
  primary button, « Approve all (N) »; each row's « Approve » is a ghost. Before
  it, **design v3** (brief « black · turquoise · white », 2026-10-02): tokens, logo, components, shell and Dashboard done, with migration 0029 (the
  action of the day retries failed payments and offers pauses, never « nothing urgent » while a
  payment failed or a member leaves). Waiting for the founder's validation of the Dashboard
  before Members → Integrations → Automations → Analytics → Settings → Onboarding and Guide, one
  stop per page. The « look » job of Inspect opens the live demo in Chrome, checks Satoshi,
  Geist and the chart, and pushes its screenshots to the `screenshots` branch
  (`git fetch origin screenshots`).
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
npm run e2e          # after `npm run build`: Playwright on the build (vite preview), demo mode;
                     # STAYPUT_URL=<site> runs it on a deployed StayPut; CHROME_PATH names the browser
                     # (in a cloud session: CHROME_PATH=/opt/pw-browsers/chromium)
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
  reference, French typed on it; `no-hardcoded-text.test.ts`); colors only from the twelve-color
  palette of `apps/web/src/styles.css` (brief v3, dark only; Tailwind's own palette is off;
  `contrast.test.ts` checks the exact values, that every color written in `apps/web/src` is one
  of them, and WCAG AA; a new text / background pair goes into its `PAIRS`). Building blocks in
  `apps/web/src/ui/` (Button / ActionButton, MetricHero / SecondaryMetric, LabelTip, RiskRing,
  BalanceChart, GettingStartedPill, Card, Badge / Notice, EmptyState, Avatar, brand marks,
  ExternalButton, Figures for the amounts inside a sentence); icons from `lucide-react`. Fonts served by StayPut: Geist (npm) and Satoshi,
  downloaded from Fontshare at each deployment (`scripts/deploy/satoshi.ts`) and **never
  committed** (its license forbids redistribution and the repository is public). Motion rules:
  `MOTION.md`. Every block reads its data with `useApi` (`apps/web/src/api.ts`): one reading at
  a time (a reload never cancels the one under way), after 5 seconds without an answer « This
  is taking longer than usual. » with « Retry », a silent call given up after 20 seconds; the
  Worker waits for Discord or Telegram 2.5 seconds at most before answering (`waitAtMost`). The
  creator view loads its data once (`CreatorView`, read by
  the sections with `useCreatorData()`). Links that leave StayPut (Discord, Telegram) go through
  `ExternalButton`: inside Whop's frame it asks Whop to open them (`src/external.ts`).
- **Risk score** (DECISIONS.md « Phase 3 »): `risk_features` gathers each member as one compact
  JSON array (order in migration 0008 and `FeatureRow` in `src/risk.ts`: change both together);
  `computeRisk` decides; `save_risk_scores` keeps. Reasons are stored as codes with figures and
  worded by `reasonText` (`apps/web/src/risk-text.ts`): a new reason code needs its i18n keys
  and a case there. Two rules come before the weights (`computeRisk`): a scheduled cancellation
  is 100 and « Leaving »; a failed or overdue payment is high risk at least, said first. The
  reasons never repeat nor contradict each other (`consistent`). A level has no color of its
  own (`LEVELS`: icon and name; the ring's turquoise and its number say the score).

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
