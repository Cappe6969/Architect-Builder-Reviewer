#!/usr/bin/env node
'use strict';
/**
 * ship-chat.js — a friendly chat front-end for the Architect/Carpenter/Reviewer
 * swarm. Instead of editing SPEC.md and reading raw orchestrator logs, you:
 *
 *   1. type what you want built (plain language),
 *   2. watch a single live "working…" line while the swarm runs,
 *   3. get a plain-English answer describing what was implemented.
 *
 * It writes SPEC.md, runs ship.js, hides the verbose log behind a spinner that
 * reflects the live phase (read from .ship-status.json), then prints the
 * summary that ship.js recorded in .ship-result.json.
 *
 * Usage:
 *   ship-chat                       # prompts for the task
 *   ship-chat "add a /health route" # task from the command line
 *   ship-chat --raw "..."           # also stream ship's full log (debug)
 */

const fs       = require('node:fs');
const path     = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const ROOT    = process.cwd();
const SPEC    = path.join(ROOT, 'SPEC.md');
const STATUS  = path.join(ROOT, '.ship-status.json');
const RESULT  = path.join(ROOT, '.ship-result.json');
const LOCK    = path.join(ROOT, '.ship.lock'); // ADR-0007 mutual exclusion (shared with ship.js)
const SHIP_JS = path.join(__dirname, 'ship.js'); // installed alongside this script

const RAW = process.argv.includes('--raw');
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};

const PHASES = {
  preflight:           'Preflighting',
  starting:            'Starting the swarm',
  round:               'Round starting',
  'worker-building':   'Worker building (Carpenter)',
  'master-inspecting': 'Master inspecting',
  'reviewer-auditing': 'Reviewer auditing',
  'clean-pass':        'Wrapping up',
  escalation:          'Wrapping up',
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// activeRun — true if another swarm holds a LIVE lock. ship.js acquires the lock
// only at preflight, but ship-chat writes SPEC.md *before* spawning ship; without
// this guard a second ship-chat would clobber an in-flight run's spec.
function activeRun() {
  const info = readJson(LOCK);
  return info && pidAlive(info.pid) ? info : null;
}

// nestedRepos — immediate subdirectories that are their OWN git repos. Their
// presence means cwd is a CONTAINER of projects, not a project: running the swarm
// here makes graphify scan everything and produces a giant contaminated diff.
function nestedRepos() {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '.git'
        && fs.existsSync(path.join(ROOT, d.name, '.git')))
      .map((d) => d.name);
  } catch { return []; }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

// Build a SPEC.md from the user's plain-language request. A multi-line request
// is treated as an already-structured spec; a one-liner gets a minimal H1 so the
// swarm's branch slug and Reviewer have a clear title to anchor on.
function buildSpec(task) {
  if (task.includes('\n')) return task.trimEnd() + '\n';
  const title = task.replace(/[.!?]+$/, '');
  return `# ${title}\n\n${task}\n`;
}

// startSpinner — live one-line spinner PLUS a durable log line each time the
// phase changes, so a long run (many minutes) shows visible forward progress
// ("Worker building → Master inspecting → Reviewer auditing") instead of an
// opaque spinner the user can't read.
function startSpinner() {
  const frames = ['|', '/', '-', '\\'];
  const t0 = Date.now();
  let i = 0;
  let lastKey = null;
  const elapsed = () => Math.floor((Date.now() - t0) / 1000);
  const tick = () => {
    const st = readJson(STATUS);
    const phase = st && st.phase;
    const label = (st && PHASES[phase]) || 'Working';
    const roundN = st && st.round ? st.round : null;
    const key = `${phase}|${roundN}`;
    // On a phase/round change, commit a permanent progress line (overwrite the
    // transient spinner line first so it doesn't get left behind).
    if (phase && key !== lastKey) {
      process.stdout.write('\r' + ' '.repeat(64) + '\r');
      const rt = roundN ? ` (round ${roundN}/${st.maxRounds || 3})` : '';
      console.log(`  ${c.cyan}→${c.reset} ${label}${c.dim}${rt} · ${elapsed()}s${c.reset}`);
      lastKey = key;
    }
    const round = roundN ? ` ${c.dim}(round ${roundN}/${st.maxRounds || 3})${c.reset}` : '';
    process.stdout.write(`\r${c.cyan}${frames[i++ % 4]}${c.reset} ${label}${round} ${c.dim}${elapsed()}s${c.reset}   `);
  };
  const id = setInterval(tick, 200);
  tick();
  return { stop() { clearInterval(id); process.stdout.write('\r' + ' '.repeat(64) + '\r'); } };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log([
      'ship-chat — plain-language front-end for the swarm.',
      'Usage:  ship-chat ["what you want built"]   (prompts if no task given)',
      'Flags:  --raw   also stream ship\'s full orchestration log',
      'It writes SPEC.md, runs ship, and prints a plain-English summary on success.',
    ].join('\n'));
    return;
  }

  // 1) Task — from argv (minus flags) or an interactive prompt.
  let task = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!task) task = (await ask(`${c.bold}What do you want built?${c.reset}\n${c.dim}(one line, or paste a fuller spec)${c.reset}\n> `)).trim();
  if (!task) { console.error(`${c.red}No task given — nothing to do.${c.reset}`); process.exit(1); }

  // 1a) Refuse if this looks like a CONTAINER of projects (nested git repos) —
  //     running here scans everything and yields a huge contaminated diff. The
  //     user almost certainly means one of the subprojects. --here overrides.
  if (!process.argv.includes('--here')) {
    const nested = nestedRepos();
    if (nested.length) {
      console.error(`${c.red}This folder contains other git repos${c.reset} — it looks like a container, not a project:`);
      for (const n of nested.slice(0, 8)) console.error(`    ${c.dim}•${c.reset} ${n}/`);
      console.error(`\n${c.dim}cd into the actual project and re-run, e.g.  cd ${nested[0]} && ship-chat "${task.slice(0, 40)}…"`);
      console.error(`Or pass --here if you really mean to run the swarm in this folder.${c.reset}`);
      process.exit(1);
    }
  }

  // 1b) Refuse if another swarm is live — BEFORE touching SPEC.md, so we never
  //     clobber the spec of an in-flight run (the lock alone can't prevent this,
  //     because ship.js acquires it only after ship-chat has written SPEC.md).
  const running = activeRun();
  if (running) {
    console.error(`${c.red}A swarm is already running here${c.reset} (PID ${running.pid}, since ${running.started}).`);
    console.error(`${c.dim}Wait for it to finish, or if you're sure it's dead, delete .ship.lock and retry.${c.reset}`);
    process.exit(1);
  }

  // 2) Write SPEC.md and clear any stale result from a previous run.
  fs.writeFileSync(SPEC, buildSpec(task));
  try { fs.rmSync(RESULT); } catch { /* none to clear */ }

  // 3) Run ship. Hide its verbose log behind the spinner unless --raw.
  console.log(`${c.dim}Spec written. Running the swarm…${c.reset}\n`);
  const child = spawn(process.execPath, [SHIP_JS], {
    cwd: ROOT,
    stdio: RAW ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let tail = '';
  if (!RAW) {
    const grab = (d) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
  }
  const spinner = RAW ? null : startSpinner();
  const code = await new Promise((res) => child.on('close', res));
  if (spinner) spinner.stop();

  // 4) Report the outcome as an "answer".
  const result = readJson(RESULT);
  if (code === 0 && result && result.ok) {
    console.log(`${c.green}${c.bold}✓ Done — here's what was implemented:${c.reset}\n`);
    console.log(result.summary
      ? result.summary.split('\n').map((l) => '  ' + l).join('\n')
      : '  (no summary available — see the diff below)');
    if (Array.isArray(result.files) && result.files.length) {
      const CAP = 14; // don't flood the terminal on a large change set
      console.log(`\n  ${c.dim}Files changed (${result.files.length}):${c.reset}`);
      for (const f of result.files.slice(0, CAP)) console.log(`    ${c.dim}•${c.reset} ${f}`);
      if (result.files.length > CAP) console.log(`    ${c.dim}… and ${result.files.length - CAP} more${c.reset}`);
    }
    console.log(`\n  ${c.dim}Review, then merge when satisfied:${c.reset}`);
    console.log(`    ${c.cyan}${result.merge_command}${c.reset}\n`);
  } else if (result && result.ok === false) {
    console.log(`${c.yellow}${c.bold}! The swarm couldn't finish cleanly.${c.reset}\n`);
    console.log(`  Reason: ${result.reason}`);
    if (Array.isArray(result.findings) && result.findings.length) {
      console.log(`\n  ${c.dim}Unresolved issues:${c.reset}`);
      for (const f of result.findings) console.log(`    ${c.dim}•${c.reset} ${f.summary || f}`);
    }
    console.log(`\n  ${c.dim}See ESCALATION.md, tighten SPEC.md, then re-run.${c.reset}\n`);
    process.exit(2);
  } else {
    console.log(`${c.red}${c.bold}✗ ship exited (code ${code}) without a result.${c.reset}`);
    if (!RAW && tail.trim()) {
      console.log(`\n${c.dim}Last output:${c.reset}`);
      console.log(tail.trim().split('\n').slice(-12).map((l) => '  ' + l).join('\n'));
    }
    console.log(`\n${c.dim}Re-run with  ship-chat --raw "<task>"  to see the full log.${c.reset}\n`);
    process.exit(code || 1);
  }
}

main().catch((err) => { console.error(`${c.red}ship-chat error:${c.reset}`, err.message); process.exit(1); });
