import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ConfigureSchema,
  ControlSchema,
  EnvelopeSchema,
  EventSchema,
  ExitSchema,
  KillSchema,
  ListSessionsSchema,
  NewSessionSchema,
  PollSchema,
  RequestSchema,
  ResponseSchema,
  RunSchema,
  ScreenSchema,
  ScrollbackSchema,
  SendSchema,
  SessionInfoSchema,
  SubscribeSchema,
  StateSchema,
  type Envelope,
  type Event as PbEvent,
  type Request as PbRequest,
  type Response as PbResponse,
} from './gen/termdeck/v1/termdeck_pb.js';

export type Status = 'running' | 'ready' | 'password' | 'confirm' | 'eof' | 'unknown';

export type Request =
  | { id: number; op: 'new'; session: string; cwd: string; shell?: string; rows?: number; cols?: number; promptRegex?: string }
  | { id: number; op: 'run'; session: string; command: string; timeoutMs?: number; quiescenceMs?: number }
  | { id: number; op: 'send'; session: string; data: string; timeoutMs?: number; quiescenceMs?: number }
  | { id: number; op: 'ctrl'; session: string; key: string; timeoutMs?: number; quiescenceMs?: number }
  | { id: number; op: 'poll'; session: string; timeoutMs?: number; quiescenceMs?: number }
  | { id: number; op: 'screen'; session: string }
  | { id: number; op: 'scrollback'; session: string; lines?: number }
  | { id: number; op: 'list' }
  | { id: number; op: 'kill'; session: string }
  | { id: number; op: 'subscribe'; session: string; afterSeq?: number }
  | { id: number; op: 'configure'; session: string; promptRegex?: string };

export type RequestInput = Request extends infer R ? R extends Request ? Omit<R, 'id'> : never : never;

export type Response = {
  id: number;
  ok: boolean;
  error?: string;
  status?: Status;
  output?: string;
  screen?: string;
  timedOut?: boolean;
  sessions?: Array<{ id: string; cwd: string; rows: number; cols: number; status: Status; lastSeq: number; promptRegex?: string }>;
  lastSeq?: number;
};

export type Event =
  | { seq: number; tsMs: number; session: string; kind: 'output'; data: string }
  | { seq: number; tsMs: number; session: string; kind: 'input'; data: string }
  | { seq: number; tsMs: number; session: string; kind: 'state'; status: Status; reason: string }
  | { seq: number; tsMs: number; session: string; kind: 'exit'; code?: number; signal?: string };

export type Frame = { type: 'request'; payload: Request } | { type: 'response'; payload: Response } | { type: 'event'; payload: Event };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(frame: Frame): Buffer {
  const body = toBinary(EnvelopeSchema, toEnvelope(frame));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, Buffer.from(body)]);
}

export class FrameReader extends EventEmitter {
  private buf = Buffer.alloc(0);

  constructor(private readonly socket: Socket) {
    super();
    socket.on('data', (chunk) => this.push(Buffer.from(chunk)));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => this.emit('close'));
  }

  private push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) return;
      const body = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      try {
        this.emit('frame', fromEnvelope(fromBinary(EnvelopeSchema, body)));
      } catch (err) {
        this.emit('error', err);
      }
    }
  }
}

export function writeFrame(socket: Socket, frame: Frame): void {
  socket.write(encodeFrame(frame));
}

function toEnvelope(frame: Frame): Envelope {
  if (frame.type === 'request') {
    return create(EnvelopeSchema, { id: BigInt(frame.payload.id), body: { case: 'request', value: toPbRequest(frame.payload) } });
  }
  if (frame.type === 'response') {
    return create(EnvelopeSchema, { id: BigInt(frame.payload.id), body: { case: 'response', value: toPbResponse(frame.payload) } });
  }
  return create(EnvelopeSchema, { id: BigInt(frame.payload.seq), seq: BigInt(frame.payload.seq), body: { case: 'event', value: toPbEvent(frame.payload) } });
}

function fromEnvelope(env: Envelope): Frame {
  switch (env.body.case) {
    case 'request':
      return { type: 'request', payload: fromPbRequest(Number(env.id), env.body.value) };
    case 'response':
      return { type: 'response', payload: fromPbResponse(Number(env.id), env.body.value) };
    case 'event':
      return { type: 'event', payload: fromPbEvent(env.body.value) };
    default:
      throw new Error('empty envelope');
  }
}

function toPbRequest(req: Request): PbRequest {
  const session = 'session' in req ? req.session : '';
  switch (req.op) {
    case 'new':
      return create(RequestSchema, { session, op: { case: 'newSession', value: create(NewSessionSchema, { cwd: req.cwd, shell: req.shell ?? '', rows: req.rows ?? 0, cols: req.cols ?? 0, promptRegex: req.promptRegex ?? '' }) } });
    case 'run':
      return create(RequestSchema, { session, op: { case: 'run', value: create(RunSchema, { command: req.command, timeoutMs: req.timeoutMs ?? 0, quiescenceMs: req.quiescenceMs ?? 0 }) } });
    case 'send':
      return create(RequestSchema, { session, op: { case: 'send', value: create(SendSchema, { data: enc.encode(req.data), timeoutMs: req.timeoutMs ?? 0, quiescenceMs: req.quiescenceMs ?? 0 }) } });
    case 'ctrl':
      return create(RequestSchema, { session, op: { case: 'control', value: create(ControlSchema, { key: req.key, timeoutMs: req.timeoutMs ?? 0, quiescenceMs: req.quiescenceMs ?? 0 }) } });
    case 'poll':
      return create(RequestSchema, { session, op: { case: 'poll', value: create(PollSchema, { timeoutMs: req.timeoutMs ?? 0, quiescenceMs: req.quiescenceMs ?? 0 }) } });
    case 'screen':
      return create(RequestSchema, { session, op: { case: 'screen', value: create(ScreenSchema) } });
    case 'scrollback':
      return create(RequestSchema, { session, op: { case: 'scrollback', value: create(ScrollbackSchema, { lines: req.lines ?? 0 }) } });
    case 'list':
      return create(RequestSchema, { op: { case: 'listSessions', value: create(ListSessionsSchema) } });
    case 'kill':
      return create(RequestSchema, { session, op: { case: 'kill', value: create(KillSchema) } });
    case 'subscribe':
      return create(RequestSchema, { session, op: { case: 'subscribe', value: create(SubscribeSchema, { afterSeq: BigInt(req.afterSeq ?? 0) }) } });
    case 'configure':
      return create(RequestSchema, { session, op: { case: 'configure', value: create(ConfigureSchema, { promptRegex: req.promptRegex ?? '' }) } });
  }
}

function fromPbRequest(id: number, req: PbRequest): Request {
  const session = req.session;
  switch (req.op.case) {
    case 'newSession':
      return withDefined({ id, op: 'new', session, cwd: req.op.value.cwd, shell: req.op.value.shell || undefined, rows: req.op.value.rows || undefined, cols: req.op.value.cols || undefined, promptRegex: req.op.value.promptRegex || undefined }) as Request;
    case 'run':
      return withDefined({ id, op: 'run', session, command: req.op.value.command, timeoutMs: req.op.value.timeoutMs || undefined, quiescenceMs: req.op.value.quiescenceMs || undefined }) as Request;
    case 'send':
      return withDefined({ id, op: 'send', session, data: dec.decode(req.op.value.data), timeoutMs: req.op.value.timeoutMs || undefined, quiescenceMs: req.op.value.quiescenceMs || undefined }) as Request;
    case 'control':
      return withDefined({ id, op: 'ctrl', session, key: req.op.value.key, timeoutMs: req.op.value.timeoutMs || undefined, quiescenceMs: req.op.value.quiescenceMs || undefined }) as Request;
    case 'poll':
      return withDefined({ id, op: 'poll', session, timeoutMs: req.op.value.timeoutMs || undefined, quiescenceMs: req.op.value.quiescenceMs || undefined }) as Request;
    case 'screen':
      return { id, op: 'screen', session };
    case 'scrollback':
      return withDefined({ id, op: 'scrollback', session, lines: req.op.value.lines || undefined }) as Request;
    case 'listSessions':
      return { id, op: 'list' };
    case 'kill':
      return { id, op: 'kill', session };
    case 'subscribe':
      return { id, op: 'subscribe', session, afterSeq: Number(req.op.value.afterSeq) };
    case 'configure':
      return withDefined({ id, op: 'configure', session, promptRegex: req.op.value.promptRegex || undefined }) as Request;
    default:
      throw new Error('empty request op');
  }
}

function withDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function toPbResponse(res: Response): PbResponse {
  return create(ResponseSchema, {
    ok: res.ok,
    error: res.error ?? '',
    status: res.status ?? '',
    output: res.output ?? '',
    screen: res.screen ?? '',
    timedOut: res.timedOut ?? false,
    lastSeq: BigInt(res.lastSeq ?? 0),
    sessions: (res.sessions ?? []).map((s) => create(SessionInfoSchema, { ...s, lastSeq: BigInt(s.lastSeq), promptRegex: s.promptRegex ?? '' })),
  });
}

function fromPbResponse(id: number, res: PbResponse): Response {
  const out: Response = { id, ok: res.ok, timedOut: res.timedOut, lastSeq: Number(res.lastSeq), sessions: res.sessions.map((s) => withDefined({ id: s.id, cwd: s.cwd, rows: s.rows, cols: s.cols, status: s.status as Status, lastSeq: Number(s.lastSeq), promptRegex: s.promptRegex || undefined }) as { id: string; cwd: string; rows: number; cols: number; status: Status; lastSeq: number; promptRegex?: string }) };
  if (res.error) out.error = res.error;
  if (res.status) out.status = res.status as Status;
  if (res.output) out.output = res.output;
  if (res.screen) out.screen = res.screen;
  return out;
}

function toPbEvent(event: Event): PbEvent {
  const base = { session: event.session, seq: BigInt(event.seq), tsMs: BigInt(event.tsMs) };
  switch (event.kind) {
    case 'output':
      return create(EventSchema, { ...base, kind: { case: 'output', value: enc.encode(event.data) } });
    case 'input':
      return create(EventSchema, { ...base, kind: { case: 'input', value: enc.encode(event.data) } });
    case 'state':
      return create(EventSchema, { ...base, kind: { case: 'state', value: create(StateSchema, { status: event.status, reason: event.reason }) } });
    case 'exit':
      return create(EventSchema, { ...base, kind: { case: 'exit', value: create(ExitSchema, { code: event.code ?? 0, signal: event.signal ?? '' }) } });
  }
}

function fromPbEvent(event: PbEvent): Event {
  const base = { session: event.session, seq: Number(event.seq), tsMs: Number(event.tsMs) };
  switch (event.kind.case) {
    case 'output':
      return { ...base, kind: 'output', data: dec.decode(event.kind.value) };
    case 'input':
      return { ...base, kind: 'input', data: dec.decode(event.kind.value) };
    case 'state':
      return { ...base, kind: 'state', status: event.kind.value.status as Status, reason: event.kind.value.reason };
    case 'exit':
      return { ...base, kind: 'exit', code: event.kind.value.code, signal: event.kind.value.signal || undefined };
    default:
      throw new Error('empty event kind');
  }
}
