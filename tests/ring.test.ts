import test from 'node:test';
import assert from 'node:assert/strict';
import { TextRing } from '../src/ring.js';

test('returns text since mark', () => {
  const r = new TextRing(100);
  r.push('one');
  const m = r.mark();
  r.push('two');
  r.push('three');
  assert.equal(r.since(m), 'twothree');
});

test('keeps bounded tail', () => {
  const r = new TextRing(5);
  r.push('abc');
  r.push('def');
  assert.equal(r.all(), 'bcdef');
});
