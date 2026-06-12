# Worker Carpenter "ultracode": force the effort tier, gate the workflow half

**Status:** accepted

## Context & decision

We wanted the DeepSeek Worker Carpenter to always build in Claude Code's **`ultracode`**
mode. Investigation showed `ultracode` is **not** a value you can pass to the engine:
the headless CLI's `--effort` flag accepts only `low | medium | high | xhigh | max`
and *ignores* `ultracode` with a warning. `ultracode` is a higher-level **session
mode** = **xhigh effort + standing dynamic-workflow orchestration** (and the trigger
keyword was renamed from `workflow` to `ultracode`).

Forcing that mode into a headless `fcc-claude -p` subprocess splits cleanly into two
halves with very different risk:

- **Effort tier (safe).** `--effort xhigh` is a real, valid flag. Worst case a backend
  that doesn't support extended effort ignores it — the single-JSON result envelope
  is unchanged either way.
- **Dynamic-workflow orchestration (the real risk is git, not JSON).** Reachable via
  the prompt **keyword trigger**, which lets the harness plan, spawn sub-agents, and
  synthesize. The synthesized final result almost certainly still resolves to one
  `{status, changed_files}` envelope (the sub-agents are internal to that one `-p`
  invocation), so the JSON contract is *not* the main hazard. The real collision is
  with the orchestrator's **git invariant**: the Worker edits the shared checkout and
  the orchestrator commits from `ROOT`; but a workflow sub-agent can call
  `EnterWorktree` and build in an **isolated worktree**. Then `carpenterCommit` (which
  stages `ROOT`) sees nothing → a **false "no changes" no-op** that silently discards a
  real build. Worktree isolation is a feature of *background* sessions, not foreground
  `-p` runs, so it is unlikely by default — but possible, and silent if unguarded.

**Decision:** force the safe half by default; make the workflow half **safe to enable**,
not merely opt-in. The Worker Carpenter gets `--effort xhigh` via `SHIP_CARPENTER_EFFORT`
(default `xhigh`; `""` disables, `max` for the highest tier). `SHIP_CARPENTER_WORKFLOW=1`
turns on the dynamic-workflow half with a **two-layer guard**:
1. **Prevent isolation.** The carpenter args gain `--disallowedTools EnterWorktree
   ExitWorktree`, so sub-agents *cannot* isolate — every workflow edit lands in the
   shared checkout the orchestrator commits from.
2. **Backstop the leak.** If a side worktree ever appears on a "no changes" round, the
   loop **fails loud** with its path (`sideWorktrees()`), never recording a false no-op
   that loses the build.

Applies to the **Worker Carpenter only** ("only the DeepSeek part"): the Master
(`claude`) foreman and the Codex Reviewer are untouched. `--effort` is added to the
carpenter engine args, so it also benefits the `SHIP_CARPENTER_CMD=claude` override
(where xhigh is fully supported).

## Why this shape

- **Reliability beats theoretical maximum.** The loop's whole value is a trustworthy,
  parseable hand-off. A flag that risks the result contract on every build is not worth
  the upside, so the contract-threatening half is off by default, not on.
- **The effort flag is free insurance.** A valid `--effort` value never errors; if the
  DeepSeek backend ignores it, nothing breaks. So defaulting it on costs nothing and
  helps wherever effort *is* honored (notably the `claude` override path).
- **One knob, honest naming.** `SHIP_CARPENTER_EFFORT` says what it does (an effort
  tier), rather than pretending `ultracode` is a thing the CLI understands.

## Considered and rejected

- **`--effort ultracode`** — what the request literally asked for; the CLI rejects it
  as an unknown value and silently uses the default. A no-op masquerading as a feature.
- **Workflow keyword on by default** — gives the full ultracode mode, but a sub-agent
  could isolate into a worktree the orchestrator can't commit. Kept opt-in, and only
  *after* adding the isolation block + backstop so enabling it can't silently lose work.
- **Auto-absorb an isolated worktree** — merge a leaked worktree's commits back into
  `ROOT` automatically. Rejected for now: too many ambiguous cases (detached HEAD,
  uncommitted-only edits, multiple worktrees) to do safely. Fail-loud-with-path is the
  honest backstop; auto-absorption is possible future work.
- **Apply to Master/Reviewer too** — out of scope; the request was the DeepSeek Worker.

## Consequences

- Verification is pending a live run with the real DeepSeek Worker, because `fcc-claude`
  is currently broken on the author's machine (missing `uv` cpython — see
  engine-environment notes). The flag is a valid no-op at worst, so this is low-risk,
  but whether DeepSeek *honors* xhigh effort is unconfirmed.
- A future reader wondering why "ultracode" became `--effort xhigh` plus a guarded
  keyword has the answer here: the mode isn't a single headless flag, and its second
  half collides with the orchestrator's commit-from-`ROOT` invariant unless isolation
  is blocked and leaks are caught.
- The workflow half is **safe to turn on**: with `SHIP_CARPENTER_WORKFLOW=1` a build
  either lands in `ROOT` (committed normally) or halts loudly pointing at the worktree
  — it can no longer silently no-op. What's still unverified is whether a real workflow
  *measurably helps* a multi-file Spec; confirming that needs a live run (blocked on the
  broken `fcc` engine, or testable via the `SHIP_CARPENTER_CMD=claude` path).
