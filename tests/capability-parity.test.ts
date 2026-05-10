import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { err += String(b); });
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed ${code}: ${err}`)));
  });
}

async function mcpToolNames(): Promise<string[]> {
  const client = new Client({ name: 'termdeck-parity-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: 'tsx',
    args: ['src/mcp.ts'],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

test('CLI and MCP expose equivalent public capability surface', async () => {
  const [mainHelp, taskHelp, tools] = await Promise.all([
    run('tsx', ['src/cli.ts', '--help']),
    run('tsx', ['src/cli.ts', 'task', '--help']),
    mcpToolNames(),
  ]);
  const mcp = new Set(tools);
  const pairs = [
    ['new', 'new_session'],
    ['state', 'state'],
    ['summary', 'summary'],
    ['step', 'step'],
    ['project-step', 'project_step'],
    ['run', 'run'],
    ['send', 'send_input'],
    ['script', 'script'],
    ['paste', 'paste'],
    ['ctrl', 'ctrl'],
    ['poll', 'poll'],
    ['screen', 'screen'],
    ['scrollback', 'scrollback'],
    ['list', 'list_sessions'],
    ['prune', 'prune_sessions'],
    ['configure', 'configure'],
    ['expect', 'expect'],
    ['password', 'password'],
    ['transcript', 'transcript'],
    ['resize', 'resize'],
    ['metadata', 'metadata'],
    ['history', 'history'],
    ['inspect', 'inspect'],
    ['log', 'log'],
    ['events', 'events'],
    ['replay', 'replay'],
    ['clear-scrollback', 'clear_scrollback'],
    ['expect-prompt', 'expect_prompt'],
    ['signal', 'signal'],
    ['kill', 'kill'],
  ] as const;
  for (const [cli, tool] of pairs) {
    assert.match(mainHelp, new RegExp(`\\b${cli}\\b`), `missing CLI command ${cli}`);
    assert.ok(mcp.has(tool), `missing MCP tool ${tool}`);
  }
  const taskPairs = [
    ['start', 'task_start'],
    ['status', 'task_status'],
    ['recover', 'task_recover'],
    ['logs', 'task_logs'],
    ['list', 'task_list'],
    ['stop', 'task_stop'],
  ] as const;
  for (const [cli, tool] of taskPairs) {
    assert.match(taskHelp, new RegExp(`\\b${cli}\\b`), `missing CLI task command ${cli}`);
    assert.ok(mcp.has(tool), `missing MCP task tool ${tool}`);
  }
});
