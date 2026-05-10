import { appendFileSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { signalProcessGroup } from './platform.js';
import { redactText } from './redact.js';
import { TextRing } from './ring.js';
import { detectState, type StateResult } from './state.js';
import type { Event, PromptKind, Status } from './protocol.js';
import { sessionDir } from './paths.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

export type SessionOptions = {
  id: string;
  cwd: string;
  shell?: string;
  rows?: number;
  cols?: number;
  promptRegex?: string;
  description?: string;
};

export type WaitResult = { output: string; status: Status; prompt: PromptKind; reason: string; lastSeq: number; timedOut: boolean; outputTruncated: boolean; droppedChars: number; exitCode?: number };

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.VIRTUAL_ENV;
  delete next.VIRTUAL_ENV_PROMPT;
  delete next.PYTHONHOME;
  delete next.PYTHONPATH;
  delete next.__PYVENV_LAUNCHER__;
  delete next.NPM_CONFIG_PREFIX;
  delete next.npm_config_verify_deps_before_run;
  next.TERM = 'xterm-256color';
  next.NPM_CONFIG_LOGLEVEL = 'error';
  next.npm_config_loglevel = 'error';
  delete next.TMUX;
  delete next.TMUX_PANE;
  return next;
}



function filterScriptResult(r: WaitResult, begin: string, endPrefix: string): WaitResult {
  const beginAt = r.output.indexOf(begin);
  const endAt = r.output.indexOf(endPrefix, beginAt + begin.length);
  if (beginAt === -1 || endAt === -1) return r;
  const afterEnd = r.output.indexOf('__', endAt + endPrefix.length);
  const codeText = afterEnd === -1 ? undefined : r.output.slice(endAt + endPrefix.length, afterEnd);
  const output = r.output.slice(beginAt + begin.length, endAt).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const exitCode = codeText === undefined ? undefined : Number(codeText);
  return { ...r, output, exitCode: Number.isFinite(exitCode) ? exitCode : undefined };
}

function filterMarkedRunResult(r: WaitResult, begin: string, endPrefix: string): WaitResult {
  const endAt = r.output.lastIndexOf(endPrefix);
  const beginAt = endAt === -1 ? r.output.lastIndexOf(begin) : r.output.lastIndexOf(begin, endAt);
  if (beginAt === -1) return r;
  const commandOutputStart = beginAt + begin.length;
  if (endAt === -1) {
    const output = r.output.slice(commandOutputStart).replace(/^\r?\n/, '');
    return { ...r, output };
  }
  const afterEnd = r.output.indexOf('__', endAt + endPrefix.length);
  const codeText = afterEnd === -1 ? undefined : r.output.slice(endAt + endPrefix.length, afterEnd);
  const output = r.output.slice(commandOutputStart, endAt).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const exitCode = codeText === undefined ? undefined : Number(codeText);
  return { ...r, output, exitCode: Number.isFinite(exitCode) ? exitCode : undefined };
}

function markedRun(command: string): { input: string; begin: string; endPrefix: string } {
  const delimiter = `TERMDECK_RUN_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (command.includes(delimiter)) throw new Error('command contains generated marker delimiter');
  const begin = `__TERMDECK_BEGIN:${delimiter}__`;
  const endPrefix = `__TERMDECK_EXIT:${delimiter}:`;
  return {
    begin,
    endPrefix,
    input: `echo; echo ${begin}; { ${command}\n}; __termdeck_rc=$?; echo ${endPrefix}\${__termdeck_rc}__\r`,
  };
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
  rows: number;
  cols: number;
  promptRegex?: string;
  description?: string;
  private readonly ptyProcess: pty.IPty;
  private term: InstanceType<typeof Terminal>;
  private readonly ring = new TextRing();
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private readonly transcript;
  private readonly transcriptPath: string;
  private readonly eventsPath: string;
  private readonly commandsPath: string;
  private readonly interactionPath: string;
  private readonly sessionPath: string;
  private readonly statePath: string;
  private readonly events: Event[] = [];
  private seq = 0;
  private readonly startedAt = new Date().toISOString();
  private lastActivityAt = this.startedAt;
  private lastOutputAt = Date.now();
  private exited = false;
  private lastExitCode: number | undefined;
  private lastExitSignal: string | undefined;
  private lastStatus: Status = 'unknown';
  private readonly shell: string;
  private readonly shellArgs: string[];

  constructor(opts: SessionOptions) {
    super();
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.rows = opts.rows ?? 40;
    this.cols = opts.cols ?? 160;
    this.promptRegex = opts.promptRegex;
    this.description = opts.description;

    const dir = sessionDir(this.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.transcriptPath = join(dir, 'transcript.log');
    this.eventsPath = join(dir, 'events.jsonl');
    this.commandsPath = join(dir, 'commands.log');
    this.interactionPath = join(dir, 'interaction.log');
    this.sessionPath = join(dir, 'session.json');
    this.statePath = join(dir, 'state.json');
    this.transcript = createWriteStream(this.transcriptPath, { flags: 'a', mode: 0o600 });
    this.loadEvents();
    this.term = new Terminal({ rows: this.rows, cols: this.cols, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    this.shell = opts.shell || userInfo().shell || process.env.SHELL || 'bash';
    this.shellArgs = [];
    this.ptyProcess = pty.spawn(this.shell, this.shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: cleanEnv(process.env),
    });

    this.ptyProcess.onData((data) => this.onOutput(data));
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.lastExitCode = exitCode;
      this.lastExitSignal = signal === undefined ? undefined : String(signal);
      this.emitEvent({ kind: 'exit', code: exitCode, signal: signal === undefined ? undefined : String(signal) });
      this.writeSessionMeta(new Date().toISOString());
      this.transcript.end();
    });
    this.writeSessionMeta();
    this.writeState();
  }

  info(): { id: string; cwd: string; rows: number; cols: number; status: Status; lastSeq: number; promptRegex?: string } {
    return { id: this.id, cwd: this.cwd, rows: this.rows, cols: this.cols, status: this.status().status, lastSeq: this.seq, promptRegex: this.promptRegex };
  }

  lastSeq(): number {
    return this.seq;
  }

  metadata(): Record<string, unknown> {
    return {
      id: this.id,
      cwd: this.cwd,
      pid: this.ptyProcess.pid,
      rows: this.rows,
      cols: this.cols,
      shell: this.shell,
      shellArgs: this.shellArgs,
      promptRegex: this.promptRegex,
      description: this.description,
      startedAt: this.startedAt,
      exited: this.exited,
      exitCode: this.lastExitCode,
      exitSignal: this.lastExitSignal,
      lastActivityAt: this.lastActivityAt,
      transcript: this.transcriptPath,
      events: this.eventsPath,
      commands: this.commandsPath,
      interaction: this.interactionPath,
      state: this.statePath,
      session: this.sessionPath,
      ring: this.ring.stats(),
    };
  }

  status(): StateResult {
    return detectState(this.screen(), this.promptRegex, this.exited);
  }

  run(command: string, timeoutMs = 30_000, quiescenceMs = 1_000): Promise<WaitResult> {
    const marked = markedRun(command);
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    appendFileSync(this.commandsPath, `${JSON.stringify({ id: commandId, kind: 'run', tsMs: startedAt, data: command, startSeq: this.seq })}\n`, { mode: 0o600 });
    return this.writeAndWait(marked.input, timeoutMs, quiescenceMs, true, command, false).then((r) => {
      const filtered = filterMarkedRunResult(r, marked.begin, marked.endPrefix);
      appendFileSync(this.commandsPath, `${JSON.stringify({
        id: commandId,
        result: {
          endSeq: filtered.lastSeq,
          durationMs: Date.now() - startedAt,
          exitCode: filtered.exitCode,
          timedOut: filtered.timedOut,
          outputTail: filtered.output.slice(-4_000),
        },
      })}\n`, { mode: 0o600 });
      return filtered;
    });
  }

  send(data: string, timeoutMs = 30_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(data, timeoutMs, quiescenceMs, true);
  }


  async script(data: string, timeoutMs = 30_000, quiescenceMs = 1_000, shell = 'bash'): Promise<WaitResult> {
    const delimiter = `TERMDECK_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (data.includes(delimiter)) throw new Error('script contains generated heredoc delimiter');
    const begin = `__TERMDECK_BEGIN:${delimiter}__`;
    const end = `__TERMDECK_EXIT:${delimiter}:`;
    const command = `cat > /tmp/${delimiter}.sh <<'${delimiter}'
${data}
${delimiter}
printf '\n__TERMDECK_BEGIN:%s__\n' '${delimiter}'; ${shell} /tmp/${delimiter}.sh; rc=$?; rm -f /tmp/${delimiter}.sh; printf '\n__TERMDECK_EXIT:%s:%s__\n' '${delimiter}' "$rc"`;
    return filterScriptResult(await this.paste(command, true, timeoutMs, quiescenceMs), begin, end);
  }

  paste(data: string, enter = false, timeoutMs = 30_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(`\x1b[200~${data}\x1b[201~${enter ? '\r' : ''}`, timeoutMs, quiescenceMs, true);
  }

  ctrl(key: string, timeoutMs = 5_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(controlChar(key), timeoutMs, quiescenceMs, true);
  }

  signal(signal: string, timeoutMs = 5_000, quiescenceMs = 1_000): Promise<WaitResult> {
    const mark = this.ring.mark();
    const sent = signalProcessGroup(this.ptyProcess.pid, signal);
    this.lastActivityAt = new Date().toISOString();
    this.emitEvent({ kind: 'state', status: this.status().status, reason: sent.detail });
    return this.waitForOutput(mark, timeoutMs, quiescenceMs, false);
  }

  poll(timeoutMs = 100, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.waitForOutput(this.ring.mark(), timeoutMs, quiescenceMs, true);
  }

  password(secret: string, timeoutMs = 30_000, quiescenceMs = 1_000): Promise<WaitResult> {
    return this.writeAndWait(`${secret}\r`, timeoutMs, quiescenceMs, false);
  }

  async expect(pattern: string, timeoutMs = 30_000): Promise<WaitResult & { matched: boolean }> {
    return this.expectPredicate((text) => new RegExp(pattern).test(text), timeoutMs);
  }

  async expectPrompt(timeoutMs = 30_000): Promise<WaitResult & { matched: boolean }> {
    return this.expectPredicate(() => this.status().status === 'ready', timeoutMs);
  }

  transcriptFile(): string {
    return this.transcriptPath;
  }

  redact(text: string): string {
    return redactText(text);
  }

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.ptyProcess.resize(cols, rows);
    this.term.resize(cols, rows);
    this.lastActivityAt = new Date().toISOString();
    this.emitEvent({ kind: 'state', status: this.status().status, reason: 'resized' });
    this.writeSessionMeta();
  }

  clearScrollback(): void {
    this.term.clear();
    this.emitEvent({ kind: 'state', status: this.status().status, reason: 'scrollback cleared' });
  }

  screen(): string {
    const lines: string[] = [];
    const buffer = this.term.buffer.active;
    for (let i = 0; i < this.term.rows; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return this.redact(lines.join('\n'));
  }

  scrollback(lines = 200): string {
    const out: string[] = [];
    const buffer = this.term.buffer.active;
    const start = Math.max(0, buffer.length - lines);
    for (let i = start; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return this.redact(out.join('\n').replace(/\n+$/, ''));
  }

  snapshot(scrollback = 1_000): string {
    return this.serializer.serialize({ scrollback });
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
    this.writeSessionMeta();
  }

  private writeAndWait(data: string, timeoutMs: number, quiescenceMs: number, logInput: boolean, logData = data, appendCommandLog = true): Promise<WaitResult> {
    const mark = this.ring.mark();
    if (logInput) {
      this.emitEvent({ kind: 'input', data: logData });
      if (appendCommandLog) appendFileSync(this.commandsPath, `${JSON.stringify({ tsMs: Date.now(), data: logData })}\n`, { mode: 0o600 });
    }
    this.ptyProcess.write(data);
    this.lastActivityAt = new Date().toISOString();
    return this.waitForOutput(mark, timeoutMs, quiescenceMs, false);
  }

  private expectPredicate(match: (text: string) => boolean, timeoutMs: number): Promise<WaitResult & { matched: boolean }> {
    const mark = this.ring.mark();
    if (match(this.ring.all())) return Promise.resolve({ ...this.resultSince(mark, false), matched: true });
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const done = (matched: boolean, timedOut: boolean) => {
        clearInterval(timer);
        this.off('output', onOutput);
        resolve({ ...this.resultSince(mark, timedOut), matched });
      };
      const onOutput = () => {
        if (match(this.ring.since(mark))) done(true, false);
      };
      const timer = setInterval(() => {
        if (match(this.ring.since(mark))) return done(true, false);
        if (Date.now() >= deadline) return done(false, true);
      }, 25);
      this.on('output', onOutput);
    });
  }

  private waitForOutput(mark: number, timeoutMs: number, quiescenceMs: number, requireNewOutput: boolean): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    let sawOutput = this.ring.mark() > mark;
    return new Promise((resolve) => {
      const done = (timedOut: boolean) => {
        clearInterval(timer);
        this.off('output', onOutput);
        const result = this.resultSince(mark, timedOut);
        this.maybeEmitState(result.status, result.reason);
        result.lastSeq = this.seq;
        appendFileSync(this.interactionPath, `${JSON.stringify({ tsMs: Date.now(), result })}\n`, { mode: 0o600 });
        resolve(result);
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

  private resultSince(mark: number, timedOut: boolean): WaitResult {
    const state = this.status();
    const output = this.ring.sinceWithStats(mark);
    return { output: this.redact(output.text), status: state.status, prompt: state.prompt, reason: state.reason, lastSeq: this.seq, timedOut, outputTruncated: output.truncated, droppedChars: output.droppedChars };
  }

  private onOutput(data: string): void {
    this.lastOutputAt = Date.now();
    this.lastActivityAt = new Date().toISOString();
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
    this.writeState();
  }

  private loadEvents(): void {
    try {
      const rows = readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean);
      for (const row of rows) this.events.push(JSON.parse(row) as Event);
      this.seq = this.events.at(-1)?.seq ?? 0;
    } catch {}
  }

  private writeSessionMeta(endTime?: string): void {
    writeFileSync(this.sessionPath, `${JSON.stringify({ ...this.metadata(), endTime }, null, 2)}\n`, { mode: 0o600 });
  }

  private writeState(): void {
    const state = this.status();
    writeFileSync(this.statePath, `${JSON.stringify({ ...state, lastSeq: this.seq, lastActivityAt: this.lastActivityAt }, null, 2)}\n`, { mode: 0o600 });
  }
}

type EventInput =
  | { kind: 'output'; data: string }
  | { kind: 'input'; data: string }
  | { kind: 'state'; status: Status; reason: string }
  | { kind: 'exit'; code?: number; signal?: string };
