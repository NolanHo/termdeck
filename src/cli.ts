import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { FrameReader, writeFrame, type Request, type RequestInput, type Response } from './protocol.js';
import { daemonLogPath, socketPath } from './paths.js';

let nextId = 1;

function request(req: RequestInput): Promise<Response> {
  const id = nextId++;
  const full = { ...req, id } as Request;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const cleanup = () => socket.end();
    socket.on('connect', () => {
      const reader = new FrameReader(socket);
      reader.on('error', reject);
      reader.on('frame', (frame) => {
        if (frame.type !== 'response') return;
        if (frame.payload.id !== id) return;
        cleanup();
        resolve(frame.payload);
      });
      writeFrame(socket, { type: 'request', payload: full });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new Error(`termdeckd is not running at ${socketPath}`));
      else reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isDaemonMissing(err: unknown): boolean {
  return err instanceof Error && err.message.includes('termdeckd is not running');
}

async function requestWithDaemon(req: RequestInput, autostart = false): Promise<Response> {
  try {
    return await request(req);
  } catch (err) {
    if (!autostart || !isDaemonMissing(err)) throw err;
    await startDaemon();
    return request(req);
  }
}

async function startDaemon(): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(daemonLogPath), { recursive: true, mode: 0o700 });
  const cliFile = fileURLToPath(import.meta.url);
  const cliDir = dirname(cliFile);
  const isSourceRun = cliFile.endsWith('.ts');
  const logFd = openSync(daemonLogPath, 'a');
  const child = spawn(isSourceRun ? 'tsx' : process.execPath, [resolve(cliDir, isSourceRun ? 'daemon.ts' : 'daemon.js')], {
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

async function ensureSession(session: string, opts: { cwd?: string; shell?: string; rows?: number; cols?: number; promptRegex?: string; autostart?: boolean; startupTimeoutMs?: number }): Promise<void> {
  const list = await requestWithDaemon({ op: 'list' }, opts.autostart);
  if (list.sessions?.some((s) => s.id === session)) return;
  if (!opts.cwd) throw new Error(`unknown session: ${session}; pass --cwd to create it`);
  const res = await requestWithDaemon({ op: 'new', session, cwd: opts.cwd, shell: opts.shell, rows: opts.rows, cols: opts.cols, promptRegex: opts.promptRegex }, opts.autostart);
  if (!res.ok) throw new Error(res.error ?? `failed to create session: ${session}`);
  await requestWithDaemon({ op: 'expectPrompt', session, timeoutMs: opts.startupTimeoutMs ?? 5_000, stripAnsi: true }, opts.autostart);
}

function tailLines(text: string, lines: number): string {
  if (!lines || lines <= 0) return '';
  return text.split(/\r?\n/).slice(-lines).join('\n').replace(/\n+$/, '');
}

function stateSummary(res: Response): string {
  const parts = [`status=${res.status ?? 'unknown'}`];
  if (res.prompt) parts.push(`prompt=${res.prompt}`);
  if (res.reason) parts.push(`reason=${JSON.stringify(res.reason)}`);
  if (res.lastSeq !== undefined) parts.push(`seq=${res.lastSeq}`);
  if (res.timedOut) parts.push('timed_out=true');
  if (res.exitCode !== undefined) parts.push(`exit_code=${res.exitCode}`);
  if (res.outputTruncated) parts.push(`truncated=true dropped=${res.droppedChars ?? 0}`);
  return parts.join(' ');
}

function printStep(res: Response, mode: 'default' | 'json'): void {
  if (!res.ok) {
    console.error(res.error ?? 'request failed');
    process.exitCode = 1;
    return;
  }
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  if (res.output) {
    process.stdout.write(res.output);
    if (!res.output.endsWith('\n')) process.stdout.write('\n');
  }
  if (res.screen) {
    process.stdout.write(res.screen);
    if (!res.screen.endsWith('\n')) process.stdout.write('\n');
  }
  process.stdout.write(`\n[termdeck] ${stateSummary(res)}\n`);
}

function stateSnapshot(status: Response, screen: Response, lines: number): Response {
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

function printResponse(res: Response, mode: 'default' | 'raw' | 'json' = 'default'): void {
  if (!res.ok) {
    console.error(res.error ?? 'request failed');
    process.exitCode = 1;
    return;
  }
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  if (mode === 'raw') {
    if (res.output) process.stdout.write(res.output);
    else if (res.screen) process.stdout.write(`${res.screen}\n`);
    else process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  if (res.output) process.stdout.write(res.output);
  else if (res.screen) process.stdout.write(`${res.screen}\n`);
  else if (res.transcript) process.stdout.write(`${res.transcript}\n`);
  else if (res.metadata) process.stdout.write(`${JSON.stringify(res.metadata, null, 2)}\n`);
  else if (res.history) process.stdout.write(`${JSON.stringify(res.history, null, 2)}\n`);
  else if (res.logText) process.stdout.write(res.logText);
  else if (res.eventsText) process.stdout.write(`${res.eventsText}\n`);
  else if (res.matched !== undefined) console.log(res.matched ? 'matched' : 'not matched');
  else if (res.sessions) {
    for (const s of res.sessions) console.log(`${s.id}\t${s.status}\t${s.cwd}`);
  } else if (res.status) {
    console.log(res.status);
  }
}

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stdout.write('Password: ');
  process.stdin.setRawMode(true);
  let secret = '';
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (s === '\r' || s === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(secret);
      } else if (s === '\u0003') {
        process.exit(130);
      } else if (s === '\u007f') {
        secret = secret.slice(0, -1);
      } else {
        secret += s;
      }
    };
    process.stdin.on('data', onData);
  });
}

const program = new Command();
program.name('termdeck').description('Persistent terminal sessions for agents and observers');

program.command('new')
  .argument('<session>')
  .requiredOption('--cwd <path>')
  .option('--shell <shell>')
  .option('--rows <rows>', 'terminal rows', (v) => Number(v))
  .option('--cols <cols>', 'terminal cols', (v) => Number(v))
  .option('--prompt-regex <regex>')
  .action(async (session, opts) => {
    printResponse(await request({ op: 'new', session, cwd: opts.cwd, shell: opts.shell, rows: opts.rows, cols: opts.cols, promptRegex: opts.promptRegex }));
  });

program.command('state')
  .argument('<session>')
  .option('--lines <lines>', 'rendered screen tail lines', (v) => Number(v), 12)
  .option('--json')
  .option('--autostart', 'start termdeckd when it is not running')
  .action(async (session, opts) => {
    const meta = await requestWithDaemon({ op: 'metadata', session }, opts.autostart);
    if (!meta.ok) return printResponse(meta, opts.json ? 'json' : 'default');
    const screen = await requestWithDaemon({ op: 'screen', session }, opts.autostart);
    printStep(stateSnapshot(meta, screen, opts.lines), opts.json ? 'json' : 'default');
  });

program.command('step')
  .argument('<session>')
  .argument('[command]')
  .option('--cwd <path>', 'create session in cwd when missing')
  .option('--shell <shell>')
  .option('--rows <rows>', 'terminal rows', (v) => Number(v))
  .option('--cols <cols>', 'terminal cols', (v) => Number(v))
  .option('--prompt-regex <regex>')
  .option('--op <op>', 'action: run, poll, send, paste, ctrl, signal', 'run')
  .option('--enter', 'submit paste input')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--startup-timeout-ms <ms>', 'new session prompt timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--lines <lines>', 'include rendered screen tail lines after poll-only steps', (v) => Number(v), 0)
  .option('--raw')
  .option('--json')
  .option('--autostart', 'start termdeckd when it is not running')
  .action(async (session, command, opts) => {
    await ensureSession(session, { cwd: opts.cwd, shell: opts.shell, rows: opts.rows, cols: opts.cols, promptRegex: opts.promptRegex, autostart: opts.autostart, startupTimeoutMs: opts.startupTimeoutMs });
    const stripAnsi = !opts.raw;
    let res: Response;
    switch (opts.op) {
      case 'run':
        if (!command) throw new Error('step --op run requires a command');
        res = await requestWithDaemon({ op: 'run', session, command, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi }, opts.autostart);
        break;
      case 'poll':
        res = await requestWithDaemon({ op: 'poll', session, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi }, opts.autostart);
        break;
      case 'send':
        if (command === undefined) throw new Error('step --op send requires data');
        res = await requestWithDaemon({ op: 'send', session, data: command, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi }, opts.autostart);
        break;
      case 'paste':
        if (command === undefined) throw new Error('step --op paste requires text');
        res = await requestWithDaemon({ op: 'paste', session, data: command, enter: opts.enter, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi }, opts.autostart);
        break;
      case 'ctrl':
        if (!command) throw new Error('step --op ctrl requires a key');
        res = await requestWithDaemon({ op: 'ctrl', session, key: command, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi }, opts.autostart);
        break;
      case 'signal':
        if (!command) throw new Error('step --op signal requires a signal');
        res = await requestWithDaemon({ op: 'signal', session, signal: command, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi }, opts.autostart);
        break;
      default:
        throw new Error(`unknown step op: ${opts.op}`);
    }
    if (opts.lines > 0) {
      const screen = await requestWithDaemon({ op: 'screen', session }, opts.autostart);
      res = stateSnapshot(res, screen, opts.lines);
    }
    printStep(res, opts.json ? 'json' : 'default');
  });

program.command('run')
  .argument('<session>')
  .argument('<command>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, command, opts) => {
    printResponse(await request({ op: 'run', session, command, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default');
  });

program.command('send')
  .argument('<session>')
  .argument('<data>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, data, opts) => {
    printResponse(await request({ op: 'send', session, data, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default');
  });

program.command('script')
  .argument('<session>')
  .argument('[file]')
  .option('--inline <script>')
  .option('--shell <shell>', 'script shell', 'bash')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, file, opts) => {
    const data = opts.inline ?? (file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'));
    printResponse(await request({ op: 'script', session, data, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw, shell: opts.shell }), opts.json ? 'json' : opts.raw ? 'raw' : 'default');
  });

program.command('paste')
  .argument('<session>')
  .argument('[file]')
  .option('--inline <text>')
  .option('--enter')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, file, opts) => {
    const data = opts.inline ?? (file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'));
    printResponse(await request({ op: 'paste', session, data, enter: opts.enter, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default');
  });

program.command('ctrl')
  .argument('<session>')
  .argument('<key>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, key, opts) => {
    printResponse(await request({ op: 'ctrl', session, key, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default');
  });

program.command('poll')
  .argument('<session>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, opts) => {
    printResponse(await request({ op: 'poll', session, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default');
  });

program.command('screen')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'screen', session })));

program.command('scrollback')
  .argument('<session>')
  .option('--lines <lines>', 'line count', (v) => Number(v))
  .action(async (session, opts) => printResponse(await request({ op: 'scrollback', session, lines: opts.lines })));

program.command('list')
  .action(async () => printResponse(await request({ op: 'list' })));

program.command('configure')
  .argument('<session>')
  .option('--prompt-regex <regex>')
  .action(async (session, opts) => printResponse(await request({ op: 'configure', session, promptRegex: opts.promptRegex })));

program.command('expect')
  .argument('<session>')
  .argument('<pattern>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, pattern, opts) => printResponse(await request({ op: 'expect', session, pattern, timeoutMs: opts.timeoutMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default'));

program.command('password')
  .argument('<session>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .action(async (session, opts) => {
    const secret = await readSecret();
    printResponse(await request({ op: 'password', session, secret, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs }));
  });

program.command('transcript')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'transcript', session })));

program.command('resize')
  .argument('<session>')
  .requiredOption('--rows <rows>', 'rows', (v) => Number(v))
  .requiredOption('--cols <cols>', 'cols', (v) => Number(v))
  .action(async (session, opts) => printResponse(await request({ op: 'resize', session, rows: opts.rows, cols: opts.cols })));

program.command('metadata')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'metadata', session })));

program.command('history')
  .action(async () => printResponse(await request({ op: 'history' })));

program.command('inspect')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'inspect', session })));

program.command('log')
  .argument('<session>')
  .option('--lines <lines>', 'line count', (v) => Number(v))
  .action(async (session, opts) => printResponse(await request({ op: 'log', session, lines: opts.lines })));

program.command('events')
  .argument('<session>')
  .option('--after-seq <seq>', 'minimum seq', (v) => Number(v))
  .option('--limit <limit>', 'max events', (v) => Number(v))
  .action(async (session, opts) => printResponse(await request({ op: 'events', session, afterSeq: opts.afterSeq, limit: opts.limit })));

program.command('replay')
  .argument('<session>')
  .option('--lines <lines>', 'scrollback lines', (v) => Number(v))
  .action(async (session, opts) => printResponse(await request({ op: 'replay', session, lines: opts.lines })));

program.command('clear-scrollback')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'clearScrollback', session })));

program.command('expect-prompt')
  .argument('<session>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, opts) => printResponse(await request({ op: 'expectPrompt', session, timeoutMs: opts.timeoutMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default'));

program.command('signal')
  .argument('<session>')
  .argument('<signal>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .option('--raw')
  .option('--json')
  .action(async (session, signal, opts) => printResponse(await request({ op: 'signal', session, signal, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs, stripAnsi: !opts.raw }), opts.json ? 'json' : opts.raw ? 'raw' : 'default'));

program.command('kill')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'kill', session })));

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
