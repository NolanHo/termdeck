import { connect } from 'node:net';
import { Command } from 'commander';
import { FrameReader, writeFrame, type Request, type RequestInput, type Response } from './protocol.js';
import { socketPath } from './paths.js';

let nextId = 1;

function request(req: RequestInput): Promise<Response> {
  const id = nextId++;
  const full = { ...req, id } as Request;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const reader = new FrameReader(socket);
    const cleanup = () => socket.end();
    socket.on('connect', () => writeFrame(socket, { type: 'request', payload: full }));
    socket.on('error', reject);
    reader.on('frame', (frame) => {
      if (frame.type !== 'response') return;
      if (frame.payload.id !== id) return;
      cleanup();
      resolve(frame.payload);
    });
  });
}

function printResponse(res: Response): void {
  if (!res.ok) {
    console.error(res.error ?? 'request failed');
    process.exitCode = 1;
    return;
  }
  if (res.output) process.stdout.write(res.output);
  else if (res.screen) process.stdout.write(`${res.screen}\n`);
  else if (res.sessions) {
    for (const s of res.sessions) console.log(`${s.id}\t${s.status}\t${s.cwd}`);
  } else if (res.status) {
    console.log(res.status);
  }
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

program.command('run')
  .argument('<session>')
  .argument('<command>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .action(async (session, command, opts) => {
    printResponse(await request({ op: 'run', session, command, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs }));
  });

program.command('send')
  .argument('<session>')
  .argument('<data>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .action(async (session, data, opts) => {
    printResponse(await request({ op: 'send', session, data, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs }));
  });

program.command('ctrl')
  .argument('<session>')
  .argument('<key>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .action(async (session, key, opts) => {
    printResponse(await request({ op: 'ctrl', session, key, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs }));
  });

program.command('poll')
  .argument('<session>')
  .option('--timeout-ms <ms>', 'timeout', (v) => Number(v))
  .option('--quiescence-ms <ms>', 'quiescence', (v) => Number(v))
  .action(async (session, opts) => {
    printResponse(await request({ op: 'poll', session, timeoutMs: opts.timeoutMs, quiescenceMs: opts.quiescenceMs }));
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

program.command('kill')
  .argument('<session>')
  .action(async (session) => printResponse(await request({ op: 'kill', session })));

program.parseAsync();
