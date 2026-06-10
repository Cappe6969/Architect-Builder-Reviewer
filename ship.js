#!/usr/bin/env node
/**
 * ship.js — Architect / Carpenter / Reviewer automated loop
 * ----------------------------------------------------------
 * Single-command trigger for the self-contained swarm.
 *
 * Implements the locked design:
 *   ADR-0001  automated, self-contained loop (no external framework)
 *   ADR-0002  clean pass = zero High; cap 3 rounds; Medium/Low -> BACKLOG.md
 *             + Retry Loop topology + defensive parser + graph-aware review
 *   ADR-0003  ESCALATION.md, Reviewer-generated root_cause_hypothesis,
 *             native-only alerting (watched folder + terminal bell)
 *   ADR-0004  cross-model routing via headless CLI behind runRole() seam
 *
 * Roles (ADR-0004): Carpenter = `fcc-claude -p` (DeepSeek via router),
 *                   Reviewer  = `codex exec` (Codex CLI, NOT the /codex plugin).
 *
 * Node >= 18.18, CommonJS, zero npm dependencies.
 *
 * Lines marked  // CALIBRATE:  are the ONLY things the one manual
 * Calibration Cycle must verify/adjust (exact flags + JSON shapes).
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { defensiveJsonParse, extractUsageTokens, extractBody } = require('./lib/parse'); // shared contract (ADR-0002)

// Load DEEPSEEK_API_KEY from ~/.fcc/.env so graphify can authenticate without
// requiring a Windows env var (which would also lock out the fcc-server Admin UI).
(function loadFccKey() {
  if (process.env.DEEPSEEK_API_KEY) return;
  try {
    const fccEnv = path.join(os.homedir(), '.fcc', '.env');
    const m = fs.readFileSync(fccEnv, 'utf8').match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (m) process.env.DEEPSEEK_API_KEY = m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no ~/.fcc/.env present — graphify degrades to diff-only */ }
})();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
const FRESH = process.argv.includes('--fresh'); // ADR-0005: opt into discarding an existing swarm branch
const LOCK_PATH = path.join(process.cwd(), '.ship.lock'); // ADR-0007: single-run mutual exclusion

const CONFIG = {
  specPath:      path.join(ROOT, 'SPEC.md'),
  backlogPath:   path.join(ROOT, 'BACKLOG.md'),
  escalationPath:path.join(ROOT, 'ESCALATION.md'), // ADR-0003: written to a watched folder (repo root by default)
  maxRounds:     3,                                // ADR-0002: circuit breaker (outer Retry Loop)
  supervisionCap:2,                                // ADR-0008: inner Supervision Loop — Master-directed fix rounds
  tokenBudget:   Number(process.env.SHIP_TOKEN_BUDGET || 2_000_000), // ADR-0002 budget bound

  timeouts: { carpenterMs: 600_000, reviewerMs: 600_000 }, // per-call kill bounds

  // Prompt on stdin (PROMPT '-'). Reviewer flags confirmed live on codex v0.137.0:
  // `exec` defaults approval=never (no --ask-for-approval flag exists); it refuses
  // to run outside a trusted repo without --skip-git-repo-check; --sandbox read-only
  // keeps it read-only; -o writes the final message to a file (pending one clean
  // `node calibrate.js` to confirm -o on this version). Carpenter still CALIBRATE.
  // Each engine command can be overridden from the environment so the runRole
  // seam (ADR-0004) is swappable WITHOUT a code edit — e.g. SHIP_CARPENTER_CMD=claude
  // isolates the loop from a flaky router. fcc-claude is Claude Code pointed at
  // DeepSeek, so it shares the exact same args as real `claude`.
  engines: {
    // carpenter == the Worker Carpenter (ADR-0008): cheap bulk builder.
    carpenter: { cmd: process.env.SHIP_CARPENTER_CMD || 'fcc-claude', args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'] },
    // master == the Master Carpenter (ADR-0008): Claude foreman. Same headless
    // claude flags as a Worker, but it inspects (read-only judgment) instead of
    // building. Claude emits a `usage` envelope, so its calls un-blind the budget.
    master:    { cmd: process.env.SHIP_MASTER_CMD     || 'claude', args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'] },
    reviewer:  { cmd: process.env.SHIP_REVIEWER_CMD  || 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', '__OUTFILE__', '-'], outputFile: true },
  },
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const log  = (...a) => console.log('[ship]', ...a);
const warn = (...a) => console.warn('\x1b[33m[ship][WARN]\x1b[0m', ...a);
const fail = (msg) => { console.error('[ship][FATAL]', msg); process.exit(1); };
const bell = () => process.stdout.write('\x07'); // ADR-0003: native terminal bell, no external deps

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

/**
 * spawnCapture — run a command (no shell), feed `input` on stdin, capture stdout.
 * Promise-wrapped spawn with a hard timeout (SIGTERM -> SIGKILL).
 * A timeout rejects with code 'ETIMEDOUT' so callers can convert it into a
 * failed round rather than a crash (constraint #3).
 */
function spawnCapture(cmd, args, input, timeoutMs, { passthroughStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    // `settled` + independent timeout: a missing/hanging engine (no 'close'
    // event, dead stdin pipe on Windows) must NEVER deadlock the orchestrator.
    let settled = false;
    const finish = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); fn(val); };

    let child;
    try { child = spawn(cmd, args, { shell: process.platform === 'win32', cwd: ROOT }); }
    catch (err) { return reject(err); }

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000).unref();
      const e = new Error(`timeout after ${timeoutMs}ms`); e.code = 'ETIMEDOUT';
      finish(reject, e); // resolve on timeout INDEPENDENTLY of 'close'
    }, timeoutMs);

    child.stdin.on('error', () => {}); // swallow EPIPE writing to a dead pipe
    child.stdout.on('data', (d) => {
      stdout += d;
      if (passthroughStdout) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code !== 0) { const e = new Error(`exit ${code}: ${stderr.slice(0, 500)}`); e.code = code; return finish(reject, e); }
      finish(resolve, stdout);
    });

    try { if (input != null) child.stdin.write(input); child.stdin.end(); }
    catch { /* stdin unavailable; rely on error/close/timeout to settle */ }
  });
}

// ---------------------------------------------------------------------------
// Orchestrator seam (ADR-0004): runRole(role, payload) -> Promise<JSON>
// The loop logic below NEVER references an engine directly — only this seam.
// ---------------------------------------------------------------------------
let tokensUsed = 0;

/**
 * autoFixRoleError — recover from common engine failures without crashing.
 *
 * Returns:
 *   { _raw: string }  — fallback stdout obtained; caller continues normal parsing
 *   result object     — synthetic High finding; caller returns it directly
 *   null              — unrecoverable; caller re-throws the original error
 *
 * Reviewer fixes: 401 auth expiry, command not found, missing output file
 *   → retries using the carpenter engine with the same prompt. The reviewer
 *   prompt requests JSON only, so the fallback model handles it correctly.
 * Carpenter fixes: any non-zero exit → synthetic High so the circuit breaker
 *   can handle it gracefully instead of crashing the whole run.
 */
async function autoFixRoleError(role, err, prompt, timeoutMs) {
  const msg = String(err.message || '');
  const isAuth     = /401|[Uu]nauthorized|invalidated|sign.?in again/.test(msg);
  const isNotFound = err.code === 'ENOENT';
  const isNoOutput = Boolean(err._noOutputFile);

  const syntheticHigh = (summary, recommendation) => ({
    verdict: 'fail',
    findings: [{ severity: 'High', file: '(orchestrator)', line: 0, summary, recommendation }],
  });

  if (role === 'reviewer') {
    const reason = isAuth      ? 'auth-401'
                 : isNotFound  ? 'command-not-found'
                 : isNoOutput  ? 'no-output-file'
                 : `exit-${err.code ?? 'error'}`;
    warn(`reviewer ${reason} — falling back to carpenter engine for review`);
    if (isAuth) warn('  → to restore Codex run:  codex login');
    try {
      const carp = CONFIG.engines.carpenter;
      const fb = await spawnCapture(carp.cmd, carp.args, prompt, timeoutMs, { passthroughStdout: true });
      warn('reviewer fallback succeeded; review result may differ from a dedicated Codex review');
      return { _raw: fb };
    } catch (fbErr) {
      warn(`reviewer fallback also failed: ${String(fbErr.message).slice(0, 120)}`);
      return syntheticHigh(
        `reviewer failed (${reason}); fallback also failed`,
        isAuth
          ? 'Run `codex login` to restore Codex authentication, then re-run.'
          : 'Ensure the reviewer engine is installed and reachable.',
      );
    }
  }

  if (role === 'carpenter') {
    warn(`carpenter engine error (${err.code ?? 'non-zero exit'}): ${msg.slice(0, 120)}`);
    return syntheticHigh(
      `Carpenter engine error: ${msg.slice(0, 200)}`,
      'Check API keys and engine connectivity.',
    );
  }

  if (role === 'master') {
    // ADR-0008: the Master is a quality amplifier, not a gate. ANY Master engine
    // failure degrades to satisfied so the Worker's best-effort build still
    // reaches the independent Reviewer — the foreman never blocks the line.
    warn(`master engine error (${err.code ?? 'non-zero exit'}): ${msg.slice(0, 120)} — degrading to satisfied (best-effort handoff)`);
    return { satisfied: true, corrections: [], notes: `master supervision unavailable: ${msg.slice(0, 160)}` };
  }

  return null; // unknown role — caller re-throws
}

async function runRole(role, payload) {
  const eng = CONFIG.engines[role];
  if (!eng) throw new Error(`unknown role: ${role}`);
  const timeoutMs = role === 'reviewer' ? CONFIG.timeouts.reviewerMs : CONFIG.timeouts.carpenterMs;

  // Prompt is the JSON payload + a role contract, delivered on stdin (constraint #2).
  const prompt = buildPrompt(role, payload);

  // Some engines (codex exec -o) write their final message to a file, not stdout.
  // Inject a temp path into args and read it back (ADR-0004 calibration).
  let args = eng.args;
  let outFile = null;
  if (eng.outputFile) {
    outFile = path.join(os.tmpdir(), `ship-${role}-${process.pid}-${Date.now()}.txt`);
    args = eng.args.map((a) => (a === '__OUTFILE__' ? outFile : a));
  }

  if (role === 'reviewer') log('reviewer: running (output streaming below)');
  let raw;
  try {
    const stdout = await spawnCapture(eng.cmd, args, prompt, timeoutMs, { passthroughStdout: role === 'reviewer' });
    if (eng.outputFile) {
      try { raw = fs.readFileSync(outFile, 'utf8'); }
      catch (readErr) {
        const e = new Error(`output file not written: ${readErr.message}`);
        e._noOutputFile = true;
        throw e;
      }
    } else {
      raw = stdout;
    }
  } catch (err) {
    if (err.code === 'ETIMEDOUT') {
      // ADR-0008: a Master timeout degrades to satisfied (amplifier, not gate).
      if (role === 'master') {
        warn(`master timed out after ${timeoutMs}ms — degrading to satisfied (best-effort handoff)`);
        return { satisfied: true, corrections: [],
          notes: `master timed out after ${timeoutMs}ms; handed off best-effort` };
      }
      // constraint #3: timeout becomes a failed round, surfaced as a synthetic High finding.
      return { verdict: 'fail', timedOut: true,
        findings: [{ severity: 'High', file: '(orchestrator)', line: 0,
          summary: `${role} timed out after ${timeoutMs}ms`,
          recommendation: 'Engine hung; likely Spec too large or context broken — escalate.' }] };
    }
    const recovery = await autoFixRoleError(role, err, prompt, timeoutMs);
    if (recovery === null) throw err;                   // unrecoverable — let main() escalate
    if (recovery._raw !== undefined) { raw = recovery._raw; } // fallback raw — continue parsing
    else { return recovery; }                           // synthetic result — return directly
  } finally {
    if (outFile) { try { fs.rmSync(outFile); } catch {} }
  }

  // Engines may wrap the answer in an envelope ({result, usage,...}). Pull token
  // usage for the budget bound (ADR-0002), unwrap the body, and if the body is
  // itself a JSON string (e.g. claude -p's `result`), parse that too.
  const outer = defensiveJsonParse(raw);
  tokensUsed += extractUsageTokens(outer);
  let body = extractBody(outer);
  if (typeof body === 'string') body = defensiveJsonParse(body) ?? body;

  let parsed = (body && typeof body === 'object') ? body : defensiveJsonParse(raw);

  // Shape guard (simulator finding): the LLM must emit the CORRECT schema, not
  // merely valid JSON. A key-less {} (prose with stray braces) would otherwise
  // slip through as zero findings -> a FALSE clean pass. Wrong shape is treated
  // as a parse failure -> coerce once.
  // NOTE: deviates from the proposed `.some(['verdict','findings'])` for the
  // reviewer. main() consumes review.findings directly, so we require it to be
  // an ARRAY — otherwise `{"verdict":"fail"}` (no findings) would still false-pass.
  const isValidShape = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (role === 'reviewer') return Array.isArray(v.findings);
    if (role === 'master') return typeof v.satisfied === 'boolean'; // ADR-0008 inspection verdict
    return 'status' in v; // carpenter liveness check (truth comes from git regardless)
  };

  if (parsed == null || !isValidShape(parsed)) {
    log(`${role} output ${parsed == null ? 'unparseable' : 'wrong-shape'}; requesting one coerce-to-JSON pass`);
    const required = role === 'reviewer' ? 'verdict (string), findings (array)'
                   : role === 'master'   ? 'satisfied (boolean), corrections (array)'
                   : 'status (string), changed_files (array)';
    try {
      const coerced = await spawnCapture(
        CONFIG.engines.carpenter.cmd, CONFIG.engines.carpenter.args,
        `Convert the following text into the exact JSON schema for a ${role} response `
        + `(required keys: ${required}). Output ONLY raw JSON, no prose, no markdown fences.\n\n${raw}`,
        CONFIG.timeouts.reviewerMs,
      );
      parsed = extractBody(defensiveJsonParse(coerced));
    } catch (coerceErr) {
      warn(`coerce pass failed (${String(coerceErr.message).slice(0, 80)}); treating as failed output`);
      parsed = null;
    }
    if (!isValidShape(parsed)) {
      warn(`${role} output failed shape validation`);
      if (role === 'master') {
        // ADR-0008: the Master is a quality amplifier, not a gate. A foreman that
        // can't produce a verdict must NOT block the build — degrade to satisfied
        // and hand the best-effort work onward to the independent Reviewer.
        return { satisfied: true, corrections: [],
          notes: 'master verdict unavailable (bad output shape); handed off best-effort' };
      }
      return { verdict: 'fail',
        findings: [{ severity: 'High', file: '(orchestrator)', line: 0,
          summary: `${role} output did not match expected JSON schema`,
          recommendation: 'Engine may have returned prose or malformed JSON; check connectivity.' }] };
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Role prompts (engine-agnostic; reference artifacts by path — never inline files)
// ---------------------------------------------------------------------------
function buildPrompt(role, payload) {
  if (role === 'carpenter') {
    // Worker Carpenter (ADR-0008). Three build modes, in priority order:
    //   1. master_corrections present → apply the Master's inner-loop corrections.
    //   2. outer retry (attempt > 1)  → fix the Reviewer's High findings.
    //   3. initial build              → build the Spec from scratch.
    const fixingMaster = Array.isArray(payload.master_corrections) && payload.master_corrections.length > 0;
    const retry = Number(payload.attempt) > 1 && !fixingMaster; // bug #1 fix: stateless headless call has no memory of prior rounds
    let task;
    if (fixingMaster) {
      task = 'The MASTER CARPENTER inspected your build and requires the corrections below before it can ship. '
        + 'Apply ONLY these corrections to the files already on disk; do NOT rebuild from scratch.';
    } else if (retry) {
      task = `This is Round ${payload.attempt}. Your previous work is ALREADY COMMITTED on the current branch. `
        + 'Read the existing diff, then fix ONLY the specific High-severity findings listed below. '
        + 'Do NOT rebuild the feature from scratch.';
    } else {
      task = 'Build EXACTLY what the Spec says, from scratch.';
    }
    return [
      'You are the WORKER CARPENTER. Make no design decisions.',
      task,
      'Re-read the Spec (SPEC.md) from disk now; it is the sole source of truth.',
      'Edit files on disk only. Do NOT run git — the orchestrator commits for you.',
      'Respond ONLY with JSON: {"status":"built","changed_files":[...]}',
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n');
  }
  if (role === 'master') {
    // Master Carpenter (ADR-0008): inspects the Worker's UNCOMMITTED tree for
    // completeness + conciseness only. Never judges correctness (Reviewer's job).
    return [
      'You are the MASTER CARPENTER (foreman). You SUPERVISE the Worker — you do not write features yourself.',
      "Inspect the Worker's CURRENT UNCOMMITTED working tree against the Spec. Run `git status` first (brand-new files are UNTRACKED — read them directly), then `git diff` for edits to existing files, and re-read SPEC.md from disk.",
      'Judge ONLY these two things, nothing else:',
      '  (1) Completeness & spec-adherence — every Spec requirement is built; nothing required is skipped; nothing outside the Spec was invented.',
      '  (2) Conciseness — no over-engineering, dead code, duplication, or needless length.',
      "Do NOT judge correctness, logic bugs, or edge cases — that is the independent Reviewer's job, not yours.",
      'If the build satisfies (1) and (2), set satisfied=true and corrections=[].',
      'Otherwise set satisfied=false and give SPECIFIC, actionable corrections the Worker can apply directly.',
      'Respond ONLY with JSON: {"satisfied":true|false,"corrections":[{"file","issue","fix"}],"notes":"short summary of any unresolved concern, or empty"}',
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n');
  }
  if (role === 'reviewer') {
    return [
      'You are the REVIEWER. Read-only. Audit the diff against the Spec.',
      'Use graph_ref to understand blast radius and avoid false-positive High flags.',
      'Classify every issue severity as exactly "High", "Medium", or "Low".',
      payload.escalating
        ? 'The circuit breaker has tripped. Also produce root_cause_hypothesis '
          + '{classification:"spec_defect"|"context_gap", rationale} from attempt_history.'
        : '',
      'Respond ONLY with JSON: {"verdict":"pass"|"fail","findings":[{"severity","file","line","summary","recommendation"}]'
        + (payload.escalating ? ',"root_cause_hypothesis":{...}}' : '}'),
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n');
  }
  throw new Error(`no prompt template for role ${role}`);
}

// ---------------------------------------------------------------------------
// Concurrency lock (ADR-0007) — one /ship run per working tree.
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }  // signal 0 = liveness probe (works on Windows too)
  catch (e) { return e.code === 'EPERM'; }     // EPERM = exists but no perms (alive); ESRCH = dead
}

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    let info = {};
    try { info = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch { /* corrupt lock */ }
    if (pidAlive(info.pid)) {
      fail(`another /ship run is active (PID ${info.pid}, since ${info.started}). `
        + `If you are sure it is not, delete .ship.lock and retry.`);
    }
    log(`reclaiming stale lock from dead PID ${info.pid ?? '?'}`);
    try { fs.rmSync(LOCK_PATH); } catch {}
  }
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cwd: ROOT }, null, 2));

  // Release on EVERY graceful exit path (normal exit, process.exit, uncaught ->
  // fail() -> exit, SIGINT/SIGTERM). SIGKILL can't be caught — that's exactly
  // what the stale-PID reclaim above exists for.
  const release = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (cur.pid === process.pid) fs.rmSync(LOCK_PATH); // only delete OUR lock
    } catch { /* already gone or not ours */ }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// fcc-server guard — probe :8082, auto-start if not reachable.
// fcc-claude is a proxy client; Carpenter calls fail silently if the server
// is down, causing carpenterCommit to stage all untracked files (false diff).
// ---------------------------------------------------------------------------
function ensureFccServer() {
  const probe = `const n=require('net'),s=n.createConnection({host:'127.0.0.1',port:8082});`
    + `s.setTimeout(500);s.on('connect',()=>{s.destroy();process.exit(0)});`
    + `s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)});`;
  const isUp = () => require('node:child_process').spawnSync(
    process.execPath, ['-e', probe], { timeout: 1500 }
  ).status === 0;

  if (isUp()) { log('preflight: fcc-server already running at :8082'); return; }

  log('preflight: fcc-server not detected — starting fcc-server in background...');
  const srv = require('node:child_process').spawn('fcc-server', [], {
    detached: true, stdio: 'ignore', shell: process.platform === 'win32',
  });
  srv.unref();

  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (isUp()) { ready = true; break; }
  }
  if (ready) log('preflight: fcc-server started and ready at :8082');
  else warn('fcc-server did not become ready within 10 s — Carpenter may fail; proceeding anyway');
}

// Preflight — Q7 decision (single /ship trigger, fully-automatic fail-fast gate,
// no confirmation prompt): 5-step gate BEFORE any tokens are spent.
// NOTE: Q7 was agreed but never written as an ADR — documentation gap to close.
// ---------------------------------------------------------------------------
function preflight() {
  log('preflight: starting fail-fast checks');
  acquireLock(); // ADR-0007: refuse a concurrent run; reclaim a stale lock from a dead PID

  // 0. Git sanity — the loop diffs/commits against HEAD, so we need a repo with
  //    at least one commit. Fail clean instead of crashing mid-loop.
  try { runGit(['rev-parse', '--is-inside-work-tree']); }
  catch { fail('not a git repository. Run: git init  (then make an initial commit) before /ship.'); }
  try { runGit(['rev-parse', 'HEAD']); }
  catch { fail('repository has no commits yet. Run: git add -A && git commit -m "init" before /ship.'); }

  // 1. Spec check — exists and > 0 bytes
  if (!fs.existsSync(CONFIG.specPath) || fs.statSync(CONFIG.specPath).size === 0) {
    fail('SPEC.md missing or empty. The Architect must write a Spec before /ship.');
  }
  // Branch name = slug (from H1) + short content hash. The hash makes the name
  // collision-proof AND deterministic: re-running /ship on the SAME Spec resumes
  // the SAME branch (a timestamp would orphan a new branch every run). ADR-0005.
  const specContent = fs.readFileSync(CONFIG.specPath, 'utf8');
  const specSlug = slugify(specContent.split('\n')[0].replace(/^#+\s*/, ''));
  const shortHash = crypto.createHash('sha256').update(specContent).digest('hex').slice(0, 6);
  const branch = `swarm/${specSlug}-${shortHash}`;

  // Base branch we diff/merge against on Clean Pass (ADR-0006). Capture BEFORE
  // checkout. If HEAD is already the swarm branch (a re-run), discover the real
  // default branch from the repo instead of hardcoding 'main'.
  let baseBranch = 'main';
  try { baseBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'main'; } catch {}
  if (baseBranch === branch || baseBranch === 'HEAD' || baseBranch.startsWith('swarm/')) {
    // Already on swarm branch — detect the real default (master/main/trunk/etc)
    try {
      baseBranch = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD']).trim().replace('refs/remotes/origin/', '');
    } catch {
      // No remote — check common names in order
      const candidates = ['main', 'master', 'trunk', 'develop'];
      baseBranch = candidates.find((b) => { try { runGit(['rev-parse', '--verify', b]); return true; } catch { return false; } }) || 'main';
    }
  }

  // 2. Branch check (ADR-0005 amended): protect the base branch, and REFUSE to
  //    clobber an existing swarm branch that holds unmerged work — Halt & Leave
  //    (ADR-0006) makes it a precious artifact pending review. --fresh opts into
  //    discarding it. Re-runs are detected, never silently resumed or reset.
  let branchExists = false;
  try { runGit(['rev-parse', '--verify', branch]); branchExists = true; } catch { branchExists = false; }

  if (branchExists) {
    let ahead = 0;
    try { ahead = Number(runGit(['rev-list', '--count', `${baseBranch}..${branch}`]).trim()) || 0; } catch { ahead = 0; }
    if (ahead > 0 && !FRESH) {
      fail(`work branch ${branch} already has ${ahead} unmerged commit(s) from a prior run.\n`
        + `  Merge it:   git checkout ${baseBranch} && git merge ${branch}\n`
        + `  Or discard: git branch -D ${branch}   (or re-run with --fresh)\n`
        + `  Refusing to clobber a branch pending review (ADR-0005/0006).`);
    }
    runGit(['checkout', branch]);
    if (ahead > 0 && FRESH) {
      // SAFETY: `git reset --hard` reverts tracked-file changes in the working tree.
      // Refuse --fresh while tracked files are dirty so it can never silently destroy
      // in-progress edits. (Untracked files like SPEC.md survive a hard reset, so
      // they are ignored here.) Learned the hard way — see ADR-0008 consequences.
      const dirty = runGit(['status', '--porcelain']).split('\n').filter((l) => l && !l.startsWith('??'));
      if (dirty.length) {
        fail(`--fresh would 'git reset --hard ${baseBranch}' and REVERT these uncommitted tracked changes:\n`
          + dirty.map((l) => '    ' + l).join('\n')
          + `\n  Commit or stash them first, then re-run with --fresh.`);
      }
      runGit(['reset', '--hard', baseBranch]);
      log(`preflight: --fresh — discarded ${ahead} prior commit(s); ${branch} reset to ${baseBranch}`);
    }
  } else {
    runGit(['checkout', '-b', branch]);
  }
  log(`preflight: on work branch ${branch} (base: ${baseBranch})`);

  // 2.5. Ensure fcc-server is reachable at :8082 — auto-start if not.
  //      fcc-claude is a proxy client; it cannot connect without the server running.
  ensureFccServer();

  // 3. Graph update — best-effort; non-fatal (mirrors refreshGraph() mid-loop).
  //    A missing API key or uninstalled graphify degrades Reviewer accuracy but
  //    must NOT block a build. Reviewer falls back to diff-only analysis.
  try {
    spawnSyncCheck('graphify', ['.', '--update'], 30_000); // CALIBRATE: exact graphify invocation
    log('preflight: graph refreshed');
  } catch (e) {
    log(`preflight: graph refresh skipped (${e.message}); Reviewer will use diff-only context`);
  }
  const graphRef = fs.existsSync(path.join(ROOT, 'graph.json')) ? path.join(ROOT, 'graph.json') : null;

  // 4. State init — attempt=0, ensure BACKLOG.md, nuke stale ESCALATION.md
  if (!fs.existsSync(CONFIG.backlogPath)) fs.writeFileSync(CONFIG.backlogPath, '# BACKLOG\n\nDeferred Medium/Low findings.\n');
  if (fs.existsSync(CONFIG.escalationPath)) fs.rmSync(CONFIG.escalationPath);

  // 5. Budget bound — already loaded into CONFIG.tokenBudget; reset counter
  tokensUsed = 0;

  log('preflight: all checks passed');
  return { branch, baseBranch, graphRef, specSlug };
}

// Synchronous git helper (preflight only, before the async loop)
function runGit(args) { return spawnSyncCheck('git', args); }

function spawnSyncCheck(cmd, args, timeoutMs) {
  const { spawnSync } = require('node:child_process');
  const opts = { cwd: ROOT, encoding: 'utf8', shell: false };
  if (timeoutMs) opts.timeout = timeoutMs;
  const r = spawnSync(cmd, args, opts);
  if (r.error) throw r.error;
  if (r.signal === 'SIGTERM') throw new Error(`${cmd} timed out after ${timeoutMs}ms`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} -> exit ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}

// Orchestrator-managed files — excluded from the Carpenter's commit so the
// Reviewer's diff is PURE feature work (no graph/backlog/spec/escalation churn).
// ORCH_EXCLUDES: orchestrator-managed files + any dirs that were already untracked
// before the run (non-work dirs swept up by `git add -- .`). Keep this in sync
// with whatever untracked dirs live alongside the work tree.
const ORCH_EXCLUDES = [
  ':(exclude)SPEC.md', ':(exclude)BACKLOG.md', ':(exclude)ESCALATION.md',
  ':(exclude)graph.json', ':(exclude)graph.html', ':(exclude)GRAPH_REPORT.md',
  ':(exclude).claude/', ':(exclude)ship.js', ':(exclude)simulate.js',
  ':(exclude)calibrate.js', ':(exclude)lib/', ':(exclude).vscode/',
  // .ship.lock is gitignored — no explicit exclude needed (git rejects it as redundant)
  // non-work sibling dirs present in this repo — exclude so they never bloat the diff
  ':(exclude)free-claude-code/', ':(exclude)llm-council-temp/', ':(exclude)ruflo/',
];

/**
 * carpenterCommit — bug #2 fix. The ORCHESTRATOR controls git state; never trust
 * a headless LLM to commit. Stage everything the Carpenter touched (minus
 * orchestrator files), commit it, and return the TRUE changed-file set derived
 * from git (not the Carpenter's self-report). `changed === false` => no-op round.
 * Works whether the LLM committed on its own or left the tree dirty.
 */
function carpenterCommit(round, preHead) {
  spawnSyncCheck('git', ['add', '--', '.', ...ORCH_EXCLUDES]);
  const staged = spawnSyncCheck('git', ['diff', '--cached', '--name-only']).trim();
  if (staged) spawnSyncCheck('git', ['commit', '-m', `carpenter: automated build round ${round}`]);
  const head = spawnSyncCheck('git', ['rev-parse', 'HEAD']).trim();
  const changed = head !== preHead;
  const files = changed
    ? spawnSyncCheck('git', ['diff', '--name-only', preHead, 'HEAD', '--', '.', ...ORCH_EXCLUDES])
        .trim().split('\n').filter(Boolean)
    : [];
  return { changed, files };
}

// refreshGraph — ADR-0002 graph-aware contract, intra-loop. The Carpenter
// changes code every round, so the Reviewer's graph_ref must be re-extracted
// before each audit or rounds 2-3 audit new code against a preflight-stale map
// (-> false-positive Highs that needlessly trip the breaker). `--update` is
// incremental (changed files only). NON-FATAL mid-loop: a failed refresh
// degrades accuracy but must not kill an in-progress build.
function refreshGraph() {
  try {
    spawnSyncCheck('graphify', ['.', '--update'], 30_000); // CALIBRATE: incremental update invocation
    return true;
  } catch (e) {
    log(`graph refresh failed mid-loop (${e.message}); Reviewer will use the prior graph`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Finding helpers
// ---------------------------------------------------------------------------
const isHigh = (f) => String(f.severity).toLowerCase() === 'high';
const splitBySeverity = (findings = []) => ({
  high:    findings.filter(isHigh),
  lowMed:  findings.filter((f) => !isHigh(f)),
});

function appendBacklog(lowMed, round) {
  if (!lowMed.length) return;
  const lines = lowMed.map((f) =>
    `- [${f.severity}] ${f.file}:${f.line} — ${f.summary} (round ${round}) → ${f.recommendation}`);
  fs.appendFileSync(CONFIG.backlogPath, `\n${lines.join('\n')}\n`);
  log(`backlog: appended ${lowMed.length} Medium/Low finding(s)`);
}

// ADR-0006 Halt & Leave: never auto-merge. Print the change surface + merge
// command so the Architect reviews and merges without digging.
function printMergeSummary(state) {
  try {
    const stat = spawnSyncCheck('git', ['diff', '--stat', `${state.baseBranch}...HEAD`]).trimEnd();
    console.log(`\n  Change surface (${state.baseBranch}...${state.branch}):`);
    console.log(stat ? stat.split('\n').map((l) => '    ' + l).join('\n') : '    (no diff)');
  } catch (e) {
    log(`(could not compute git diff --stat: ${e.message})`);
  }
  console.log('\n  Review, then merge when satisfied:');
  console.log(`    git checkout ${state.baseBranch} && git merge ${state.branch}\n`);
}

function writeEscalation(state, highFindings, reviewerResult) {
  const payload = {
    reason: 'circuit_breaker_tripped',
    spec_path: 'SPEC.md',
    diff_ref: state.branch,
    graph_ref: state.graphRef,
    rounds_attempted: CONFIG.maxRounds,
    unresolved_findings: highFindings,
    attempt_history: state.attemptHistory,
    root_cause_hypothesis: reviewerResult.root_cause_hypothesis
      || { classification: 'context_gap', rationale: 'Reviewer did not return a hypothesis.' },
  };
  fs.writeFileSync(CONFIG.escalationPath, JSON.stringify(payload, null, 2) + '\n');
  bell(); // ADR-0003: native alert; external watcher/orchestrator handles the rest
  log(`ESCALATION.md written (${highFindings.length} unresolved High). Architect intervention required.`);
}

// ---------------------------------------------------------------------------
// Carpenter sub-swarm (ADR-0008) — the Supervision Loop runs entirely behind
// what the outer loop sees as a single Carpenter. The Worker (DeepSeek) builds
// on the UNCOMMITTED working tree; the Master (Claude) inspects that tree for
// completeness + conciseness ONLY (never correctness) and directs up to
// supervisionCap fixes. At the cap the best-effort build is handed onward with
// the Master's notes; the Master NEVER escalates — the outer Circuit Breaker is
// the only path to the Architect. Returns { masterNotes } for the Reviewer payload.
// ---------------------------------------------------------------------------
async function runCarpenterSwarm(payload) {
  // Worker builds (initial) or fixes the Reviewer's High findings (outer retry).
  await runRole('carpenter', payload);

  let masterNotes = '';
  for (let s = 1; s <= CONFIG.supervisionCap; s++) {
    // ADR-0002 budget guard, applied mid-supervision (Master/Claude calls accrue real usage).
    if (tokensUsed > CONFIG.tokenBudget) {
      masterNotes = 'supervision halted early: token budget reached';
      log(`supervision: token budget reached (${tokensUsed}/${CONFIG.tokenBudget}); handing off best-effort`);
      break;
    }

    const inspection = await runRole('master', {
      spec_path: 'SPEC.md', supervision_round: s, attempt: payload.attempt,
    });

    if (inspection.satisfied) {
      log(`supervision: Master satisfied after ${s - 1} fix round(s)`);
      masterNotes = inspection.notes || '';
      break;
    }

    const corrections = Array.isArray(inspection.corrections) ? inspection.corrections : [];
    log(`supervision round ${s}/${CONFIG.supervisionCap}: Master unsatisfied — ${corrections.length} correction(s)`);

    // Worker applies the Master's corrections (no rebuild).
    await runRole('carpenter', {
      spec_path: 'SPEC.md', master_corrections: corrections,
      attempt: payload.attempt, supervision_round: s,
    });

    masterNotes = (inspection.notes ? inspection.notes + ' ' : '')
      + `(supervision round ${s}: ${corrections.length} correction(s) applied)`;
    if (s === CONFIG.supervisionCap) {
      log('supervision: cap reached — handing best-effort build to Reviewer (final fixes not re-inspected)');
      masterNotes += ' — supervision cap reached; final fixes not re-inspected';
    }
  }
  return { masterNotes };
}

// ---------------------------------------------------------------------------
// Main loop — Retry Loop spins Carpenter <-> Reviewer (ADR-0002 topology)
// ---------------------------------------------------------------------------
async function main() {
  const state = preflight();
  state.attemptHistory = [];

  let failedFindings = [];           // High-only, fed back to Carpenter (Reviewer->Carpenter edge)

  for (let attempt = 1; attempt <= CONFIG.maxRounds; attempt++) {
    log(`--- round ${attempt}/${CONFIG.maxRounds} ---`);

    // Budget bound (ADR-0002): stop before overspending.
    if (tokensUsed > CONFIG.tokenBudget) {
      log(`token budget exceeded (${tokensUsed}/${CONFIG.tokenBudget}); escalating.`);
      writeEscalation(state, failedFindings.length ? failedFindings
        : [{ severity: 'High', file: '(orchestrator)', line: 0, summary: 'Token budget exceeded', recommendation: 'Tighten Spec scope.' }],
        { root_cause_hypothesis: { classification: 'spec_defect', rationale: 'Scope too large for budget.' } });
      process.exit(2);
    }

    // 1) Carpenter builds (Architect->Carpenter on round 1, else Reviewer->Carpenter retry payload)
    const carpenterPayload = attempt === 1
      ? { spec_path: 'SPEC.md', token_budget: CONFIG.tokenBudget, build_context: [], attempt }
      : { spec_path: 'SPEC.md', failed_findings: failedFindings, attempt };
    const preHead = spawnSyncCheck('git', ['rev-parse', 'HEAD']).trim();
    const swarm = await runCarpenterSwarm(carpenterPayload); // ADR-0008: Worker build + Master Supervision Loop

    // 1b) Orchestrator commits the Carpenter's work; derive the TRUE diff (bug #2 fix).
    const commit = carpenterCommit(attempt, preHead);
    if (!commit.changed) {
      // No-op Carpenter must NOT reach a false clean pass. Skip the Reviewer (save
      // tokens), record a synthetic High, and let the breaker handle it.
      log(`round ${attempt}: Carpenter produced NO changes — treating as High no-op`);
      const noop = [{ severity: 'High', file: '(orchestrator)', line: 0,
        summary: `Carpenter produced no changes on round ${attempt}`,
        recommendation: 'Spec may be unbuildable, contradictory, or already satisfied — verify SPEC.md.' }];
      state.attemptHistory.push({ round: attempt, fix_attempted: [], why_it_failed: ['no changes produced'] });
      failedFindings = noop;
      if (attempt === CONFIG.maxRounds) {
        writeEscalation(state, noop, { root_cause_hypothesis:
          { classification: 'spec_defect', rationale: 'Carpenter repeatedly produced no changes.' } });
        process.exit(2);
      }
      continue;
    }

    // Refresh the graph for THIS round's diff so the Reviewer audits new code
    // against a current map, not a preflight-stale one (ADR-0002 graph-aware).
    refreshGraph();

    // 2) Reviewer audits (Carpenter->Reviewer edge, graph-aware). changed_files from git, not self-report.
    const escalating = attempt === CONFIG.maxRounds; // ask for hypothesis on the final attempt
    const review = await runRole('reviewer', {
      diff_ref: state.branch,
      spec_path: 'SPEC.md',
      graph_ref: state.graphRef,
      changed_files: commit.files,
      master_notes: swarm.masterNotes, // ADR-0008: Master's unresolved concerns (advisory; Reviewer decides independently)
      escalating,
      attempt_history: state.attemptHistory,
    });

    const { high, lowMed } = splitBySeverity(review.findings);
    appendBacklog(lowMed, attempt);                         // ADR-0002: Medium/Low -> BACKLOG.md
    state.attemptHistory.push({ round: attempt,
      fix_attempted: commit.files,
      why_it_failed: high.map((f) => f.summary) });

    // 3) Stop condition (ADR-0002): zero High == clean pass.
    //    Halt & Leave (ADR-0006): do NOT auto-merge; show the change surface.
    if (high.length === 0) {
      log(`CLEAN PASS on round ${attempt} (tokens ~${tokensUsed}). Halt & Leave — not auto-merged.`);
      printMergeSummary(state);
      process.exit(0);
    }

    log(`round ${attempt}: ${high.length} High finding(s) remain`);
    failedFindings = high; // feed back to Carpenter next round

    // 4) Circuit breaker (ADR-0002/0003): out of rounds -> escalate with Reviewer hypothesis
    if (attempt === CONFIG.maxRounds) {
      writeEscalation(state, high, review);
      process.exit(2);
    }
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'ship — Architect/Carpenter/Reviewer automated loop.',
    'Usage: write SPEC.md at the repo root, then run `ship` (or `node ship.js`).',
    'Flags:  --fresh   discard a prior swarm branch for this Spec (refuses if tracked files are dirty)',
    'Env:    SHIP_CARPENTER_CMD / SHIP_MASTER_CMD / SHIP_REVIEWER_CMD   override engines (ADR-0004/0008)',
    '        SHIP_TOKEN_BUDGET   token cap across all rounds (default 2,000,000)',
  ].join('\n'));
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
