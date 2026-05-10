import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../src/session.js';

test('session writes metadata state command and interaction logs', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-meta-'));
  const id = `meta-${process.pid}`;
  const s = new TermSession({ id, cwd, rows: 24, cols: 80, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    await s.run('printf meta-ok', 3_000, 100);
    const meta = s.metadata();
    for (const key of ['transcript', 'events', 'commands', 'interaction', 'state', 'session']) {
      assert.equal(existsSync(String(meta[key])), true, key);
    }
    assert.match(readFileSync(String(meta.commands), 'utf8'), /printf meta-ok/);
    assert.match(readFileSync(String(meta.interaction), 'utf8'), /meta-ok/);
    assert.equal(meta.cwd, cwd);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('expectPrompt matches current ready state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-prompt-'));
  const s = new TermSession({ id: `prompt-${process.pid}`, cwd, rows: 24, cols: 80, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    await s.run('printf prompt-ok', 3_000, 100);
    const r = await s.expectPrompt(100);
    assert.equal(r.matched, true);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run markers return command output and exit code without logging wrapper', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-run-marker-'));
  const s = new TermSession({ id: `marker-${process.pid}`, cwd, rows: 24, cols: 80, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    const r = await s.run('printf marker-ok; false', 3_000, 100);
    assert.equal(r.output, 'marker-ok');
    assert.equal(r.exitCode, 1);
    const commands = readFileSync(String(s.metadata().commands), 'utf8');
    assert.match(commands, /printf marker-ok; false/);
    assert.doesNotMatch(commands, /TERMDECK_RUN_/);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
