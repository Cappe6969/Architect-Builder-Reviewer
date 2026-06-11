# Architect · Carpenter · Reviewer

An automated, self-contained build loop for [Claude Code](https://claude.com/claude-code).
Write a `SPEC.md`. Type `/ship`. A **Carpenter** (DeepSeek V4) builds it; a **Reviewer**
(OpenAI Codex) audits the diff; the loop retries until zero High findings or 3 rounds —
then stops and hands the branch back to you. It **never auto-merges**.

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

> **Platform:** developed and tested on **Windows**. The core (`ship.js`) is plain Node
> and runs anywhere, but the one-shot installer (`setup.ps1`) is PowerShell. macOS/Linux
> users can set up manually — see [macOS / Linux](#macos--linux-manual-untested). PRs to
> make `*nix` first-class are welcome.

---

## Try it in 60 seconds (no extra accounts)

The full setup wires up DeepSeek + Codex for the cheapest, most rigorous loop. But if
you just want to **see it run right now**, build with the `claude` CLI you already have
authenticated for Claude Code — zero extra keys, zero router:

```powershell
git clone https://github.com/Cappe6969/Architect-Builder-Reviewer.git
cd Architect-Builder-Reviewer
npm link                                   # puts `ship` on your PATH

cd path\to\any-git-project                 # a repo with at least one commit
ship-init                                  # writes a SPEC.md stub + workflow files
# edit SPEC.md — describe one concrete change

$env:SHIP_CARPENTER_CMD = 'claude'         # build with Claude (no DeepSeek/router needed)
$env:SHIP_REVIEWER_CMD  = 'claude'         # review with Claude too (skip Codex for now)
ship
```

That's a complete Architect → Carpenter → Reviewer run on Claude alone. When you're
ready for the cheaper, independent-reviewer setup, do the [full install](#install)
below and drop the two env vars. (`ship` **fails fast with this exact command** if the
default DeepSeek engine isn't set up — it never burns tokens on a misconfigured run.)

---

## What you need (and what each thing costs)

This tool orchestrates **three** AI engines. You bring credentials for two of them; the
third is Claude Code itself, which you already have.

| Role | Engine | You provide | Cost |
|------|--------|-------------|------|
| **Architect** (you) | Claude Code | already installed | your existing plan |
| **Carpenter** (builds) | DeepSeek V4 via the [`free-claude-code`](https://github.com/Alishahryar1/free-claude-code) router (`fcc-claude`) | a **DeepSeek API key** | ~cents; pay-as-you-go |
| **Reviewer** (audits) | OpenAI **Codex** CLI (`codex exec`) | **`codex login`** (ChatGPT plan) or `OPENAI_API_KEY` | your ChatGPT/OpenAI plan |
| Graph (optional) | `graphify` via `uv` | *(reuses the DeepSeek key)* | optional |

Don't want the DeepSeek router? You can build with Claude instead in one env var —
see [Swapping engines](#swapping-engines). The default is DeepSeek for cost reasons
([ADR-0009](docs/adr/0009-public-default-engine.md)).

---

## Where your API keys go

**Keys never go in this repo.** Each engine owns its own credential store:

1. **DeepSeek key → the fcc-server admin UI (paste once).**
   Get a key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
   (add a small balance). Then:
   ```powershell
   fcc-server                       # starts the local router on :8082
   ```
   Open **http://127.0.0.1:8082/admin**, paste the key, set the model to
   `deepseek/deepseek-v4-pro`, then **Validate + Apply**. The router persists it to
   `~/.fcc/.env` — which `ship.js` also reads so the optional `graphify` step can
   authenticate. **One paste covers both.**

2. **OpenAI/Codex → `codex login`.**
   ```powershell
   codex login                      # browser OAuth (paid ChatGPT plan)
   # — or — set OPENAI_API_KEY in your environment instead
   ```

That's it. There is **no project `.env` for secrets**. `.env.example` exists only for
optional, non-secret tuning knobs (token budget, engine overrides).

---

## Install

### Windows (tested)

```powershell
git clone https://github.com/Cappe6969/Architect-Builder-Reviewer.git
cd Architect-Builder-Reviewer
./setup.ps1
```

`setup.ps1` installs/verifies everything it can (Node ≥ 22, `uv` + `graphify`, the
Codex CLI, the fcc router), links `ship` + `ship-init` onto your PATH, runs the two
interactive logins, and ends with a **doctor** that functionally probes each engine
(not just "is it on PATH"). Re-runnable. Verify any time with:

```powershell
./setup.ps1 -DoctorOnly
```

Two steps stay manual (they need a browser / a key you own) — the doctor reminds you:
- paste the **DeepSeek key** in the fcc admin UI (above), and
- run **`codex login`**.

For a live, token-spending check of the engines end to end: `node calibrate.js`.

### macOS / Linux (manual, untested)

The orchestrator is plain Node, so the loop itself runs. There's no `setup.sh` yet —
do the equivalents by hand:

```bash
# 1. Node ≥ 22  (codex requires it)            https://nodejs.org
# 2. Codex CLI
npm install -g @openai/codex && codex login
# 3. graphify (optional, for graph-aware review)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install graphifyy && graphify install
# 4. fcc router (the Carpenter) — see its repo for *nix install:
#    https://github.com/Alishahryar1/free-claude-code
#    then `fcc-server`, paste the DeepSeek key at http://127.0.0.1:8082/admin
# 5. Link the CLIs
npm link        # from the repo root → puts `ship` / `ship-init` on PATH
```

Prefer not to run the fcc router on `*nix`? Build with Claude instead:
`export SHIP_CARPENTER_CMD=claude` (see [Swapping engines](#swapping-engines)).

---

## Quick start

```powershell
# 1. Bootstrap any project with the workflow (idempotent)
cd path\to\your-project
ship-init                 # adds CLAUDE.md guidance, .gitignore rules, a SPEC.md stub

# 2. Write your spec — one H1 title + concrete acceptance criteria.
#    See the SPEC.md in THIS repo for an annotated example.

# 3. Ship it
ship                      # or, inside Claude Code:  /ship
```

Three ways to run the loop, same engine underneath:

| Command | What you get |
|---------|--------------|
| `ship` | the full orchestrator log (the canonical, validated path) |
| `ship-chat "build X"` | a friendly chat front-end: type a task, watch one live status line, get a plain-English summary |
| `ship-ui "build X"` | a local web dashboard with three live columns (Worker / Master / Reviewer) streaming their reasoning |

On **clean pass** (exit 0): review the printed diff, then merge:
```powershell
git checkout master; git merge swarm/<branch>
```
On **escalation** (exit 2): read `ESCALATION.md` → tighten `SPEC.md` → re-run with `--fresh`.

---

## Swapping engines

Every role is a headless CLI behind the `runRole` seam ([ADR-0004](docs/adr/0004-cross-model-orchestration-headless-cli.md)),
overridable by env var with **no code edit**:

```powershell
$env:SHIP_CARPENTER_CMD = 'claude'   # build with Claude instead of DeepSeek/fcc
$env:SHIP_MASTER_CMD    = 'claude'   # the foreman (default: claude)
$env:SHIP_REVIEWER_CMD  = 'codex'    # the auditor (default: codex)
```

Setting `SHIP_CARPENTER_CMD=claude` lets you skip the fcc router and DeepSeek entirely —
at higher token cost. Copy `.env.example` → `.env` to set these persistently.

---

## Repository layout

```
ship.js            — orchestrator (Architect → Carpenter → Reviewer loop)
ship-init.js       — bootstrap any project with the workflow
ship-chat.js       — chat front-end (type a task, get a plain-English answer)
ship-ui.js         — live web dashboard (three streaming agent columns)
ship-watch.ps1     — desktop notifier that toasts on terminal states
calibrate.js       — one-time live calibration to verify engine shapes
simulate.js        — offline self-test (no tokens)
setup.ps1          — Windows prereq installer + doctor
launch.js          — convenience launcher
lib/parse.js       — shared defensive JSON parsing (shape-validated)
docs/
  WORKFLOW.md      — full expert workflow guide
  CONTEXT.md       — canonical glossary of all roles/terms
  adr/             — Architecture Decision Records (ADR-0001 → ADR-0009)
.claude/skills/ship/SKILL.md  — the /ship Claude Code skill
.env.example       — optional, NON-SECRET tuning knobs
```

---

## How it works

### Roles
- **Architect** — you (+ Claude Code in plan mode). Writes `SPEC.md`. Never edits
  Carpenter output directly — fixes go through `SPEC.md`.
- **Carpenter** — a sub-swarm ([ADR-0008](docs/adr/0008-carpenter-sub-swarm.md)): a
  cheap **Worker** (`fcc-claude`/DeepSeek) builds; a **Master** (`claude`) foreman
  inspects for completeness + conciseness only. Makes no correctness calls.
- **Reviewer** — `codex exec`, headless, read-only. Returns JSON findings classified
  `High / Medium / Low`.

### Loop mechanics
1. Preflight: branch isolation, lock, optional graph refresh — all before any tokens.
2. Carpenter builds → orchestrator commits (never trust the LLM to commit).
3. Reviewer audits the diff → returns findings.
4. Zero High → **clean pass**. Any High → retry payload fed back to the Carpenter.
5. After 3 rounds with unresolved Highs → `ESCALATION.md` + a native terminal bell.

`Medium` / `Low` findings never block a pass — they go to `BACKLOG.md` automatically.

### Key design decisions
Full log in [`docs/adr/`](docs/adr/). Highlights:
- **ADR-0002** — severity gating + 3-round circuit breaker
- **ADR-0004** — cross-model routing via headless CLI (the `runRole` seam)
- **ADR-0006** — Halt & Leave merge policy (never auto-merge)
- **ADR-0008** — the Carpenter sub-swarm (Worker + Master foreman)
- **ADR-0009** — why the public default Carpenter stays DeepSeek

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `SHIP_TOKEN_BUDGET` | `2000000` | token cap across all rounds |
| `SHIP_CARPENTER_CMD` | `fcc-claude` | Worker Carpenter engine |
| `SHIP_MASTER_CMD` | `claude` | Master Carpenter (foreman) engine |
| `SHIP_REVIEWER_CMD` | `codex` | Reviewer engine |

Timeouts (`carpenterMs`, `reviewerMs`) and `maxRounds` live in `CONFIG` near the top
of `ship.js`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `not a git repository` / `no commits yet` | `git init` and make one commit, or run `ship-init`. |
| `Carpenter engine '…' is not on your PATH` | Preflight halted before spending tokens. Either set up the engine, or build with Claude: `$env:SHIP_CARPENTER_CMD='claude'; ship`. |
| `fcc-server router is not reachable` | Run `fcc-server`, confirm `http://127.0.0.1:8082/admin` loads and the DeepSeek key is applied — or use the Claude override above. |
| `reviewer auth-401` | Run `codex login` again (or build/review with Claude via the env vars in [Try it in 60 seconds](#try-it-in-60-seconds-no-extra-accounts)). |
| `work branch … already has N unmerged commit(s)` | Merge it, or re-run with `--fresh` (discards the branch's commits, never your working tree). |
| Everything green but unsure engines really work | `node calibrate.js` (spends a few tokens to verify end to end). |

---

## License

[MIT](LICENSE) © 2026 Matteo Cappellato
