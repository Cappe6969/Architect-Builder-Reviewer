# 0001 — Automated agent orchestration for the Architect/Carpenter/Reviewer loop

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner

## Context

The workflow runs a loop: **Architect** (Claude Opus) writes a Spec → **Carpenter** (Claude Code on DeepSeek V4) builds it → **Reviewer** (Codex/GPT-5.x) audits it → Architect applies fixes → repeat until a clean pass.

The question was *who moves work between the three roles*: a human acting as message bus across three terminals (copy Spec path to Carpenter, diff to Codex, findings back to Architect), or an automated single-command workflow.

Constraints that drove the decision:
- The owner already operates agents as a **coordinated swarm** with a single-command trigger goal. Babysitting three terminals and hand-copying context is a regression against that model.
- The long-session failure modes this whole workflow exists to fix (agent laziness, self-preference, goal drift) are *process* problems — they want a process encoded once, not re-performed by hand each time.
- Automating a process **before it is understood** bakes in unfound friction. The biggest unknown is how Codex emits pass/fail (its "failure-state" formatting), which the control flow must parse.

## Decision

Automate the loop as a **single self-contained native Claude Code `.js` workflow**, reached via a **hybrid on-ramp**:

1. **One Calibration Cycle (manual).** Run the loop by hand exactly once to capture the real shape of each **Handoff Payload** and — critically — how Codex formats its findings and pass/fail signal.
2. **Lock it into a `.js` workflow.** Encode the calibrated loop using the native Claude Code workflow mechanism (the `.js` + `SKILL.md` bundle from the guide's "Sharing" section). Keep the loop **tight and self-contained**.
3. **Defer broader orchestration.** Do **not** hook into any larger orchestration framework yet. If cross-workflow reuse is needed later, integrate then.

## Consequences

**Positive**
- Single-command trigger; no terminal babysitting; reproducible, shareable (`.js` + `SKILL.md`).
- Calibration-first means the automation is built on observed payloads, not guesses — especially Codex's failure states.
- Self-contained native `.js` keeps the dependency surface minimal.

**Negative / accepted costs**
- The `.js` calcifies a specific process; revisiting it later requires deliberate effort (this is the "hard to reverse" risk we are accepting).
- We must reverse-engineer Codex's finding/pass-fail format during the Calibration Cycle; if Codex changes its output format, the parser needs maintenance.
- Native `.js` may limit reuse if we later adopt a broader orchestration framework — accepted as a deferred problem.

## Alternatives considered

- **Human-orchestrated loop (manual message bus).** Rejected: a regression against the owner's existing single-command swarm model; slow; re-performs the process by hand every time.
- **Design straight for a broader orchestration framework now.** Deferred: premature before the single loop is proven; adds dependency and abstraction the current scope doesn't need.
