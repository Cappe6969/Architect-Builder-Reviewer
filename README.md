# Architect · Carpenter · Reviewer

An automated, self-contained build loop for [Claude Code](https://claude.com/claude-code).
Write a `SPEC.md`. Type `/ship`. A **Carpenter** (`claude` routed to DeepSeek — no router
to install) builds it; a **Reviewer** (OpenAI Codex) audits the diff; the loop retries
until zero High findings or 3 rounds — then stops and hands the branch back to you. It
**never auto-merges**.

```
You (Architect)
    │  SPEC.md
    ▼
  /ship ──► Preflight (branch, lock, graph)
              │
              ▼
        ┌─ Carpenter (claude → DeepSeek) ─builds─► commit
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

## Try it in 60 seconds

No third-party router to install. The Carpenter is the `claude` you already have:

```powershell
git clone https://github.com/Cappe6969/Architect-Builder-Reviewer.git
cd Architect-Builder-Reviewer
npm link                                   # puts ship / ship-app / ship-init on your PATH

cd path\to\any-git-project                 # a repo with at least one commit
ship-init                                  # scaffolds the workflow + a ship-app.cmd launcher

# (optional) cheap DeepSeek builds — still no router, just a key:
$env:DEEPSEEK_API_KEY = '<your-deepseek-key>'

ship-app                                   # chat with the Architect, then press Ship it
```

No DeepSeek key? It still runs — the Carpenter just builds on Anthropic Claude (costlier).
The only hard requirement is **Claude Code** (you have it) plus **Codex** for review
(or review with Claude too via `SHIP_REVIEWER_CMD=claude`).

---

## What you need (and what each thing costs)

| Role | Engine | You provide | Cost |
|------|--------|-------------|------|
| **Architect** (you) | Claude Code (`claude`) | already installed | your existing plan |
| **Carpenter** (builds) | `claude` → **DeepSeek endpoint** (default) | a DeepSeek key *(optional)* | ~cents on DeepSeek, or your Claude plan if no key |
| **Reviewer** (audits) | OpenAI **Codex** (`codex exec`) | `codex login` or `OPENAI_API_KEY` | your ChatGPT/OpenAI plan |
| Graph (optional) | `graphify` via `uv` | *reuses the DeepSeek key* | optional |

**No free-claude-code router.** The Carpenter is the `claude` you already have, pointed at
DeepSeek's official [Anthropic-compatible endpoint](https://api-docs.deepseek.com/guides/anthropic_api)
via env vars ([ADR-0012](docs/adr/0012-deepseek-direct-no-fcc-router.md)): set
`DEEPSEEK_API_KEY` for cheap DeepSeek builds (claude-opus → deepseek-v4-pro), or omit it to
build on Anthropic Claude. The legacy router is still an opt-in
(`SHIP_CARPENTER_CMD=fcc-claude`) — see [Optional: the legacy fcc router](#optional-the-legacy-fcc-router).

---

## Where your API keys go

**Keys never go in this repo.**

1. **DeepSeek key** *(optional — only for cheap builds)* → set **`DEEPSEEK_API_KEY`** as an
   environment variable, or in a gitignored `.env`, or in `~/.fcc/.env` (read as a legacy
   home). Get one at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
   (add a small balance). The orchestrator points the Carpenter's `claude` at DeepSeek for you.
2. **OpenAI/Codex** → `codex login` (browser OAuth) or set `OPENAI_API_KEY`.

`.env` is gitignored; `.env.example` documents the non-secret knobs plus where the DeepSeek
key goes.

---

## Install

### Windows (tested)

```powershell
git clone https://github.com/Cappe6969/Architect-Builder-Reviewer.git
cd Architect-Builder-Reviewer
./setup.ps1
```

`setup.ps1` installs/verifies what it can (Node ≥ 22, `uv` + `graphify`, the Codex CLI),
links `ship` / `ship-app` / `ship-init` onto your PATH, runs `codex login`, and ends with
a **doctor** that functionally probes each engine (not just "is it on PATH"). Re-runnable.
Verify any time with:

```powershell
./setup.ps1 -DoctorOnly
```

Manual steps the doctor reminds you of:
- run **`codex login`** (the Reviewer), and
- *(optional, for cheap builds)* set **`DEEPSEEK_API_KEY`** in your environment.

For a live, token-spending check of the engines end to end: `node calibrate.js`.

### macOS / Linux (manual, untested)

The orchestrator is plain Node, so the loop itself runs. There's no `setup.sh` yet —
do the equivalents by hand:

```bash
# 1. Node ≥ 22  (codex requires it)            https://nodejs.org
# 2. Claude Code (the Architect + default Carpenter)   https://claude.com/claude-code
# 3. Codex CLI (the Reviewer)
npm install -g @openai/codex && codex login
# 4. (optional) cheap DeepSeek builds — no router, just a key:
export DEEPSEEK_API_KEY=<your-deepseek-key>
# 5. (optional) graphify for graph-aware review
curl -LsSf https://astral.sh/uv/install.sh | sh && uv tool install graphifyy && graphify install
# 6. Link the CLIs
npm link        # from the repo root → puts ship / ship-app / ship-init on PATH
```

No fcc router required on any platform — the Carpenter routes `claude` straight to DeepSeek.

### Optional: the legacy fcc router

Already running [free-claude-code](https://github.com/Alishahryar1/free-claude-code), or
want to route the Carpenter through it (e.g. to reach a provider DeepSeek's endpoint
doesn't)? Set `SHIP_CARPENTER_CMD=fcc-claude` and start `fcc-server`; the orchestrator's
preflight will manage the `:8082` router as before. Not needed for the default path.

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

Four ways to run it, same loop underneath:

| Command | What you get |
|---------|--------------|
| `ship-app` | **the one-window app** — chat with the **Architect** (Claude), who asks what it needs, writes `SPEC.md`, then on **Ship it** runs the loop with the three agents streaming live below. After `ship-init`, just double-click `ship-app.cmd`. |
| `ship` | the full orchestrator log (the canonical, validated path) |
| `ship-chat "build X"` | terminal front-end: type a task verbatim, watch one live status line, get a plain-English summary |
| `ship-ui "build X"` | a local web dashboard with three live columns (Worker / Master / Reviewer) streaming their reasoning |

> **`ship-app` vs `ship-chat`:** `ship-chat` writes your text to `SPEC.md` *verbatim*.
> `ship-app` puts a real **Architect** in front: it converses, sharpens the spec, and —
> for UI/front-end work the DeepSeek Carpenter can't do well — **builds the UI itself**
> before the loop runs ([ADR-0011](docs/adr/0011-architect-chat-app-and-ui-routing.md)).
> Engine overridable via `SHIP_ARCHITECT_CMD` (default `claude`).

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
$env:SHIP_CARPENTER_CMD = 'fcc-claude'  # use the legacy router instead of claude→DeepSeek
$env:SHIP_MASTER_CMD    = 'claude'      # the foreman (default: claude)
$env:SHIP_REVIEWER_CMD  = 'codex'       # the auditor (default: codex)
```

Setting `SHIP_CARPENTER_CMD=claude` lets you skip the fcc router and DeepSeek entirely —
at higher token cost. Copy `.env.example` → `.env` to set these persistently.

---

## Repository layout

```
ship.js            — orchestrator (Architect → Carpenter → Reviewer loop)
ship-init.js       — bootstrap any project with the workflow (+ ship-app.cmd launcher)
ship-app.js        — one-window app: chat with the Architect, then ship (ADR-0011)
ship-chat.js       — terminal front-end (type a task, get a plain-English answer)
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
  adr/             — Architecture Decision Records (ADR-0001 → ADR-0011)
.claude/skills/ship/SKILL.md  — the /ship Claude Code skill
.env.example       — optional, NON-SECRET tuning knobs
```

---

## How it works

### Roles
- **Architect** — you (+ Claude Code in plan mode). Writes `SPEC.md`. Never edits
  Carpenter output directly — fixes go through `SPEC.md`.
- **Carpenter** — a sub-swarm ([ADR-0008](docs/adr/0008-carpenter-sub-swarm.md)): a
  cheap **Worker** (`claude` routed to DeepSeek, [ADR-0012](docs/adr/0012-deepseek-direct-no-fcc-router.md))
  builds; a **Master** (`claude`, Anthropic) foreman inspects for completeness +
  conciseness only. Makes no correctness calls.
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
- **ADR-0010** — Worker effort (`xhigh`) + the gated `ultracode` workflow half
- **ADR-0011** — the Architect chat-app + UI-from-handoff routing
- **ADR-0012** — `claude`→DeepSeek direct; drop the free-claude-code install (supersedes ADR-0009)

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `SHIP_TOKEN_BUDGET` | `2000000` | token cap across all rounds |
| `DEEPSEEK_API_KEY` | _(unset)_ | routes the default `claude` Carpenter to DeepSeek (cheap, no router); unset = build on Anthropic Claude ([ADR-0012](docs/adr/0012-deepseek-direct-no-fcc-router.md)) |
| `SHIP_CARPENTER_CMD` | `claude` | Worker Carpenter engine (`fcc-claude` for the legacy router) |
| `SHIP_CARPENTER_MODEL` | `opus` | model the DeepSeek-routed Worker requests: `opus` → deepseek-v4-pro (quality), `haiku` → deepseek-v4-flash (fast) |
| `SHIP_DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic endpoint the Carpenter points at |
| `SHIP_MASTER_CMD` | `claude` | Master Carpenter (foreman) engine |
| `SHIP_REVIEWER_CMD` | `codex` | Reviewer engine |
| `SHIP_CARPENTER_EFFORT` | `xhigh` | Worker effort tier: `low\|medium\|high\|xhigh\|max`; `""` disables ([ADR-0010](docs/adr/0010-carpenter-effort-and-workflow.md)) |
| `SHIP_CARPENTER_WORKFLOW` | _(unset)_ | `1` opts the Worker into dynamic-workflow orchestration (the "workflow" half of `ultracode`) — guarded; see below |

> **About `ultracode`:** Claude Code's `ultracode` mode is *xhigh effort + dynamic-workflow
> orchestration* — it isn't a single headless flag (`--effort` only accepts
> `low/medium/high/xhigh/max`). The Worker Carpenter runs at **`xhigh`** by default to
> capture the effort half. The orchestration half is opt-in via
> `SHIP_CARPENTER_WORKFLOW=1` and **safe to enable**: the loop blocks worktree isolation
> (`--disallowedTools EnterWorktree`) so workflow sub-agents build in the tree the
> orchestrator commits, and if one ever isolates anyway the run **halts loudly with the
> worktree path** instead of silently losing the build. Master and Reviewer are
> unaffected. (What's still unverified: whether a real workflow measurably improves a
> multi-file build — that needs a live run.)

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
