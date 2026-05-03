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
    const out = await run('tsx', ['src/cli.ts', 'run', 'int', 'printf int-ok', '--strip-ansi'], env);
    assert.match(out, /int-ok/);
    assert.match(await run('tsx', ['src/cli.ts', 'log', 'int', '--lines', '5'], env), /int-ok/);
    const res = await fetch('http://127.0.0.1:8876/api/sessions');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /int/);
  } finally {
    daemon.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
});
