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
  StayPut needs, checked against the Whop documentation.
- Code, identifiers, comments and commits in **English** (`SPEC.md`, rule 5).

## Status

- **Phase 0** (Whop API check): done, waiting for the founder's validation. Sandbox test of
  2026-09-30 (`docs/whop-api-verification.md`, sections 8 and 11): `POST /variants` works (use
  it, not `/plans`); `POST /memberships/invite` answers `403` (enabled account by account), so
  the Alumni offer enters through the free variant's `purchase_url`. That link reaches leavers
  through Whop's native « User left » automated message (dashboard → Support chats, DM + e-mail,
  set up by the creator during onboarding, no API), the exit survey and the confirmation page;
  an existing free product of the creator can also carry the Alumni experience (`SPEC.md` 5.9).
  To re-run the test:

  ```bash
  NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs <test e-mail> --cleanup
  ```

  It reads `WHOP_SANDBOX_API_KEY` from the environment (never print it).
- **Phase 1** (foundations): not started; waits for the founder's validation of Phase 0. Open
  points to settle first: `docs/whop-api-verification.md`, section 12.

## Environment notes

- The cloud environment « StayPut » is shared by every session (SAHA included). Its **setup
  script must stay empty**: a line there that is not a shell command (a domain name, a key)
  makes every new session fail at startup (« Setup script failed »). Keys belong in its
  environment variables (`WHOP_SANDBOX_API_KEY=…`, one per line).

- Cloud sessions go through an HTTP proxy: Node's built-in `fetch` needs
  `NODE_USE_ENV_PROXY=1` to use it (otherwise the proxy answers 403 "Host not in allowlist").
- The Whop hosts (`docs.whop.com`, `api.whop.com`, `sandbox-api.whop.com`) are allowed in the
  environment's network settings.
