<#
.SYNOPSIS
  One-stop machine setup + health check for the Architect/Carpenter/Reviewer swarm.
.DESCRIPTION
  Installs/upgrades the prerequisites it can (Node, uv, Graphify, Codex CLI, the
  fcc router), runs the interactive logins, then runs a "doctor" that verifies
  every engine and prints what is still manual. Re-runnable (idempotent).
.EXAMPLE
  ./setup.ps1               # install missing pieces + verify
.EXAMPLE
  ./setup.ps1 -DoctorOnly   # just verify, install nothing
#>
param([switch]$DoctorOnly)

$ErrorActionPreference = 'Continue'
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK]  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]   $t" -ForegroundColor Yellow }
function Bad($t)  { Write-Host "  [X]   $t" -ForegroundColor Red }
function Has($n)  { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
# Functional probe: a command can EXIST yet be BROKEN (e.g. a uv tool whose
# pinned Python was deleted -> exit 103). Run a no-token liveness check and
# report missing / broken / ok so the doctor can't give false greens.
function Probe($n, [string[]]$liveArgs = @('--version')) {
  if (-not (Has $n)) { return @{ state='missing'; detail='not on PATH' } }
  try {
    $out = (& $n @liveArgs 2>&1) -join ' '
    if ($LASTEXITCODE -ne 0) {
      return @{ state='broken'; detail=("exit {0}: {1}" -f $LASTEXITCODE, $out.Substring(0, [Math]::Min(140, $out.Length))) }
    }
    return @{ state='ok'; detail=$out.Substring(0, [Math]::Min(60, $out.Length)) }
  } catch { return @{ state='broken'; detail=$_.Exception.Message } }
}

Write-Host "Swarm setup — Architect (Opus) / Carpenter (DeepSeek) / Reviewer (Codex)" -ForegroundColor White

# ---------------------------------------------------------------------------
# 1. Node.js >= 22  (Codex CLI needs 22+, ship.js needs 18.18+)
# ---------------------------------------------------------------------------
Section "Node.js (>= 22)"
$nodeOk = $false
if (Has node) {
  $major = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($major -ge 22) { Ok "node $(node --version)"; $nodeOk = $true }
  else { Warn "node $(node --version) is too old (need >= 22)" }
} else { Warn "node not found" }
if (-not $nodeOk -and -not $DoctorOnly) {
  if (Has winget) { Warn "installing Node LTS via winget…"; winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
  else { Bad "winget not available — install Node 22+ manually from https://nodejs.org" }
  Warn "Open a NEW terminal after install so PATH refreshes, then re-run -DoctorOnly."
}

# ---------------------------------------------------------------------------
# 2. uv + Graphify  (token-cutting knowledge graph; preflight runs `graphify . --update`)
# ---------------------------------------------------------------------------
Section "Graphify (via uv)"
if (-not $DoctorOnly) {
  if (-not (Has uv)) {
    if (Has winget) { Warn "installing uv…"; winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements }
    else { Bad "winget not available — install uv manually: https://docs.astral.sh/uv" }
  }
  if (Has uv) { Warn "installing graphify (graphifyy)…"; uv tool install graphifyy 2>$null; if (Has graphify) { graphify install 2>$null } }
}
if (Has graphify) { Ok "graphify present" } else { Warn "graphify missing (run without -DoctorOnly, or: uv tool install graphifyy)" }

# ---------------------------------------------------------------------------
# 3. Codex CLI  (the Reviewer — `codex exec`)
# ---------------------------------------------------------------------------
Section "Codex CLI (Reviewer)"
if (-not $DoctorOnly) {
  if (-not (Has codex)) {
    if (Has npm) { Warn "installing @openai/codex…"; npm install -g @openai/codex }
    else { Bad "npm not available (install Node first)" }
  }
  if (Has codex) {
    $status = (codex login status 2>&1) -join ' '
    if ($status -match 'not logged in|no auth|unauthenticated|error') {
      Warn "launching 'codex login' (browser OAuth; paid ChatGPT plan or OPENAI_API_KEY)…"
      codex login
    }
  }
}
if (Has codex) {
  $st = (codex login status 2>&1) -join ' '
  if ($st -match 'logged in|authenticated|active') { Ok "codex installed + authenticated" }
  else { Warn "codex installed but auth unconfirmed — run: codex login" }
} else { Warn "codex missing — run: npm install -g @openai/codex" }

# ---------------------------------------------------------------------------
# 4. Carpenter — claude -> DeepSeek direct (ADR-0012). The DEFAULT Carpenter is the
#    `claude` you already have, pointed at DeepSeek's Anthropic endpoint via env vars.
#    NO free-claude-code router to install. Set DEEPSEEK_API_KEY for cheap builds;
#    without it the Carpenter builds on Anthropic Claude (still works, costlier).
# ---------------------------------------------------------------------------
Section "Carpenter (claude -> DeepSeek)"
if (Has claude) { Ok "claude present (Carpenter + Architect engine)" }
else { Bad "claude (Claude Code) missing — install from https://claude.com/claude-code" }
$dsKey = $env:DEEPSEEK_API_KEY
if (-not $dsKey -and (Test-Path "$HOME/.fcc/.env")) {
  $m = Select-String -Path "$HOME/.fcc/.env" -Pattern '^DEEPSEEK_API_KEY=(.+)$' -ErrorAction SilentlyContinue
  if ($m) { $dsKey = 'set (in ~/.fcc/.env)' }
}
if ($dsKey) { Ok "DEEPSEEK_API_KEY found — Carpenter will route to DeepSeek (cheap)" }
else { Warn "DEEPSEEK_API_KEY not set — Carpenter will build on Anthropic Claude (costlier). For cheap builds: set DEEPSEEK_API_KEY (key at platform.deepseek.com/api_keys)." }
# Legacy: the fcc router stays supported via SHIP_CARPENTER_CMD=fcc-claude.
if (Has fcc-claude) { Ok "fcc-claude also present (optional legacy router)" }

# ---------------------------------------------------------------------------
# 5. git
# ---------------------------------------------------------------------------
Section "git"
if (Has git) { Ok "git $(git --version)" } else { Bad "git missing — install from https://git-scm.com" }

# ---------------------------------------------------------------------------
# 5b. Global install — link `ship` + `ship-init` onto PATH (npm link) so the
#     loop is ONE command in any project. A symlink, so repo edits reflect live.
# ---------------------------------------------------------------------------
Section "Global install (ship CLI)"
if (-not $DoctorOnly) {
  if (Has npm) {
    Push-Location $PSScriptRoot
    Warn "linking 'ship' + 'ship-init' globally (npm link)…"
    npm link 2>&1 | Select-Object -Last 2
    Pop-Location
  } else { Bad "npm not available — install Node first, then re-run" }
}
if (Has ship) { Ok "ship on PATH ($((Get-Command ship).Source))" }
else { Warn "ship not linked — run 'npm link' from $PSScriptRoot" }

# ---------------------------------------------------------------------------
# 6. Offline self-test (no engines, no tokens)
# ---------------------------------------------------------------------------
Section "Offline parser self-test"
if ((Has node) -and (Test-Path "$PSScriptRoot/simulate.js")) {
  node "$PSScriptRoot/simulate.js" | Select-Object -Last 8
} else { Warn "simulate.js not found here, or node missing" }

# ---------------------------------------------------------------------------
# Doctor summary
# ---------------------------------------------------------------------------
Section "Doctor summary (functional probes — not just 'is it on PATH')"
# node needs >= 22 specifically; Probe only confirms it runs.
$nodeP = Probe node
if ($nodeP.state -eq 'ok') {
  $maj = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($maj -lt 22) { $nodeP = @{ state='broken'; detail="$(node --version) < required 22" } }
}
$probes = @(
  @{ n='node>=22';                p=$nodeP }
  @{ n='git';                     p=(Probe git) }
  @{ n='claude (Carpenter+Arch)'; p=(Probe claude --version) }
  @{ n='graphify';                p=(Probe graphify) }
  @{ n='codex (Reviewer)';        p=(Probe codex) }
  @{ n='ship (CLI on PATH)';      p=(Probe ship --help) }
)
$bad = 0
foreach ($r in $probes) {
  switch ($r.p.state) {
    'ok'      { Ok  ("{0,-26} {1}" -f $r.n, $r.p.detail) }
    'broken'  { Bad ("{0,-26} BROKEN — {1}" -f $r.n, $r.p.detail); $bad++ }
    'missing' { Warn ("{0,-26} missing" -f $r.n); $bad++ }
  }
}
if ($bad -eq 0) { Ok "all engines functional" }
else { Bad "$bad item(s) not functional — fix above. For live token-spending probes (codex -o, git effect): node calibrate.js" }

Write-Host "`nNext:" -ForegroundColor White
Write-Host "  1. Run 'codex login' (the Reviewer)."
Write-Host "  2. (Optional, for cheap builds) set DEEPSEEK_API_KEY — else the Carpenter uses Anthropic Claude."
Write-Host "  3. Verify the live engines:   node calibrate.js"
Write-Host "  4. New project:   cd <project>; ship-init   then  ship-app  (chat with the Architect) or  ship"
Write-Host "  5. 'ship' / 'ship-app' / 'ship-init' are global after the link above — no per-project copy needed."
