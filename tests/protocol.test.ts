import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encodeFrame, FrameReader, type Event, type Frame, type Request, type Response } from '../src/protocol.js';

class FakeSocket extends EventEmitter {
  write(): void {}
}

async function roundtrip(frame: Frame): Promise<Frame> {
  const socket = new FakeSocket();
  const reader = new FrameReader(socket as never);
  const wait = new Promise<Frame>((resolve, reject) => {
    reader.once('frame', (f) => resolve(f as Frame));
    reader.once('error', reject);
  });
  socket.emit('data', encodeFrame(frame));
  return wait;
}

test('roundtrips protobuf request frame', async () => {
  const payload: Request = { id: 7, op: 'run', session: 'dev', command: 'pwd', timeoutMs: 1000 };
  assert.deepEqual(await roundtrip({ type: 'request', payload }), { type: 'request', payload });
});

test('roundtrips protobuf response frame', async () => {
  const payload: Response = { id: 8, ok: true, status: 'ready', output: 'ok', lastSeq: 3 };
  assert.deepEqual(await roundtrip({ type: 'response', payload }), { type: 'response', payload: { ...payload, timedOut: false, sessions: [] } });
});

test('roundtrips protobuf event frame', async () => {
  const payload: Event = { seq: 9, tsMs: 123, session: 'dev', kind: 'output', data: 'hello' };
  assert.deepEqual(await roundtrip({ type: 'event', payload }), { type: 'event', payload });
});
