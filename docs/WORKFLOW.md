# EXPERT WORKFLOW — Architect / Carpenter / Reviewer

> A complete, **PowerShell / Windows** implementation guide for a three-model coding pipeline, driven by a **single command** (`/ship`):
> **Claude Opus (Architect)** plans → **DeepSeek V4 (Carpenter)** writes the heavy code cheaply → **Codex / GPT-5.x (Reviewer)** audits it → fixes loop automatically until a clean pass.
>
> The Carpenter is **Claude Code itself** — the same Anthropic harness — with the underlying model swapped to **DeepSeek V4** via a local router (`fcc-claude`), at ~1/100th the cost. The whole loop is automated by `ship.js`. The Architect gates the **entry** (write `SPEC.md`, fire `/ship`) and the **exit** (review the printed change surface, then merge — Halt & Leave, ADR-0006); the loop is autonomous in between and pulls the human in mid-flight only to **resolve an `ESCALATION.md`**.
>
> **This guide describes the automated pipeline.** The canonical design record is `CONTEXT.md` (glossary) + `docs/adr/0001…0005` (decisions). When this guide and an ADR disagree, the ADR wins.

---

## 0. The Core Idea (read this first)

A single long Claude session degrades in four predictable ways: **agent laziness** (does 7 of 15 tasks), **self-preference** (grades its own work too kindly), **goal drift** (forgets the original intent after compactions), and **token cost** (Opus rates on work that doesn't need Opus thinking).

This workflow fixes all four by splitting the job across three specialists with **separate context windows and separate billing**, coordinated by an orchestrator script (not a human message-bus):

| Role | Who it actually is | Why | Strengths |
|------|--------------------|-----|-----------|
| **Architect** | Claude Code → **real Opus** (`claude`) | Has *taste*. Pay once to get the plan right. | Planning, UI/UX, design systems, edge-case reasoning. Writes `SPEC.md`. Resolves escalations. |
| **Carpenter** | Claude Code → **DeepSeek V4**, called headlessly (`fcc-claude -p`) | Same Anthropic harness, cheap model. Builds the Spec; no design decisions. | Big code writing, scripts, backend, "dirty work." |
| **Reviewer** | **Codex / GPT-5.x** — `codex exec` CLI in the loop (the `/codex` plugin for manual reviews) | Independent eyes — breaks the self-preference loop. | Bug-hunting, adversarial review, severity grading, root-cause diagnosis. |

The handoff in one sentence: **"Opus already decided. The Spec is on disk. Carpenter, build it. Codex, try to break it."**

> ⚠️ DeepSeek runs on China-based servers. The Carpenter never touches secrets, client data, or unpublished IP — enforced **structurally** by a skill file (§6), not by memory.

---

## 1. Architecture — the automated state machine

There is **no manual copy-paste between terminals.** The Architect writes `SPEC.md` and fires `/ship`; `ship.js` drives the rest. The loop spins **Carpenter ↔ Reviewer** autonomously (the *Retry Loop*) and only summons the human on escalation.

```
       [ START: /ship trigger ]
                  │
                  ▼
       ┌──────────────────────┐
       │ 1. Preflight (×5)    │ ──(any fail)──► [ HARD HALT · 0 tokens ]
       └──────────────────────┘
                  │ (pass)
                  ▼
       ┌──────────────────────┐
       │ 2. Carpenter build   │◄─────────────────────────────┐
       │    (fcc-claude -p)   │                              │
       └──────────────────────┘                              │
                  │                                          │ Reviewer→Carpenter
                  ▼                                          │ (High findings only,
       ┌──────────────────────┐                              │  round < 3)
       │ 3. Scoped commit     │                              │
       │  (orchestrator owns  │                              │
       │   git, ORCH_EXCLUDES)│                              │
       └──────────────────────┘                              │
            │ zero changes? ──► synthetic High ──────────────┤
            │ (no-op guard)                                  │
            ▼                                                │
       ┌──────────────────────┐                              │
       │ 4. Reviewer audit    │                              │
       │    (codex exec)      │                              │
       └──────────────────────┘                              │
                  │                                          │
          (findings severity?)                               │
          ├── zero High ──────► [ CLEAN PASS · merge · exit 0 ]
          │   (Medium/Low → BACKLOG.md)                       │
          └── High exist                                      │
                  │                                          │
          (circuit breaker: round == 3?)                      │
          ├── no  ─────────────────────────────────────────────┘
          └── yes ──► [ WRITE ESCALATION.md · bell ] ──► [ Summon Architect ]
```

**Two engines, one seam.** `ship.js` never calls an engine directly — it goes through `runRole(role, payload)`, which shells out headlessly to `fcc-claude -p` (Carpenter) or `codex exec` (Reviewer). That seam is the only place engines are named, so swapping or upgrading them is localized (ADR-0004).

---

## 2. Setup — Part 1: The DeepSeek Carpenter

> **Updated (ADR-0012):** the **default** Carpenter no longer uses the `free-claude-code`
> router. It runs the `claude` you already have, pointed at **DeepSeek's own
> Anthropic-compatible endpoint** (`https://api.deepseek.com/anthropic`) via env vars —
> just set `DEEPSEEK_API_KEY` (no `:8082` proxy, no admin UI). Omit the key and the
> Carpenter builds on Anthropic Claude. **The fcc-router setup below is now the OPTIONAL
> legacy path** (`SHIP_CARPENTER_CMD=fcc-claude`) — useful only if you already run the
> router or need it to reach a provider DeepSeek's endpoint doesn't.

A local proxy (port **8082**) intercepts the Anthropic API and reroutes Claude Code to DeepSeek, so the whole harness works unchanged on a cheaper brain. Repo: **https://github.com/Alishahryar1/free-claude-code**

### 2.1 DeepSeek API key
1. Account at **platform.deepseek.com**; add a small balance ($2–$5 is plenty).
2. **platform.deepseek.com/api_keys** → create → copy.

### 2.2 Install the router (PowerShell)
```powershell
irm "https://github.com/Alishahryar1/free-claude-code/blob/main/scripts/install.ps1?raw=1" | iex
```
Creates **`fcc-server`** (proxy), **`fcc-claude`** (Claude Code → proxy), **`fcc-init`**. Config lives at `~/.fcc/.env`; configure via the Admin UI, not by hand.

### 2.3 Start the proxy and configure DeepSeek
```powershell
fcc-server   # → Admin UI: http://127.0.0.1:8082/admin
```
In the Admin UI: paste the key into **`DEEPSEEK_API_KEY`**, set **`MODEL`** to **`deepseek/deepseek-chat`** (DeepSeek V4), **Validate**, **Apply**.

### 2.4 Two ways the Carpenter runs
- **Interactive** (manual/ad-hoc): `fcc-claude` opens a Claude Code session on DeepSeek.
- **Headless** (what `ship.js` uses): `fcc-claude -p` — print mode, one-shot, JSON output. This is how the orchestrator calls the Carpenter; it has **no memory between rounds**, which is why retry payloads tell it to read the existing branch diff (ADR-0002/Q… retry fix).

> Optional `$PROFILE` alias for manual use: `function ds { fcc-claude @args }` → `ds` = carpenter, `claude` = architect.

### 2.5 Verify the model
**Don't trust the self-report** — it will say "Claude Sonnet" (it reads the harness system data, not its weights). Confirm in the **Admin UI** routing config; it should read `deepseek/deepseek-chat`.

### Why it's cheap — caching
Real dashboard: **40 calls, 3.9M tokens, 10¢/month** vs ~$12.67 (Sonnet) / $63 (Opus). DeepSeek's rate helps, but **~85% cache hits** do the heavy lifting (§7).

---

## 3. Setup — Part 2: The Reviewer (Codex)

The Reviewer has **two faces**, and the distinction matters:

| Use | Tool | When |
|-----|------|------|
| **Automated loop** | **`codex exec` CLI** (headless) | Inside `ship.js` — the orchestrator shells out to it via `runRole('reviewer', …)`. |
| **Manual / ad-hoc** | **`/codex` plugin** in a Claude Code session | When *you* want a one-off review outside the loop. |

> ⚠️ **The loop uses the CLI, not the plugin.** Headless orchestration cannot drive an in-session plugin (ADR-0004). So the loop requires the **Codex CLI on PATH** — `codex exec`. (As of the last calibration check, `codex` was **not** installed on this machine — installing/configuring it is the top blocker for a live run.)

### 3.1 Manual plugin (optional, for ad-hoc reviews)
Inside Claude Code (Architect terminal), free ChatGPT tier, Node ≥18.18:
```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```
Modes: **review** (standard) and **adversarial review** (questions design/trade-offs, read-only). Jobs: `/codex:status|result|cancel|rescue`.

### 3.2 CLI (required for the loop)
Install the Codex CLI and authenticate (free ChatGPT tier works). The loop invokes it roughly as `codex exec --json` with the review prompt on stdin. **Confirm the exact flags + output shape during the Calibration Cycle (§10)** before trusting the loop.

### 3.3 Why the trio works — complementary weaknesses
Claude over-engineers, is token-hungry, drifts, and **misses its own bugs**. Codex is weaker at planning but **excellent at catching what Claude missed**. So: Opus plans, DeepSeek builds, Codex breaks, Opus fixes. Codex never plans; the Architect never grades its own homework.

---

## 4. The Automated Workflow (`/ship`)

**Manual gate, automated loop.** You do two things; the script does everything between.

### Touchpoint 1 — Write `SPEC.md` (Architect, `claude`, plan mode)
```
[Opus, plan mode]
Produce SPEC.md: file layout, data model, component breakdown, design system,
and explicit build instructions detailed enough that the Carpenter can implement
it WITHOUT making design decisions. Write it to SPEC.md. Do not write bulk code.
```
`SPEC.md` is a **single rolling file at repo root**, the sole source of truth, re-read from disk on every build (Q1/Q2). Retire the word "blueprint" — it's the **Spec**.

### Fire it
```
/ship
```
`ship.js` runs the **5-step fail-fast preflight** (§4 table), then the autonomous loop. No confirmation prompt — fail-fast *is* the safety (ADR-0005).

| Preflight check | Effect on failure |
|---|---|
| 1. `SPEC.md` exists & non-empty | hard halt, **0 tokens** |
| 2. `swarm/<slug>-<hash>` branch checked out | protects `main`; deterministic resume |
| 3. `graphify . --update` succeeds | halt before Reviewer reads a stale graph |
| 4. state init (attempt=0, ensure `BACKLOG.md`, delete stale `ESCALATION.md`) | clean slate |
| 5. token budget bound | runaway-cost ceiling set |

### What the loop does (autonomous)
1. **Carpenter builds** headlessly. Round 1 builds from scratch; rounds 2–3 read the existing branch diff and fix **only** the listed High findings (no rebuild).
2. **Orchestrator commits** the work — *scoped* (excludes `SPEC.md`/`BACKLOG.md`/`ESCALATION.md`/graph files) so the Reviewer's diff is pure feature work. The true `changed_files` come from **git**, not the Carpenter's self-report. **No-op guard:** zero changes → synthetic `High`, Reviewer skipped.
3. **Reviewer audits** the diff (graph-aware via `graph_ref`), grades each finding `High`/`Medium`/`Low`.
4. **Decision (ADR-0002):**
   - **zero High → CLEAN PASS.** Halt & Leave (ADR-0006): the loop stops on the `swarm/` branch, **does not auto-merge**, and prints the change surface (`git diff --stat <base>...HEAD`) + the merge command. `Medium`/`Low` were appended to `BACKLOG.md`.
   - **High exist, round < 3 →** feed High findings back to the Carpenter (Retry Loop).
   - **High exist, round == 3 → Circuit Breaker:** write `ESCALATION.md` + terminal bell, stop.

### Touchpoint 2 — Resolve `ESCALATION.md` (only if the breaker trips)
`ESCALATION.md` carries a **Reviewer-generated** `root_cause_hypothesis` (ADR-0003) classifying the failure as:
- **`spec_defect`** → rewrite `SPEC.md`, then re-run `/ship`.
- **`context_gap`** → augment context (often refresh/extend the Graphify index), then re-run `/ship`.

### Artifacts on disk (all transparent, all at repo root)
| File | Owner | Purpose |
|------|-------|---------|
| `SPEC.md` | Architect (human) | the Spec; sole source of truth |
| `BACKLOG.md` | `ship.js` | deferred Medium/Low findings |
| `ESCALATION.md` | `ship.js` (Reviewer hypothesis) | breaker diagnosis for the human |
| `swarm/<slug>-<hash>` | `ship.js` | isolated work branch (never touches `main`) |

### Routing cheat-sheet
| Task | Route to |
|------|----------|
| Planning, specs, architecture, UI/UX taste | **Opus** (`claude`) |
| Big code writing, scripts, backend, tests, "dirty work" | **DeepSeek** (Carpenter) |
| Code review, audits, adversarial pressure-testing | **Codex** (Reviewer) |
| Anything touching secrets / client data / IP | **Opus only** (never DeepSeek — §6) |

---

## 5. Orchestration Patterns (the conceptual roots)

The six patterns from the source material, and where they live in this pipeline:

1. **Classify & Act** — cheap classifier routes input before any handler acts.
2. **Fan-out & Synthesize** — split into mutually-exclusive sub-tasks in clean contexts, then a barrier merges with citations. *(Cheap on the DeepSeek Carpenter.)*
3. **Adversarial Verification** — skeptics cross-check against a rubric you wrote first. **This is the Reviewer.**
4. **Generate & Filter** — over-generate, then a *separate* judge scores. Generator ≠ judge.
5. **Tournament** — pair-wise comparisons, fresh context each, winners advance; a deterministic loop holds the bracket.
6. **Loop Until Done** — no fixed count; iterate to a target. **Realized here as the Retry Loop + Circuit Breaker** (bounded, not infinite — ADR-0002).

> **Budget control is built in.** The token budget + 3-round cap are the guide's "tell the agent its budget" rule enforced in code. Reserve the swarm for real work — don't `/ship` a button-colour change.

---

## 6. Guardrails — Privacy is Structural, Not Manual

DeepSeek = China-based servers. You're **not regulated**, so this setup fits — but the boundary is enforced by a skill file, not memory.

### `deepseek/skill.md` — auto-invoke conditions
The Carpenter (DeepSeek) is invoked **automatically only** when one is true: (1) **explicit user request**, (2) **HTML/visual-surface build inside an existing framework**, or (3) **a script > 200 lines**. Otherwise → **suggest mode only**.

### Never send through DeepSeek (hard stops)
- ❌ Email & calendar content (names, meetings, relationships).
- ❌ Auth tokens, API keys, naked URLs, page/DB IDs — treat the DeepSeek chat as public.
- ❌ Voice corpus / unpublished scripts / core IP.

✅ **Good fit:** non-regulated solo dev — saving credits, prototyping, backend plumbing, throwaway scripts, open source.

---

## 7. Token Optimization

DeepSeek cuts *rate*; these cut *volume*.

| Tool | Verdict | Why |
|------|---------|-----|
| **Graphify** | ✅ Keep | Repo → knowledge graph; agents stop grepping file-by-file. ~27–70% token cut. **Also feeds the Reviewer's `graph_ref`** (blast-radius awareness, fewer false-positive Highs). |
| **CodeGraph** | ❌ Drop | Redundant with Graphify; two indexes to keep in sync, no extra benefit. |
| **RTK** (log compression) | ✅ Keep | Shrinks noisy logs before they hit context. Toggle off when debugging (lossy). |
| **Caveman** (terse output) | ✅ Keep, optional | ~50% shorter output, similar quality. Back off during deep planning. |
| **Cache discipline** | ✅ Keep | Free; biggest single lever (below). |

### Graphify setup (PowerShell)
```powershell
winget install astral-sh.uv
uv tool install graphifyy          # NOTE: package is "graphifyy" (double-y)
graphify install                   # register the skill
```
Usage: `/graphify .` (build), `/graphify . --update` (refresh changed files — **preflight step 3 runs this**), `/graphify query "…"`, `/graphify path "A" "B"`, `/graphify explain "X"`. Outputs `graph.html`, `GRAPH_REPORT.md`, `graph.json` (the `graph_ref` the Reviewer reads).

### Caching rules
Cached tokens cost **10%** of fresh input. TTL: **1 h** (subscription), **5 min** (API/sub-agents). Cache breaks on: pausing >1 h, **switching models mid-session** (incl. `opus-plan`), but **not** editing CLAUDE.md until restart. Habits: don't pause too long, start fresh on task switch, keep sessions focused. The Carpenter's `CLAUDE_CODE_AUTO_COMPACT_WINDOW=190000` tunes auto-compaction.

---

## 8. Sharing the Workflow

The workflow **is** `ship.js` + its shared module + a `SKILL.md` that defines the `/ship` trigger. Bundle them:

```
ship-workflow/
├── SKILL.md          # defines /ship; how/when to invoke
├── ship.js           # the orchestrator (preflight + loop + escalation)
├── lib/parse.js      # shared defensive-parsing contract (imported by ship.js AND calibrate.js)
└── docs/adr/         # the decisions (optional but recommended to ship together)
```

`lib/parse.js` is a **single source of truth** — the same parser the loop runs and the calibration tools test, so they can't drift.

---

## 9. The Design Record (canonical)

The tutorial explains; these define. Keep them authoritative:

- **`CONTEXT.md`** — glossary of canonical terms (Spec, Carpenter, Reviewer, Retry Loop, Clean Pass, Circuit Breaker, Backlog, Escalation, Preflight, `/ship`, `runRole`, …).
- **`docs/adr/`**
  - **0001** automated, self-contained loop
  - **0002** clean pass = zero High · 3-round breaker · backlog · topology · parser · graph-aware
  - **0003** `ESCALATION.md` · Reviewer-generated hypothesis · native-only alerting
  - **0004** cross-model routing via headless CLI behind `runRole()` (+ spawn-must-settle contract)
  - **0005** `/ship` entry point · 5-step fail-fast preflight · deterministic `swarm/<slug>-<hash>`
  - **0006** merge policy: Halt & Leave · change-surface print · no auto-merge / no draft PR
  - **0007** concurrency lock (`.ship.lock`) · stale-PID reclaim · one run per working tree

If this guide ever contradicts an ADR, **the ADR wins** — fix the guide.

---

## 10. Calibration (verify before trusting the loop)

The loop carries a few `CALIBRATE:` tags — assumptions about how the real CLIs behave. Two tools close them:

- **`node simulate.js`** — offline. Feeds the production parser (`lib/parse.js`) a battery of real-world output shapes (fenced JSON, prose preamble, truncation, missing usage, stray braces). **Already passing 13/14**, with one documented WARN that drove the parser's **shape guard** (a key-less `{}` must not become a false clean pass).
- **`node calibrate.js`** — live; **run on the local machine** with both CLIs configured. Three probes: **Extraction** (clean JSON vs wrapped?), **Token Meter** (does `usage.total_tokens` exist, or is the budget rail blind?), **Git Effect** (does the headless Carpenter edit on disk without running its own git?). It degrades gracefully (`SKIP`) when a CLI is absent, and **cannot hang** — every spawn settles on error/close/timeout (ADR-0004 contract; verified ENOENT settles in ~12 ms).

Run `calibrate.js`, fold the findings into `ship.js CONFIG.engines` / `lib/parse.js`, then **drop the `CALIBRATE:` tags**.

---

## 11. Quick-Start Checklist

- [ ] DeepSeek key → `irm ".../install.ps1?raw=1" | iex` → `fcc-server` → Admin UI `127.0.0.1:8082` set to `deepseek/deepseek-chat`, **Validate + Apply**. Confirm via Admin UI (ignore self-report).
- [ ] **Codex CLI installed** (`codex exec` on PATH, free ChatGPT auth) — *required for the loop*. Plugin optional for ad-hoc.
- [ ] Node ≥18.18.
- [ ] Graphify (`uv tool install graphifyy` → `graphify install`); RTK + Caveman available to toggle.
- [ ] `deepseek/skill.md` guardrail in place (3 conditions + hard-stop list).
- [ ] Files present: `ship.js`, `lib/parse.js`, `simulate.js`, `calibrate.js`, `CONTEXT.md`, `docs/adr/0001–0005`, plus a `SKILL.md` exposing `/ship`.
- [ ] `node simulate.js` passes; `node calibrate.js` run locally; `CALIBRATE:` tags dropped.
- [ ] Workflow: **write `SPEC.md` → `/ship` → (autonomous) → resolve `ESCALATION.md` only if it appears.**

---

### TL;DR
> Write `SPEC.md`, run `/ship`. `ship.js` preflights (fail-fast, zero-cost on a bad setup), then spins **DeepSeek (Carpenter) ↔ Codex (Reviewer)** autonomously: build → scoped-commit → audit → fix, gating on **zero High findings**, capped at **3 rounds**, with Medium/Low parked in `BACKLOG.md`. If it can't pass in 3 rounds, it writes a Reviewer-diagnosed `ESCALATION.md` and rings the bell for you. Opus architects, DeepSeek carpenters (~100× cheaper), Codex reviews — secrets stay off DeepSeek, Graphify cuts tokens, and you never babysit three terminals again.
