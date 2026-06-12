# Default Carpenter is `claude`→DeepSeek direct; drop the free-claude-code install

**Status:** accepted — supersedes [ADR-0009](0009-public-default-engine.md)

## Context & decision

ADR-0009 kept `fcc-claude` (the third-party **free-claude-code** router) as the default
Carpenter, accepting that a public user had to install the router, run `fcc-server`, and
paste a DeepSeek key into its admin UI before the tool would build. That install friction
is the single biggest barrier to a stranger running this, and the requirement is now
avoidable: **DeepSeek ships an official Anthropic-compatible endpoint**
(`https://api.deepseek.com/anthropic`), so the `claude` agent the user *already has* can
build on DeepSeek directly by setting two environment variables — **no router to install.**

**Decision:** the default Carpenter is **`claude`**, and when `DEEPSEEK_API_KEY` is set the
orchestrator spawns it with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` +
`ANTHROPIC_API_KEY=<that key>` (the carpenter-only `env` on the engine config). Result:
cheap DeepSeek builds (claude-opus → deepseek-v4-pro) with **zero third-party install**.

- No `DEEPSEEK_API_KEY`? The Carpenter runs as plain Anthropic Claude — costlier, but the
  loop still works with nothing but Claude Code. No hard dependency, no dead end.
- The routing env is injected **only** on the default path (no `SHIP_CARPENTER_CMD`
  override) so an explicit engine choice is never silently re-pointed.
- The **Master** stays real Anthropic `claude` (its `env` is empty) — it's the smart
  foreman (ADR-0008); only the bulk **Worker** routes to DeepSeek.
- `fcc-claude` remains a supported **legacy** path via `SHIP_CARPENTER_CMD=fcc-claude`
  (the `ensureFccServer` guard only runs then). Nothing is deleted; it's demoted.

## Why this shape

- **Removing an install beats saving a few tokens.** The user's explicit goal: a public
  user must not have to download free-claude-code to run the program. Pointing `claude` at
  DeepSeek's own endpoint deletes that prerequisite while *keeping* the cheap DeepSeek
  builds the cost model (ADR-0001/0008) depends on.
- **Same binary, two backends, clean isolation.** Worker = `claude`+DeepSeek-env,
  Master = `claude`+Anthropic. Per-engine `env` on the spawn keeps them apart with no new
  process type and no router in the middle.
- **Graceful, not gated.** Falling back to Anthropic Claude when no key is present means
  the tool is never bricked by a missing key — it just isn't cheap until you add one.

## Considered and rejected

- **Keep fcc the default (ADR-0009)** — forces the router install this ADR exists to
  remove. Superseded.
- **Default to Anthropic Claude, drop DeepSeek entirely** — removes the install but throws
  away the cost advantage; the user wanted DeepSeek *kept*, just without fcc.
- **A raw DeepSeek API call instead of the `claude` agent** — loses the agentic file-editing
  loop (Read/Write/Edit/Bash); the Carpenter must be an agent, not a completion.
- **Delete the fcc code** — needless; it's a one-line override that costs nothing to keep
  for anyone already running the router or routing exotic providers through it.

## Consequences

- **Key handling changes** (revises ADR-0009's "secrets live only in the fcc admin UI"):
  with no router, `DEEPSEEK_API_KEY` is a normal env var — set it in the environment, a
  gitignored `.env`, or `~/.fcc/.env` (still read as a convenient legacy home). `.env`
  stays gitignored.
- README/`setup.ps1` move the fcc router + `:8082` admin UI from **required** to an
  **optional / legacy** section. The "have Claude Code + a DeepSeek key" path is now the
  documented default.
- **The OAuth-precedence trap (found during verification).** When Claude Code is
  OAuth-logged-in (`~/.claude/.credentials.json` present — the normal subscription case),
  `claude` **ignores** `ANTHROPIC_API_KEY` and sends its rotating OAuth token to whatever
  `ANTHROPIC_BASE_URL` points at — which DeepSeek 401s (after ~187s of client-side
  retry/backoff, looking like a hang). The env-var redirect alone is therefore **not
  enough** on a logged-in machine. Fix: the Worker's spawn also sets
  `CLAUDE_CONFIG_DIR=~/.ship-carpenter-deepseek` — an isolated, credential-free config dir
  — so `claude` falls back to the injected DeepSeek key. Verified: with the isolated dir
  the same call returns `OK` in ~6s (vs the 187s 401). The Master keeps the real OAuth
  (no override), so only the bulk Worker routes to DeepSeek.
- **Model pinning.** DeepSeek maps `opus → deepseek-v4-pro` (the stronger model) and
  only `haiku → deepseek-v4-flash` (fast/cheap). The Worker pins `--model opus` by default
  → **v4-pro for build quality** (a thinking model: slower first token, better code);
  override with `SHIP_CARPENTER_MODEL=haiku` for fast flash builds.
- This is what free-claude-code's proxy did transparently (network-level interception +
  server-side DeepSeek auth); ADR-0012 reproduces the effect with an isolated config dir
  instead of a router to install.
