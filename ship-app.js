#!/usr/bin/env node
'use strict';
/**
 * ship-app.js — the one-window app for the Architect/Carpenter/Reviewer swarm.
 *
 * Run it in a project and a localhost page opens where you CHAT WITH THE ARCHITECT
 * (Claude) directly: you describe what you want, the Architect asks anything it
 * needs, then writes SPEC.md. When you click "Ship it" the build loop runs and the
 * three agents (Worker / Master / Reviewer) stream live below the chat.
 *
 *   ship-app                    # chat with the Architect in the current project
 *   ship-app --port 8099        # pick the port (default 8088)
 *   ship-app --no-open          # don't auto-open the browser
 *
 * The Architect is a real multi-turn Claude session (ADR-0011): it converses, writes
 * SPEC.md (the Reviewer's source of truth), and — for UI/front-end-from-handoff work
 * the DeepSeek Carpenter can't do well — builds those files itself before the loop runs.
 */

const fs     = require('node:fs');
const path   = require('node:path');
const http   = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT    = process.cwd();
const SPEC    = path.join(ROOT, 'SPEC.md');
const STATUS  = path.join(ROOT, '.ship-status.json');
const TRACE   = path.join(ROOT, '.ship-trace.jsonl');
const RESULT  = path.join(ROOT, '.ship-result.json');
const LOCK    = path.join(ROOT, '.ship.lock');
const SHIP_JS = path.join(__dirname, 'ship.js');
const NO_MCP  = path.join(__dirname, 'no-mcp.json'); // avoid loading global MCP servers (they hang headless)

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt  = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT    = Number(opt('--port', process.env.SHIP_APP_PORT || 8088));
const NO_OPEN = flag('--no-open');
const ARCHITECT_CMD = process.env.SHIP_ARCHITECT_CMD || 'claude';

if (flag('--help') || flag('-h')) {
  console.log([
    'ship-app — chat with the Architect, then ship. One localhost window.',
    'Usage:  ship-app [--port N] [--no-open]   (run inside your project)',
    'You talk to the Architect (Claude); it writes SPEC.md; "Ship it" runs the loop.',
    'Env:    SHIP_ARCHITECT_CMD   override the Architect engine (default claude)',
  ].join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The Architect's standing role. Sent as the first message of the session so it
// persists across turns (cleaner than re-appending a system prompt every call).
// ---------------------------------------------------------------------------
const ARCHITECT_BRIEF = [
  'You are the ARCHITECT in an automated Architect/Carpenter/Reviewer build loop, talking to a user in a chat window. Reply in the user\'s language, conversationally and briefly.',
  '',
  'How you work:',
  '1. Understand what the user wants built. Ask a clarifying question ONLY when something is genuinely ambiguous and would change the build; otherwise move the plan forward.',
  '2. When you and the user agree on the work, WRITE the file SPEC.md at the repository root. Format: one H1 title line; then concrete requirements; exact filenames; explicit, CHECKABLE acceptance criteria; and an out-of-scope list. The independent Reviewer reads SPEC.md to verify the finished build, so every acceptance criterion must be objectively verifiable.',
  '3. After writing SPEC.md, tell the user in one short line that the spec is ready and they can press "Ship it" to run the build.',
  '',
  'CRITICAL capability rule (ADR-0011): the Carpenter engine is DeepSeek and CANNOT reliably build a good UI / front-end from a design handoff (Figma, screenshot, HTML mockup). For any UI / front-end-from-handoff work, BUILD those files YOURSELF NOW — you are Claude with file tools — then in SPEC.md state that the UI has already been built by the Architect and instruct the Reviewer to AUDIT the existing UI files against the spec. Delegate to the Carpenter only what it does well: well-specified non-UI logic, wiring, and tests.',
  '',
  'Rules: Put real work in files, not in chat code blocks. Never run git — the loop commits for you. SPEC.md is the single source of truth for the build. Keep chat replies short.',
  '',
  '--- The user\'s first message follows ---',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function specMtime() { try { return fs.statSync(SPEC).mtimeMs; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function readTrace(since) {
  let raw; try { raw = fs.readFileSync(TRACE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if ((ev.seq || 0) > since) out.push(ev); } catch { /* partial line */ }
  }
  return out;
}

// nestedRepos — immediate subdirs that are their own git repos => cwd is a CONTAINER
// of projects, not a project. Running the swarm here contaminates the diff.
function nestedRepos() {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '.git' && fs.existsSync(path.join(ROOT, d.name, '.git')))
      .map((d) => d.name);
  } catch { return []; }
}

function activeRun() { const i = readJson(LOCK); return i && pidAlive(i.pid) ? i : null; }

// ---------------------------------------------------------------------------
// Architect engine — one multi-turn Claude session. We mint a session id up
// front: first turn uses --session-id, later turns --resume the same id.
// ---------------------------------------------------------------------------
const sessionId = crypto.randomUUID();
let firstTurn = true;
let architectBusy = false;

function runArchitect(message) {
  return new Promise((resolve, reject) => {
    const base = ['-p', '--output-format', 'json', '--dangerously-skip-permissions',
      '--mcp-config', NO_MCP, '--strict-mcp-config'];
    const args = firstTurn
      ? [...base, '--session-id', sessionId]
      : [...base, '--resume', sessionId];
    const stdin = firstTurn ? ARCHITECT_BRIEF + message : message;

    let child;
    try { child = spawn(ARCHITECT_CMD, args, { cwd: ROOT, shell: process.platform === 'win32' }); }
    catch (err) { return reject(err); }

    let out = '', err = '', settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(reject, new Error('the Architect took too long (timeout). Try again or simplify the request.'));
    }, 600_000);

    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`Architect engine exit ${code}: ${err.slice(0, 200)}`));
      // claude -p --output-format json prints one object: { result, session_id, ... }
      let reply = '';
      try { const j = JSON.parse(out); reply = (typeof j.result === 'string' ? j.result : '') || ''; }
      catch { reply = out.trim(); }
      firstTurn = false;
      finish(resolve, reply || '(the Architect replied with nothing — try rephrasing)');
    });

    try { child.stdin.write(stdin); child.stdin.end(); } catch {}
  });
}

// ---------------------------------------------------------------------------
// The page — chat with the Architect (left) + live swarm dashboard (right).
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ship · talk to the Architect</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--edge:#21262d;--txt:#c9d1d9;--dim:#8b949e;
    --arch:#7ee787;--worker:#d29922;--master:#a371f7;--reviewer:#388bfd;--ok:#3fb950;--bad:#f85149;--accent:#388bfd}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;height:100vh;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--edge)}
  header .dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}
  header .dot.live{background:var(--ok);box-shadow:0 0 8px var(--ok);animation:pulse 1.4s infinite}
  @keyframes pulse{50%{opacity:.4}}
  header h1{font-size:13px;margin:0;font-weight:600;letter-spacing:.5px}
  header .meta{color:var(--dim);font-size:12px}
  header .phase{margin-left:auto;font-weight:600}
  .wrap{flex:1;display:grid;grid-template-columns:minmax(340px,1fr) 1.3fr;min-height:0}
  @media(max-width:820px){.wrap{grid-template-columns:1fr}}
  /* chat */
  .chat{display:flex;flex-direction:column;border-right:1px solid var(--edge);min-height:0}
  .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
  .msg{max-width:90%;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
  .msg.user{align-self:flex-end;background:#1f6feb22;border:1px solid #1f6feb55}
  .msg.arch{align-self:flex-start;background:var(--panel);border:1px solid var(--edge)}
  .msg.arch::before{content:"Architect";display:block;color:var(--arch);font-size:11px;font-weight:700;margin-bottom:3px}
  .msg.sys{align-self:center;color:var(--dim);font-style:italic;font-size:12px;background:none}
  .composer{display:flex;gap:8px;padding:12px;border-top:1px solid var(--edge);background:var(--panel)}
  .composer textarea{flex:1;resize:none;background:var(--bg);color:var(--txt);border:1px solid var(--edge);border-radius:8px;padding:9px;font:inherit;height:46px}
  button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:0 14px;cursor:pointer;color:#fff;background:var(--accent)}
  button:disabled{opacity:.4;cursor:not-allowed}
  #ship{background:var(--ok);color:#062;display:none}
  #ship.ready{display:inline-block}
  .specbar{padding:8px 12px;border-top:1px solid var(--edge);background:#0b3;background:#10301a;color:var(--ok);font-size:12px;display:none}
  .specbar.show{display:flex;align-items:center;gap:10px}
  .specbar a{color:var(--ok);text-decoration:underline;cursor:pointer}
  /* dashboard */
  .board{display:flex;flex-direction:column;min-height:0}
  .board .bhead{padding:8px 12px;border-bottom:1px solid var(--edge);color:var(--dim);font-size:12px}
  .cols{flex:1;display:grid;grid-template-rows:1fr 1fr 1fr;min-height:0}
  .col{display:flex;flex-direction:column;min-height:0;border-bottom:1px solid var(--edge)}
  .col h2{margin:0;padding:6px 12px;font-size:12px;font-weight:700;border-bottom:1px solid var(--edge);background:var(--panel)}
  .col[data-a=worker] h2{color:var(--worker)} .col[data-a=master] h2{color:var(--master)} .col[data-a=reviewer] h2{color:var(--reviewer)}
  .col .sub{font-weight:400;color:var(--dim)}
  .feed{overflow-y:auto;padding:6px 12px;flex:1}
  .ev{margin:0 0 5px;white-space:pre-wrap;word-break:break-word;font-size:12px}
  .ev.reasoning{color:var(--dim)} .ev.action::before{content:"› ";color:var(--arch)}
  .ev.result,.ev.verdict{font-weight:600} .ev.verdict.pass{color:var(--ok)} .ev.verdict.fail{color:var(--bad)}
  .ev.note{color:var(--master)} .empty{color:var(--dim);padding:12px;font-style:italic;font-size:12px}
</style></head><body>
<header>
  <span class="dot" id="dot"></span><h1>SHIP · ARCHITECT</h1>
  <span class="meta" id="branch"></span><span class="meta" id="round"></span>
  <span class="phase" id="phase">talk to the Architect</span><span class="meta" id="elapsed"></span>
</header>
<div class="wrap">
  <div class="chat">
    <div class="msgs" id="msgs">
      <div class="msg arch">Tell me what you want built. I'll ask anything I need, write the spec, and when you're happy press “Ship it”.</div>
    </div>
    <div class="specbar" id="specbar">✓ SPEC.md ready <a id="viewspec">view</a><button id="ship">🚀 Ship it</button></div>
    <div class="composer">
      <textarea id="inp" placeholder="Describe the change…  (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send">Send</button>
    </div>
  </div>
  <div class="board">
    <div class="bhead">The build — Worker / Master / Reviewer stream here once you ship.</div>
    <div class="cols">
      <div class="col" data-a="worker"><h2>Worker Carpenter <span class="sub">DeepSeek · builds</span></h2><div class="feed" id="worker"><div class="empty">idle</div></div></div>
      <div class="col" data-a="master"><h2>Master Carpenter <span class="sub">Claude · supervises</span></h2><div class="feed" id="master"><div class="empty">idle</div></div></div>
      <div class="col" data-a="reviewer"><h2>Reviewer <span class="sub">Codex · audits</span></h2><div class="feed" id="reviewer"><div class="empty">idle</div></div></div>
    </div>
  </div>
</div>
<script>
  const $=id=>document.getElementById(id);
  const msgs=$('msgs'), inp=$('inp');
  let since=0,t0=null,shipped=false,resultShown=false;
  const feeds={worker:$('worker'),master:$('master'),reviewer:$('reviewer')};
  const PHASE={preflight:'Preflighting',starting:'Starting',round:'Round','worker-building':'Worker building','master-inspecting':'Master inspecting','reviewer-auditing':'Reviewer auditing','clean-pass':'CLEAN PASS',escalation:'ESCALATION'};
  function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
  function bubble(cls,text){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d}
  function near(el){return el.scrollTop+el.clientHeight>=el.scrollHeight-40}
  function addEv(ev){const f=feeds[ev.agent];if(!f)return;const e=f.querySelector('.empty');if(e)e.remove();const stick=near(f);const d=document.createElement('div');let cls='ev '+(ev.kind||'reasoning');if(ev.kind==='verdict')cls+=' '+(/pass|clean|satisfied/i.test(ev.text)?'pass':'fail');d.className=cls;d.textContent=ev.text||'';f.appendChild(d);if(stick)f.scrollTop=f.scrollHeight}

  async function send(){
    const text=inp.value.trim(); if(!text) return;
    inp.value=''; bubble('user',text);
    $('send').disabled=true;
    const thinking=bubble('sys','Architect is thinking…');
    try{
      const r=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})});
      const j=await r.json(); thinking.remove();
      if(j.error){bubble('sys','⚠ '+j.error)} else {bubble('arch',j.reply)}
      if(j.specReady){$('specbar').classList.add('show');$('ship').classList.add('ready')}
    }catch(e){thinking.remove();bubble('sys','⚠ '+e.message)}
    $('send').disabled=false; inp.focus();
  }
  async function ship(){
    if(shipped) return;
    $('ship').disabled=true;
    const r=await fetch('/ship',{method:'POST'}); const j=await r.json();
    if(j.error){bubble('sys','⚠ '+j.error);$('ship').disabled=false;return}
    shipped=true; resultShown=false; since=0; t0=null;
    bubble('sys','🚀 Shipped. Watch the build on the right.');
  }
  $('send').onclick=send;
  $('ship').onclick=ship;
  $('viewspec').onclick=async()=>{const r=await fetch('/spec');const j=await r.json();bubble('sys','SPEC.md:\\n\\n'+(j.content||'(empty)'))};
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});

  async function poll(){
    try{
      const r=await fetch('/trace?since='+since); const j=await r.json();
      for(const ev of j.events){addEv(ev);since=Math.max(since,ev.seq||0)}
      const st=j.status||{}, live=j.alive;
      $('dot').className='dot'+(live?' live':'');
      $('branch').textContent=st.branch||''; $('round').textContent=st.round?('round '+st.round+'/'+(st.maxRounds||3)):'';
      $('phase').textContent=live?(PHASE[st.phase]||'working'):(shipped?'done':'talk to the Architect');
      if(j.startedAt){t0=t0||j.startedAt;$('elapsed').textContent=live?Math.floor((Date.now()-t0)/1000)+'s':''} else $('elapsed').textContent='';
      if(shipped && !live && j.result && !resultShown){
        resultShown=true;
        if(j.result.ok){bubble('arch','✓ Done. '+(j.result.summary||'Build complete.')+'\\n\\nMerge when ready:\\n'+(j.result.merge_command||''))}
        else{bubble('arch','! The build couldn\\'t finish cleanly ('+(j.result.reason||'see ESCALATION.md')+'). Tell me how to adjust and we\\'ll refine the spec.')}
        $('ship').disabled=false; shipped=false;
      }
    }catch(e){$('dot').className='dot'}
    setTimeout(poll,500);
  }
  poll(); inp.focus();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function body(req) {
  return new Promise((res) => { let b = ''; req.on('data', (d) => b += d); req.on('end', () => res(b)); });
}

let startedAt = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE);
  }

  if (url.pathname === '/chat' && req.method === 'POST') {
    if (architectBusy) return json({ error: 'the Architect is still answering — one message at a time.' });
    let message = '';
    try { message = JSON.parse(await body(req)).message || ''; } catch {}
    if (!message.trim()) return json({ error: 'empty message' });
    architectBusy = true;
    const before = specMtime();
    try {
      const reply = await runArchitect(message);
      const specReady = specMtime() > before && specMtime() > 0;
      json({ reply, specReady });
    } catch (e) { json({ error: e.message }); }
    finally { architectBusy = false; }
    return;
  }

  if (url.pathname === '/spec') {
    let content = ''; try { content = fs.readFileSync(SPEC, 'utf8'); } catch {}
    return json({ exists: !!content, content });
  }

  if (url.pathname === '/ship' && req.method === 'POST') {
    if (activeRun()) return json({ error: 'a build is already running in this project.' });
    const nested = nestedRepos();
    if (nested.length) return json({ error: `this folder contains other git repos (${nested.slice(0,3).join(', ')}…) — open ship-app inside the actual project.` });
    if (specMtime() === 0) return json({ error: 'no SPEC.md yet — agree on the work with the Architect first.' });
    try { fs.writeFileSync(TRACE, ''); } catch {}
    try { fs.rmSync(RESULT); } catch {}
    const child = spawn(process.execPath, [SHIP_JS], {
      cwd: ROOT, stdio: 'ignore', env: { ...process.env, SHIP_TRACE: 'stream' },
    });
    child.on('close', (code) => console.log(`[ship-app] build finished (exit ${code}).`));
    return json({ ok: true });
  }

  if (url.pathname === '/trace') {
    const since = Number(url.searchParams.get('since') || 0);
    const status = readJson(STATUS) || {};
    const lock = readJson(LOCK);
    const alive = lock ? pidAlive(lock.pid) : false;
    if (alive && !startedAt && status.ts) startedAt = Date.parse(status.ts);
    if (!alive) startedAt = null;
    const result = alive ? null : readJson(RESULT);
    return json({ events: readTrace(since), status, alive, startedAt, result });
  }

  res.writeHead(404); res.end('not found');
});

function openBrowser(u) {
  if (NO_OPEN) return;
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', u] : [u];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* open manually */ }
}

// Listen, auto-stepping the port if it's taken (e.g. a leftover ship-ui/ship-app)
// instead of crashing with an unhandled EADDRINUSE.
function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`[ship-app] port ${port} busy — trying ${port + 1}…`);
      setTimeout(() => listen(port + 1, attemptsLeft - 1), 50);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`[ship-app] no free port near ${PORT}. Close the other app or pass --port N.`);
      process.exit(1);
    } else { console.error('[ship-app]', err.message); process.exit(1); }
  });
  server.listen(port, () => {
    const u = `http://localhost:${port}`;
    console.log(`[ship-app] talk to the Architect at ${u}  (Ctrl+C to stop)`);
    if (activeRun()) console.log('[ship-app] note: a build is already running in this project — its progress will stream in the dashboard.');
    openBrowser(u);
  });
}
listen(PORT, 10);
