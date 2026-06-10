<#
.SYNOPSIS
  Live progress panel + desktop notifications for the Architect/Carpenter/Reviewer
  swarm. Reads the .ship-status.json heartbeat that ship.js writes each phase.
.DESCRIPTION
  Run this in a side terminal/pane while `ship` runs. It renders a compact live
  panel and fires a desktop toast on CLEAN PASS or ESCALATION — so you fire-and-
  forget and get pinged only when the loop reaches a gate (ADR-0003 watcher model).
  Dependency-free: prefers the BurntToast module if present, else a built-in
  balloon tip, else a console banner + beep.
.EXAMPLE
  ./ship-watch.ps1
.EXAMPLE
  ./ship-watch.ps1 -Path C:\Dev\my-app\.ship-status.json
#>
param(
  [string]$Path = (Join-Path (Get-Location) '.ship-status.json'),
  [int]$IntervalMs = 500
)

$ErrorActionPreference = 'SilentlyContinue'

function Send-Toast($title, $message) {
  # 1) BurntToast module (nicest, if the user installed it)
  if (Get-Module -ListAvailable -Name BurntToast) {
    Import-Module BurntToast
    New-BurntToastNotification -Text $title, $message
    return
  }
  # 2) Built-in balloon tip — no module required
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.ShowBalloonTip(8000, $title, $message, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Milliseconds 250
    $ni.Dispose()
  } catch { } # 3) the console banner + beep below always fire regardless
}

$labels = @{
  'preflight'         = @{ t = 'Preflighting...';            c = 'Cyan';    spin = $true  }
  'starting'          = @{ t = 'Starting loop...';           c = 'Cyan';    spin = $true  }
  'round'             = @{ t = 'Round begins';               c = 'White';   spin = $false }
  'worker-building'   = @{ t = 'Worker building (DeepSeek)'; c = 'Yellow';  spin = $true  }
  'master-inspecting' = @{ t = 'Master inspecting (Claude)'; c = 'Magenta'; spin = $true  }
  'reviewer-auditing' = @{ t = 'Reviewer auditing (Codex)';  c = 'Blue';    spin = $true  }
  'clean-pass'        = @{ t = 'CLEAN PASS';                 c = 'Green';   spin = $false }
  'escalation'        = @{ t = 'ESCALATION';                 c = 'Red';     spin = $false }
}
$spinner = '|', '/', '-', '\'
$started = Get-Date
$i = 0

Write-Host "ship-watch -- watching $Path  (Ctrl+C to stop)" -ForegroundColor DarkGray

while ($true) {
  $i++
  $st = $null
  if (Test-Path $Path) {
    $raw = Get-Content $Path -Raw
    if ($raw) { try { $st = $raw | ConvertFrom-Json } catch { } }
  }

  # Ignore a terminal status left over from a PREVIOUS run: only act on a
  # heartbeat written after we started watching.
  $fresh = $false
  if ($st -and $st.ts) { try { $fresh = ([datetime]$st.ts) -ge $started } catch { $fresh = $true } }

  try { Clear-Host } catch { }
  Write-Host ""
  Write-Host "  +-- SWARM --------------------------------------" -ForegroundColor DarkGray
  if (-not $st) {
    Write-Host "  |  (no active run -- waiting for ship)" -ForegroundColor DarkGray
  } else {
    $meta = $labels[$st.phase]
    if (-not $meta) { $meta = @{ t = $st.phase; c = 'White'; spin = $false } }
    $sp = if ($meta.spin) { $spinner[$i % 4] } else { '*' }
    $stale = if (-not $fresh) { '  (last run)' } else { '' }
    Write-Host ("  |  {0} {1}{2}" -f $sp, $meta.t, $stale) -ForegroundColor $meta.c
    if ($st.round) {
      $sup = if ($st.supervisionRound) { " | supervision $($st.supervisionRound)/2" } else { '' }
      Write-Host ("  |     round $($st.round)/$($st.maxRounds)$sup") -ForegroundColor DarkGray
    }
    if ($st.branch) { Write-Host ("  |     $($st.branch)") -ForegroundColor DarkGray }
  }
  Write-Host "  +-----------------------------------------------" -ForegroundColor DarkGray

  if ($fresh -and $st.phase -eq 'clean-pass') {
    try { [console]::beep(880, 150); [console]::beep(1175, 250) } catch { }
    Write-Host "`n  [OK] CLEAN PASS -- review the diff and merge when satisfied." -ForegroundColor Green
    Send-Toast "Swarm: CLEAN PASS" "Branch $($st.branch) is ready -- review & merge."
    break
  }
  if ($fresh -and $st.phase -eq 'escalation') {
    try { [console]::beep(440, 400) } catch { }
    Write-Host "`n  [!!] ESCALATION -- read ESCALATION.md, fix SPEC.md, re-run." -ForegroundColor Red
    Send-Toast "Swarm: ESCALATION" "Needs you -- see ESCALATION.md."
    break
  }

  Start-Sleep -Milliseconds $IntervalMs
}
