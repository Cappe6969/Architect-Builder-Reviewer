# Carpenter sub-swarm: a Claude-supervised, inspect-and-correct foreman

**Status:** accepted

## Context & decision

The single-agent Carpenter (DeepSeek via `fcc-claude`) is cheap but exhibits the
classic failure modes a cheap builder has: **laziness** (builds 7 of 15 things),
**drift** (builds something off-Spec), and **over-engineering** (needless code
length / bloat). The independent Reviewer (Codex) catches *correctness* bugs, but
it is the wrong — and too-late, too-expensive-to-loop — tool for "did you build
*all* of it, tightly?"

We make the **Carpenter a two-agent sub-swarm**, entirely behind the existing
`runRole` seam (ADR-0004), so the outer loop is unchanged and still sees one
Carpenter returning `{status, changed_files}`:

- **Worker Carpenter** — DeepSeek (`fcc-claude`). Writes the code. Cheap; we treat
  its token cost as negligible, so supervision may iterate freely.
- **Master Carpenter** — **Claude** (real `claude`, the Architect's engine). A
  *foreman* that inspects the Worker's uncommitted working tree against the Spec
  and judges **only completeness, spec-adherence, and conciseness** — never
  correctness. If unsatisfied, it issues specific corrections back to the Worker.

The inner **Supervision Loop** is bounded: **1 build + up to 2 Master-directed
fix rounds** (`CONFIG.supervisionCap = 2`). If the Master is still unsatisfied at
the cap, it **hands the best-effort build to the Reviewer anyway**, attaching its
unresolved concerns as a note. There is **no inner escalation**: the outer Circuit
Breaker (ADR-0002/0003) remains the *only* path to the Architect. The sub-swarm
re-engages identically on outer retries (Worker fixes the Reviewer's High finding;
Master inspects the fix before re-handing). Master (Claude) calls count toward the
token budget, which partly un-blinds the meter since Claude emits a `usage`
envelope (DeepSeek and Codex `-o` do not).

## Why this shape

- **The Master is an amplifier, not a gate.** Correctness authority stays with the
  *independent* Reviewer. A Master that judged correctness would (a) duplicate the
  Reviewer and (b) be **the same model grading kin output** — re-introducing the
  self-preference failure the three-model split exists to kill (WORKFLOW §0). It is
  confined to completeness/conciseness precisely because those are intra-model-safe.
- **Claude Master, not DeepSeek Master.** Conciseness/anti-bloat is a *taste* call;
  a same-model foreman gives a cheap opinion on its own crew's style. "Carpenter
  cost is superfluous" is the unlock: the Master makes one judgment per round over a
  diff (not bulk codegen), so smart supervision is affordable.

## Considered and rejected

- **DeepSeek Master** — free, but weak on taste and mildly self-preferential. Rejected
  for the quality goal.
- **Parallel Worker crew (fan-out/synthesize)** — optimizes *throughput*, not the
  *output control* that was the actual goal, and makes conciseness harder (more
  seams/duplication). Deferred as a separate future feature; build the foreman before
  hiring the crew.
- **Inner escalation** — if the Master gave up it would trip the breaker early. Rejected:
  two competing escalation paths, and it would escalate builds the independent Reviewer
  might have passed. One gate, one escalation path.

## Consequences

- A future reader seeing the "cheap" Carpenter spawn **Claude** calls has the rationale
  here: cheap *building*, smart *supervision*, cost-is-superfluous-in-this-sub-swarm.
- Engine routing inside the sub-swarm adds a third engine (`master`) to
  `CONFIG.engines`; the seam (ADR-0004) absorbs it. `SHIP_MASTER_CMD` overrides it,
  mirroring `SHIP_CARPENTER_CMD`.
- **`--fresh` data-loss guard.** During development a `--fresh` re-run did
  `git reset --hard`, which reverts tracked-file changes and silently destroyed
  uncommitted work. Preflight now refuses `--fresh` while tracked files are dirty
  (untracked files survive a hard reset and are exempt). `--fresh` discards the
  *branch's commits*, never your *working tree*.
