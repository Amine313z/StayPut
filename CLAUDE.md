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
- **Phase 1** (foundations): done, waiting for the founder's validation. Not deployed yet: the
  first deployment needs the founder's Cloudflare account, the Supabase connection string (for
  Hyperdrive) and the Whop sandbox app (README.md, Deployment).

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
- **Frontend**: no text in components, everything through `t()` from `packages/i18n` (English
  reference, French typed on it; `no-hardcoded-text.test.ts`); colors only as tokens in
  `apps/web/src/styles.css` (`contrast.test.ts` checks WCAG AA in both themes).

## Environment notes

- The cloud environment « StayPut » is shared by every session (SAHA included). Its **setup
  script must stay empty**: a line there that is not a shell command (a domain name, a key)
  makes every new session fail at startup (« Setup script failed »). Keys belong in its
  environment variables (`WHOP_SANDBOX_API_KEY=…`, one per line).
- Cloud sessions go through an HTTP proxy: Node's built-in `fetch` needs
  `NODE_USE_ENV_PROXY=1` to use it (otherwise the proxy answers 403 "Host not in allowlist").
- The Whop hosts (`docs.whop.com`, `api.whop.com`, `sandbox-api.whop.com`) are allowed in the
  environment's network settings; `developers.cloudflare.com` and `supabase.com` are not (use
  web search, or the docs shipped in npm packages).
- To re-run the Phase 0 sandbox check:
  `NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs <test e-mail> --cleanup` (reads
  `WHOP_SANDBOX_API_KEY`, never print it).
