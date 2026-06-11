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
- **Dynamic-workflow orchestration (risky).** Only reachable via the prompt **keyword
  trigger**, which asks the harness to spawn Workflow *sub-agents*. That can change the
  process's output shape, and the loop hard-depends on each Worker call returning one
  `{status, changed_files}` JSON object (ADR-0002 shape guard). A broken envelope →
  synthetic High → wasted rounds → escalation: the *opposite* of "always works."

**Decision:** force only the safe half by default. The Worker Carpenter gets
`--effort xhigh` via `SHIP_CARPENTER_EFFORT` (default `xhigh`; set to `""` to disable,
or `max` for the highest tier). The workflow-orchestration half is **opt-in** behind
`SHIP_CARPENTER_WORKFLOW=1`, which injects the `ultracode` trigger keyword into the
Worker's build prompt — documented as "may alter the result envelope."

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
- **Workflow keyword on by default** — gives the full ultracode mode, but lets dynamic
  sub-agents break the JSON envelope unpredictably. Kept as an explicit opt-in instead.
- **Apply to Master/Reviewer too** — out of scope; the request was the DeepSeek Worker.

## Consequences

- Verification is pending a live run with the real DeepSeek Worker, because `fcc-claude`
  is currently broken on the author's machine (missing `uv` cpython — see
  engine-environment notes). The flag is a valid no-op at worst, so this is low-risk,
  but whether DeepSeek *honors* xhigh effort is unconfirmed.
- A future reader wondering why "ultracode" became `--effort xhigh` plus an opt-in
  keyword has the answer here: the mode isn't a single headless flag, and its second
  half fights the result contract.
