# 0004 — Cross-model orchestration via headless CLI behind a `runRole()` seam

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner
- **Depends on:** [ADR-0001](0001-automated-agent-orchestration.md)
- **Relates to:** confirms ADR-0001's "self-contained, defer broader framework"

## Context

The loop must drive **two different engines**: the Carpenter on DeepSeek (via the `fcc-claude` router) and the Reviewer on Codex. A native Claude Code workflow's sub-agents inherit the launching session's model, so a `.js` triggered from the Opus Architect session **cannot natively hot-swap** the underlying engine to DeepSeek or Codex mid-script. The native sub-agent API is therefore insufficient for cross-model routing.

Two tempting solutions both contain traps:
- **Drive the interactive CLIs via `child_process` and scrape TUI output** — same brittleness class as trusting raw LLM JSON (ADR-0002): you do not pipe a REPL.
- **Offload orchestration to the broader RuFlow framework now** — reverses ADR-0001 on the first hard problem, and was decided without evidence RuFlow is ready.

## Decision

Introduce a single engine-routing seam:

```js
runRole(role, payload) -> Promise<JSON>     // role ∈ { carpenter, reviewer }
```

- **Implemented today** with Node.js `child_process` calling each engine in **headless mode with structured output** — **never** TUI scraping:
  - Carpenter → `fcc-claude -p` (Claude Code print/headless mode, DeepSeek via router)
  - Reviewer → `codex exec` (Codex CLI, non-interactive)
- The loop logic (predicate, circuit breaker, backlog, escalation — ADR-0002/0003) sits **above** the seam and is engine-agnostic.
- **RuFlow is off the table for this loop.** If a broader orchestrator is ever wanted, it becomes an alternate implementation of `runRole()` — swapping two functions, not the loop. The seam is what makes ADR-0001's deferral cheap and reversible.

## Consequences

**Positive**
- Fully self-contained and dependency-free (honors ADR-0001); runs locally with no external framework.
- Headless + JSON output avoids interactive-TUI scraping brittleness.
- Engine choice is now a swappable config; RuFlow-or-anything-later is a localized change.

**Negative / accepted costs**
- **The Reviewer is now the `codex exec` CLI, not the in-session `/codex` plugin.** Headless orchestration cannot drive the plugin. (CONTEXT.md updated accordingly.)
- Headless calls still need per-call timeouts, exit-code handling, and the ADR-0002 defensive JSON parser around their stdout.
- Depends on both engines honoring headless flags (`fcc-claude -p`, `codex exec`) — to be confirmed in the Calibration Cycle.

## Alternatives considered

- **Native CC sub-agents.** Rejected: cannot cross-model; inherit session engine.
- **`child_process` driving interactive TUIs + output scraping.** Rejected: brittle REPL-scraping; use headless modes instead.
- **RuFlow orchestration layer now.** Rejected for this loop: reverses ADR-0001 without evidence of readiness; the `runRole()` seam preserves the option for later at near-zero cost.

## Implementation contract — spawn calls must always settle (added 2026-06-05)

Every headless invocation runs behind a guard that resolves on `error` (ENOENT), `close`, **or an independent timeout** — never on `close` alone. A missing engine, a hung engine, or a dead Windows stdin pipe must never deadlock the loop. The `stdin` write is wrapped in `try/catch` and an `stdin` `error` handler swallows EPIPE.

Discovered during calibration: an early wrapper relied on `close`, so a CLI that never closed would hang past its own timeout. Verified after the fix — ENOENT settles in ~12 ms; a live-but-blocked engine settles at the timeout.

### Calibration findings (this machine, 2026-06-05)
- `fcc-claude.exe` is installed (`~/.local/bin`) and launches — the Carpenter binary is real (full extraction still pending a configured DeepSeek run).
- `codex` is **not on PATH** — the Reviewer (`codex exec`) cannot run until the Codex CLI is installed/configured. This is the top blocker for a live Calibration Cycle.
- **Reviewer invocation (live-calibrated on codex v0.137.0):** corrected against real CLI behaviour after three smoke-test errors:
  - `--ask-for-approval` is **not** a valid `exec` flag — `exec` already defaults `approval: never`.
  - `exec` **refuses to run outside a trusted repo** without `--skip-git-repo-check`.
  - `--json` emits JSONL (event stream), so `-o <file>` (final message only) is used instead.
  - A stale auth token returns **401 `token_invalidated`** — requires a fresh `codex login`.
  Final invocation: **`codex exec --skip-git-repo-check --sandbox read-only -o <file> -`** (prompt on stdin, final message read back from `<file>`). Token usage isn't in the `-o` file → Reviewer is blind to the budget rail; the 3-round cap is its bound. `-o`/stdin still to be confirmed by one clean `calibrate.js`. Carpenter (`fcc-claude -p --output-format json`) flags still pending a live check.
