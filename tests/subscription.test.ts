import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../src/session.js';

test('eventsAfter returns only later events for replay', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-replay-'));
  const s = new TermSession({ id: `replay-${process.pid}`, cwd, rows: 24, cols: 80 });
  try {
    await s.run('printf one', 3_000, 100);
    const mark = s.info().lastSeq;
    await s.run('printf two', 3_000, 100);
    const later = s.eventsAfter(mark);
    assert.ok(later.length > 0);
    assert.ok(later.every((e) => e.seq > mark));
    assert.ok(later.some((e) => e.kind === 'output' && e.data.includes('two')));
    assert.equal(later.some((e) => e.kind === 'output' && e.data.includes('one')), false);
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
