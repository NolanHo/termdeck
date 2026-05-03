import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../src/session.js';

test('run wraps quoted multiline commands without leaving shell continuation state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-script-'));
  const s = new TermSession({ id: `script-${process.pid}-${Date.now()}`, cwd });
  try {
    const command = 'printf "A=%s\\n" "quoted value"\nprintf "B=%s\\n" "second value"';
    const r = await s.run(command, 5000, 200);
    assert.match(r.output, /A=quoted value/);
    assert.match(r.output, /B=second value/);
    const prompt = await s.expectPrompt(5000);
    assert.equal(prompt.matched, true);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
