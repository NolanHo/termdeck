import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { FrameReader, writeFrame, type Request, type Response } from './protocol.js';
import { rootDir, socketPath } from './paths.js';
import { TermSession } from './session.js';

class SessionManager {
  private readonly sessions = new Map<string, TermSession>();

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
    s.on('event', (event) => {
      // Web fanout will subscribe here. For MVP the event log lives in transcript/ring only.
      void event;
    });
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
}

const manager = new SessionManager();

function assertNever(x: never): never {
  throw new Error(`unknown request: ${JSON.stringify(x)}`);
}

async function handle(req: Request): Promise<Response> {
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
      default:
        return assertNever(req);
    }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function main(): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    rmSync(socketPath);
  } catch {}

  const server = createServer((socket: Socket) => {
    const reader = new FrameReader(socket);
    reader.on('frame', async (frame) => {
      if (frame.type !== 'request') return;
      const response = await handle(frame.payload);
      writeFrame(socket, { type: 'response', payload: response });
    });
  });

  server.listen(socketPath, () => {
    console.log(`termdeckd listening on ${socketPath}`);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main();
