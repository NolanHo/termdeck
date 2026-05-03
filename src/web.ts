export const webHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TermDeck</title>
  <link rel="stylesheet" href="/xterm.css" />
  <style>
    body { margin: 0; background: #0b1020; color: #d7dde8; font: 14px sans-serif; }
    header { padding: 10px 14px; border-bottom: 1px solid #1f2a44; display: flex; gap: 12px; align-items: center; }
    select { background: #111827; color: #d7dde8; border: 1px solid #334155; padding: 4px 8px; }
    #terminal { height: calc(100vh - 46px); padding: 8px; box-sizing: border-box; }
    .muted { color: #94a3b8; }
  </style>
</head>
<body>
  <header>
    <strong>TermDeck</strong>
    <label>session <select id="sessions"></select></label>
    <span class="muted" id="status">observe-only</span>
  </header>
  <div id="terminal"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

export const webAppJs = `import { Terminal } from '/xterm.js';
import { FitAddon } from '/xterm-addon-fit.js';

const select = document.querySelector('#sessions');
const status = document.querySelector('#status');
const fit = new FitAddon();
const term = new Terminal({ convertEol: true, cursorBlink: false, disableStdin: true });
term.loadAddon(fit);
term.open(document.querySelector('#terminal'));
fit.fit();

let ws;
let currentSession;
let lastSeq = 0;
let reconnectTimer;

async function refreshSessions() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  select.replaceChildren(...sessions.map((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.id + ' ' + s.status;
    return opt;
  }));
  if (sessions.length > 0) openSession(sessions[0].id);
  else status.textContent = 'no sessions';
}

async function openSession(id) {
  if (ws) ws.close();
  currentSession = id;
  lastSeq = 0;
  term.clear();
  const snap = await fetch('/api/sessions/' + encodeURIComponent(id) + '/screen').then((r) => r.json());
  lastSeq = snap.lastSeq || 0;
  if (snap.screen) term.write(snap.screen.replace(/\n/g, '\r\n'));
  connectEvents(id);
}

function connectEvents(id) {
  clearTimeout(reconnectTimer);
  ws = new WebSocket('/ws?session=' + encodeURIComponent(id) + '&afterSeq=' + lastSeq);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { status.textContent = 'observing ' + id; };
  ws.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.seq) lastSeq = Math.max(lastSeq, event.seq);
    if (event.kind === 'output') term.write(event.data);
    if (event.kind === 'state') status.textContent = id + ' ' + event.status;
    if (event.kind === 'exit') status.textContent = id + ' exited';
  };
  ws.onclose = () => {
    status.textContent = 'disconnected';
    if (currentSession === id) reconnectTimer = setTimeout(() => connectEvents(id), 1000);
  };
}

window.addEventListener('resize', () => fit.fit());
select.addEventListener('change', () => openSession(select.value));
refreshSessions();`;
