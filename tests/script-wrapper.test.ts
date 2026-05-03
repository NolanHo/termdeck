import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../src/session.js';

test('script runs quoted multiline blocks without leaving shell continuation state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-script-'));
  const s = new TermSession({ id: `script-${process.pid}-${Date.now()}`, cwd, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    const command = 'printf "A=%s\\n" "quoted value"\nprintf "B=%s\\n" "second value"';
    const r = await s.script(command, 5000, 200);
    assert.match(r.output, /A=quoted value/);
    assert.match(r.output, /B=second value/);
    const prompt = await s.expectPrompt(5000);
    assert.equal(prompt.matched, true);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run preserves interactive shell state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-run-'));
  const s = new TermSession({ id: `run-${process.pid}-${Date.now()}`, cwd, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    await s.run('export TERMDECK_RUN_STATE=kept', 5000, 200);
    const r = await s.run('printf "$TERMDECK_RUN_STATE"', 5000, 200);
    assert.match(r.output, /kept/);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('paste uses bracketed paste and can submit input', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-paste-'));
  const s = new TermSession({ id: `paste-${process.pid}-${Date.now()}`, cwd, shell: 'bash', promptRegex: '.*[$#>]\\s*$' });
  try {
    const r = await s.paste('printf paste-ok', true, 5000, 200);
    assert.match(r.output, /paste-ok/);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
