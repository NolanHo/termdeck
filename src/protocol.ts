import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

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
  | { id: number; op: 'kill'; session: string };

export type RequestInput = Request extends infer R ? R extends Request ? Omit<R, 'id'> : never : never;

export type Response = {
  id: number;
  ok: boolean;
  error?: string;
  status?: Status;
  output?: string;
  screen?: string;
  timedOut?: boolean;
  sessions?: Array<{ id: string; cwd: string; rows: number; cols: number; status: Status; lastSeq: number }>;
  lastSeq?: number;
};

export type Event =
  | { seq: number; tsMs: number; session: string; kind: 'output'; data: string }
  | { seq: number; tsMs: number; session: string; kind: 'input'; data: string }
  | { seq: number; tsMs: number; session: string; kind: 'state'; status: Status; reason: string }
  | { seq: number; tsMs: number; session: string; kind: 'exit'; code?: number; signal?: string };

export type Frame = { type: 'request'; payload: Request } | { type: 'response'; payload: Response } | { type: 'event'; payload: Event };

export function encodeFrame(frame: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
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
        this.emit('frame', JSON.parse(body.toString('utf8')) as Frame);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }
}

export function writeFrame(socket: Socket, frame: Frame): void {
  socket.write(encodeFrame(frame));
}
