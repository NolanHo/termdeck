import test from 'node:test';
import assert from 'node:assert/strict';
import { detectState } from '../src/state.js';

test('detects password prompt from recent screen lines', () => {
  assert.equal(detectState('ssh host\nPassword:').status, 'password');
});

test('detects confirmation prompt from recent screen lines', () => {
  assert.equal(detectState('continue? [y/N]').status, 'confirm');
});

test('detects ready prompt using custom regex', () => {
  assert.deepEqual(detectState('repo main >', '.*>\\s*$'), {
    status: 'ready',
    reason: 'custom prompt regex',
    prompt: 'shell',
  });
});

test('detects python prompt as repl', () => {
  assert.deepEqual(detectState('>>> '), {
    status: 'repl',
    reason: 'python prompt',
    prompt: 'python',
  });
});

test('detects pdb prompt as repl', () => {
  assert.deepEqual(detectState('(Pdb) '), {
    status: 'repl',
    reason: 'pdb prompt',
    prompt: 'pdb',
  });
});

test('detects editor markers', () => {
  assert.deepEqual(detectState('file.txt\n-- INSERT --'), {
    status: 'editor',
    reason: 'editor marker',
    prompt: 'editor',
  });
});

test('detects shell continuation prompt', () => {
  assert.deepEqual(detectState('bash$ printf "unterminated\n> '), {
    status: 'running',
    reason: 'shell continuation prompt',
    prompt: 'continuation',
  });
});

test('falls back to running when no prompt matches', () => {
  assert.equal(detectState('building\nstep 1').status, 'running');
});
