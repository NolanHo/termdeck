import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../src/session.js';
import { lastCommand } from '../src/commands.js';

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
    const last = lastCommand(s.id);
    assert.equal(last?.data, 'printf marker-ok; false');
    assert.equal(last?.exitCode, 1);
    assert.match(last?.outputTail ?? '', /marker-ok/);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('agent-facing text redacts returned text and last command by default', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-redact-'));
  const s = new TermSession({ id: `redact-${process.pid}`, cwd, rows: 24, cols: 80, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    const r = await s.run('printf "api_key=secret-value"', 3_000, 100);
    assert.doesNotMatch(r.output, /secret-value/);
    assert.match(r.output, /\[REDACTED\]/);
    const last = lastCommand(s.id);
    assert.doesNotMatch(JSON.stringify(last), /secret-value/);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
