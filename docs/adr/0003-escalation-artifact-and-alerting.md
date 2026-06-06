# 0003 — Escalation artifact, root-cause diagnosis, and native-only alerting

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner
- **Depends on:** [ADR-0002](0002-loop-termination-severity-gating.md)

## Context

When the Circuit Breaker trips (`attempt == 3 && High findings remain`), the loop must hand the human Architect a **diagnosis, not a mess**. Two questions had to be settled: (1) what the escalation artifact is and who generates its root-cause hypothesis, and (2) how the human is alerted that the pipeline has halted.

## Decision

### 1. Artifact: `ESCALATION.md` at repo root
Consistent with the file-on-disk philosophy (`SPEC.md`, `BACKLOG.md`). Keeps pipeline state fully transparent on disk. Schema:

```js
{ reason: "circuit_breaker_tripped",
  spec_path, diff_ref, graph_ref,
  rounds_attempted: 3,
  unresolved_findings: [ {severity:"High", file, line, summary, recommendation} ],
  attempt_history: [ {round, fix_attempted, why_it_failed}, ... ],
  root_cause_hypothesis: { classification: "spec_defect"|"context_gap", rationale } }
```
Token discipline is **deliberately inverted** here: this payload is read once, by a human, outside the loop — completeness beats thrift, so summaries/history are inlined (the opposite of the by-reference rule inside the Retry Loop).

### 2. The Reviewer (Codex) generates `root_cause_hypothesis` — NOT the Carpenter
At `attempt == 3` the `.js` passes `attempt_history` to the **Reviewer** and commands it to append the hypothesis before the final JSON is written to `ESCALATION.md`.

Rationale: a Carpenter that has failed three rounds has heavily degraded context and is "in the weeds" — asking it to diagnose its own failure yields **defensive hallucination** ("the linter is broken"), not objective analysis. The Reviewer holds the clean, external perspective and knows precisely why it rejected the code each round.

### 3. Alerting: native-only — watched folder + terminal bell
**No external notification APIs** (Twilio/Slack/email) in the `.js`. The script:
- writes `ESCALATION.md` into a **watched folder** (e.g. an Obsidian vault or a path the broader orchestrator monitors), and
- emits a **native OS terminal bell (`\x07`)** when it halts.

External alerting is delegated to the existing ecosystem (file-watcher / orchestrator). The Claude Code script stays strictly focused on agent management.

## Consequences

**Positive**
- Escalation produces a directed action (`spec_defect` → rewrite `SPEC.md`; `context_gap` → augment/refresh Graphify index), not a re-derivation of three dead-end rounds.
- Diagnosis comes from the objective agent, avoiding self-serving hallucination.
- Zero external network dependencies in the script → no class of failure where a notification error destroys the escalation artifact.

**Negative / accepted costs**
- Alerting now depends on an external watcher/orchestrator being configured; a terminal bell alone is easy to miss if the operator isn't near the terminal.
- `root_cause_hypothesis` is only as good as Codex's judgment — it is a hypothesis, not ground truth.

## Alternatives considered

- **Carpenter generates the hypothesis.** Rejected: failing-agent self-diagnosis is unreliable and defensive.
- **Push notification (Twilio/Slack/email) on escalation.** Rejected: external network deps make a local safety-valve script brittle; an API failure could lose the escalation entirely.

## Human resolution path
Read `ESCALATION.md` → if `spec_defect`, rewrite `SPEC.md`; if `context_gap`, augment context (often refresh/extend the Graphify index) → re-trigger the loop with `attempt` reset to 0.
