#!/usr/bin/env node
/**
 * ship-init.js — bootstrap the Architect/Carpenter/Reviewer workflow in any project.
 *
 * Usage:
 *   node ship-init.js                  # bootstraps the current directory
 *   node ship-init.js path/to/project  # bootstraps the given directory
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const ok   = (msg) => console.log('\x1b[32m✓\x1b[0m', msg);
const info = (msg) => console.log('\x1b[36mℹ\x1b[0m', msg);
const warn = (msg) => console.warn('\x1b[33m!\x1b[0m', msg);
const fail = (msg) => { console.error('\x1b[31m✗\x1b[0m', msg); process.exit(1); };

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
if (!fs.existsSync(TARGET)) fail(`Target directory does not exist: ${TARGET}`);

const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: TARGET, encoding: 'utf8' });
if (gitCheck.status !== 0) {
  warn('No git repo found — initialising one now');
  const init = spawnSync('git', ['init'], { cwd: TARGET, encoding: 'utf8' });
  if (init.status !== 0) fail(`git init failed: ${init.stderr}`);
  ok('git init');
}

const headCheck = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: TARGET, encoding: 'utf8' });
if (headCheck.status !== 0) {
  warn('No commits yet — creating an initial empty commit');
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: TARGET });
  ok('initial commit created');
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------
const CLAUDE_PATH = path.join(TARGET, 'CLAUDE.md');
const CLAUDE_MARKER = '<!-- ship-workflow -->';

const CLAUDE_BLOCK = `${CLAUDE_MARKER}
## Architect workflow (ship)

You are the **Architect**. When the user asks for a feature, change, or fix:

1. Write \`SPEC.md\` at the project root — one H1 title, concrete requirements, exact filenames.
2. Run \`ship\` (or \`node <path-to-ship.js>\` if not globally linked).
   - Use \`--fresh\` if a swarm branch already has commits for this spec.
3. If the loop escalates:
   - Read \`ESCALATION.md\` to understand the root cause.
   - Tighten \`SPEC.md\` to resolve the ambiguity.
   - Re-run with \`--fresh\`.
4. On clean pass: show the user the git diff and wait for approval before merging.
5. On approval: run \`git checkout master && git merge swarm/<branch>\`.

### Rules
- Fix wrong output by improving \`SPEC.md\` — never edit Carpenter files directly.
- Never merge without explicit user approval.
- Deferred Medium/Low findings go to \`BACKLOG.md\` — review with the user periodically.
<!-- end ship-workflow -->`;

if (!fs.existsSync(CLAUDE_PATH)) {
  fs.writeFileSync(CLAUDE_PATH, CLAUDE_BLOCK + '\n');
  ok('CLAUDE.md created');
} else {
  const existing = fs.readFileSync(CLAUDE_PATH, 'utf8');
  if (existing.includes(CLAUDE_MARKER)) {
    info('CLAUDE.md already contains ship workflow — skipping');
  } else {
    fs.appendFileSync(CLAUDE_PATH, '\n' + CLAUDE_BLOCK + '\n');
    ok('ship workflow appended to existing CLAUDE.md');
  }
}

// ---------------------------------------------------------------------------
// .gitignore — keep orchestrator runtime artifacts out of the working tree so
// `git status` stays clean and they never reach a commit.
// ---------------------------------------------------------------------------
const GITIGNORE_PATH = path.join(TARGET, '.gitignore');
const GI_MARKER = '# ship orchestrator artifacts';
const GI_BLOCK = `${GI_MARKER}
.ship.lock
.ship-status.json
.ship-result.json
.ship-trace.jsonl
ESCALATION.md
graph.json
graph.html
GRAPH_REPORT.md
graphify-out/
# machine-specific launcher (absolute path) — created by ship-init, not shared
ship-app.cmd
# secrets live in their tools (fcc admin UI / codex login), never the repo
.env
.env.local`;

if (!fs.existsSync(GITIGNORE_PATH)) {
  fs.writeFileSync(GITIGNORE_PATH, GI_BLOCK + '\n');
  ok('.gitignore created (ship artifacts ignored)');
} else if (fs.readFileSync(GITIGNORE_PATH, 'utf8').includes(GI_MARKER)) {
  info('.gitignore already ignores ship artifacts — skipping');
} else {
  fs.appendFileSync(GITIGNORE_PATH, '\n' + GI_BLOCK + '\n');
  ok('ship artifacts appended to existing .gitignore');
}

// ---------------------------------------------------------------------------
// ship-app.cmd — a double-click launcher (Windows) that opens the Architect chat
// app IN THIS PROJECT. Built against the absolute path of the installed ship-app.js
// so it works whether or not `ship-app` is globally linked.
// ---------------------------------------------------------------------------
const APP_JS = path.join(__dirname, 'ship-app.js');
const CMD_PATH = path.join(TARGET, 'ship-app.cmd');
if (process.platform === 'win32' && !fs.existsSync(CMD_PATH)) {
  fs.writeFileSync(CMD_PATH,
    '@echo off\r\n'
    + 'cd /d "%~dp0"\r\n'
    + `node "${APP_JS}" %*\r\n`);
  ok('ship-app.cmd created (double-click to chat with the Architect)');
}

// ---------------------------------------------------------------------------
// SPEC.md placeholder (only if missing)
// ---------------------------------------------------------------------------
const SPEC_PATH = path.join(TARGET, 'SPEC.md');
if (!fs.existsSync(SPEC_PATH)) {
  fs.writeFileSync(SPEC_PATH, '# (describe your task here)\n\nReplace this file with a concrete spec before running `ship`.\n');
  ok('SPEC.md placeholder created');
} else {
  info('SPEC.md already exists — leaving it untouched');
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('');
console.log('Project bootstrapped. Next steps:');
console.log('  • Chat with the Architect:  double-click ship-app.cmd  (or run  ship-app)');
console.log('  • Or go straight to a build: edit SPEC.md, then run  ship');
