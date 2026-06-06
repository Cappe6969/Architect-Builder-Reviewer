# 0005 — `/ship` entry point and the fail-fast preflight contract

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner
- **Depends on:** [ADR-0001](0001-automated-agent-orchestration.md), [ADR-0002](0002-loop-termination-severity-gating.md), [ADR-0004](0004-cross-model-orchestration-headless-cli.md)
- **Closes:** the documentation gap noted inline in `ship.js` ("Q7 was agreed but never written as an ADR")

## Context

The automated loop (ADR-0001) needs exactly one deterministic entry point. The human Architect triggers it after writing `SPEC.md` in plan mode. The expensive failure mode is **starting a loop that cannot succeed** — a missing Spec, a stale Graphify index, an unprotected `main` — and only discovering it after the Carpenter and Reviewer have already burned tokens.

We also had to decide whether the trigger pauses for human confirmation after verifying its own checklist.

## Decision

### Single trigger: `/ship`
A thin skill wraps `node ship.js`, invoked from the Architect's Opus session once `SPEC.md` exists. This realizes the **manual-gate / automated-loop** principle: the human has exactly **two** touchpoints in the entire pipeline —
1. write `SPEC.md` and fire `/ship`, and
2. resolve an `ESCALATION.md` if one appears.

Everything between is autonomous (the Retry Loop of ADR-0002).

### 5-step fail-fast preflight (runs BEFORE any tokens are spent)
1. **Spec check** — `SPEC.md` exists and is `> 0` bytes, else hard halt at **zero token cost**.
2. **Branch check** — create/checkout `swarm/<spec-slug>` so `main` is never touched and the Reviewer always has a clean `diff_ref`.
3. **Graph update** — `graphify . --update` must succeed; a failure halts before the Reviewer can read a stale index.
4. **State init** — `attempt = 0`; ensure `BACKLOG.md` exists; **delete any stale `ESCALATION.md`** so a leftover file can't be mistaken for a fresh halt.
5. **Budget bound** — the loop token ceiling (`CONFIG.tokenBudget`, distinct from the `190000` auto-compact window) is bound at launch.

### No confirmation gate
Preflight is **fully automatic**. If all five checks pass, the swarm executes up to the token budget or the circuit breaker without asking permission. Fail-fast is the protection mechanism; a confirmation prompt is not.

## Consequences

**Positive**
- A misconfigured run fails for **zero token cost** (missing Spec, failed graph update) instead of mid-loop.
- True single-command trigger; no babysitting — consistent with the swarm model that motivated ADR-0001.
- `main` is structurally protected; every run is isolated on its own `swarm/` branch.

**Negative / accepted costs**
- No human eyeball on the branch/graph state before spend — accepted, because fail-fast catches the failure classes that matter and a gate would re-introduce the babysitting four ADRs removed.
- ~~**Known limitation:** `swarm/<spec-slug>` is derived from the Spec's first heading; two Specs sharing an H1 collide on the same branch.~~ **RESOLVED 2026-06-05:** branch name is now `swarm/<spec-slug>-<sha256(spec)[:6]>` (Node built-in `crypto`, zero deps). The content hash is collision-proof and **deterministic** — an unchanged Spec maps to the **same canonical branch** (no orphan littering), so a re-run is *detected* rather than silently forked (a timestamp suffix was rejected for breaking that property). **Correction:** an earlier draft of this note said determinism lets a re-run "resume the same branch" — the loop never resumes; see the re-run policy amendment below.

## Amendment — 2026-06-05 — re-run policy (fail-fast refuse + `--fresh`)

Because deterministic naming + Halt & Leave (ADR-0006) mean a `swarm/` branch **persists after a clean pass** and a re-run of the same Spec lands on it, preflight step 2 now has explicit re-run behavior:

- **Branch exists with commits ahead of base →** **HALT** (fail-fast) with guidance to either merge it (`git checkout <base> && git merge <branch>`) or discard it (`git branch -D <branch>`). The script refuses to clobber a branch that is pending human review.
- **`--fresh` flag →** opt in to discarding the prior attempt: `git reset --hard <base>` and rebuild from scratch. Use after an Escalation when you've updated `SPEC.md` and accept throwing away the failed attempt.
- **Branch exists with zero commits ahead (already merged / empty) →** checked out and reused safely.

Rejected: **silent reset** (data-loss risk — would nuke a branch left for review) and **true resume** (too complex for V1; risks the Carpenter untangling a broken implementation instead of starting clean from an updated Spec).

## Alternatives considered

- **Confirmation gate after preflight.** Rejected: re-introduces a manual checkpoint into an autonomous pipeline; erodes the single-command goal.
- **Lazy checks during the loop.** Rejected: discovers a missing Spec or stale graph only *after* spending tokens — the exact waste preflight exists to prevent.
