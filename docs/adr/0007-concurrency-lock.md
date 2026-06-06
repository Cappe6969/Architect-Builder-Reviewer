# 0007 — Concurrency lock with stale-PID reclaim

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Project owner
- **Depends on:** [ADR-0005](0005-ship-entry-point-and-preflight.md)

## Context

`ship.js` mutates a single shared working tree (branch checkout, commits, Graphify index). Two concurrent `/ship` runs would corrupt that state — fighting over the index, the checkout, and `graph.json`. Relying on a usage convention ("don't run two at once") guarantees an eventual corrupted workspace.

## Decision

A **`.ship.lock`** file at repo root enforces one run per working tree, acquired at the **top of preflight** (before any mutation or token spend).

- **Contents:** `{ pid, started, cwd }` — the PID is the liveness key.
- **On an existing lock:** check whether `pid` is still running via `process.kill(pid, 0)` (`EPERM` = alive, `ESRCH` = dead; works on Windows). If **alive → refuse** with a clear message. If **dead → stale: auto-reclaim** (log, delete, proceed). A force-kill (`SIGKILL`) or terminal crash must never permanently brick `/ship` behind a hidden lock file requiring a manual hunt.
- **Release on every graceful exit path:** `process.on('exit', …)` covers normal exit, `process.exit()` (clean pass, escalation, halt), and uncaught → `fail()` → exit; `SIGINT`/`SIGTERM` handlers route to `process.exit` so the `exit` hook fires. Release only deletes the lock if its `pid` matches our own (never deletes another run's lock).
- **`SIGKILL` is uncatchable** — which is the entire reason the stale-PID reclaim exists.
- `.ship.lock` is **git-ignored** so it can never be staged into a commit.

## Consequences

**Positive**
- Concurrent runs are impossible; the working tree can't be corrupted by overlap.
- A crashed run self-heals on the next invocation — no manual cleanup.
- Zero dependencies (Node built-ins, signal 0).

**Negative / accepted costs**
- Tiny race window: two runs starting within milliseconds could both see "no lock." Acceptable for a single-user local tool; a true lock would need `O_EXCL` atomic create (a possible later hardening).
- A lock whose PID was *reused* by an unrelated process would read as "alive" and falsely block. Extremely unlikely on a desktop within a session; the message tells the human how to clear it.

## Alternatives considered

- **Usage convention only.** Rejected: guarantees eventual corruption.
- **Refuse stale locks, require manual `rm`.** Rejected: a crash would brick `/ship` until a human hunts down a hidden file — bad ergonomics.
- **OS-level / `O_EXCL` atomic lock.** Deferred: stronger against the millisecond race, but more complexity than a single-user V1 needs.
