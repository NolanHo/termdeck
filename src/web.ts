export const webHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TermDeck</title>
  <link rel="stylesheet" href="/xterm.css" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b1020; color: #d7dde8; font: 14px sans-serif; overflow: hidden; }
    #app { height: 100vh; display: grid; grid-template-columns: 260px 1fr; }
    #sidebar { border-right: 1px solid #1f2a44; background: #080d1a; display: flex; flex-direction: column; min-width: 0; }
    #brand { height: 46px; padding: 13px 14px; border-bottom: 1px solid #1f2a44; font-weight: 700; }
    .section-title { padding: 10px 12px 4px; color: #94a3b8; font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
    #sessions, #tasks { padding: 8px; overflow-y: auto; min-height: 0; }
    #sessions { flex: 2; }
    #tasks { flex: 1; border-top: 1px solid #1f2a44; }
    .tab { width: 100%; border: 1px solid transparent; border-radius: 6px; padding: 8px; margin-bottom: 6px; background: transparent; color: #d7dde8; text-align: left; cursor: pointer; }
    .tab:hover { background: #111827; }
    .tab.active { background: #172033; border-color: #334155; }
    .tab-id { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tab-meta { display: block; margin-top: 3px; color: #94a3b8; font-size: 12px; }
    .task { border: 1px solid #1f2a44; border-radius: 6px; padding: 8px; margin-bottom: 6px; background: #0d1424; }
    .task-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
    .task-meta { display: block; margin-top: 3px; color: #94a3b8; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task.ready { border-color: #166534; }
    .task.stale { border-color: #7f1d1d; }
    #main { min-width: 0; display: grid; grid-template-rows: 46px 1fr; }
    #topbar { border-bottom: 1px solid #1f2a44; display: flex; align-items: center; gap: 14px; padding: 0 14px; min-width: 0; }
    #title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #status { color: #94a3b8; white-space: nowrap; }
    #terminal-wrap { min-height: 0; padding: 8px; }
    #terminal { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div id="brand">TermDeck</div>
      <div class="section-title">Sessions</div>
      <div id="sessions"></div>
      <div class="section-title">Tasks</div>
      <div id="tasks"></div>
    </aside>
    <main id="main">
      <div id="topbar"><span id="title">No session</span><span id="status">observe-only</span></div>
      <div id="terminal-wrap"><div id="terminal"></div></div>
    </main>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

export const webAppJs = `import { Terminal } from '/xterm.js';
import { FitAddon } from '/xterm-addon-fit.js';

const sessionsEl = document.querySelector('#sessions');
const tasksEl = document.querySelector('#tasks');
const status = document.querySelector('#status');
const title = document.querySelector('#title');
const utf8 = new TextDecoder();
const fit = new FitAddon();
const term = new Terminal({ convertEol: true, cursorBlink: false, disableStdin: true });
term.loadAddon(fit);
term.open(document.querySelector('#terminal'));
fit.fit();

let ws;
let sessions = [];
let tasks = [];
let currentSession;
let lastSeq = 0;
let reconnectTimer;
let refreshTimer;
let resizeTimer;

async function refreshSessions() {
  const [sessionsRes, tasksRes] = await Promise.all([fetch('/api/sessions'), fetch('/api/tasks')]);
  sessions = await sessionsRes.json();
  tasks = await tasksRes.json();
  renderTabs();
  renderTasks();
  if (!currentSession && sessions.length > 0) openSession(sessions[0].id);
  if (currentSession && !sessions.some((s) => s.id === currentSession)) closeSession();
}

function renderTabs() {
  sessionsEl.replaceChildren(...sessions.map((s) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (s.id === currentSession ? ' active' : '');
    btn.type = 'button';
    btn.innerHTML = '<span class="tab-id"></span><span class="tab-meta"></span>';
    btn.querySelector('.tab-id').textContent = s.id;
    btn.querySelector('.tab-meta').textContent = s.status + ' seq=' + s.lastSeq;
    btn.addEventListener('click', () => openSession(s.id));
    return btn;
  }));
  if (sessions.length === 0) sessionsEl.textContent = 'No sessions';
}

function renderTasks() {
  tasksEl.replaceChildren(...tasks.map((t) => {
    const item = document.createElement('button');
    item.className = 'task' + (t.ready ? ' ready' : '') + (t.stale ? ' stale' : '');
    item.type = 'button';
    item.innerHTML = '<span class="task-name"></span><span class="task-meta"></span>';
    item.querySelector('.task-name').textContent = t.name;
    item.querySelector('.task-meta').textContent = (t.ready ? 'ready' : t.stale ? 'stale' : 'starting') + ' ' + (t.readyDetail || t.failureReason || '');
    item.addEventListener('click', () => openSession(t.session));
    return item;
  }));
  if (tasks.length === 0) tasksEl.textContent = 'No tasks';
}

async function openSession(id) {
  if (ws) ws.close();
  currentSession = id;
  lastSeq = 0;
  title.textContent = id;
  term.reset();
  renderTabs();
  const snap = await fetch('/api/sessions/' + encodeURIComponent(id) + '/snapshot').then((r) => r.json());
  lastSeq = snap.lastSeq || 0;
  if (snap.snapshot) term.write(snap.snapshot);
  status.textContent = snap.status ? id + ' ' + snap.status + ' seq=' + lastSeq : 'observing ' + id;
  connectEvents(id);
  setTimeout(() => {
    fit.fit();
    sendResize();
  }, 0);
}

function closeSession() {
  if (ws) ws.close();
  currentSession = undefined;
  lastSeq = 0;
  title.textContent = 'No session';
  status.textContent = 'no sessions';
  term.reset();
}

function connectEvents(id, replayTargetSeq = 0) {
  clearTimeout(reconnectTimer);
  fit.fit();
  ws = new WebSocket('/ws?session=' + encodeURIComponent(id) + '&afterSeq=' + lastSeq);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { status.textContent = 'observing ' + id + ' seq=' + lastSeq; };
  ws.onmessage = handleEventMessage;
  ws.onclose = () => {
    if (currentSession !== id) return;
    status.textContent = 'disconnected seq=' + lastSeq;
    reconnectTimer = setTimeout(() => connectEvents(id), 1000);
  };
}

function handleEventMessage(msg) {
  const event = decodeEvent(new Uint8Array(msg.data));
    if (event.seq) lastSeq = Math.max(lastSeq, event.seq);
    if (event.kind === 'output') term.write(event.data);
    if (event.kind === 'state') status.textContent = currentSession + ' ' + event.status + ' seq=' + lastSeq;
    if (event.kind === 'exit') status.textContent = currentSession + ' exited seq=' + lastSeq;
    refreshSessionsSoon();
}

function refreshSessionsSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void refreshSessions();
    refreshTimer = setInterval(refreshSessions, 1000);
  }, 100);
}

function sendResize() {
  if (!currentSession || !ws || ws.readyState !== WebSocket.OPEN || term.rows <= 0 || term.cols <= 0) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    ws.send(JSON.stringify({ op: 'resize', rows: term.rows, cols: term.cols }));
  }, 100);
}

function decodeEvent(buf) {
  const r = reader(buf);
  const event = {};
  while (!r.eof()) {
    const tag = Number(r.varint());
    const field = tag >> 3;
    if (field === 1) event.session = utf8.decode(r.bytes());
    else if (field === 2) event.seq = Number(r.varint());
    else if (field === 3) event.tsMs = Number(r.varint());
    else if (field === 10) { event.kind = 'output'; event.data = utf8.decode(r.bytes()); }
    else if (field === 11) { event.kind = 'input'; event.data = utf8.decode(r.bytes()); }
    else if (field === 13) Object.assign(event, decodeState(r.bytes()));
    else if (field === 14) { event.kind = 'exit'; r.bytes(); }
    else skip(r, tag & 7);
  }
  return event;
}

function decodeState(buf) {
  const r = reader(buf);
  const out = { kind: 'state' };
  while (!r.eof()) {
    const tag = Number(r.varint());
    const field = tag >> 3;
    if (field === 1) out.status = utf8.decode(r.bytes());
    else if (field === 2) out.reason = utf8.decode(r.bytes());
    else skip(r, tag & 7);
  }
  return out;
}

function reader(buf) {
  let i = 0;
  const r = {
    eof: () => i >= buf.length,
    varint: () => {
      let x = 0n, shift = 0n;
      while (true) {
        const b = buf[i++];
        x |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return x;
        shift += 7n;
      }
    },
    bytes: () => {
      const n = Number(r.varint());
      const out = buf.slice(i, i + n);
      i += n;
      return out;
    },
  };
  return r;
}

function skip(r, wire) {
  if (wire === 0) r.varint();
  else if (wire === 2) r.bytes();
  else throw new Error('unsupported protobuf wire type ' + wire);
}

window.addEventListener('resize', () => {
  fit.fit();
  sendResize();
});
refreshSessions();
refreshTimer = setInterval(refreshSessions, 1000);
window.addEventListener('beforeunload', () => clearInterval(refreshTimer));`;
