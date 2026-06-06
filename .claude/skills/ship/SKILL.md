---
name: ship
description: Trigger the automated Architect/Carpenter/Reviewer loop on the current SPEC.md. Use when the user types /ship, says "ship it", or asks to run the swarm build. Runs `node ship.js`, which preflights then loops the Carpenter (DeepSeek via fcc-claude) and Reviewer (Codex via codex exec) until a clean pass or the circuit breaker.
---

# /ship — run the automated swarm loop

You are the **Architect**. The human has (presumably) written `SPEC.md`. Your job here is **thin glue**: run the orchestrator, then interpret what it returns. Do **not** re-implement any of its logic.

## Hard rules
- **Delegate all preflight to `ship.js`.** Do not check `SPEC.md`, branches, or the graph yourself — `ship.js` does the 5-step fail-fast preflight and will exit cleanly with a reason if something is wrong. Just run it and relay the reason.
- **Never auto-merge.** Halt & Leave (ADR-0006): the Architect gates the exit. On a clean pass, present the change surface and the merge command — do not run the merge unless the human explicitly tells you to.
- **Never edit `SPEC.md` on your own.** If the loop escalates with `spec_defect`, summarize the fix needed and let the human decide.
- **`--fresh` is destructive.** Only pass it when the human explicitly asks (e.g. "/ship fresh", "ship --fresh", "discard the old branch and re-run"). It throws away an unmerged `swarm/` branch.

## Steps

1. **Confirm the orchestrator is present.** If `ship.js` is not in the repo root, tell the human it isn't set up here and stop.

2. **Decide flags.** If the human asked for a fresh run, use `node ship.js --fresh`; otherwise `node ship.js`.

3. **Run it** with the Bash tool from the repo root. It is long-running (up to 3 rounds × two engine calls). Prefer running it in the **background** and reporting when it finishes; for quick runs, foreground with a generous timeout is fine. **Relay `ship.js`'s own stdout verbatim** — its log lines (`[ship] …`) and the change surface are the source of truth; do not paraphrase away the diff.

4. **Interpret the exit code** and tell the human exactly what happened and what to do next:

   | Exit | Meaning | What you do |
   |------|---------|-------------|
   | **0** | **CLEAN PASS** | Show the printed `Change surface (...)` and the merge command. Remind: nothing was merged. Ask if they want you to run `git checkout <base> && git merge <branch>`. Mention `BACKLOG.md` if Medium/Low were logged. |
   | **2** | **Circuit breaker / escalation** (or budget exceeded) | **Read `ESCALATION.md`.** Summarize its `root_cause_hypothesis`: if `spec_defect` → tell them which part of `SPEC.md` to revise; if `context_gap` → tell them what context is missing (often: refresh/extend the Graphify index). After they fix it, the re-run uses `/ship --fresh` (the failed branch is pending and will otherwise block). |
   | **1** | **Preflight halt** (e.g. missing `SPEC.md`, failed graph update) or fatal error | Relay the exact reason from stdout. The most common case is no `SPEC.md` — tell them to write it first (in plan mode). |

5. **Do not loop on your own.** `ship.js` owns the retry/breaker logic. Your job ends when you've reported the outcome.

## Prerequisites (mention only if a run fails on them)
- `fcc-claude` (Carpenter) and `codex` (Reviewer CLI) must be on PATH and configured. If `ship.js` reports an engine could not be spawned, point the human at the Calibration Cycle (`node calibrate.js`) and the setup guide.
