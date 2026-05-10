import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { enrichedResponse, ensureSession, request, requestWithDaemon, stateSnapshot } from './client.js';
import { lastCommand } from './commands.js';
import { projectSessionName } from './project.js';
import { sessionSummary } from './summary.js';
import { listSessions, listTasks, pruneSessions, taskDashboard, taskLogs, taskRecover, taskPrune, taskStart, taskStatus, taskStop } from './tasks.js';
import type { RequestInput, Response } from './protocol.js';

const StatusSchema = z.enum(['running', 'ready', 'repl', 'password', 'confirm', 'editor', 'pager', 'eof', 'unknown']).optional();

function result(data: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError,
  };
}

function responseResult(res: Response): CallToolResult {
  return result(res as unknown as Record<string, unknown>, !res.ok);
}

async function call(req: RequestInput, autostart?: boolean): Promise<CallToolResult> {
  return responseResult(await requestWithDaemon(req, autostart));
}

type ToolArgs = Record<string, unknown>;

function registerRequestTool(server: McpServer, name: string, description: string, inputSchema: Record<string, z.ZodType>, build: (args: ToolArgs) => RequestInput, opts: { autostartArg?: boolean } = {}): void {
  server.registerTool(name, { description, inputSchema }, async (args) => call(build(args as ToolArgs), opts.autostartArg && 'autostart' in args ? Boolean(args.autostart) : false));
}

function s(args: ToolArgs, key: string): string {
  return args[key] as string;
}

function os(args: ToolArgs, key: string): string | undefined {
  return args[key] as string | undefined;
}

function n(args: ToolArgs, key: string): number {
  return args[key] as number;
}

function on(args: ToolArgs, key: string): number | undefined {
  return args[key] as number | undefined;
}

function ob(args: ToolArgs, key: string): boolean | undefined {
  return args[key] as boolean | undefined;
}

const autostart = z.boolean().optional().describe('Start termdeckd when it is not running.');
const session = z.string().describe('TermDeck session id.');
const timeoutMs = z.number().int().positive().optional();
const quiescenceMs = z.number().int().positive().optional();
const stripAnsi = z.boolean().optional().default(true);
const raw = z.boolean().optional().describe('Return raw terminal output with ANSI escapes.');

const runLike = {
  session,
  timeoutMs,
  quiescenceMs,
  raw,
};

export function createServer(): McpServer {
  const server = new McpServer({ name: 'termdeck', version: '0.3.0' });

  server.registerTool('list_sessions', {
    description: 'List TermDeck sessions with optional cwd/name/status filters.',
    inputSchema: { cwd: z.string().optional(), name: z.string().optional(), status: StatusSchema, autostart },
  }, async (args) => responseResult(await listSessions(args)));

  server.registerTool('prune_sessions', {
    description: 'Kill sessions matching optional cwd/name/status filters.',
    inputSchema: { cwd: z.string().optional(), name: z.string().optional(), status: StatusSchema, autostart },
  }, async (args) => result(await pruneSessions(args)));

  registerRequestTool(server, 'new_session', 'Create a TermDeck session.', {
    session,
    cwd: z.string(),
    shell: z.string().optional(),
    rows: z.number().int().positive().optional(),
    cols: z.number().int().positive().optional(),
    promptRegex: z.string().optional(),
  }, (args) => ({ op: 'new', session: s(args, 'session'), cwd: s(args, 'cwd'), shell: os(args, 'shell'), rows: on(args, 'rows'), cols: on(args, 'cols'), promptRegex: os(args, 'promptRegex') }));

  server.registerTool('step', {
    description: 'Agent-default TermDeck entrypoint. Creates a missing session when cwd is provided, performs one operation, and returns stable JSON.',
    inputSchema: {
      session,
      command: z.string().optional(),
      cwd: z.string().optional(),
      shell: z.string().optional(),
      rows: z.number().int().positive().optional(),
      cols: z.number().int().positive().optional(),
      promptRegex: z.string().optional(),
      op: z.enum(['run', 'poll', 'send', 'paste', 'ctrl', 'signal']).optional().default('run'),
      enter: z.boolean().optional(),
      timeoutMs,
      startupTimeoutMs: z.number().int().positive().optional(),
      quiescenceMs,
      lines: z.number().int().nonnegative().optional().default(0),
      raw,
      autostart,
    },
  }, async (args) => {
    await ensureSession(args.session, { cwd: args.cwd, shell: args.shell, rows: args.rows, cols: args.cols, promptRegex: args.promptRegex, autostart: args.autostart, startupTimeoutMs: args.startupTimeoutMs });
    const common = { session: args.session, timeoutMs: args.timeoutMs, quiescenceMs: args.quiescenceMs, stripAnsi: !args.raw };
    let res: Response;
    switch (args.op) {
      case 'run':
        if (!args.command) return result({ ok: false, error: 'step op run requires command' }, true);
        res = await requestWithDaemon({ op: 'run', ...common, command: args.command }, args.autostart);
        break;
      case 'poll':
        res = await requestWithDaemon({ op: 'poll', ...common }, args.autostart);
        break;
      case 'send':
        if (args.command === undefined) return result({ ok: false, error: 'step op send requires command/data' }, true);
        res = await requestWithDaemon({ op: 'send', ...common, data: args.command }, args.autostart);
        break;
      case 'paste':
        if (args.command === undefined) return result({ ok: false, error: 'step op paste requires command/text' }, true);
        res = await requestWithDaemon({ op: 'paste', ...common, data: args.command, enter: args.enter }, args.autostart);
        break;
      case 'ctrl':
        if (!args.command) return result({ ok: false, error: 'step op ctrl requires command/key' }, true);
        res = await requestWithDaemon({ op: 'ctrl', ...common, key: args.command }, args.autostart);
        break;
      case 'signal':
        if (!args.command) return result({ ok: false, error: 'step op signal requires command/signal' }, true);
        res = await requestWithDaemon({ op: 'signal', ...common, signal: args.command }, args.autostart);
        break;
    }
    if (args.lines > 0) {
      const screen = await requestWithDaemon({ op: 'screen', session: args.session }, args.autostart);
      res = stateSnapshot(res, screen, args.lines);
    }
    return responseResult(await enrichedResponse(args.session, res, args.autostart));
  });

  server.registerTool('project_step', {
    description: 'Project-default step entrypoint. Derives a stable session id from cwd/name, creates it when missing, and returns stable JSON.',
    inputSchema: {
      command: z.string().optional(),
      cwd: z.string().optional(),
      name: z.string().optional(),
      shell: z.string().optional(),
      rows: z.number().int().positive().optional(),
      cols: z.number().int().positive().optional(),
      promptRegex: z.string().optional(),
      op: z.enum(['run', 'poll', 'send', 'paste', 'ctrl', 'signal']).optional().default('run'),
      enter: z.boolean().optional(),
      timeoutMs,
      startupTimeoutMs: z.number().int().positive().optional(),
      quiescenceMs,
      lines: z.number().int().nonnegative().optional().default(0),
      raw,
      autostart,
    },
  }, async (args) => {
    const cwd = args.cwd ?? process.cwd();
    const derivedSession = projectSessionName(cwd, args.name);
    await ensureSession(derivedSession, { cwd, shell: args.shell, rows: args.rows, cols: args.cols, promptRegex: args.promptRegex, autostart: args.autostart, startupTimeoutMs: args.startupTimeoutMs });
    const common = { session: derivedSession, timeoutMs: args.timeoutMs, quiescenceMs: args.quiescenceMs, stripAnsi: !args.raw };
    let res: Response;
    switch (args.op) {
      case 'run':
        if (!args.command) return result({ ok: false, error: 'project_step op run requires command' }, true);
        res = await requestWithDaemon({ op: 'run', ...common, command: args.command }, args.autostart);
        break;
      case 'poll':
        res = await requestWithDaemon({ op: 'poll', ...common }, args.autostart);
        break;
      case 'send':
        if (args.command === undefined) return result({ ok: false, error: 'project_step op send requires command/data' }, true);
        res = await requestWithDaemon({ op: 'send', ...common, data: args.command }, args.autostart);
        break;
      case 'paste':
        if (args.command === undefined) return result({ ok: false, error: 'project_step op paste requires command/text' }, true);
        res = await requestWithDaemon({ op: 'paste', ...common, data: args.command, enter: args.enter }, args.autostart);
        break;
      case 'ctrl':
        if (!args.command) return result({ ok: false, error: 'project_step op ctrl requires command/key' }, true);
        res = await requestWithDaemon({ op: 'ctrl', ...common, key: args.command }, args.autostart);
        break;
      case 'signal':
        if (!args.command) return result({ ok: false, error: 'project_step op signal requires command/signal' }, true);
        res = await requestWithDaemon({ op: 'signal', ...common, signal: args.command }, args.autostart);
        break;
    }
    res = { ...res, metadata: { ...(res.metadata ?? {}), session: derivedSession, cwd } };
    if (args.lines > 0) {
      const screen = await requestWithDaemon({ op: 'screen', session: derivedSession }, args.autostart);
      res = stateSnapshot(res, screen, args.lines);
    }
    return responseResult(await enrichedResponse(derivedSession, res, args.autostart));
  });

  registerRequestTool(server, 'run', 'Run a command in an existing TermDeck session.', { ...runLike, command: z.string(), autostart }, (args) => ({ op: 'run', session: s(args, 'session'), command: s(args, 'command'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'send_input', 'Send raw input to a TermDeck session.', { ...runLike, data: z.string(), autostart }, (args) => ({ op: 'send', session: s(args, 'session'), data: s(args, 'data'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'script', 'Run a multiline script without changing persistent shell state.', { ...runLike, data: z.string(), shell: z.string().optional(), autostart }, (args) => ({ op: 'script', session: s(args, 'session'), data: s(args, 'data'), shell: os(args, 'shell'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'paste', 'Bracketed-paste text into a TermDeck session.', { ...runLike, data: z.string(), enter: z.boolean().optional(), autostart }, (args) => ({ op: 'paste', session: s(args, 'session'), data: s(args, 'data'), enter: ob(args, 'enter'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'ctrl', 'Send a control key to a TermDeck session.', { ...runLike, key: z.string(), autostart }, (args) => ({ op: 'ctrl', session: s(args, 'session'), key: s(args, 'key'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'poll', 'Poll output from a TermDeck session.', { ...runLike, autostart }, (args) => ({ op: 'poll', session: s(args, 'session'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'screen', 'Read rendered screen text.', { session, autostart }, (args) => ({ op: 'screen', session: s(args, 'session') }), { autostartArg: true });
  registerRequestTool(server, 'scrollback', 'Read rendered scrollback text.', { session, lines: z.number().int().positive().optional(), autostart }, (args) => ({ op: 'scrollback', session: s(args, 'session'), lines: on(args, 'lines') }), { autostartArg: true });
  registerRequestTool(server, 'configure', 'Configure session prompt detection.', { session, promptRegex: z.string().optional(), autostart }, (args) => ({ op: 'configure', session: s(args, 'session'), promptRegex: os(args, 'promptRegex') }), { autostartArg: true });
  registerRequestTool(server, 'expect', 'Wait for a regex pattern in session output.', { session, pattern: z.string(), timeoutMs, raw, autostart }, (args) => ({ op: 'expect', session: s(args, 'session'), pattern: s(args, 'pattern'), timeoutMs: on(args, 'timeoutMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'password', 'Send secret input through the password path; does not log the secret to commands.log.', { session, secret: z.string(), timeoutMs, quiescenceMs, autostart }, (args) => ({ op: 'password', session: s(args, 'session'), secret: s(args, 'secret'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs') }), { autostartArg: true });
  registerRequestTool(server, 'transcript', 'Return the raw transcript path for a session.', { session, autostart }, (args) => ({ op: 'transcript', session: s(args, 'session') }), { autostartArg: true });
  registerRequestTool(server, 'resize', 'Resize a TermDeck session.', { session, rows: z.number().int().positive(), cols: z.number().int().positive(), autostart }, (args) => ({ op: 'resize', session: s(args, 'session'), rows: n(args, 'rows'), cols: n(args, 'cols') }), { autostartArg: true });
  server.registerTool('state', {
    description: 'Return session metadata and rendered screen tail.',
    inputSchema: { session, lines: z.number().int().nonnegative().optional().default(12), autostart },
  }, async (args) => {
    const meta = await requestWithDaemon({ op: 'metadata', session: args.session }, args.autostart);
    if (!meta.ok) return responseResult(meta);
    const screen = await requestWithDaemon({ op: 'screen', session: args.session }, args.autostart);
    return responseResult(stateSnapshot(meta, screen, args.lines));
  });
  server.registerTool('summary', {
    description: 'Return a compact agent-oriented session summary with screen tail, output tail, recent events, and likely error lines.',
    inputSchema: { session, lines: z.number().int().positive().optional().default(80), events: z.number().int().positive().optional().default(20), autostart },
  }, async (args) => responseResult(await sessionSummary({ session: args.session, lines: args.lines, events: args.events, autostart: args.autostart })));
  server.registerTool('last_command', {
    description: 'Return the last structured command record for a session.',
    inputSchema: { session },
  }, async (args) => result({ command: lastCommand(args.session) }));
  registerRequestTool(server, 'metadata', 'Return session metadata.', { session, autostart }, (args) => ({ op: 'metadata', session: s(args, 'session') }), { autostartArg: true });
  registerRequestTool(server, 'history', 'List persisted session metadata.', { autostart }, () => ({ op: 'history' }), { autostartArg: true });
  registerRequestTool(server, 'inspect', 'Inspect live or historical session metadata.', { session, autostart }, (args) => ({ op: 'inspect', session: s(args, 'session') }), { autostartArg: true });
  registerRequestTool(server, 'log', 'Read transcript log tail.', { session, lines: z.number().int().positive().optional(), autostart }, (args) => ({ op: 'log', session: s(args, 'session'), lines: on(args, 'lines') }), { autostartArg: true });
  registerRequestTool(server, 'events', 'Read sequenced session events.', { session, afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), autostart }, (args) => ({ op: 'events', session: s(args, 'session'), afterSeq: on(args, 'afterSeq'), limit: on(args, 'limit') }), { autostartArg: true });
  registerRequestTool(server, 'replay', 'Replay transcript into a headless terminal and return reconstructed screen/scrollback.', { session, lines: z.number().int().positive().optional(), autostart }, (args) => ({ op: 'replay', session: s(args, 'session'), lines: on(args, 'lines') }), { autostartArg: true });
  registerRequestTool(server, 'clear_scrollback', 'Clear server-side rendered scrollback for a session.', { session, autostart }, (args) => ({ op: 'clearScrollback', session: s(args, 'session') }), { autostartArg: true });
  registerRequestTool(server, 'expect_prompt', 'Wait for a prompt-like ready state.', { session, timeoutMs, raw, autostart }, (args) => ({ op: 'expectPrompt', session: s(args, 'session'), timeoutMs: on(args, 'timeoutMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'signal', 'Signal the foreground process group.', { session, signal: z.string(), timeoutMs, quiescenceMs, raw, autostart }, (args) => ({ op: 'signal', session: s(args, 'session'), signal: s(args, 'signal'), timeoutMs: on(args, 'timeoutMs'), quiescenceMs: on(args, 'quiescenceMs'), stripAnsi: !ob(args, 'raw') }), { autostartArg: true });
  registerRequestTool(server, 'kill', 'Kill a TermDeck session.', { session, autostart }, (args) => ({ op: 'kill', session: s(args, 'session') }), { autostartArg: true });

  server.registerTool('task_start', {
    description: 'Start a background task backed by a named TermDeck session.',
    inputSchema: {
      name: z.string(),
      command: z.string(),
      cwd: z.string(),
      owner: z.string().optional(),
      labels: z.array(z.string()).optional(),
      ttlMs: z.number().int().positive().optional(),
      restartPolicy: z.enum(['never', 'on-exit', 'on-failure']).optional(),
      maxRestarts: z.number().int().nonnegative().optional(),
      backoffMs: z.number().int().nonnegative().optional(),
      readyUrl: z.string().optional(),
      readyPort: z.number().int().positive().optional(),
      expect: z.string().optional(),
      timeoutMs,
      readyTimeoutMs: z.number().int().positive().optional(),
      quiescenceMs,
      shell: z.string().optional(),
      rows: z.number().int().positive().optional(),
      cols: z.number().int().positive().optional(),
      promptRegex: z.string().optional(),
      autostart,
    },
  }, async (args) => result(await taskStart(args)));

  server.registerTool('task_status', {
    description: 'Check status and readiness for a background task.',
    inputSchema: { name: z.string(), timeoutMs, autostart },
  }, async (args) => result(await taskStatus(args.name, { timeoutMs: args.timeoutMs, autostart: args.autostart })));

  server.registerTool('task_recover', {
    description: 'Recover a stale task by recreating its TermDeck session from persisted task metadata and rerunning its command.',
    inputSchema: { name: z.string(), timeoutMs, readyTimeoutMs: z.number().int().positive().optional(), quiescenceMs, autostart },
  }, async (args) => result(await taskRecover(args.name, { timeoutMs: args.timeoutMs, readyTimeoutMs: args.readyTimeoutMs, quiescenceMs: args.quiescenceMs, autostart: args.autostart })));

  server.registerTool('task_logs', {
    description: 'Read background task transcript logs.',
    inputSchema: { name: z.string(), lines: z.number().int().positive().optional().default(200), autostart },
  }, async (args) => responseResult(await taskLogs(args.name, args.lines, args.autostart)));

  server.registerTool('task_stop', {
    description: 'Stop a background task and remove its task metadata.',
    inputSchema: { name: z.string(), autostart },
  }, async (args) => result(await taskStop(args.name, args.autostart)));

  server.registerTool('task_list', {
    description: 'List known background task metadata.',
    inputSchema: {},
  }, async () => result({ tasks: listTasks() }));

  server.registerTool('task_dashboard', {
    description: 'Return task statuses plus orphan task sessions that have no task metadata.',
    inputSchema: { timeoutMs, autostart },
  }, async (args) => result(await taskDashboard({ timeoutMs: args.timeoutMs, autostart: args.autostart })));

  server.registerTool('task_prune', {
    description: 'Remove stale and/or expired task metadata.',
    inputSchema: { stale: z.boolean().optional(), expired: z.boolean().optional(), dryRun: z.boolean().optional(), autostart },
  }, async (args) => result(await taskPrune({ stale: args.stale, expired: args.expired, dryRun: args.dryRun, autostart: args.autostart })));

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
