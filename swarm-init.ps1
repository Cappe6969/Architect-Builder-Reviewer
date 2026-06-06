<#
.SYNOPSIS
  Scaffold the Architect/Carpenter/Reviewer swarm into any project.
.DESCRIPTION
  Copies the portable runtime (ship.js + lib/parse.js), the /ship skill, the
  VS Code cockpit, and the dev tools into a target repo, and gitignores the
  lock file. Run from inside this kit repo.
.EXAMPLE
  ./swarm-init.ps1 -Target C:\Dev\my-app
.EXAMPLE
  ./swarm-init.ps1 -Target C:\Dev\my-app -WithDocs   # also copy CONTEXT.md + docs/adr
#>
param(
  [Parameter(Mandatory)][string]$Target,
  [switch]$WithDocs
)
$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot

if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target -Force | Out-Null }

# Runtime (required) + dev/verification tools (recommended)
$files = @('ship.js', 'simulate.js', 'calibrate.js')
$dirs  = @('lib', '.claude', '.vscode')

foreach ($f in $files) {
  Copy-Item -Path (Join-Path $kit $f) -Destination (Join-Path $Target $f) -Force
  Write-Host "  copied $f"
}
foreach ($d in $dirs) {
  Copy-Item -Path (Join-Path $kit $d) -Destination $Target -Recurse -Force
  Write-Host "  copied $d/"
}
if ($WithDocs) {
  Copy-Item -Path (Join-Path $kit 'docs')       -Destination $Target -Recurse -Force
  Copy-Item -Path (Join-Path $kit 'CONTEXT.md') -Destination $Target -Force
  Write-Host "  copied CONTEXT.md + docs/adr/"
}

# Ensure .ship.lock is gitignored
$gi = Join-Path $Target '.gitignore'
if (-not (Test-Path $gi) -or -not (Select-String -Path $gi -Pattern '^\.ship\.lock' -Quiet)) {
  Add-Content -Path $gi -Value "`n# ship.js concurrency lock`n.ship.lock"
  Write-Host "  added .ship.lock to .gitignore"
}

Write-Host ""
Write-Host "Swarm scaffolded into $Target" -ForegroundColor Green
Write-Host "Next steps in that project:"
Write-Host "  1. Ensure it's a git repo with >=1 commit   (git init; git add -A; git commit -m init)"
Write-Host "  2. graphify .            # build the initial knowledge graph"
Write-Host "  3. Write SPEC.md         # what the Carpenter should build"
Write-Host "  4. node ship.js          # or open the VS Code cockpit and type /ship"
