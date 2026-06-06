#!/usr/bin/env node
'use strict';
/**
 * calibrate.js — LIVE half of the Calibration Cycle (ADR-0001)
 * ------------------------------------------------------------
 * The simulator (simulate.js) proved our parser handles noisy text offline.
 * This script proves what the REAL engines actually emit. It invokes
 * `fcc-claude -p` and `codex exec` against trivial, low-cost tasks, intercepts
 * raw stdout, and reports the three unknowns that still carry `CALIBRATE:` tags
 * in ship.js / lib/parse.js:
 *
 *   Probe 1 — Extraction : clean JSON vs markdown/preamble wrapping?
 *   Probe 2 — Token Meter: does an outer.usage.total_tokens (or kin) exist?
 *   Probe 3 — Git Effect : does a headless Carpenter edit on disk WITHOUT
 *                          running its own git (which would bypass ORCH_EXCLUDES)?
 *
 * Spends a tiny number of tokens. Run on the local machine with BOTH CLIs
 * installed + configured:  `node calibrate.js`
 * Probe 3 runs entirely in a throwaway temp repo — it never touches your work.
 *
 * Uses the SAME lib/parse.js the production loop uses (no drift).
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defensiveJsonParse, extractUsageTokens, extractBody } = require('./lib/parse');

// CALIBRATE: mirror ship.js CONFIG.engines. Tune flags HERE first; once a probe
// passes, copy the winning invocation into ship.js and drop its CALIBRATE tag.
const ENGINES = {
  carpenter: { cmd: 'fcc-claude', args: ['-p', '--output-format', 'json'] },
  reviewer:  { cmd: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', '__OUTFILE__', '-'], outputFile: true },
};
const TIMEOUT_MS = 60_000; // generous for a trivial probe task; a real build is longer but probes are tiny

// ---------------------------------------------------------------------------
function run(cmd, args, { input = null, cwd = process.cwd(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // Always-settles guard: ENOENT, no-close, or dead stdin pipe must never hang.
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; clearTimeout(timer); resolve(val); };

    let child;
    try { child = spawn(cmd, args, { shell: false, cwd }); }
    catch (error) { return resolve({ ok: false, error, stdout: '', stderr: '', code: null }); }

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3_000).unref();
      finish({ ok: false, code: null, stdout, stderr, killed: true, error: null });
    }, timeoutMs);

    child.stdin.on('error', () => {}); // swallow EPIPE
    child.on('error', (error) => finish({ ok: false, error, stdout, stderr, code: null }));
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr, killed: false, error: null }));

    try { if (input != null) child.stdin.write(input); child.stdin.end(); } catch {}
  });
}

const isENOENT = (res) => res.error && res.error.code === 'ENOENT';
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });

function detectStyle(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'EMPTY';
  if (t.startsWith('{') || t.startsWith('[')) return 'clean';
  if (t.includes('```')) return 'fenced';
  return 'preamble/prose';
}

function preview(raw, n = 280) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + ' …' : t;
}

const REQUIRED_PROMPT = {
  carpenter: 'Respond with ONLY this JSON and nothing else (no prose, no markdown fences): {"status":"built","changed_files":[]}',
  reviewer:  'Respond with ONLY this JSON and nothing else (no prose, no markdown fences): {"verdict":"pass","findings":[]}',
};
const hasShape = (role, v) => role === 'reviewer'
  ? (v && Array.isArray(v.findings))
  : (v && typeof v === 'object' && 'status' in v);

// ---------------------------------------------------------------------------
// Probe 1 — Extraction (both engines). Returns raw outputs for Probe 2 reuse.
// ---------------------------------------------------------------------------
async function probeExtraction() {
  console.log('\n=== Probe 1 — Extraction ===');
  const raws = {};
  for (const role of ['carpenter', 'reviewer']) {
    const eng = ENGINES[role];
    console.log(`  [${role}] invoking '${eng.cmd}' (waiting up to ${TIMEOUT_MS / 1000}s for a response)…`);
    let args = eng.args, outFile = null;
    if (eng.outputFile) { outFile = path.join(os.tmpdir(), `calib-${role}-${Date.now()}.txt`); args = eng.args.map((a) => (a === '__OUTFILE__' ? outFile : a)); }
    const res = await run(eng.cmd, args, { input: REQUIRED_PROMPT[role] });
    if (isENOENT(res)) { console.log(`  [${role}] SKIP — '${eng.cmd}' not found on PATH`); raws[role] = null; continue; }
    let outText = res.stdout;
    if (eng.outputFile) { try { outText = fs.readFileSync(outFile, 'utf8'); } catch { outText = ''; } finally { try { fs.rmSync(outFile); } catch {} } }
    if (!res.ok)       { console.log(`  [${role}] FAIL — exit ${res.code}: ${preview(res.stderr, 160)}`); raws[role] = outText; continue; }

    raws[role] = outText;
    const outer = defensiveJsonParse(outText);
    let body = extractBody(outer);
    if (typeof body === 'string') body = defensiveJsonParse(body) ?? body;
    const style = detectStyle(outText);
    const ok = hasShape(role, body);
    console.log(`  [${role}] ${ok ? 'PASS' : 'FAIL'} — wrapper: ${style}, parsed: ${ok ? 'valid shape' : 'WRONG/none'}`);
    console.log(`           raw: ${preview(outText)}`);
    if (!ok) console.log(`           -> adjust ENGINES.${role}.args or the CALIBRATE flags until this parses`);
  }
  return raws;
}

// ---------------------------------------------------------------------------
// Probe 2 — Token Meter (reuses Probe 1 raw output).
// ---------------------------------------------------------------------------
function probeTokenMeter(raws) {
  console.log('\n=== Probe 2 — Token Meter ===');
  for (const role of ['carpenter', 'reviewer']) {
    if (raws[role] == null) { console.log(`  [${role}] SKIP — no output from Probe 1`); continue; }
    const outer = defensiveJsonParse(raws[role]);
    const tokens = extractUsageTokens(outer);
    if (tokens > 0) {
      console.log(`  [${role}] LIVE — extractUsageTokens = ${tokens}. Budget rail works.`);
    } else {
      const hint = /token|usage/i.test(raws[role]) ? "raw mentions 'token/usage' — field name differs; update lib/parse.js extractUsageTokens" : 'no usage field present in output';
      console.log(`  [${role}] BLIND — 0 tokens. ${hint}.`);
      console.log(`           => budget bound is inert for ${role}; only the 3-round cap protects spend (ADR-0002).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Probe 3 — Git Effect (Carpenter only, throwaway sandbox repo).
// ---------------------------------------------------------------------------
async function probeGitEffect() {
  console.log('\n=== Probe 3 — Git Effect (sandbox) ===');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-git-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'calib@local']);
    git(dir, ['config', 'user.name', 'calibrate']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(dir, ['add', '.']); git(dir, ['commit', '-q', '-m', 'seed']);
    const before = Number(git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim());

    const eng = ENGINES.carpenter;
    console.log(`  invoking '${eng.cmd}' in sandbox (waiting up to ${TIMEOUT_MS / 1000}s)…`);
    const res = await run(eng.cmd, eng.args, {
      cwd: dir,
      input: 'Create a file named hello.txt containing the text hi. Edit files on disk only. Do NOT run any git commands.',
    });
    if (isENOENT(res)) { console.log(`  SKIP — '${eng.cmd}' not found on PATH`); return; }

    const porcelain = git(dir, ['status', '--porcelain']).stdout.trim();
    const after = Number(git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim());
    const lock = fs.existsSync(path.join(dir, '.git', 'index.lock'));
    const dirty = porcelain.length > 0;
    const engineCommits = after - before;
    const pass = dirty && engineCommits === 0 && !lock;

    console.log(`  ${pass ? 'PASS' : 'FAIL'} — workingTreeDirty=${dirty}, engineCommits=${engineCommits}, indexLock=${lock}`);
    if (engineCommits > 0) console.log('  -> Carpenter ran its own git: it would BYPASS ORCH_EXCLUDES. Re-examine ADR-0004 assumption.');
    if (lock)              console.log('  -> stale .git/index.lock left behind: orchestrator commit could deadlock.');
    if (!dirty)            console.log('  -> Carpenter produced no on-disk changes: check the engine actually writes files.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
(async function main() {
  console.log('calibrate.js — live Calibration Cycle. Engines:',
    `${ENGINES.carpenter.cmd} (carpenter), ${ENGINES.reviewer.cmd} (reviewer)`);
  const raws = await probeExtraction();
  probeTokenMeter(raws);
  await probeGitEffect();
  console.log('\nDone. Update ship.js CONFIG.engines / lib/parse.js to match the findings,');
  console.log('then drop the CALIBRATE: tags. Re-run until all probes PASS.\n');
})().catch((e) => { console.error('[calibrate][FATAL]', e.stack || String(e)); process.exit(1); });
