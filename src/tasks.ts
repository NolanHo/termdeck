import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ensureSession, requestWithDaemon, sleep } from './client.js';
import { lastCommand } from './commands.js';
import { rootDir } from './paths.js';
import type { Response, Status } from './protocol.js';

export type TaskSpec = {
  name: string;
  session: string;
  command: string;
  cwd: string;
  owner?: string;
  labels?: string[];
  ttlMs?: number;
  readyUrl?: string;
  readyPort?: number;
  expect?: string;
  startedAt: string;
  updatedAt?: string;
  recoveries?: number;
  restartCount?: number;
  restartPolicy?: 'never' | 'on-exit' | 'on-failure';
  maxRestarts?: number;
  backoffMs?: number;
  lastRestartAt?: string;
};

export type TaskStartOptions = {
  name: string;
  command: string;
  cwd: string;
  owner?: string;
  labels?: string[];
  ttlMs?: number;
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
  restartPolicy?: 'never' | 'on-exit' | 'on-failure';
  maxRestarts?: number;
  backoffMs?: number;
};

export type TaskStatus = {
  name: string;
  session: string;
  command: string;
  cwd: string;
  owner?: string;
  labels: string[];
  ageMs: number;
  ttlMs?: number;
  expired: boolean;
  live: boolean;
  stale: boolean;
  processExited: boolean;
  recovered?: boolean;
  restartCount: number;
  restartPolicy: 'never' | 'on-exit' | 'on-failure';
  maxRestarts?: number;
  backoffMs?: number;
  ready: boolean;
  readyKind: 'url' | 'port' | 'expect' | 'status' | 'combined' | 'stale';
  readyDetail: string;
  readyChecks: ReadyCheck[];
  failureReason?: string;
  status?: Status;
  prompt?: string;
  reason?: string;
  lastSeq?: number;
  transcriptPath?: string;
  logTail?: string;
};

export type TaskDashboard = {
  tasks: TaskStatus[];
  orphanSessions: NonNullable<Response['sessions']>;
};

export type SessionFilter = {
  cwd?: string;
  name?: string;
  status?: Status;
  autostart?: boolean;
};

export type TaskPruneOptions = {
  stale?: boolean;
  expired?: boolean;
  dryRun?: boolean;
  autostart?: boolean;
};

const tasksDir = join(rootDir, 'tasks');

type ReadyCheck = {
  kind: 'url' | 'port' | 'expect' | 'status';
  detail: string;
  ready: boolean;
  error?: string;
};

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

export async function listTaskStatuses(opts: { autostart?: boolean; timeoutMs?: number } = {}): Promise<TaskStatus[]> {
  const statuses: TaskStatus[] = [];
  for (const task of listTasks()) {
    try {
      statuses.push(await taskStatus(task.name, opts));
    } catch (err) {
      statuses.push(staleTaskStatus(task, err instanceof Error ? err.message : String(err)));
    }
  }
  return statuses;
}

export async function taskDashboard(opts: { autostart?: boolean; timeoutMs?: number } = {}): Promise<TaskDashboard> {
  const tasks = await listTaskStatuses(opts);
  const taskSessions = new Set(listTasks().map((task) => task.session));
  const live = await requestWithDaemon({ op: 'list' }, opts.autostart).catch(() => undefined);
  const orphanSessions = (live?.sessions ?? []).filter((session) => session.id.startsWith('task-') && !taskSessions.has(session.id));
  return { tasks, orphanSessions };
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
    owner: opts.owner,
    labels: opts.labels ?? [],
    ttlMs: opts.ttlMs,
    readyUrl: opts.readyUrl,
    readyPort: opts.readyPort,
    expect: opts.expect,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    restartCount: 0,
    restartPolicy: opts.restartPolicy ?? 'never',
    maxRestarts: opts.maxRestarts,
    backoffMs: opts.backoffMs,
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
  if (!meta.ok) return staleTaskStatus(spec, meta.error ?? 'task session is not live');
  const lifecycle = lifecycleInfo(spec);
  const last = lastCommand(spec.session);
  const exitCode = typeof meta.metadata?.exitCode === 'number' ? meta.metadata.exitCode : last?.data === spec.command ? last.exitCode : undefined;
  const processExited = meta.status === 'eof' || (last?.data === spec.command && last.exitCode !== undefined && meta.status !== 'running');
  if (processExited && shouldAutoRestart(spec, exitCode)) {
    const restarted = await restartTask(spec, opts);
    return { ...restarted, recovered: true };
  }
  const base = {
    name: spec.name,
    session: spec.session,
    command: spec.command,
    cwd: spec.cwd,
    owner: spec.owner,
    labels: spec.labels ?? [],
    ageMs: lifecycle.ageMs,
    ttlMs: spec.ttlMs,
    expired: lifecycle.expired,
    live: true,
    stale: false,
    processExited,
    restartCount: spec.restartCount ?? spec.recoveries ?? 0,
    restartPolicy: spec.restartPolicy ?? 'never',
    maxRestarts: spec.maxRestarts,
    backoffMs: spec.backoffMs,
    status: meta.status,
    prompt: meta.prompt,
    reason: meta.reason,
    lastSeq: meta.lastSeq,
    transcriptPath: typeof meta.metadata?.transcript === 'string' ? meta.metadata.transcript : undefined,
  };
  if (lifecycle.expired) return { ...base, ready: false, readyKind: 'status', readyDetail: 'task ttl expired', readyChecks: [], failureReason: 'task ttl expired' };
  if (processExited) return { ...base, ready: false, readyKind: 'status', readyDetail: 'task process exited', readyChecks: [], failureReason: meta.reason ?? 'task process exited' };
  const ready = await detectReady(spec, opts.timeoutMs ?? 1, opts.autostart);
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

export async function taskRecover(name: string, opts: { autostart?: boolean; timeoutMs?: number; quiescenceMs?: number; readyTimeoutMs?: number } = {}): Promise<TaskStatus & { start: Response }> {
  const spec = readTask(name);
  await requestWithDaemon({ op: 'kill', session: spec.session }, opts.autostart).catch(() => undefined);
  await ensureSession(spec.session, { cwd: spec.cwd, autostart: opts.autostart });
  const next: TaskSpec = {
    ...spec,
    updatedAt: new Date().toISOString(),
    recoveries: (spec.recoveries ?? 0) + 1,
    restartCount: (spec.restartCount ?? spec.recoveries ?? 0) + 1,
    lastRestartAt: new Date().toISOString(),
  };
  writeTask(next);
  const start = await requestWithDaemon({
    op: 'run',
    session: next.session,
    command: next.command,
    timeoutMs: opts.timeoutMs ?? 2_000,
    quiescenceMs: opts.quiescenceMs ?? 500,
    stripAnsi: true,
  }, opts.autostart);
  const status = await taskStatus(name, { autostart: opts.autostart, timeoutMs: opts.readyTimeoutMs ?? 10_000 });
  return { ...status, recovered: true, start };
}

export async function taskPrune(opts: TaskPruneOptions = {}): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const tasks = listTasks();
  for (const task of tasks) {
    const status = await taskStatus(task.name, { autostart: opts.autostart, timeoutMs: 1 }).catch(() => staleTaskStatus(task, 'status failed'));
    const shouldRemove = Boolean((opts.stale && status.stale) || (opts.expired && status.expired));
    if (!shouldRemove) {
      kept.push(task.name);
      continue;
    }
    removed.push(task.name);
    if (!opts.dryRun) rmSync(taskPath(task.name), { force: true });
  }
  return { removed, kept };
}

function staleTaskStatus(spec: TaskSpec, reason: string): TaskStatus {
  const lifecycle = lifecycleInfo(spec);
  return {
    name: spec.name,
    session: spec.session,
    command: spec.command,
    cwd: spec.cwd,
    owner: spec.owner,
    labels: spec.labels ?? [],
    ageMs: lifecycle.ageMs,
    ttlMs: spec.ttlMs,
    expired: lifecycle.expired,
    live: false,
    stale: true,
    processExited: false,
    restartCount: spec.restartCount ?? spec.recoveries ?? 0,
    restartPolicy: spec.restartPolicy ?? 'never',
    maxRestarts: spec.maxRestarts,
    backoffMs: spec.backoffMs,
    ready: false,
    readyKind: 'stale',
    readyDetail: 'task metadata exists but its TermDeck session is not live',
    readyChecks: [],
    failureReason: reason,
    status: 'eof',
  };
}

async function restartTask(spec: TaskSpec, opts: { autostart?: boolean; timeoutMs?: number } = {}): Promise<TaskStatus> {
  const next: TaskSpec = {
    ...spec,
    updatedAt: new Date().toISOString(),
    lastRestartAt: new Date().toISOString(),
    restartCount: (spec.restartCount ?? spec.recoveries ?? 0) + 1,
  };
  writeTask(next);
  await requestWithDaemon({ op: 'kill', session: next.session }, opts.autostart).catch(() => undefined);
  await ensureSession(next.session, { cwd: next.cwd, autostart: opts.autostart });
  await requestWithDaemon({
    op: 'run',
    session: next.session,
    command: next.command,
    timeoutMs: opts.timeoutMs ?? 2_000,
    quiescenceMs: 500,
    stripAnsi: true,
  }, opts.autostart);
  return taskStatus(next.name, { autostart: opts.autostart, timeoutMs: opts.timeoutMs });
}

function shouldAutoRestart(spec: TaskSpec, exitCode: number | undefined): boolean {
  const policy = spec.restartPolicy ?? 'never';
  if (policy === 'never') return false;
  if (policy === 'on-failure' && exitCode === 0) return false;
  const count = spec.restartCount ?? spec.recoveries ?? 0;
  if (spec.maxRestarts !== undefined && count >= spec.maxRestarts) return false;
  if (spec.backoffMs !== undefined && spec.lastRestartAt) {
    const last = Date.parse(spec.lastRestartAt);
    if (Number.isFinite(last) && Date.now() - last < spec.backoffMs) return false;
  }
  return true;
}

function lifecycleInfo(spec: TaskSpec): { ageMs: number; expired: boolean } {
  const started = Date.parse(spec.startedAt);
  const ageMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
  return { ageMs, expired: spec.ttlMs !== undefined && ageMs > spec.ttlMs };
}

async function detectReady(spec: TaskSpec, timeoutMs: number, autostart = false): Promise<Pick<TaskStatus, 'ready' | 'readyKind' | 'readyDetail' | 'readyChecks' | 'failureReason' | 'logTail'>> {
  const checks: ReadyCheck[] = [];
  if (spec.readyUrl) {
    const result = await waitUntil(timeoutMs, async () => {
      try {
        const res = await fetch(spec.readyUrl as string, { method: 'GET' });
        return { ok: res.ok, error: res.ok ? undefined : `http ${res.status}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    checks.push({ kind: 'url', detail: spec.readyUrl, ready: result.ok, error: result.error });
  }
  if (spec.readyPort) {
    const result = await waitUntil(timeoutMs, async () => {
      const ok = await canConnect('127.0.0.1', spec.readyPort as number);
      return { ok, error: ok ? undefined : 'port not accepting connections' };
    });
    checks.push({ kind: 'port', detail: String(spec.readyPort), ready: result.ok, error: result.error });
  }
  if (spec.expect) {
    const res = await requestWithDaemon({ op: 'expect', session: spec.session, pattern: spec.expect, timeoutMs, stripAnsi: true }, autostart);
    checks.push({ kind: 'expect', detail: spec.expect, ready: Boolean(res.matched), error: res.ok ? undefined : res.error });
  }
  if (checks.length === 0) {
    const res = await requestWithDaemon({ op: 'metadata', session: spec.session }, autostart);
    checks.push({ kind: 'status', detail: res.reason ?? res.status ?? 'unknown', ready: res.ok && res.status !== 'eof', error: res.ok ? undefined : res.error });
  }
  const ready = checks.every((check) => check.ready);
  const failed = checks.find((check) => !check.ready);
  const logTail = ready ? undefined : (await requestWithDaemon({ op: 'log', session: spec.session, lines: 40 }, autostart).catch(() => undefined))?.logText;
  return {
    ready,
    readyKind: checks.length === 1 ? checks[0].kind : 'combined',
    readyDetail: checks.map((check) => `${check.kind}:${check.detail}`).join(', '),
    readyChecks: checks,
    failureReason: failed ? failed.error ?? `${failed.kind} not ready` : undefined,
    logTail,
  };
}

async function waitUntil(timeoutMs: number, probe: () => Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { ok: boolean; error?: string } = { ok: false, error: 'timed out' };
  do {
    last = await probe();
    if (last.ok) return last;
    await sleep(100);
  } while (Date.now() < deadline);
  return last.ok ? last : { ...last, error: last.error ?? 'timed out' };
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
