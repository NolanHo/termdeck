import { createReadStream } from 'node:fs';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export type ReplayResult = { screen: string; scrollback: string; rows: number; cols: number };

export async function replayTranscript(path: string, rows = 30, cols = 120, scrollbackLines = 500): Promise<ReplayResult> {
  const term = new Terminal({ rows, cols, allowProposedApi: true });
  for await (const chunk of createReadStream(path)) {
    await new Promise<void>((resolve) => term.write(chunk as Buffer, resolve));
  }
  return { screen: render(term, rows), scrollback: renderScrollback(term, scrollbackLines), rows, cols };
}

function render(term: InstanceType<typeof Terminal>, rows: number): string {
  const out: string[] = [];
  const buffer = term.buffer.active;
  for (let i = 0; i < rows; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function renderScrollback(term: InstanceType<typeof Terminal>, lines: number): string {
  const out: string[] = [];
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.length - lines);
  for (let i = start; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\n+$/, '');
}
