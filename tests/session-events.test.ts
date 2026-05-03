import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TermSession } from '../src/session.js';

function onceEvent(s: TermSession): Promise<unknown> {
  return new Promise((resolve) => s.once('event', resolve));
}

test('session appends ordered output events', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'termdeck-events-'));
  const s = new TermSession({ id: `events-${process.pid}`, cwd, rows: 24, cols: 80 });
  try {
    const eventPromise = onceEvent(s);
    const r = await s.run('printf event-ok', 3_000, 100);
    assert.match(r.output, /event-ok/);
    await eventPromise;
    const events = s.eventsAfter(0);
    assert.ok(events.some((e) => e.kind === 'output' && e.data.includes('event-ok')));
    assert.deepEqual(events.map((e) => e.seq), [...events].map((_, i) => i + 1));
  } finally {
    s.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
