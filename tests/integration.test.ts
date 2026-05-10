import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { err += String(b); });
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed ${code}: ${err}`)));
  });
}

async function waitSocket(env: NodeJS.ProcessEnv): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await run('tsx', ['src/cli.ts', 'list'], env);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not become ready');
}

test('daemon cli and web smoke', async () => {
  const home = mkdtempSync(join(tmpdir(), 'termdeck-int-'));
  const env = { ...process.env, TERMDECK_HOME: home, TERMDECK_WEB_PORT: '8876' };
  const daemon = spawn('tsx', ['src/daemon.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await waitSocket(env);
    await run('tsx', ['src/cli.ts', 'new', 'int', '--cwd', process.cwd()], env);
    const out = await run('tsx', ['src/cli.ts', 'run', 'int', 'printf int-ok'], env);
    assert.match(out, /int-ok/);
    const step = await run('tsx', ['src/cli.ts', 'step', 'int', 'printf step-ok', '--timeout-ms', '5000'], env);
    assert.match(step, /step-ok/);
    assert.match(step, /\[termdeck\] status=ready/);
    assert.match(step, /reason="custom prompt regex"|reason="default prompt regex"/);
    const state = await run('tsx', ['src/cli.ts', 'state', 'int', '--lines', '5'], env);
    assert.match(state, /\[termdeck\] status=ready/);
    assert.match(await run('tsx', ['src/cli.ts', 'log', 'int', '--lines', '20'], env), /int-ok/);
    const searchOut = await run('tsx', ['src/cli.ts', 'search', 'int-ok', '--json'], env);
    const search = JSON.parse(searchOut) as { hits?: Array<{ session?: string; kind?: string }> };
    assert.ok(search.hits?.some((hit) => hit.session === 'int' && hit.kind === 'transcript'));
    const res = await fetch('http://127.0.0.1:8876/api/sessions');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /int/);
    const searchRes = await fetch('http://127.0.0.1:8876/api/search?q=int-ok');
    assert.equal(searchRes.status, 200);
    assert.match(await searchRes.text(), /int-ok/);
    await run('tsx', ['src/cli.ts', 'task', 'start', 'webtask', 'printf web-task-ok', '--cwd', process.cwd(), '--expect', 'web-task-ok', '--json'], env);
    const tasksRes = await fetch('http://127.0.0.1:8876/api/tasks');
    assert.equal(tasksRes.status, 200);
    const tasks = await tasksRes.json() as { tasks?: Array<{ name: string; ready: boolean }>; orphanSessions?: unknown[] };
    assert.ok(tasks.tasks?.some((task) => task.name === 'webtask'));
    assert.ok(Array.isArray(tasks.orphanSessions));
    const stopRes = await fetch('http://127.0.0.1:8876/api/tasks/webtask/stop', { method: 'POST' });
    assert.equal(stopRes.status, 200);
    const restartOut = await run('tsx', ['src/cli.ts', 'task', 'start', 'restart-once', 'false', '--cwd', process.cwd(), '--restart-policy', 'on-failure', '--max-restarts', '1', '--json'], env);
    const restart = JSON.parse(restartOut) as { restartCount?: number; processExited?: boolean };
    assert.equal(restart.restartCount, 1);
    assert.equal(restart.processExited, true);
  } finally {
    daemon.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});
