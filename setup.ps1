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
# 4. fcc router  (the Carpenter — `fcc-claude -p`, DeepSeek behind a local proxy)
# ---------------------------------------------------------------------------
Section "fcc router (Carpenter)"
if (-not (Has fcc-claude) -and -not $DoctorOnly) {
  Warn "installing free-claude-code router…"
  try { irm "https://github.com/Alishahryar1/free-claude-code/blob/main/scripts/install.ps1?raw=1" | iex }
  catch { Bad "router install failed: $($_.Exception.Message)" }
}
if (Has fcc-claude) { Ok "fcc-claude present" } else { Warn "fcc-claude missing" }
Warn "MANUAL: run 'fcc-server', open http://127.0.0.1:8082/admin, paste DEEPSEEK_API_KEY,"
Warn "        set MODEL = deepseek/deepseek-v4-pro, Validate + Apply. (Get a key + small balance"
Warn "        at platform.deepseek.com/api_keys.)"

# ---------------------------------------------------------------------------
# 5. git
# ---------------------------------------------------------------------------
Section "git"
if (Has git) { Ok "git $(git --version)" } else { Bad "git missing — install from https://git-scm.com" }

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
Section "Doctor summary"
$rows = @(
  @{ n='node>=22'; ok=((Has node) -and ([int]((node --version).TrimStart('v').Split('.')[0]) -ge 22)) }
  @{ n='git';      ok=(Has git) }
  @{ n='graphify'; ok=(Has graphify) }
  @{ n='fcc-claude (Carpenter)'; ok=(Has fcc-claude) }
  @{ n='codex (Reviewer)';       ok=(Has codex) }
)
foreach ($r in $rows) { if ($r.ok) { Ok $r.n } else { Bad $r.n } }

Write-Host "`nNext:" -ForegroundColor White
Write-Host "  1. Finish the two MANUAL items above (DeepSeek Admin UI; codex login)."
Write-Host "  2. Verify the live engines:   node calibrate.js"
Write-Host "  3. Scaffold a project:        ./swarm-init.ps1 -Target C:\Dev\my-app"
Write-Host "  4. In that project: git commit an init, 'graphify .', write SPEC.md, then 'node ship.js' (or /ship)."
