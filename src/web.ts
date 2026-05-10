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
    #app { height: 100vh; display: grid; grid-template-columns: 300px 1fr; }
    #sidebar { border-right: 1px solid #1f2a44; background: #080d1a; display: flex; flex-direction: column; min-width: 0; }
    #brand { height: 46px; padding: 13px 14px; border-bottom: 1px solid #1f2a44; font-weight: 700; }
    #filters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 8px; border-bottom: 1px solid #1f2a44; }
    #searchbar { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 8px; border-bottom: 1px solid #1f2a44; }
    #search-input { min-width: 0; border: 1px solid #24324f; border-radius: 6px; background: #0d1424; color: #d7dde8; padding: 7px 8px; }
    .filter { border: 1px solid #24324f; border-radius: 6px; background: #0d1424; color: #cbd5e1; padding: 6px 4px; cursor: pointer; }
    .filter.active { background: #1e293b; border-color: #64748b; }
    .section-title { padding: 10px 12px 4px; color: #94a3b8; font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
    #sessions, #tasks { padding: 8px; overflow-y: auto; min-height: 0; }
    #sessions { flex: 2; }
    #tasks { flex: 1; border-top: 1px solid #1f2a44; }
    .tab { width: 100%; border: 1px solid transparent; border-radius: 6px; padding: 8px; margin-bottom: 6px; background: transparent; color: #d7dde8; text-align: left; cursor: pointer; }
    .tab:hover { background: #111827; }
    .tab.active { background: #172033; border-color: #334155; }
    .tab-id { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tab-meta { display: block; margin-top: 3px; color: #94a3b8; font-size: 12px; }
    .task { border: 1px solid #1f2a44; border-radius: 6px; padding: 8px; margin-bottom: 6px; background: #0d1424; cursor: pointer; }
    .task-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
    .task-meta { display: block; margin-top: 3px; color: #94a3b8; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-actions { display: flex; gap: 6px; margin-top: 7px; }
    .task.ready { border-color: #166534; }
    .task.stale { border-color: #7f1d1d; }
    .task.expired, .task.exited { border-color: #854d0e; }
    .task.orphan { border-style: dashed; }
    #main { min-width: 0; display: grid; grid-template-rows: 46px 96px 1fr 170px; }
    #topbar { border-bottom: 1px solid #1f2a44; display: flex; align-items: center; gap: 14px; padding: 0 14px; min-width: 0; }
    #title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #status { color: #94a3b8; white-space: nowrap; }
    #dashboard { border-bottom: 1px solid #1f2a44; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 10px 14px; min-width: 0; }
    .metric-row { display: flex; gap: 12px; min-width: 0; }
    .metric { color: #94a3b8; white-space: nowrap; }
    .metric strong { color: #e2e8f0; }
    #detail { color: #94a3b8; display: flex; gap: 8px; align-items: center; min-width: 0; }
    #detail-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .action { border: 1px solid #334155; border-radius: 6px; background: #0d1424; color: #cbd5e1; padding: 5px 8px; cursor: pointer; white-space: nowrap; }
    .action:hover { background: #1e293b; }
    #terminal-wrap { min-height: 0; padding: 8px; }
    #terminal { width: 100%; height: 100%; }
    #panel { border-top: 1px solid #1f2a44; min-height: 0; display: grid; grid-template-rows: 34px 1fr; }
    #panel-title { padding: 9px 14px; color: #94a3b8; font-size: 12px; font-weight: 700; }
    #panel-body { overflow: auto; padding: 0 14px 12px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; color: #cbd5e1; }
    .hit { border-top: 1px solid #1f2a44; padding: 7px 0; cursor: pointer; }
    .hit:hover { color: #e2e8f0; }
  </style>
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div id="brand">TermDeck</div>
      <div id="filters">
        <button class="filter active" data-filter="all">All</button>
        <button class="filter" data-filter="active">Active</button>
        <button class="filter" data-filter="needs-attention">Attention</button>
      </div>
      <div id="searchbar"><input id="search-input" type="search" placeholder="Search sessions and tasks" /><button class="action" id="search-button" type="button">Search</button></div>
      <div class="section-title">Sessions</div>
      <div id="sessions"></div>
      <div class="section-title">Tasks</div>
      <div id="tasks"></div>
    </aside>
    <main id="main">
      <div id="topbar"><span id="title">No session</span><span id="status">observe-only</span></div>
      <div id="dashboard">
        <div class="metric-row" id="metrics"></div>
        <div id="detail"><span id="detail-text">No selection</span></div>
      </div>
      <div id="terminal-wrap"><div id="terminal"></div></div>
      <div id="panel"><div id="panel-title">Activity</div><div id="panel-body">No logs or search results</div></div>
    </main>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

export const webAppJs = `import { Terminal } from '/xterm.js';
import { FitAddon } from '/xterm-addon-fit.js';

const sessionsEl = document.querySelector('#sessions');
const tasksEl = document.querySelector('#tasks');
const metricsEl = document.querySelector('#metrics');
const detailEl = document.querySelector('#detail');
const detailTextEl = document.querySelector('#detail-text');
const filtersEl = document.querySelector('#filters');
const status = document.querySelector('#status');
const title = document.querySelector('#title');
const searchInput = document.querySelector('#search-input');
const searchButton = document.querySelector('#search-button');
const panelTitle = document.querySelector('#panel-title');
const panelBody = document.querySelector('#panel-body');
const utf8 = new TextDecoder();
const fit = new FitAddon();
const term = new Terminal({ convertEol: true, cursorBlink: false, disableStdin: true });
term.loadAddon(fit);
term.open(document.querySelector('#terminal'));
fit.fit();

let ws;
let sessions = [];
let tasks = [];
let orphanSessions = [];
let currentSession;
let currentFilter = 'all';
let lastSeq = 0;
let reconnectTimer;
let refreshTimer;
let refreshSoonTimer;
let refreshInFlight = false;
let resizeTimer;

async function refreshSessions() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
  const [sessionsRes, tasksRes] = await Promise.all([fetch('/api/sessions'), fetch('/api/tasks')]);
  sessions = await sessionsRes.json();
  const dashboard = await tasksRes.json();
  tasks = dashboard.tasks || [];
  orphanSessions = dashboard.orphanSessions || [];
  renderTabs();
  renderTasks();
  renderMetrics();
  if (!currentSession && sessions.length > 0) openSession(sessions[0].id);
  if (currentSession && !sessions.some((s) => s.id === currentSession)) closeSession();
  } finally {
    refreshInFlight = false;
  }
}

function renderTabs() {
  const visible = sessions.filter((s) => currentFilter !== 'active' || s.status !== 'eof');
  sessionsEl.replaceChildren(...visible.map((s) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (s.id === currentSession ? ' active' : '');
    btn.type = 'button';
    btn.innerHTML = '<span class="tab-id"></span><span class="tab-meta"></span>';
    btn.querySelector('.tab-id').textContent = s.id;
    btn.querySelector('.tab-meta').textContent = s.status + ' seq=' + s.lastSeq;
    btn.addEventListener('click', () => openSession(s.id));
    return btn;
  }));
  if (visible.length === 0) sessionsEl.textContent = 'No sessions';
}

function renderTasks() {
  const rows = [...tasks.map((t) => ({ ...t, orphan: false })), ...orphanSessions.map((s) => ({
    name: s.id,
    session: s.id,
    ready: false,
    stale: false,
    expired: false,
    processExited: s.status === 'eof',
    readyDetail: 'orphan task session',
    failureReason: 'no task metadata',
    orphan: true,
  }))].filter((t) => {
    if (currentFilter === 'active') return !t.stale && !t.expired && !t.processExited && !t.orphan;
    if (currentFilter === 'needs-attention') return t.stale || t.expired || t.processExited || t.orphan || !t.ready;
    return true;
  });
  tasksEl.replaceChildren(...rows.map((t) => {
    const item = document.createElement('div');
    item.className = 'task' + (t.ready ? ' ready' : '') + (t.stale ? ' stale' : '') + (t.expired ? ' expired' : '') + (t.processExited ? ' exited' : '') + (t.orphan ? ' orphan' : '');
    item.innerHTML = '<span class="task-name"></span><span class="task-meta"></span><div class="task-actions"></div>';
    item.querySelector('.task-name').textContent = t.name;
    item.querySelector('.task-meta').textContent = taskState(t) + ' ' + (t.readyDetail || t.failureReason || '');
    item.addEventListener('click', () => openSession(t.session));
    const actions = item.querySelector('.task-actions');
    actions.append(actionButton('Logs', () => showTaskLogs(t.name)));
    if (!t.orphan) {
      actions.append(actionButton('Recover', () => taskAction(t.name, 'recover')));
      actions.append(actionButton('Stop', () => taskAction(t.name, 'stop')));
    }
    return item;
  }));
  if (rows.length === 0) tasksEl.textContent = 'No tasks';
}

function renderMetrics() {
  const ready = tasks.filter((t) => t.ready).length;
  const attention = tasks.filter((t) => t.stale || t.expired || t.processExited || !t.ready).length + orphanSessions.length;
  metricsEl.innerHTML = '<span class="metric"><strong></strong> sessions</span><span class="metric"><strong></strong> tasks</span><span class="metric"><strong></strong> ready</span><span class="metric"><strong></strong> attention</span>';
  const values = [sessions.length, tasks.length, ready, attention];
  metricsEl.querySelectorAll('strong').forEach((el, i) => { el.textContent = String(values[i]); });
  const task = tasks.find((t) => t.session === currentSession);
  const taskText = task ? task.name + ': ' + taskState(task) + ' ' + (task.failureReason || task.readyDetail || '') : currentSession ? 'Session ' + currentSession : 'No selection';
  detailTextEl.textContent = taskText;
  detailEl.querySelectorAll('button.action').forEach((button) => button.remove());
  if (task) {
    detailEl.append(actionButton('Recover', () => taskAction(task.name, 'recover')));
    detailEl.append(actionButton('Stop', () => taskAction(task.name, 'stop')));
  }
  if (tasks.some((t) => t.stale || t.expired)) detailEl.append(actionButton('Prune', () => pruneTasks()));
}

function actionButton(label, handler) {
  const button = document.createElement('button');
  button.className = 'action';
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void handler();
  });
  return button;
}

async function taskAction(name, action) {
  status.textContent = action + ' ' + name;
  await fetch('/api/tasks/' + encodeURIComponent(name) + '/' + action, { method: 'POST' });
  await refreshSessions();
}

async function pruneTasks() {
  status.textContent = 'pruning tasks';
  await fetch('/api/tasks/prune', { method: 'POST' });
  await refreshSessions();
}

async function showTaskLogs(name) {
  panelTitle.textContent = 'Logs: ' + name;
  panelBody.textContent = 'Loading...';
  const data = await fetch('/api/tasks/' + encodeURIComponent(name) + '/logs?lines=160').then((r) => r.json());
  panelBody.textContent = data.logText || data.output || JSON.stringify(data, null, 2);
}

function taskState(t) {
  if (t.orphan) return 'orphan';
  if (t.stale) return 'stale';
  if (t.expired) return 'expired';
  if (t.processExited) return 'exited';
  if (t.ready) return 'ready';
  return 'starting';
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
  renderMetrics();
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
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = setTimeout(() => {
    void refreshSessions();
  }, 100);
}

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    panelTitle.textContent = 'Activity';
    panelBody.textContent = 'No logs or search results';
    return;
  }
  panelTitle.textContent = 'Search: ' + q;
  panelBody.textContent = 'Searching...';
  const data = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=80&context=1').then((r) => r.json());
  renderSearchResults(data);
}

function renderSearchResults(data) {
  panelBody.replaceChildren(...(data.hits || []).map((hit) => {
    const row = document.createElement('div');
    row.className = 'hit';
    const target = hit.session || hit.task || hit.source;
    const loc = hit.seq !== undefined ? 'seq=' + hit.seq : 'line=' + hit.line;
    row.textContent = hit.kind + ' ' + target + ' ' + loc + '\\n' + hit.text;
    row.addEventListener('click', () => {
      if (hit.session) openSession(hit.session);
    });
    return row;
  }));
  if (!data.hits || data.hits.length === 0) panelBody.textContent = 'No matches';
}

filtersEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  currentFilter = button.dataset.filter;
  filtersEl.querySelectorAll('.filter').forEach((el) => el.classList.toggle('active', el === button));
  renderTabs();
  renderTasks();
});

searchButton.addEventListener('click', () => { void runSearch(); });
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void runSearch();
});

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
