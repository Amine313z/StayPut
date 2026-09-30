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

- **Phase 0** (Whop API check): done, except the sandbox test of « Invite to a Membership »
  (`SPEC.md` 5.9):

  ```bash
  NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs <test e-mail> --cleanup
  ```

  It reads `WHOP_SANDBOX_API_KEY` from the environment (never print it). Report the result in
  sections 8 and 11 of `docs/whop-api-verification.md`, then ask the founder to validate
  Phase 0.
- **Phase 1** (foundations): not started; waits for the founder's validation of Phase 0.

## Environment notes

- Cloud sessions go through an HTTP proxy: Node's built-in `fetch` needs
  `NODE_USE_ENV_PROXY=1` to use it (otherwise the proxy answers 403 "Host not in allowlist").
- The Whop hosts (`docs.whop.com`, `api.whop.com`, `sandbox-api.whop.com`) are allowed in the
  environment's network settings.
