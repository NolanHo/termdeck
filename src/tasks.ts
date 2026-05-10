import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ensureSession, requestWithDaemon, sleep } from './client.js';
import { rootDir } from './paths.js';
import type { Response, Status } from './protocol.js';

export type TaskSpec = {
  name: string;
  session: string;
  command: string;
  cwd: string;
  readyUrl?: string;
  readyPort?: number;
  expect?: string;
  startedAt: string;
};

export type TaskStartOptions = {
  name: string;
  command: string;
  cwd: string;
  readyUrl?: string;
  readyPort?: number;
  expect?: string;
  timeoutMs?: number;
  readyTimeoutMs?: number;
  quiescenceMs?: number;
  autostart?: boolean;
  shell?: string;
  rows?: number;
  cols?: number;
  promptRegex?: string;
};

export type TaskStatus = {
  name: string;
  session: string;
  command: string;
  cwd: string;
  ready: boolean;
  readyKind: 'url' | 'port' | 'expect' | 'status';
  readyDetail: string;
  status?: Status;
  prompt?: string;
  reason?: string;
  lastSeq?: number;
  transcriptPath?: string;
};

export type SessionFilter = {
  cwd?: string;
  name?: string;
  status?: Status;
  autostart?: boolean;
};

const tasksDir = join(rootDir, 'tasks');

function safeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safe) throw new Error('task name must contain at least one safe character');
  return safe;
}

export function taskSessionName(name: string): string {
  return `task-${safeName(name)}`;
}

function taskPath(name: string): string {
  return join(tasksDir, `${safeName(name)}.json`);
}

function writeTask(spec: TaskSpec): void {
  mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
  writeFileSync(taskPath(spec.name), `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
}

export function readTask(name: string): TaskSpec {
  const file = taskPath(name);
  if (!existsSync(file)) throw new Error(`unknown task: ${name}`);
  return JSON.parse(readFileSync(file, 'utf8')) as TaskSpec;
}

export function listTasks(): TaskSpec[] {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .flatMap((d) => {
      try {
        return [JSON.parse(readFileSync(join(tasksDir, d.name), 'utf8')) as TaskSpec];
      } catch {
        return [];
      }
    });
}

export async function listSessions(filter: SessionFilter = {}): Promise<Response> {
  const res = await requestWithDaemon({ op: 'list' }, filter.autostart);
  if (!res.ok || !res.sessions) return res;
  const sessions = res.sessions.filter((s) => {
    if (filter.cwd && s.cwd !== filter.cwd) return false;
    if (filter.name && !s.id.includes(filter.name)) return false;
    if (filter.status && s.status !== filter.status) return false;
    return true;
  });
  return { ...res, sessions };
}

export async function pruneSessions(filter: SessionFilter = {}): Promise<{ killed: string[]; skipped: string[] }> {
  const res = await listSessions(filter);
  const killed: string[] = [];
  const skipped: string[] = [];
  for (const session of res.sessions ?? []) {
    const kill = await requestWithDaemon({ op: 'kill', session: session.id }, filter.autostart);
    if (kill.ok) killed.push(session.id);
    else skipped.push(session.id);
  }
  return { killed, skipped };
}

export async function taskStart(opts: TaskStartOptions): Promise<TaskStatus & { start: Response }> {
  const session = taskSessionName(opts.name);
  const spec: TaskSpec = {
    name: opts.name,
    session,
    command: opts.command,
    cwd: opts.cwd,
    readyUrl: opts.readyUrl,
    readyPort: opts.readyPort,
    expect: opts.expect,
    startedAt: new Date().toISOString(),
  };
  await ensureSession(session, {
    cwd: opts.cwd,
    shell: opts.shell,
    rows: opts.rows,
    cols: opts.cols,
    promptRegex: opts.promptRegex,
    autostart: opts.autostart,
  });
  writeTask(spec);
  const start = await requestWithDaemon({
    op: 'run',
    session,
    command: opts.command,
    timeoutMs: opts.timeoutMs ?? 2_000,
    quiescenceMs: opts.quiescenceMs ?? 500,
    stripAnsi: true,
  }, opts.autostart);
  const status = await taskStatus(opts.name, { autostart: opts.autostart, timeoutMs: opts.readyTimeoutMs ?? 10_000 });
  return { ...status, start };
}

export async function taskStatus(name: string, opts: { autostart?: boolean; timeoutMs?: number } = {}): Promise<TaskStatus> {
  const spec = readTask(name);
  const meta = await requestWithDaemon({ op: 'metadata', session: spec.session }, opts.autostart);
  const base = {
    name: spec.name,
    session: spec.session,
    command: spec.command,
    cwd: spec.cwd,
    status: meta.status,
    prompt: meta.prompt,
    reason: meta.reason,
    lastSeq: meta.lastSeq,
    transcriptPath: typeof meta.metadata?.transcript === 'string' ? meta.metadata.transcript : undefined,
  };
  const ready = await detectReady(spec, opts.timeoutMs ?? 1);
  return { ...base, ...ready };
}

export async function taskLogs(name: string, lines = 200, autostart = false): Promise<Response> {
  const spec = readTask(name);
  return requestWithDaemon({ op: 'log', session: spec.session, lines }, autostart);
}

export async function taskStop(name: string, autostart = false): Promise<{ name: string; session: string; stopped: boolean; response: Response }> {
  const spec = readTask(name);
  const response = await requestWithDaemon({ op: 'kill', session: spec.session }, autostart);
  if (response.ok) rmSync(taskPath(name), { force: true });
  return { name, session: spec.session, stopped: response.ok, response };
}

async function detectReady(spec: TaskSpec, timeoutMs: number): Promise<Pick<TaskStatus, 'ready' | 'readyKind' | 'readyDetail'>> {
  if (spec.readyUrl) {
    const ok = await waitUntil(timeoutMs, async () => {
      try {
        const res = await fetch(spec.readyUrl as string, { method: 'GET' });
        return res.ok;
      } catch {
        return false;
      }
    });
    return { ready: ok, readyKind: 'url', readyDetail: spec.readyUrl };
  }
  if (spec.readyPort) {
    const ok = await waitUntil(timeoutMs, () => canConnect('127.0.0.1', spec.readyPort as number));
    return { ready: ok, readyKind: 'port', readyDetail: String(spec.readyPort) };
  }
  if (spec.expect) {
    const res = await requestWithDaemon({ op: 'expect', session: spec.session, pattern: spec.expect, timeoutMs, stripAnsi: true });
    return { ready: Boolean(res.matched), readyKind: 'expect', readyDetail: spec.expect };
  }
  const res = await requestWithDaemon({ op: 'metadata', session: spec.session });
  return { ready: res.ok && res.status !== 'eof', readyKind: 'status', readyDetail: res.reason ?? res.status ?? 'unknown' };
}

async function waitUntil(timeoutMs: number, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probe()) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return false;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
