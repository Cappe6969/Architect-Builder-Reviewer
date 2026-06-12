# CONTEXT — Glossary

> Canonical language for the Architect / Carpenter / Reviewer workflow.
> This file is a **glossary only** — no implementation details, no specs, no decisions. Terms are added as they are resolved during grilling sessions.

## Spec
The single artifact that carries the Architect's intent to the Carpenter. A file on disk named **`SPEC.md`**, written by the Architect in plan mode, detailed enough that the Carpenter can build it **without making design decisions**. The Carpenter reads it **by path, not by paste**.

- Canonical term: **Spec**. The word **"blueprint" is retired** — use it at most as casual prose, never as a named artifact.
- A Spec is *instructions to build*, not a glossary and not an ADR.

## Architect
The role that decides. Claude Code running real **Opus** (`claude`). Owns planning, design/taste, terminology, and the Spec. Also applies fixes after review. Never grades its own output. Reachable as an **interactive multi-turn agent** through `ship-app` (a localhost chat) — it converses, then writes `SPEC.md`. By exception it also **builds**: UI / front-end-from-handoff work, which the Carpenter cannot do well, is built by the Architect directly before the loop runs (the Reviewer then audits those files against the Spec). See [ADR-0011](docs/adr/0011-architect-chat-app-and-ui-routing.md).

## Carpenter
The role that builds. By default the **`claude`** agent pointed at **DeepSeek V4** via DeepSeek's Anthropic-compatible endpoint (no `free-claude-code` router to install — see [ADR-0012](docs/adr/0012-deepseek-direct-no-fcc-router.md)); falls back to Anthropic Claude when no DeepSeek key is set, and `SHIP_CARPENTER_CMD=fcc-claude` restores the legacy router. Executes the Spec verbatim; makes **no** design decisions. Never sees secrets/IP (see workflow guardrails). Realized as a **sub-swarm** — a Master Carpenter supervising one or more Worker Carpenters — entirely behind the `runRole` seam, so the outer loop still sees a single Carpenter.

## Master Carpenter
The supervising agent inside the Carpenter sub-swarm (the "foreman"). Owns **completeness, spec-adherence, and conciseness** of the build: every Spec requirement met, nothing invented or skipped, no over-engineering or needless code length. Explicitly does **not** judge correctness or hunt bugs — that stays with the independent Reviewer, because the Master shares the Workers' model and so cannot provide independent eyes (the self-preference trap). Carpenter token cost is treated as negligible, so its supervision may iterate freely. See [ADR-0008](docs/adr/0008-carpenter-sub-swarm.md).
- _Avoid_: inner reviewer, QA, second reviewer (it is **not** a Reviewer — it never owns correctness).

## Worker Carpenter
The agent(s) inside the Carpenter sub-swarm that actually write the code, directed and corrected by the Master Carpenter.
- _Avoid_: apprentice (casual prose only), builder, coder.

## Reviewer
The role that breaks. **Codex (GPT-5.x)**, invoked **headlessly via the `codex exec` CLI** — *not* the in-session `/codex` plugin, because the automated loop drives engines headlessly (see [ADR-0004](docs/adr/0004-cross-model-orchestration-headless-cli.md)). Read-only; audits the Carpenter's output and returns prioritized findings with exact line refs. Never plans, never edits. *(The `/codex` plugin remains valid for manual, ad-hoc reviews outside the loop.)*

## /ship
The single trigger for the whole loop: a skill (`.claude/skills/ship/SKILL.md`) wrapping `node ship.js`, fired by the Architect once `SPEC.md` exists. The skill is thin glue — it delegates all preflight to `ship.js` and only interprets the exit code (0 = clean pass → present merge; 2 = escalation → read `ESCALATION.md`; 1 = preflight halt). Embodies the **manual-gate / automated-loop** principle — the human's only two touchpoints are firing `/ship` and resolving an `ESCALATION.md`. See [ADR-0005](docs/adr/0005-ship-entry-point-and-preflight.md).

## Preflight
The 5-step fail-fast gate `/ship` runs **before any tokens are spent**: (1) Spec exists & non-empty, (2) `swarm/<spec-slug>-<hash>` branch checked out (deterministic content hash avoids collisions; **refuses** to clobber an existing branch with unmerged work unless `--fresh`), (3) Graphify index refreshed, (4) state init (attempt=0, ensure `BACKLOG.md`, delete stale `ESCALATION.md`), (5) token budget bound. Any failure halts at zero token cost. Fully automatic — no confirmation gate. See [ADR-0005](docs/adr/0005-ship-entry-point-and-preflight.md).

## Lock (`.ship.lock`)
The concurrency guard enforcing **one `/ship` run per working tree**. Written at the top of Preflight with `{ pid, started, cwd }`; refuses to start if a live run holds it, but **auto-reclaims a stale lock** whose PID is dead (`process.kill(pid, 0)`), so a force-kill never bricks `/ship`. Released on every graceful exit; git-ignored. See [ADR-0007](docs/adr/0007-concurrency-lock.md).

## Orchestrator seam (`runRole`)
The single engine-routing function `runRole(role, payload) -> JSON` that the `.js` loop calls to run a role. Implemented with Node `child_process` headless CLI calls (`fcc-claude -p` for the Carpenter, `codex exec` for the Reviewer). The loop logic lives **above** this seam and never knows which engine ran. See [ADR-0004](docs/adr/0004-cross-model-orchestration-headless-cli.md).

## Handoff Payload
The structured JSON envelope passed across one edge of the loop, always **by reference (paths/refs), never inlined text**. Four edges exist:
- **Architect→Carpenter** — Spec path + token budget + build context
- **Carpenter→Reviewer** — diff/branch ref + `graph_ref` (Graphify index) + changed files
- **Reviewer→Carpenter** — High-only `failed_findings` + attempt number (the Retry Loop edge)
- **Reviewer→Architect** — escalation only (see Escalation), when the Circuit Breaker trips

Exact schemas are fixed during the Calibration Cycle. See [ADR-0001](docs/adr/0001-automated-agent-orchestration.md), [ADR-0002](docs/adr/0002-loop-termination-severity-gating.md).

## Retry Loop
The autonomous **outer** loop between **Carpenter and Reviewer** for rounds 1–2 (and round 3's attempt). The Architect is **not** part of it — it spins Carpenter↔Reviewer until a Clean Pass or the Circuit Breaker trips. Keeps revision rounds free of human/Architect involvement.

## Supervision Loop
The autonomous **inner** loop inside the Carpenter sub-swarm, between the **Master Carpenter and Worker Carpenter** (parallel to the outer Retry Loop). The Worker builds; the Master inspects for completeness/spec-adherence/conciseness; if unsatisfied it returns corrections and the Worker fixes. **Bounded**: 1 build + up to 2 Master-directed fix rounds (`supervisionCap`). At the cap the Master hands the best-effort build to the Reviewer with its unresolved concerns noted — it **never escalates on its own**; the outer Circuit Breaker stays the only path to the Architect. See [ADR-0008](docs/adr/0008-carpenter-sub-swarm.md).

## Calibration Cycle
The single manual run of the full loop, done once before automation, whose only purpose is to observe the real shape of each Handoff Payload and how the Reviewer formats its findings and pass/fail signal — so the `.js` workflow can be built against observed reality, not guesses.

## Clean Pass
The loop's success condition: a full Reviewer pass returning **zero `High`-severity findings**. `Medium`/`Low` findings do not block a Clean Pass. See [ADR-0002](docs/adr/0002-loop-termination-severity-gating.md).

## Merge Policy
**Halt & Leave.** On a Clean Pass the loop stops on the `swarm/` branch and **never auto-merges** — the Architect is the final gatekeeper. The script prints the change surface (`git diff --stat <base>...HEAD`) plus the merge command directly to the terminal so the operator reviews without digging. No draft PR (would add external deps). The merge is the deliberate **exit gate**; the Architect gates entry (`SPEC.md` + `/ship`) and exit (review + merge). See [ADR-0006](docs/adr/0006-merge-policy-halt-and-leave.md).

## Circuit Breaker
The safety cap on the loop: a maximum of **3 review rounds** per Spec. If `High` findings remain after round 3, the loop halts and escalates to the Architect instead of continuing. Prevents runaway token spend on an unresolvable issue.

## Backlog
The rolling **`BACKLOG.md`** file at repo root. The workflow automatically appends unaddressed `Medium`/`Low` findings here so deferred issues are captured for later cleanup cycles rather than lost.

## Finding
A single issue emitted by the Reviewer, carrying a **severity** (`High`/`Medium`/`Low`), a file + exact line, a summary, and a recommendation. Severity is the field the loop predicate reads.

## Escalation
The terminal state when the Circuit Breaker trips. The workflow writes **`ESCALATION.md`** at repo root (into a watched folder) and emits a native terminal bell. Its centerpiece is the **Root-Cause Hypothesis**, generated by the **Reviewer** (never the Carpenter). See [ADR-0003](docs/adr/0003-escalation-artifact-and-alerting.md).

## Root-Cause Hypothesis
The Reviewer's classification of why the loop failed: **`spec_defect`** (the Spec was flawed) or **`context_gap`** (insufficient/broken context), with rationale. Tells the human Architect whether to rewrite `SPEC.md` or augment context. Generated by the Reviewer because a failed Carpenter self-diagnoses defensively.
