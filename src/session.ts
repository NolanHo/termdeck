import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { TextRing } from './ring.js';
import { detectState } from './state.js';
import type { Event, Status } from './protocol.js';
import { sessionDir } from './paths.js';

export type SessionOptions = {
  id: string;
  cwd: string;
  shell?: string;
  rows?: number;
  cols?: number;
  promptRegex?: string;
};

export type WaitResult = { output: string; status: Status; timedOut: boolean };

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.VIRTUAL_ENV;
  delete next.VIRTUAL_ENV_PROMPT;
  delete next.PYTHONHOME;
  delete next.PYTHONPATH;
  delete next.__PYVENV_LAUNCHER__;
  delete next.NPM_CONFIG_PREFIX;
  delete next.npm_config_verify_deps_before_run;
  next.TERM = next.TERM || 'xterm-256color';
  return next;
}

function controlChar(key: string): string {
  const k = key.toLowerCase();
  if (k === 'escape' || k === 'esc' || k === '[') return '\x1b';
  if (k.length === 1 && k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) - 96);
  throw new Error(`unknown control key: ${key}`);
}

export class TermSession extends EventEmitter {
  readonly id: string;
  readonly cwd: string;
  readonly rows: number;
  readonly cols: number;
  promptRegex?: string;
  private readonly ptyProcess: pty.IPty;
  private readonly term: InstanceType<typeof Terminal>;
  private readonly ring = new TextRing();
  private readonly transcript;
  private readonly eventsPath: string;
  private readonly events: Event[] = [];
  private seq = 0;
  private lastOutputAt = Date.now();
  private exited = false;
  private lastStatus: Status = 'unknown';

  constructor(opts: SessionOptions) {
    super();
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.rows = opts.rows ?? 30;
    this.cols = opts.cols ?? 120;
    this.promptRegex = opts.promptRegex;

    const dir = sessionDir(this.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.transcript = createWriteStream(join(dir, 'transcript.log'), { flags: 'a', mode: 0o600 });
    this.eventsPath = join(dir, 'events.jsonl');
    this.loadEvents();
    this.term = new Terminal({ rows: this.rows, cols: this.cols, allowProposedApi: true });

    const shell = opts.shell || 'bash';
    const shellArgs = opts.shell ? [] : ['--noprofile', '--norc'];
    this.ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: cleanEnv(process.env),
    });

    this.ptyProcess.onData((data) => this.onOutput(data));
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.emitEvent({ kind: 'exit', code: exitCode, signal: signal === undefined ? undefined : String(signal) });
      this.transcript.end();
    });
  }

  info(): { id: string; cwd: string; rows: number; cols: number; status: Status; lastSeq: number; promptRegex?: string } {
    return { id: this.id, cwd: this.cwd, rows: this.rows, cols: this.cols, status: this.status().status, lastSeq: this.seq, promptRegex: this.promptRegex };
  }

  status(): { status: Status; reason: string } {
    return detectState(this.screen(), this.promptRegex, this.exited);
  }

  run(command: string, timeoutMs = 30_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(`${command}\r`, timeoutMs, quiescenceMs, true);
  }

  send(data: string, timeoutMs = 30_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(data, timeoutMs, quiescenceMs, true);
  }

  ctrl(key: string, timeoutMs = 5_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(controlChar(key), timeoutMs, quiescenceMs, true);
  }

  poll(timeoutMs = 100, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.waitForOutput(this.ring.mark(), timeoutMs, quiescenceMs, true);
  }

  screen(): string {
    const lines: string[] = [];
    const buffer = this.term.buffer.active;
    for (let i = 0; i < this.term.rows; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  scrollback(lines = 200): string {
    const out: string[] = [];
    const buffer = this.term.buffer.active;
    const start = Math.max(0, buffer.length - lines);
    for (let i = start; i < buffer.length; i++) {
      out.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return out.join('\n').replace(/\n+$/, '');
  }

  kill(): void {
    this.ptyProcess.kill();
  }

  eventsAfter(seq: number): Event[] {
    return this.events.filter((e) => e.seq > seq);
  }

  configure(promptRegex?: string): void {
    this.promptRegex = promptRegex;
    const state = this.status();
    this.emitEvent({ kind: 'state', status: state.status, reason: state.reason });
  }

  private writeAndWait(data: string, timeoutMs: number, quiescenceMs: number, logInput: boolean): Promise<WaitResult> {
    const mark = this.ring.mark();
    if (logInput) this.emitEvent({ kind: 'input', data });
    this.ptyProcess.write(data);
    return this.waitForOutput(mark, timeoutMs, quiescenceMs, false);
  }

  private waitForOutput(mark: number, timeoutMs: number, quiescenceMs: number, requireNewOutput: boolean): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    let sawOutput = this.ring.mark() > mark;

    return new Promise((resolve) => {
      const done = (timedOut: boolean) => {
        clearInterval(timer);
        this.off('output', onOutput);
        const state = this.status();
        this.maybeEmitState(state.status, state.reason);
        resolve({ output: this.ring.since(mark), status: state.status, timedOut });
      };
      const onOutput = () => {
        sawOutput = true;
      };
      const timer = setInterval(() => {
        const now = Date.now();
        if (this.exited) return done(false);
        if ((!requireNewOutput || sawOutput) && now - this.lastOutputAt >= quiescenceMs) return done(false);
        if (now >= deadline) return done(true);
      }, 25);
      this.on('output', onOutput);
    });
  }

  private onOutput(data: string): void {
    this.lastOutputAt = Date.now();
    this.transcript.write(data);
    this.ring.push(data);
    this.term.write(data);
    this.emitEvent({ kind: 'output', data });
    this.emit('output');
  }

  private maybeEmitState(status: Status, reason: string): void {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.emitEvent({ kind: 'state', status, reason });
  }

  private emitEvent(event: EventInput): void {
    this.seq += 1;
    const full = { ...event, seq: this.seq, tsMs: Date.now(), session: this.id } as Event;
    this.events.push(full);
    appendFileSync(this.eventsPath, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    this.emit('event', full);
  }

  private loadEvents(): void {
    try {
      const rows = readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean);
      for (const row of rows) this.events.push(JSON.parse(row) as Event);
      this.seq = this.events.at(-1)?.seq ?? 0;
    } catch {}
  }
}

type EventInput =
  | { kind: 'output'; data: string }
  | { kind: 'input'; data: string }
  | { kind: 'state'; status: Status; reason: string }
  | { kind: 'exit'; code?: number; signal?: string };
