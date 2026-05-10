import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactValue } from './redact.js';
import { isSensitiveSession } from './sensitive.js';
import { sessionDir } from './paths.js';

export type LastCommand = {
  id: string;
  kind: string;
  data: string;
  tsMs: number;
  startSeq?: number;
  endSeq?: number;
  durationMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  outputTail?: string;
};

export function lastCommand(session: string): LastCommand | undefined {
  const file = join(sessionDir(session), 'commands.log');
  if (!existsSync(file)) return undefined;
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const byId = new Map<string, Partial<LastCommand>>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row) as Partial<LastCommand> & { result?: Partial<LastCommand> };
      const id = parsed.id ?? `${parsed.tsMs ?? byId.size}`;
      const current = byId.get(id) ?? {};
      byId.set(id, { ...current, ...parsed, ...(parsed.result ?? {}) });
    } catch {}
  }
  const last = [...byId.values()].filter((row): row is LastCommand => typeof row.data === 'string' && typeof row.tsMs === 'number').at(-1);
  if (!last) return undefined;
  return isSensitiveSession(session) ? redactValue(last) as LastCommand : last;
}
