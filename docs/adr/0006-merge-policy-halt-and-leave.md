# 0006 — Merge policy: Halt & Leave with change-surface summary

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner
- **Depends on:** [ADR-0002](0002-loop-termination-severity-gating.md), [ADR-0005](0005-ship-entry-point-and-preflight.md)

## Context

On a **Clean Pass** (zero High findings) the loop has produced reviewed code on the isolated `swarm/<slug>-<hash>` branch. What happens to that branch? Three options:

1. **Auto-merge** into the base branch.
2. **Open a draft PR.**
3. **Halt & Leave** — stop on the work branch and let the human Architect merge.

## Decision

**Halt & Leave.** On a Clean Pass the script stops on the `swarm/` branch and does **not** merge. The Architect is the final gatekeeper.

**Strict requirement:** the halt is not a generic success message. The script prints the **change surface** directly to the terminal — `git diff --stat <base>...HEAD` — plus the exact merge command, so the operator sees what they're about to merge without digging:

```
  Change surface (main...swarm/<slug>-<hash>):
    <git diff --stat output>

  Review, then merge when satisfied:
    git checkout main && git merge swarm/<slug>-<hash>
```

## Consequences

**Positive**
- The human remains the final gate — a "clean" automated pass is necessary but not sufficient to ship; subtly-wrong-but-passing code still gets a human look.
- Zero external dependencies (no `gh`, no network) — honors the self-contained principle (ADR-0001/0004).
- The change surface is on the terminal at the moment of decision; no digging.

**Negative / accepted costs**
- One manual merge step on the happy path. This makes the **merge the deliberate exit gate**: the Architect gates *entry* (`SPEC.md` + `/ship`) and *exit* (review + merge); the loop is autonomous in between and only pulls the human mid-flight on escalation. (Refines ADR-0005's "two touchpoints" framing into entry/exit gates.)

## Alternatives considered

- **Auto-merge.** Rejected: too dangerous — a green loop can still ship subtly wrong code; removes the human gate entirely.
- **Draft PR.** Rejected: adds an external dependency (`gh` CLI / network / a remote) to a local-first script, against the self-contained design.
