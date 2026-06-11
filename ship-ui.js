#!/usr/bin/env node
'use strict';
/**
 * ship-ui.js — a single live dashboard for the Architect/Carpenter/Reviewer
 * swarm. Opens a local web page with three columns — Worker Carpenter,
 * Master Carpenter, Reviewer — each streaming what that agent is reasoning and
 * doing, under a header showing the current phase / round / branch.
 *
 * It reads two files the orchestrator writes in the target project:
 *   .ship-status.json   — the phase heartbeat (also used by ship-watch.ps1)
 *   .ship-trace.jsonl   — append-only agent events { ts, seq, agent, phase, round, kind, text }
 *
 * Usage:
 *   ship-ui                         # watch the current project, open the dashboard
 *   ship-ui "add a /health route"   # write SPEC.md, launch ship WITH tracing, watch
 *   ship-ui --port 8099             # pick the port (default 8090)
 *   ship-ui --no-open               # don't auto-open the browser
 *
 * Launching a task here sets SHIP_TRACE=stream so ship.js emits token-level
 * reasoning. Plain `ship` / `ship-chat` never enable that — the validated path
 * is unchanged unless you opt in through this UI.
 */

const fs   = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT    = process.cwd();
const STATUS  = path.join(ROOT, '.ship-status.json');
const TRACE   = path.join(ROOT, '.ship-trace.jsonl');
const SPEC    = path.join(ROOT, 'SPEC.md');
const LOCK    = path.join(ROOT, '.ship.lock');
const SHIP_JS = path.join(__dirname, 'ship.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt  = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const PORT    = Number(opt('--port', process.env.SHIP_UI_PORT || 8090));
const NO_OPEN = flag('--no-open');
const TASK    = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--port').join(' ').trim();

if (flag('--help') || flag('-h')) {
  console.log([
    'ship-ui — live three-column dashboard for the swarm.',
    'Usage:  ship-ui ["task"]   (no task = just watch the current run)',
    'Flags:  --port N   server port (default 8090)   --no-open   skip opening the browser',
    'Reads .ship-status.json + .ship-trace.jsonl in the current project.',
  ].join('\n'));
  process.exit(0);
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Read trace events with seq > since. The file is append-only JSONL; we scan
// from the top (cheap for the sizes involved) and filter by seq.
function readTrace(since) {
  let raw;
  try { raw = fs.readFileSync(TRACE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if ((ev.seq || 0) > since) out.push(ev); } catch { /* skip partial line */ }
  }
  return out;
}

function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// ---------------------------------------------------------------------------
// The dashboard page (inline; dependency-free).
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ship · swarm dashboard</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --edge:#21262d; --txt:#c9d1d9; --dim:#8b949e;
    --worker:#d29922; --master:#a371f7; --reviewer:#388bfd; --orch:#7ee787;
    --ok:#3fb950; --bad:#f85149;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header{display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--edge);position:sticky;top:0;z-index:2}
  header .dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}
  header .dot.live{background:var(--ok);box-shadow:0 0 8px var(--ok);animation:pulse 1.4s infinite}
  @keyframes pulse{50%{opacity:.4}}
  header h1{font-size:13px;margin:0;font-weight:600;letter-spacing:.5px}
  header .meta{color:var(--dim);font-size:12px}
  header .phase{margin-left:auto;font-weight:600}
  .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--edge);height:calc(100vh - 45px)}
  .col{background:var(--bg);display:flex;flex-direction:column;min-width:0}
  .col h2{margin:0;padding:8px 12px;font-size:12px;font-weight:700;letter-spacing:.4px;border-bottom:1px solid var(--edge);position:sticky;top:0;background:var(--panel)}
  .col[data-a=worker]   h2{color:var(--worker)}
  .col[data-a=master]   h2{color:var(--master)}
  .col[data-a=reviewer] h2{color:var(--reviewer)}
  .col .sub{font-weight:400;color:var(--dim)}
  .feed{overflow-y:auto;padding:8px 12px;flex:1;scroll-behavior:smooth}
  .ev{margin:0 0 6px;white-space:pre-wrap;word-break:break-word}
  .ev.reasoning{color:var(--dim)}
  .ev.action{color:var(--txt)}
  .ev.action::before{content:"› ";color:var(--orch)}
  .ev.result,.ev.verdict{font-weight:600}
  .ev.verdict.pass{color:var(--ok)} .ev.verdict.fail{color:var(--bad)}
  .ev.note{color:var(--master)}
  .ev .t{color:var(--dim);font-size:11px;margin-right:6px}
  .empty{color:var(--dim);padding:16px;font-style:italic}
</style></head><body>
<header>
  <span class="dot" id="dot"></span>
  <h1>SWARM</h1>
  <span class="meta" id="branch">—</span>
  <span class="meta" id="round"></span>
  <span class="phase" id="phase">idle</span>
  <span class="meta" id="elapsed"></span>
</header>
<div class="cols">
  <div class="col" data-a="worker"><h2>Worker Carpenter <span class="sub">DeepSeek · builds</span></h2><div class="feed" id="worker"><div class="empty">waiting…</div></div></div>
  <div class="col" data-a="master"><h2>Master Carpenter <span class="sub">Claude · supervises</span></h2><div class="feed" id="master"><div class="empty">waiting…</div></div></div>
  <div class="col" data-a="reviewer"><h2>Reviewer <span class="sub">Codex · audits</span></h2><div class="feed" id="reviewer"><div class="empty">waiting…</div></div></div>
</div>
<script>
  let since = 0, t0 = null;
  const feeds = { worker:document.getElementById('worker'), master:document.getElementById('master'), reviewer:document.getElementById('reviewer') };
  const PHASE = { preflight:'Preflighting', starting:'Starting', round:'Round', 'worker-building':'Worker building', 'master-inspecting':'Master inspecting', 'reviewer-auditing':'Reviewer auditing', 'clean-pass':'CLEAN PASS', escalation:'ESCALATION' };
  function near(el){ return el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }
  function add(ev){
    const feed = feeds[ev.agent]; if(!feed) return;
    const empty = feed.querySelector('.empty'); if(empty) empty.remove();
    const stick = near(feed);
    const div = document.createElement('div');
    let cls = 'ev ' + (ev.kind||'reasoning');
    if(ev.kind==='verdict') cls += ' ' + (/pass|clean|satisfied/i.test(ev.text)?'pass':'fail');
    div.className = cls;
    const tm = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '';
    div.innerHTML = (ev.kind!=='reasoning' && tm ? '<span class="t">'+tm+'</span>' : '') + escapeHtml(ev.text||'');
    feed.appendChild(div);
    if(stick) feed.scrollTop = feed.scrollHeight;
  }
  function escapeHtml(s){ return s.replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  async function poll(){
    try{
      const r = await fetch('/trace?since='+since); const j = await r.json();
      for(const ev of j.events){ add(ev); since = Math.max(since, ev.seq||0); }
      const st = j.status || {};
      const live = j.alive;
      document.getElementById('dot').className = 'dot' + (live?' live':'');
      document.getElementById('branch').textContent = st.branch || (live?'…':'no active run');
      document.getElementById('round').textContent = st.round ? ('round '+st.round+'/'+(st.maxRounds||3)) : '';
      const ph = PHASE[st.phase] || (live?'working':'idle');
      document.getElementById('phase').textContent = ph;
      if(j.startedAt){ t0 = t0 || j.startedAt; const s = Math.floor((Date.now()-t0)/1000); document.getElementById('elapsed').textContent = live? s+'s':''; }
      else document.getElementById('elapsed').textContent='';
    }catch(e){ document.getElementById('dot').className='dot'; }
    setTimeout(poll, 500);
  }
  poll();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
let startedAt = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (url.pathname === '/trace') {
    const since = Number(url.searchParams.get('since') || 0);
    const events = readTrace(since);
    const status = readJson(STATUS) || {};
    const lock = readJson(LOCK);
    const alive = lock ? pidAlive(lock.pid) : false;
    if (alive && !startedAt && status.ts) startedAt = Date.parse(status.ts);
    if (!alive) startedAt = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ events, status, alive, startedAt }));
  }
  res.writeHead(404); res.end('not found');
});

function openBrowser(u) {
  if (NO_OPEN) return;
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', u] : [u];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* user opens manually */ }
}

function launchTask(task) {
  // Reset the trace for a fresh run and write the spec, then spawn ship with
  // tracing enabled. ship-ui only WATCHES if no task is given.
  try { fs.writeFileSync(TRACE, ''); } catch {}
  const title = task.includes('\n') ? task.split('\n')[0].replace(/^#\s*/, '') : task.replace(/[.!?]+$/, '');
  const body  = task.includes('\n') ? task : `# ${title}\n\n${task}\n`;
  fs.writeFileSync(SPEC, body);
  const child = spawn(process.execPath, [SHIP_JS], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, SHIP_TRACE: 'stream' }, // opt into token-level reasoning
  });
  child.on('close', (code) => console.log(`[ship-ui] run finished (exit ${code}). Dashboard still live; Ctrl+C to stop.`));
}

server.listen(PORT, () => {
  const u = `http://localhost:${PORT}`;
  console.log(`[ship-ui] dashboard at ${u}  (Ctrl+C to stop)`);
  if (TASK) {
    const lock = readJson(LOCK);
    if (lock && pidAlive(lock.pid)) { console.error('[ship-ui] a swarm is already running here — watching it instead of starting a new one.'); }
    else { console.log(`[ship-ui] starting run: "${TASK}"`); launchTask(TASK); }
  } else {
    console.log('[ship-ui] watching for a run (start one with `ship` / `ship-chat`, or `ship-ui "task"`).');
  }
  openBrowser(u);
});
