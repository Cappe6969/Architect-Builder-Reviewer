# Architect · Carpenter · Reviewer

An automated, self-contained build loop for [Claude Code](https://claude.ai/code).  
Write a `SPEC.md`. Type `/ship`. A **Carpenter** (DeepSeek V4) builds it; a **Reviewer** (OpenAI Codex) audits the diff; the loop retries until zero High findings or 3 rounds — then stops and hands the branch back to you.

```
You (Architect)
    │  SPEC.md
    ▼
  /ship ──► Preflight (branch, lock, graph)
              │
              ▼
        ┌─ Carpenter (DeepSeek/fcc-claude) ─builds─► commit
        │         ▲
        │    High findings only
        │         │
        └─ Reviewer (Codex/codex exec) ◄─── audits diff
              │
         Zero High?
           Yes ──► CLEAN PASS — branch ready, never auto-merged
           No  ──► retry (max 3 rounds) → ESCALATION.md
```

---

## Prerequisites

| Tool | Role | Install |
|------|------|---------|
| Node ≥ 22 | runtime | [nodejs.org](https://nodejs.org) |
| `fcc-claude` | Carpenter engine | [free-claude-code](https://github.com/Alishahryar1/free-claude-code) |
| `codex` CLI | Reviewer engine | `npm install -g @openai/codex` then `codex login` |
| `graphify` (optional) | graph-aware review | `uv tool install graphifyy` |

Run `./setup.ps1` (Windows) for a guided one-stop install + health check.

---

## Quick start

```powershell
# 1. Bootstrap an existing project
node path/to/ship-init.js path/to/your-project

# 2. Write your spec
# Edit SPEC.md — one H1 title + acceptance-criteria bullets

# 3. Ship it (inside Claude Code)
/ship
# or: node ship.js
```

On **clean pass** (exit 0): review the printed diff, then merge:
```
git checkout main && git merge swarm/<branch>
```

On **escalation** (exit 2): read `ESCALATION.md` → fix `SPEC.md` → re-run with `--fresh`.

---

## Repository layout

```
ship.js            — orchestrator (Architect → Carpenter → Reviewer loop)
ship-init.js       — bootstrap any project with the workflow
calibrate.js       — one-time calibration run to verify engine shapes
simulate.js        — offline self-test (no tokens)
setup.ps1          — Windows prereq installer + doctor
swarm-init.ps1     — scaffold a new project with git init + SPEC placeholder
launch.js          — convenience launcher
lib/
  parse.js         — shared JSON parsing (defensive, shape-validated)
docs/
  WORKFLOW.md      — full expert workflow guide
  CONTEXT.md       — canonical glossary of all roles/terms
  adr/             — Architecture Decision Records (ADR-0001 → ADR-0007)
.claude/skills/ship/SKILL.md  — /ship Claude Code skill definition
```

---

## How it works

### Roles
- **Architect** — you (+ Claude Code in plan mode). Writes `SPEC.md`. Never edits Carpenter output directly — fixes go through `SPEC.md`.
- **Carpenter** — `fcc-claude -p` (DeepSeek V4 via a local proxy). Builds the spec verbatim. Makes no design decisions.
- **Reviewer** — `codex exec` (OpenAI Codex CLI, headless). Read-only. Returns JSON findings classified `High / Medium / Low`.

### Loop mechanics
1. Preflight: branch isolation, lock, optional graph refresh.
2. Carpenter builds → orchestrator commits (never trust the LLM to commit).
3. Reviewer audits the diff → returns findings.
4. Zero High → **clean pass**. Any High → retry payload fed back to Carpenter.
5. After 3 rounds with unresolved Highs → write `ESCALATION.md` + terminal bell.

`Medium` / `Low` findings never block a pass — they go to `BACKLOG.md` automatically.

### Key design decisions
See [`docs/adr/`](docs/adr/) for the full decision log. Highlights:
- **ADR-0002** — severity gating + 3-round circuit breaker
- **ADR-0004** — cross-model routing via headless CLI (`runRole` seam)
- **ADR-0006** — Halt & Leave merge policy (never auto-merge)

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `SHIP_TOKEN_BUDGET` | `2_000_000` | token cap across all rounds |
| `DEEPSEEK_API_KEY` | hardcoded fallback | key for Graphify's LLM calls |

Timeouts (`carpenterMs`, `reviewerMs`) and `maxRounds` are in `CONFIG` near the top of `ship.js`.

---

## License

MIT
