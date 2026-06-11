# Public release keeps fcc-claude/DeepSeek as the default Carpenter

**Status:** accepted

## Context & decision

Making this repo public raises a question the private project never had to answer:
what engines should a *stranger* get by default? Every role is a headless CLI behind
the `runRole` seam (ADR-0004) and is overridable by env var, so the only thing being
decided here is the **zero-config default** — what runs when the user sets nothing.

The lowest-friction default would be plain `claude` for the Carpenter: a Claude Code
user is already authenticated for it, so the tool would run with no extra account.
We **rejected** that as the default and **kept `fcc-claude` (DeepSeek via the
`free-claude-code` router)** as the documented default Carpenter, with `claude`
offered as a one-line override (`SHIP_CARPENTER_CMD=claude`).

## Why this shape

- **The Carpenter is the bulk builder; cost dominates there, not taste.** The whole
  three-engine split (ADR-0001/0008) is premised on a *cheap* Carpenter doing the
  heavy codegen while a smart Master (Claude) supervises and an independent Reviewer
  (Codex) audits. Defaulting the Carpenter to Claude would quietly make the cheapest,
  highest-volume role the most expensive one — inverting the economics the design
  exists to exploit.
- **It matches what the author actually runs.** Documenting a default that differs
  from the validated, real-world configuration would publish an untested path.
- **The override is trivial and documented.** Users who would rather not stand up the
  fcc router set one env var. The seam (ADR-0004) makes this free; no code edit.

## Considered and rejected

- **Default to `claude`** — lowest onboarding friction (no fcc router, no DeepSeek
  key), but inverts the cost model and ships an unvalidated default. Offered as an
  override instead.
- **Bring-your-own, no default** — most honest about the seam, but removes the
  zero-config path and forces every new user to make a decision before first run.

## Consequences

- The README's setup is heavier than a single-vendor tool's: a public user must set
  up the fcc router + a DeepSeek key (one paste in the admin UI) **and** Codex auth.
  This is an accepted, documented cost of the cheap-Carpenter economics — the "API
  keys" section of the README owns making it painless.
- A future reader wondering "why does a public tool default to a third-party free
  proxy instead of the `claude` the user already has?" has the answer here: cheap
  building is the point, and the override is one env var away.
- **Fail-fast guard, not silent failure.** Because the default depends on a router
  that a newcomer (or even the author) may not have running, `preflight()` calls
  `assertCarpenterReady()`: it verifies the Carpenter command resolves on PATH and —
  for `fcc-claude` — that the router answers on `:8082`, halting at **zero token
  cost** with the exact `SHIP_CARPENTER_CMD=claude` retry line if not. This keeps the
  cost-driven default from becoming a hostile first-run: a misconfigured engine stops
  instantly instead of burning all three rounds into a confusing escalation. The
  README's "Try it in 60 seconds" leads with the same `claude` override so a curious
  stranger gets a green run before standing up the router.
