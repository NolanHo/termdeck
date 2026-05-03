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
const utf8 = new TextDecoder();
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
    const event = decodeEvent(new Uint8Array(msg.data));
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

window.addEventListener('resize', () => fit.fit());
select.addEventListener('change', () => openSession(select.value));
refreshSessions();`;
