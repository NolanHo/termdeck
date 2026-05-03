import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer, Socket, type Server as NetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import stripAnsi from 'strip-ansi';
import { encodeEvent, FrameReader, writeFrame, type Event, type Request, type Response } from './protocol.js';
import { isWindows, socketAccessMode } from './platform.js';
import { rootDir, sessionDir, sessionsDir, socketPath } from './paths.js';
import { TermSession } from './session.js';
import { webAppJs, webHtml } from './web.js';

const require = createRequire(import.meta.url);
const xtermJsPath = require.resolve('@xterm/xterm');
const xtermCssPath = require.resolve('@xterm/xterm/css/xterm.css');
const xtermFitPath = require.resolve('@xterm/addon-fit');

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

  subscribe(socket: Socket, session: string, afterSeq: number): void {
    const s = this.get(session);
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

function result(id: number, r: { status: import('./protocol.js').Status; output: string; timedOut: boolean; outputTruncated: boolean; droppedChars: number }, strip = false): Response {
  return { id, ok: true, status: r.status, output: strip ? stripAnsi(r.output) : r.output, timedOut: r.timedOut, outputTruncated: r.outputTruncated, droppedChars: r.droppedChars };
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

function tailFile(file: string, lines: number): string {
  const text = readFileSync(file, 'utf8');
  if (!lines || lines <= 0) return text;
  return text.split('\n').slice(-lines).join('\n');
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
  return rows.slice(0, limit || rows.length).join('\n');
}

async function handle(req: Request, socket?: Socket): Promise<Response> {
  try {
    switch (req.op) {
      case 'new': {
        const s = manager.create(req);
        const state = s.status();
        return { id: req.id, ok: true, status: state.status, prompt: state.prompt, screen: s.screen(), lastSeq: s.info().lastSeq };
      }
      case 'run': {
        const r = await manager.get(req.session).run(req.command, req.timeoutMs, req.quiescenceMs);
        return result(req.id, r, req.stripAnsi);
      }
      case 'send': {
        const r = await manager.get(req.session).send(req.data, req.timeoutMs, req.quiescenceMs);
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
        return { id: req.id, ok: true, status: s.status().status, prompt: s.status().prompt, screen: s.screen() };
      }
      case 'scrollback': {
        const s = manager.get(req.session);
        return { id: req.id, ok: true, status: s.status().status, prompt: s.status().prompt, screen: s.scrollback(req.lines) };
      }
      case 'list':
        return { id: req.id, ok: true, sessions: manager.list() };
      case 'kill':
        manager.kill(req.session);
        return { id: req.id, ok: true, status: 'eof' };
      case 'configure': {
        const s = manager.get(req.session);
        s.configure(req.promptRegex);
        return { id: req.id, ok: true, status: s.status().status };
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
        return { id: req.id, ok: true, transcript: s.transcriptFile(), status: s.status().status };
      }
      case 'resize': {
        const s = manager.get(req.session);
        s.resize(req.rows, req.cols);
        return { id: req.id, ok: true, status: s.status().status };
      }
      case 'metadata': {
        const s = manager.get(req.session);
        return { id: req.id, ok: true, status: s.status().status, prompt: s.status().prompt, metadata: s.metadata() };
      }
      case 'clearScrollback': {
        const s = manager.get(req.session);
        s.clearScrollback();
        return { id: req.id, ok: true, status: s.status().status, prompt: s.status().prompt };
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
        return { id: req.id, ok: true, logText: tailFile(join(sessionDir(req.session), 'transcript.log'), req.lines ?? 200) };
      case 'events':
        return { id: req.id, ok: true, eventsText: eventLines(req.session, req.afterSeq ?? 0, req.limit ?? 200) };
      case 'subscribe': {
        if (!socket) return { id: req.id, ok: false, error: 'subscribe requires socket' };
        manager.subscribe(socket, req.session, req.afterSeq ?? 0);
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
  if (!isWindows) mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket();

  const webServer = startWebServer();
  const server = createDaemonServer();

  server.listen(socketPath, () => {
    if (!isWindows) chmodSync(socketPath, socketAccessMode());
    console.log(`termdeckd listening on ${socketPath}`);
  });

  const shutdown = () => {
    manager.terminateAll();
    server.close();
    webServer.close();
    if (!isWindows) {
      try {
        rmSync(socketPath);
      } catch {}
    }
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
  if (isWindows || !existsSync(socketPath)) return;
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
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', webHtml);
      if (url.pathname === '/app.js') return send(res, 200, 'text/javascript; charset=utf-8', webAppJs);
      if (url.pathname === '/xterm.js') return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(xtermJsPath));
      if (url.pathname === '/xterm.css') return send(res, 200, 'text/css; charset=utf-8', readFileSync(xtermCssPath));
      if (url.pathname === '/xterm-addon-fit.js') return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(xtermFitPath));
      if (url.pathname === '/api/sessions') return send(res, 200, 'application/json', JSON.stringify(manager.list()));
      const screenMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/screen$/);
      if (screenMatch) {
        const s = manager.get(decodeURIComponent(screenMatch[1]));
        return send(res, 200, 'application/json', JSON.stringify({ screen: s.screen(), status: s.status().status, lastSeq: s.info().lastSeq }));
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err));
    }
  });

  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket));
  server.listen(port, '127.0.0.1', () => console.log(`termdeck web listening on http://127.0.0.1:${port}`));
  return server;
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
  const onEvent = (event: Event) => {
    if (event.session === session) socket.write(wsBinary(encodeEvent(event)));
  };
  for (const event of s.eventsAfter(afterSeq)) socket.write(wsBinary(encodeEvent(event)));
  s.on('event', onEvent);
  socket.on('close', () => s.off('event', onEvent));
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
