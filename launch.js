#!/usr/bin/env node
/**
 * launch.js — open 3 pre-instructed Claude Code terminals
 *             Architect | Carpenter | Reviewer
 *
 * Usage:  node launch.js
 * Requires DEEPSEEK_API_KEY in env (or set one below as fallback).
 */
'use strict';

const { execSync, spawn } = require('node:child_process');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const DIR = __dirname;
const KEY = process.env.DEEPSEEK_API_KEY || '';
if (!KEY) { console.error('Set DEEPSEEK_API_KEY in your environment before running launch.js'); process.exit(1); }


// ---------------------------------------------------------------------------
// Role definitions
// Each role gets its own temp .ps1 so quoting inside wt/Start-Process is clean.
// ---------------------------------------------------------------------------
const ROLES = [
  {
    name: 'Architect',
    color: 'Cyan',
    // Architect is interactive — opens claude with an initial instruction message
    launch: `claude "You are the ARCHITECT in this 3-role swarm (Architect / Carpenter / Reviewer). Your job: understand requirements, write SPEC.md (one H1 title + acceptance-criteria bullets), then trigger the build by running: node ship.js. Do NOT write source code yourself — that is the Carpenter's job. What would you like to build?"`,
  },
  {
    name: 'Carpenter',
    color: 'Green',
    // Carpenter runs with dangerously-skip-permissions so ship.js can drive it headlessly
    launch: `claude --dangerously-skip-permissions "You are the CARPENTER in this swarm. When ship.js calls you, build exactly what SPEC.md says — edit files on disk, do not run git (the orchestrator commits for you). Until ship.js calls you, stand by for instructions."`,
  },
  {
    name: 'Reviewer',
    color: 'Yellow',
    // Reviewer uses codex; codex login was already done
    launch: `codex "You are the REVIEWER in this swarm. Your job: audit the diff against SPEC.md, classify every finding as High / Medium / Low, and respond with JSON only: {verdict, findings[]}."`,
  },
];

// Write a tiny bootstrap .ps1 per role — avoids all quoting nightmares in wt args
const tmp = os.tmpdir();
const scripts = ROLES.map((r) => {
  const file = path.join(tmp, `swarm-${r.name.toLowerCase()}.ps1`);
  fs.writeFileSync(file, [
    `$env:DEEPSEEK_API_KEY = '${KEY.replace(/'/g, "''")}'`,
    `Set-Location '${DIR.replace(/'/g, "''")}'`,
    `$Host.UI.RawUI.WindowTitle = 'Swarm :: ${r.name}'`,
    `Write-Host ''`,
    `Write-Host '  === ${r.name.toUpperCase()} ===' -ForegroundColor ${r.color}`,
    `Write-Host ''`,
    r.launch,
  ].join('\r\n') + '\r\n');
  return { ...r, file };
});

// ---------------------------------------------------------------------------
// Open terminals — prefer Windows Terminal (one window, 3 tabs),
// fall back to 3 separate pwsh windows.
// ---------------------------------------------------------------------------
let hasWT = false;
try { execSync('where wt', { stdio: 'pipe' }); hasWT = true; } catch {}

if (hasWT) {
  console.log('[launch] Windows Terminal detected — opening 3 tabs...');
  // wt uses ';' as sub-command separator; pass each as a distinct arg
  const wtArgs = [];
  scripts.forEach((s, i) => {
    if (i > 0) wtArgs.push(';');
    wtArgs.push('new-tab', '--title', s.name, 'pwsh', '-NoExit', '-File', s.file);
  });
  spawn('wt', wtArgs, { detached: true, shell: false }).unref();
} else {
  console.log('[launch] Windows Terminal not found — opening 3 separate PowerShell windows...');
  scripts.forEach((s) => {
    spawn('pwsh', ['-NoExit', '-File', s.file], { detached: true, shell: false }).unref();
  });
}

console.log('[launch] Swarm terminals launched:');
ROLES.forEach((r) => console.log(`  [${r.name}]`));
