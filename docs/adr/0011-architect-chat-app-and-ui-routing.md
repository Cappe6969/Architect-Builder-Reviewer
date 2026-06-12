# The Architect becomes an interactive agent; UI-from-handoff is Architect-built

**Status:** accepted

## Context & decision

Until now the **Architect** was not a process in the system — it was the human (plus
Claude Code in plan mode) who hand-wrote `SPEC.md` before triggering the loop. The
front-ends reflected that: `ship-chat` / `ship-ui` take a task string and write it to
`SPEC.md` *verbatim* (an H1 + the text). There is no one to converse with, and the raw
request — not a structured spec — drives the build.

We add **`ship-app`**: a single localhost window whose primary surface is a **multi-turn
chat with the Architect** (a real `claude` session). You describe the work; the Architect
asks what it needs, then **writes `SPEC.md`** (the Reviewer's source of truth); you press
**Ship it** and the existing loop runs, streaming Worker/Master/Reviewer below the chat.
The other two roles stay passive — you only talk to the Architect.

Two decisions are locked here:

1. **The Architect is a conversational, file-writing agent.** It runs as one persistent
   session (`--session-id` on turn 1, `--resume` after) so it can clarify across turns,
   and it has file tools so it can author `SPEC.md` itself rather than echoing the user.
2. **Capability routing — UI/front-end-from-handoff is Architect-built, not delegated.**
   The Carpenter (DeepSeek) cannot reliably reconstruct a decent UI from a design handoff
   (Figma/screenshot/HTML mockup). For that class of work the Architect (Claude) **builds
   the files directly**, then writes `SPEC.md` stating the UI is already built and telling
   the Reviewer to audit the existing files. The Carpenter gets only what it does well:
   well-specified non-UI logic, wiring, tests.

## Why this shape

- **A structured spec beats a verbatim one.** The loop's quality is bounded by `SPEC.md`;
  a Claude Architect that interrogates ambiguity and writes checkable acceptance criteria
  produces a far better contract than pasting the user's one-liner.
- **Routing matches each engine to what it's good at.** The three-engine split already
  pairs a cheap builder with a smart supervisor and an independent reviewer; this extends
  the same logic to *task type* — don't hand a cheap code model a job (UI taste) it can't
  do, hand it to the Architect who can. The Architect's UI files land on disk before the
  loop, so `carpenterCommit` stages them and the Reviewer audits them against the spec
  with no special plumbing.
- **One window, engines stay external.** `ship-app` is a launcher (a `ship-app.cmd`
  double-click that `ship-init` drops into each project), not a bundled binary: the
  engines (`claude`/`codex`/`fcc`) are prerequisites a packaged `.exe` couldn't contain
  anyway, so a click-to-run launcher delivers the "just run it" goal without the bundling
  cost.

## Considered and rejected

- **Keep the verbatim task→spec front-end** — simplest, but it's exactly the gap this
  closes; no Architect means no clarification and a weak spec.
- **Append the Architect role via `--append-system-prompt` each turn** — a long multiline
  system prompt mangles through `cmd.exe` (`shell:true` on Windows). Instead the role is
  the first message of a persistent session, which sticks across turns without escaping.
- **A true bundled `.exe`** — heavier build, and it still can't contain the external
  engines, so the only thing it saves is a Node install. Not worth it; launcher chosen.
- **Let the Carpenter attempt UI anyway** — rejected: it's the failure the user hit.

## Consequences

- The Architect runs with `--dangerously-skip-permissions` (to write files) and
  `--mcp-config no-mcp.json --strict-mcp-config` (the documented fix for headless engines
  hanging on the user's global MCP servers). It uses `claude` by default, overridable via
  `SHIP_ARCHITECT_CMD`.
- A new role boundary: the Architect now sometimes **builds**, not only specs. The commit
  attribution blurs (its UI files commit as part of the build diff), which is acceptable —
  the Reviewer still audits the whole diff against `SPEC.md`.
- End-to-end verification is pending an actual conversation + ship (token cost), and a
  full build still defaults the Carpenter to `fcc-claude`; on a machine where that's down,
  `ship-app`'s "Ship it" inherits the same fail-fast halt (ADR-0009) with the
  `SHIP_CARPENTER_CMD=claude` escape hatch.
