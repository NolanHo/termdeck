import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FrameReader, writeFrame, type Event, type Request, type Response } from './protocol.js';
import { rootDir, socketPath } from './paths.js';
import { TermSession } from './session.js';
import { webAppJs, webHtml } from './web.js';

const require = createRequire(import.meta.url);
const xtermJsPath = require.resolve('@xterm/xterm');
const xtermCssPath = require.resolve('@xterm/xterm/css/xterm.css');

class SessionManager {
  private readonly sessions = new Map<string, TermSession>();
  private readonly subscribers = new Set<Socket>();

  terminateAll(): void {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
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

  listSessions(): TermSession[] {
    return [...this.sessions.values()];
  }

  kill(id: string): void {
    const s = this.get(id);
    s.kill();
    this.sessions.delete(id);
  }

  subscribe(socket: Socket, session: string, afterSeq: number): void {
    const s = this.get(session);
    this.subscribers.add(socket);
    socket.on('close', () => this.subscribers.delete(socket));
    for (const event of s.eventsAfter(afterSeq)) writeFrame(socket, { type: 'event', payload: event });
  }

  private fanout(event: Event): void {
    for (const socket of this.subscribers) {
      if (socket.destroyed || !socket.writable) {
        this.subscribers.delete(socket);
        continue;
      }
      const ok = socket.write(Buffer.from([]));
      if (!ok) {
        this.subscribers.delete(socket);
        socket.destroy();
        continue;
      }
      writeFrame(socket, { type: 'event', payload: event });
    }
  }
}

const manager = new SessionManager();

function assertNever(x: never): never {
  throw new Error(`unknown request: ${JSON.stringify(x)}`);
}

async function handle(req: Request, socket?: Socket): Promise<Response> {
  try {
    switch (req.op) {
      case 'new': {
        const s = manager.create(req);
        const state = s.status();
        return { id: req.id, ok: true, status: state.status, screen: s.screen(), lastSeq: s.info().lastSeq };
      }
      case 'run': {
        const r = await manager.get(req.session).run(req.command, req.timeoutMs, req.quiescenceMs);
        return { id: req.id, ok: true, status: r.status, output: r.output, timedOut: r.timedOut };
      }
      case 'send': {
        const r = await manager.get(req.session).send(req.data, req.timeoutMs, req.quiescenceMs);
        return { id: req.id, ok: true, status: r.status, output: r.output, timedOut: r.timedOut };
      }
      case 'ctrl': {
        const r = await manager.get(req.session).ctrl(req.key, req.timeoutMs, req.quiescenceMs);
        return { id: req.id, ok: true, status: r.status, output: r.output, timedOut: r.timedOut };
      }
      case 'poll': {
        const r = await manager.get(req.session).poll(req.timeoutMs, req.quiescenceMs);
        return { id: req.id, ok: true, status: r.status, output: r.output, timedOut: r.timedOut };
      }
      case 'screen': {
        const s = manager.get(req.session);
        return { id: req.id, ok: true, status: s.status().status, screen: s.screen() };
      }
      case 'scrollback': {
        const s = manager.get(req.session);
        return { id: req.id, ok: true, status: s.status().status, screen: s.scrollback(req.lines) };
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
        return { id: req.id, ok: true, status: r.status, output: r.output, timedOut: r.timedOut, matched: r.matched };
      }
      case 'password': {
        const r = await manager.get(req.session).password(req.secret, req.timeoutMs, req.quiescenceMs);
        return { id: req.id, ok: true, status: r.status, output: '[password sent]', timedOut: r.timedOut };
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
      default: {
        if (req.op === 'subscribe') {
          if (!socket) return { id: req.id, ok: false, error: 'subscribe requires socket' };
          manager.subscribe(socket, req.session, req.afterSeq ?? 0);
          return { id: req.id, ok: true, status: 'ready' };
        }
        return assertNever(req);
      }
    }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function main(): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  removeStaleSocket();

  startWebServer();

  const server = createServer((socket: Socket) => {
    const reader = new FrameReader(socket);
    reader.on('frame', async (frame) => {
      if (frame.type !== 'request') return;
      const response = await handle(frame.payload, socket);
      writeFrame(socket, { type: 'response', payload: response });
    });
  });

  server.listen(socketPath, () => {
    console.log(`termdeckd listening on ${socketPath}`);
  });

  const shutdown = () => {
    manager.terminateAll();
    server.close();
    try {
      rmSync(socketPath);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function removeStaleSocket(): void {
  if (!existsSync(socketPath)) return;
  const probe = new Socket();
  probe.once('connect', () => {
    console.error(`termdeckd already running at ${socketPath}`);
    process.exit(1);
  });
  probe.once('error', () => {
    try {
      rmSync(socketPath);
    } catch {}
  });
  probe.connect(socketPath);
}

function startWebServer(): void {
  const port = Number(process.env.TERMDECK_WEB_PORT ?? 8765);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', webHtml);
    if (url.pathname === '/app.js') return send(res, 200, 'text/javascript; charset=utf-8', webAppJs);
    if (url.pathname === '/xterm.js') return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(xtermJsPath));
    if (url.pathname === '/xterm.css') return send(res, 200, 'text/css; charset=utf-8', readFileSync(xtermCssPath));
    if (url.pathname === '/api/sessions') return send(res, 200, 'application/json', JSON.stringify(manager.list()));
    const screenMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/screen$/);
    if (screenMatch) {
      const s = manager.get(decodeURIComponent(screenMatch[1]));
      return send(res, 200, 'application/json', JSON.stringify({ screen: s.screen(), status: s.status().status, lastSeq: s.info().lastSeq }));
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  });

  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket));
  server.listen(port, '127.0.0.1', () => console.log(`termdeck web listening on http://127.0.0.1:${port}`));
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
  const s = manager.get(session);
  const onEvent = (event: Event) => {
    if (event.session === session) socket.write(wsText(JSON.stringify(event)));
  };
  s.on('event', onEvent);
  socket.on('close', () => s.off('event', onEvent));
}

function wsText(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.allocUnsafe(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

main();
