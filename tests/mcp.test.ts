import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('mcp server exposes termdeck tools and can step through daemon', async () => {
  const home = mkdtempSync(join(tmpdir(), 'termdeck-mcp-'));
  const client = new Client({ name: 'termdeck-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: 'tsx',
    args: ['src/mcp.ts'],
    cwd: process.cwd(),
    env: { ...process.env, TERMDECK_HOME: home, TERMDECK_WEB_PORT: '8877' } as Record<string, string>,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const name of ['list_sessions', 'new_session', 'step', 'project_step', 'run', 'poll', 'state', 'summary', 'scrollback', 'transcript', 'expect', 'expect_prompt', 'send_input', 'paste', 'ctrl', 'signal', 'kill', 'task_start', 'task_status', 'task_recover', 'task_logs', 'task_dashboard', 'task_prune', 'task_stop']) {
      assert.ok(names.includes(name), `missing MCP tool ${name}`);
    }
    const step = await client.callTool({
      name: 'step',
      arguments: {
        session: 'mcp',
        command: 'printf mcp-ok',
        cwd: process.cwd(),
        autostart: true,
        timeoutMs: 5_000,
      },
    });
    assert.equal(step.isError, false);
    assert.match(JSON.stringify(step.structuredContent), /mcp-ok/);
    assert.match(JSON.stringify(step.structuredContent), /transcriptPath/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
