import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer, Socket, type Server as NetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { encodeEvent, FrameReader, writeFrame, type Event, type Request, type Response } from './protocol.js';
import { socketAccessMode } from './platform.js';
import { redactJsonl, redactText } from './redact.js';
import { rootDir, sessionDir, sessionsDir, socketPath } from './paths.js';
import { replayTranscript } from './replay.js';
import { TermSession } from './session.js';
import { isSensitiveSession } from './sensitive.js';
import { taskDashboard, taskPrune, taskRecover, taskStop } from './tasks.js';
import { webAppJs, webHtml } from './web.js';

const require = createRequire(import.meta.url);
const xtermJsPath = require.resolve('@xterm/xterm/lib/xterm.mjs');
const xtermCssPath = require.resolve('@xterm/xterm/css/xterm.css');
const xtermFitPath = require.resolve('@xterm/addon-fit/lib/addon-fit.mjs');

type Subscriber = { socket: Socket; session: string };

class SessionManager {
  private readonly sessions = new Map<string, TermSession>();
  private readonly subscribers = new Set<Subscriber>();

  terminateAll(): void {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
    for (const sub of this.subscribers) sub.socket.destroy();
    this.subscribers.clear();
  }

  get(id: string): TermSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session: ${id}`);
    return s;
  }

  create(req: Extract<Request, { op: 'new' }>): TermSession {
    if (this.sessions.has(req.session)) return this.get(req.session);
    const s = new TermSession({
      id: req.session,
      cwd: resolve(req.cwd),
      shell: req.shell,
      rows: req.rows,
      cols: req.cols,
      promptRegex: req.promptRegex,
    });
    this.sessions.set(req.session, s);
    s.on('event', (event) => this.fanout(event as Event));
    return s;
  }

  list(): Response['sessions'] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  kill(id: string): void {
    const s = this.get(id);
    s.kill();
    this.sessions.delete(id);
  }

  subscribe(socket: Socket, session: string, afterSeq: number, rows?: number, cols?: number): void {
    const s = this.get(session);
    if (rows && cols && rows > 0 && cols > 0 && (s.rows !== rows || s.cols !== cols)) s.resize(rows, cols);
    const sub = { socket, session };
    this.subscribers.add(sub);
    socket.on('close', () => this.subscribers.delete(sub));
    for (const event of s.eventsAfter(afterSeq)) {
      if (!writeFrame(socket, { type: 'event', payload: event })) {
        this.subscribers.delete(sub);
        socket.destroy();
        return;
      }
    }
  }

  private fanout(event: Event): void {
    for (const sub of this.subscribers) {
      if (sub.session !== event.session) continue;
      if (sub.socket.destroyed || !sub.socket.writable || !writeFrame(sub.socket, { type: 'event', payload: event })) {
        this.subscribers.delete(sub);
        sub.socket.destroy();
      }
    }
  }
}

const manager = new SessionManager();

function assertNever(x: never): never {
  throw new Error(`unknown request: ${JSON.stringify(x)}`);
}

function statusResponse(id: number, s: TermSession, extra: Partial<Response> = {}): Response {
  const state = s.status();
  return { id, ok: true, status: state.status, prompt: state.prompt, reason: state.reason, lastSeq: s.lastSeq(), ...extra };
}

function result(id: number, r: { status: import('./protocol.js').Status; prompt?: import('./protocol.js').PromptKind; reason?: string; lastSeq?: number; output: string; timedOut: boolean; outputTruncated: boolean; droppedChars: number; exitCode?: number }, strip = false): Response {
  return { id, ok: true, status: r.status, prompt: r.prompt, reason: r.reason, lastSeq: r.lastSeq, output: strip ? stripAnsi(r.output) : r.output, timedOut: r.timedOut, outputTruncated: r.outputTruncated, droppedChars: r.droppedChars, exitCode: r.exitCode };
}

function history(): Array<Record<string, unknown>> {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      try {
        return [JSON.parse(readFileSync(join(sessionsDir, d.name, 'session.json'), 'utf8')) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function inspectSession(id: string): Record<string, unknown> {
  const file = join(sessionDir(id), 'session.json');
  if (!existsSync(file)) throw new Error(`unknown session history: ${id}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function tailFile(file: string, lines: number, redact = false): string {
  const text = readFileSync(file, 'utf8');
  const out = !lines || lines <= 0 ? text : text.split('\n').slice(-lines).join('\n');
  return redact ? redactText(out) : out;
}

function eventLines(id: string, afterSeq: number, limit: number): string {
  const file = join(sessionDir(id), 'events.jsonl');
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((row) => {
    try {
      return Number((JSON.parse(row) as { seq?: number }).seq ?? 0) > afterSeq;
    } catch {
      return false;
    }
  });
  const out = rows.slice(0, limit || rows.length).join('\n');
  return isSensitiveSession(id) ? redactJsonl(out) : out;
}

async function handle(req: Request, socket?: Socket): Promise<Response> {
  try {
    switch (req.op) {
      case 'new': {
        const s = manager.create(req);
        return statusResponse(req.id, s);
      }
      case 'run': {
        const r = await manager.get(req.session).run(req.command, req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'send': {
        const r = await manager.get(req.session).send(req.data, req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'script': {
        const r = await manager.get(req.session).script(req.data, req.timeoutMs, req.quiescenceMs, req.shell);
        return result(req.id, r, req.stripAnsi);
      }
      case 'paste': {
        const r = await manager.get(req.session).paste(req.data, req.enter, req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'ctrl': {
        const r = await manager.get(req.session).ctrl(req.key, req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'poll': {
        const r = await manager.get(req.session).poll(req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'screen': {
        const s = manager.get(req.session);
        return statusResponse(req.id, s, { screen: s.screen() });
      }
      case 'scrollback': {
        const s = manager.get(req.session);
        return statusResponse(req.id, s, { screen: s.scrollback(req.lines) });
      }
      case 'list':
        return { id: req.id, ok: true, sessions: manager.list() };
      case 'kill':
        manager.kill(req.session);
        return { id: req.id, ok: true, status: 'eof' };
      case 'configure': {
        const s = manager.get(req.session);
        s.configure(req.promptRegex);
        return statusResponse(req.id, s);
      }
      case 'expect': {
        const r = await manager.get(req.session).expect(req.pattern, req.timeoutMs);
        return { ...result(req.id, r, req.stripAnsi), matched: r.matched };
      }
      case 'password': {
        const r = await manager.get(req.session).password(req.secret, req.timeoutMs, req.quiescenceMs);
        return { ...result(req.id, r), output: '[password sent]' };
      }
      case 'transcript': {
        const s = manager.get(req.session);
        return statusResponse(req.id, s, { transcript: s.transcriptFile() });
      }
      case 'resize': {
        const s = manager.get(req.session);
        s.resize(req.rows, req.cols);
        return statusResponse(req.id, s);
      }
      case 'metadata': {
        const s = manager.get(req.session);
        return statusResponse(req.id, s, { metadata: s.metadata() });
      }
      case 'clearScrollback': {
        const s = manager.get(req.session);
        s.clearScrollback();
        return statusResponse(req.id, s);
      }
      case 'expectPrompt': {
        const r = await manager.get(req.session).expectPrompt(req.timeoutMs);
        return { ...result(req.id, r, req.stripAnsi), matched: r.matched };
      }
      case 'signal': {
        const r = await manager.get(req.session).signal(req.signal, req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'history':
        return { id: req.id, ok: true, history: history() };
      case 'inspect':
        return { id: req.id, ok: true, metadata: manager.list()?.some((s) => s.id === req.session) ? manager.get(req.session).metadata() : inspectSession(req.session) };
      case 'log':
        return { id: req.id, ok: true, logText: tailFile(join(sessionDir(req.session), 'transcript.log'), req.lines ?? 200, isSensitiveSession(req.session)) };
      case 'events':
        return { id: req.id, ok: true, eventsText: eventLines(req.session, req.afterSeq ?? 0, req.limit ?? 200) };
      case 'replay': {
        const meta = manager.list()?.some((s) => s.id === req.session) ? manager.get(req.session).metadata() : inspectSession(req.session);
        const replay = await replayTranscript(String(meta.transcript), Number(meta.rows ?? 30), Number(meta.cols ?? 120), req.lines ?? 500);
        return { id: req.id, ok: true, screen: replay.scrollback || replay.screen, metadata: { rows: replay.rows, cols: replay.cols } };
      }
      case 'subscribe': {
        if (!socket) return { id: req.id, ok: false, error: 'subscribe requires socket' };
        manager.subscribe(socket, req.session, req.afterSeq ?? 0, req.rows, req.cols);
        return { id: req.id, ok: true, status: 'ready' };
      }
      default:
        return assertNever(req);
    }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function main(): Promise<void> {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket();

  const webServer = startWebServer();
  const server = createDaemonServer();

  server.listen(socketPath, () => {
    chmodSync(socketPath, socketAccessMode());
    console.log(`termdeckd listening on ${socketPath}`);
  });

  const shutdown = () => {
    manager.terminateAll();
    server.close();
    webServer.close();
    try {
      rmSync(socketPath);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function createDaemonServer(): NetServer {
  return createServer((socket: Socket) => {
    const reader = new FrameReader(socket);
    reader.on('frame', (frame) => {
      if (frame.type !== 'request') return;
      void handle(frame.payload, socket).then((response) => {
        writeFrame(socket, { type: 'response', payload: response });
      });
    });
  });
}

async function removeStaleSocket(): Promise<void> {
  if (!existsSync(socketPath)) return;
  await new Promise<void>((resolve) => {
    const probe = new Socket();
    probe.once('connect', () => {
      console.error(`termdeckd already running at ${socketPath}`);
      process.exit(1);
    });
    probe.once('error', () => {
      try {
        rmSync(socketPath);
      } catch {}
      resolve();
    });
    probe.connect(socketPath);
  });
}

function startWebServer(): HttpServer {
  const port = Number(process.env.TERMDECK_WEB_PORT ?? 8765);
  const server = createHttpServer((req, res) => handleWebRequest(req, res));
  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket));
  server.on('error', (err) => console.error(`termdeck web error: ${err instanceof Error ? err.message : String(err)}`));
  server.listen(port, '127.0.0.1', () => console.log(`termdeck web listening on http://127.0.0.1:${port}`));
  return server;
}

function handleWebRequest(req: IncomingMessage, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string | Buffer): void }): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', webHtml);
    if (url.pathname === '/app.js') return send(res, 200, 'text/javascript; charset=utf-8', webAppJs);
    if (url.pathname === '/xterm.js') return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(xtermJsPath));
    if (url.pathname === '/xterm.css') return send(res, 200, 'text/css; charset=utf-8', readFileSync(xtermCssPath));
    if (url.pathname === '/xterm-addon-fit.js') return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(xtermFitPath));
    if (url.pathname === '/api/sessions') return send(res, 200, 'application/json', JSON.stringify(manager.list()));
    if (url.pathname === '/api/tasks') {
      void taskDashboard({ timeoutMs: 1 }).then((dashboard) => send(res, 200, 'application/json', JSON.stringify(dashboard))).catch((err: unknown) => send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err)));
      return;
    }
    if (req.method === 'POST') {
      const taskActionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(stop|recover)$/);
      if (taskActionMatch) {
        const name = decodeURIComponent(taskActionMatch[1]);
        const action = taskActionMatch[2];
        const run = action === 'stop' ? taskStop(name, true) : taskRecover(name, { autostart: true });
        void run.then((body) => send(res, 200, 'application/json', JSON.stringify(body))).catch((err: unknown) => send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err)));
        return;
      }
      if (url.pathname === '/api/tasks/prune') {
        void taskPrune({ stale: true, expired: true, autostart: true }).then((body) => send(res, 200, 'application/json', JSON.stringify(body))).catch((err: unknown) => send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err)));
        return;
      }
    }
    const screenMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/screen$/);
    if (screenMatch) {
      const s = manager.get(decodeURIComponent(screenMatch[1]));
      return send(res, 200, 'application/json', JSON.stringify({ screen: s.screen(), status: s.status().status, lastSeq: s.info().lastSeq }));
    }
    const snapshotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
    if (snapshotMatch) {
      const s = manager.get(decodeURIComponent(snapshotMatch[1]));
      return send(res, 200, 'application/json', JSON.stringify({ status: s.status().status, lastSeq: s.info().lastSeq, rows: s.rows, cols: s.cols, sensitive: s.isSensitive(), snapshot: s.snapshot() }));
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  } catch (err) {
    send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err));
  }
}

function send(res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string | Buffer): void }, code: number, contentType: string, body: string | Buffer): void {
  res.writeHead(code, { 'content-type': contentType });
  res.end(body);
}

function handleWebSocketUpgrade(req: IncomingMessage, socket: Duplex): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const session = url.searchParams.get('session');
  if (!session) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
  const s = manager.get(session);
  socket.on('data', (chunk: Buffer) => {
    try {
      handleWebSocketData(chunk, s);
    } catch (err) {
      console.error(`termdeck websocket input error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const onEvent = (event: Event) => {
    if (event.session !== session) return;
    const out = s.isSensitive() && (event.kind === 'output' || event.kind === 'input') ? { ...event, data: redactText(event.data) } as Event : event;
    socket.write(wsBinary(encodeEvent(out)));
  };
  for (const event of s.eventsAfter(afterSeq)) {
    const out = s.isSensitive() && (event.kind === 'output' || event.kind === 'input') ? { ...event, data: redactText(event.data) } as Event : event;
    socket.write(wsBinary(encodeEvent(out)));
  }
  s.on('event', onEvent);
  socket.on('close', () => s.off('event', onEvent));
}

function handleWebSocketData(chunk: Buffer, s: TermSession): void {
  let offset = 0;
  while (offset < chunk.length) {
    const frame = readWebSocketFrame(chunk, offset);
    if (!frame) return;
    offset = frame.next;
    if (frame.opcode !== 1) continue;
    const msg = JSON.parse(frame.payload.toString('utf8')) as { op?: string; rows?: number; cols?: number };
    if (msg.op !== 'resize' || !msg.rows || !msg.cols) continue;
    s.resize(msg.rows, msg.cols);
  }
}

function readWebSocketFrame(buf: Buffer, offset: number): { opcode: number; payload: Buffer; next: number } | undefined {
  if (buf.length - offset < 2) return undefined;
  const opcode = buf[offset] & 0x0f;
  const masked = (buf[offset + 1] & 0x80) !== 0;
  let len = buf[offset + 1] & 0x7f;
  let pos = offset + 2;
  if (len === 126) {
    if (buf.length - pos < 2) return undefined;
    len = buf.readUInt16BE(pos);
    pos += 2;
  } else if (len === 127) {
    if (buf.length - pos < 8) return undefined;
    const bigLen = buf.readBigUInt64BE(pos);
    if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large');
    len = Number(bigLen);
    pos += 8;
  }
  const mask = masked ? buf.subarray(pos, pos + 4) : undefined;
  if (masked) pos += 4;
  if (buf.length - pos < len) return undefined;
  const payload = Buffer.from(buf.subarray(pos, pos + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, next: pos + len };
}

function wsBinary(payload: Buffer): Buffer {
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x82, payload.length]), payload]);
  const header = Buffer.allocUnsafe(4);
  header[0] = 0x82;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

void main();
