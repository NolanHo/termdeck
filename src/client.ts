import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateSockets, daemonLogPath, setActiveTermDeckRoot, socketPath } from './paths.js';
import { FrameReader, writeFrame, type Request, type RequestInput, type Response } from './protocol.js';

let nextId = 1;

export function request(req: RequestInput): Promise<Response> {
  const id = nextId++;
  const full = { ...req, id } as Request;
  const candidates = candidateSockets();
  let index = 0;
  return new Promise((resolveRequest, reject) => {
    const errors: string[] = [];
    const tryNext = () => {
      const candidate = candidates[index++];
      if (!candidate) {
        reject(new Error(`termdeckd is not running at ${candidates.map((item) => item.socketPath).join(', ') || socketPath}${errors.length ? ` (${errors.join('; ')})` : ''}`));
        return;
      }
      const socket = connect(candidate.socketPath);
      const cleanup = () => socket.end();
      socket.on('connect', () => {
        setActiveTermDeckRoot(candidate.rootDir, candidate.socketPath);
        const reader = new FrameReader(socket);
        reader.on('error', reject);
        reader.on('frame', (frame) => {
          if (frame.type !== 'response') return;
          if (frame.payload.id !== id) return;
          cleanup();
          resolveRequest(frame.payload);
        });
        writeFrame(socket, { type: 'request', payload: full });
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          errors.push(`${candidate.socketPath}: ${err.code}`);
          tryNext();
        } else reject(err);
      });
    };
    tryNext();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isDaemonMissing(err: unknown): boolean {
  return err instanceof Error && err.message.includes('termdeckd is not running');
}

export async function requestWithDaemon(req: RequestInput, autostart = false): Promise<Response> {
  try {
    return await request(req);
  } catch (err) {
    if (!autostart || !isDaemonMissing(err)) throw err;
    await startDaemon();
    return request(req);
  }
}

export async function startDaemon(): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(daemonLogPath), { recursive: true, mode: 0o700 });
  const clientFile = fileURLToPath(import.meta.url);
  const clientDir = dirname(clientFile);
  const isSourceRun = clientFile.endsWith('.ts');
  const logFd = openSync(daemonLogPath, 'a');
  const child = spawn(isSourceRun ? 'tsx' : process.execPath, [resolve(clientDir, isSourceRun ? 'daemon.ts' : 'daemon.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    try {
      await request({ op: 'list' });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`termdeckd did not become ready at ${socketPath}; check ${daemonLogPath}`);
}

export async function ensureSession(session: string, opts: { cwd?: string; shell?: string; rows?: number; cols?: number; promptRegex?: string; autostart?: boolean; startupTimeoutMs?: number }): Promise<void> {
  const list = await requestWithDaemon({ op: 'list' }, opts.autostart);
  if (list.sessions?.some((s) => s.id === session)) return;
  if (!opts.cwd) throw new Error(`unknown session: ${session}; pass cwd to create it`);
  const res = await requestWithDaemon({ op: 'new', session, cwd: opts.cwd, shell: opts.shell, rows: opts.rows, cols: opts.cols, promptRegex: opts.promptRegex }, opts.autostart);
  if (!res.ok) throw new Error(res.error ?? `failed to create session: ${session}`);
  await requestWithDaemon({ op: 'expectPrompt', session, timeoutMs: opts.startupTimeoutMs ?? 5_000, stripAnsi: true }, opts.autostart);
}

export function tailLines(text: string, lines: number): string {
  if (!lines || lines <= 0) return '';
  return text.split(/\r?\n/).slice(-lines).join('\n').replace(/\n+$/, '');
}

export function stateSnapshot(status: Response, screen: Response, lines: number): Response {
  const screenTail = tailLines(screen.screen ?? '', lines);
  return {
    ...status,
    screen: screenTail || undefined,
    metadata: {
      ...(status.metadata ?? {}),
      screenTail,
    },
  };
}

export async function enrichedResponse(session: string, res: Response, autostart = false): Promise<Response> {
  const meta = await requestWithDaemon({ op: 'metadata', session }, autostart).catch(() => undefined);
  const transcriptPath = typeof meta?.metadata?.transcript === 'string' ? meta.metadata.transcript : undefined;
  const cwd = typeof meta?.metadata?.cwd === 'string' ? meta.metadata.cwd : undefined;
  return {
    ...res,
    metadata: {
      ...(res.metadata ?? {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(cwd ? { cwd } : {}),
    },
  };
}
