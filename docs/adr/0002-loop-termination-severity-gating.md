# 0002 — Loop termination, severity gating, and deferred-finding capture

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner
- **Depends on:** [ADR-0001](0001-automated-agent-orchestration.md)

## Context

The automated loop (ADR-0001) needs a **terminating predicate** the `.js` workflow can evaluate. The guide's original wording — "loop until no new issues" — does not terminate reliably: a reviewer can always surface one more minor finding, so a "zero findings" gate risks endless Carpenter↔Reviewer rounds and unbounded token spend on stylistic or minor-refactor churn.

The pipeline's job is to **ship functional features and move forward**, not to chase nitpicks in an automated swarm.

## Decision

**Clean pass ≡ zero `High`-severity findings on a full Reviewer pass.**

- **Severity gate:** the loop continues only while a `High` finding exists. `Medium`/`Low` findings **do not block**.
- **Circuit breaker:** hard cap of **3 review rounds** per Spec. If `High` findings remain after round 3, the workflow **stops and escalates to the Architect** rather than looping. Rationale: three failed targeted attempts on a High issue almost always means the `SPEC.md` was flawed or context is broken — which requires Architect intervention anyway.
- **Deferred-finding capture:** unaddressed `Medium`/`Low` findings are **automatically appended to a rolling `BACKLOG.md`** by the workflow, so they are captured for future cleanup cycles instead of evaporating.

## Consequences

**Positive**
- The predicate **provably terminates** (gate on High + 3-round cap), giving cost control — the guide's "tell the agent its token budget" rule, enforced in code.
- Carpenter and Reviewer can't burn tokens debating minor style/refactors.
- Nothing is silently dropped: Medium/Low live on in `BACKLOG.md`.
- A tripped breaker routes to the right place (Architect) for the right reason (likely Spec/context defect).

**Negative / accepted costs**
- `Medium`/`Low` issues **ship unfixed** until a later backlog-cleanup cycle.
- Correct severity gating depends on the Reviewer (Codex) emitting a **parseable severity per finding** — this is a primary thing the Calibration Cycle must confirm.
- `BACKLOG.md` will grow and needs its own periodic cleanup pass (out of scope here).

## Alternatives considered

- **Gate on zero findings (any severity).** Rejected: does not reliably terminate; burns tokens on nitpicks.
- **Gate on zero High AND zero Medium.** Rejected for the default loop: safer output but more rounds, more tokens, and far higher chance of tripping the circuit breaker. May be reconsidered for a slower "polish" mode later.
- **No round cap.** Rejected: a stubborn High issue would loop until manual kill — the exact runaway-cost failure automation is meant to prevent.

## Amendment — 2026-06-05 — loop topology

The original decision implied every failed review returned to the Architect. Corrected: the **inner Retry Loop spins directly between Carpenter and Reviewer** for rounds 1–2; the Architect is **only** summoned when `attempt == 3 && High findings remain`.

- This requires a **fourth Handoff Payload edge: Reviewer → Carpenter** (`{ spec_path, failed_findings:[High only], attempt }`) — not present in the original three-edge schema.
- The human Architect is therefore an **escalation target, not an inner-loop participant**, keeping rounds 1–2 fully autonomous.

### Related implementation contracts (deliberately NOT separate ADRs)

These are required engineering tactics, not genuine trade-offs (no serious alternative), so per our ADR bar they live here as contracts the `.js` must honor:

1. **Defensive finding parser.** The Reviewer (Codex on free ChatGPT tier) cannot be trusted to emit clean JSON — it will wrap in markdown fences or add conversational preamble. The `.js` MUST run a defensive parse (strip fences → `JSON.parse` in `try/catch`); on total failure, command the **Carpenter** to do a cheap "coerce-to-JSON" pass before the predicate is evaluated. The script must never crash on a regex/parse mismatch.
2. **Graph-aware review.** The Carpenter → Reviewer payload carries a `graph_ref` (the Graphify index) so the Reviewer understands the blast radius of a change across folders/repos, minimizing false-positive `High` flags. Cost: extra tokens into review; benefit: fewer wasted rounds. Requires the Graphify index to be fresh before review. **The index is incrementally refreshed (`graphify . --update`, changed files only) before EVERY round's audit — not just at preflight** — otherwise rounds 2–3 audit new code against a stale map, producing false-positive Highs that needlessly trip the breaker. The mid-loop refresh is **non-fatal**: on failure the loop logs and proceeds on the prior graph (vs preflight's hard halt).
