import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from './paths.js';

export function sensitivePath(session: string): string {
  return join(sessionDir(session), 'sensitive');
}

export function isSensitiveSession(session: string): boolean {
  return existsSync(sensitivePath(session));
}

export function setSensitiveSession(session: string, enabled: boolean): { session: string; sensitive: boolean; path: string } {
  const file = sensitivePath(session);
  mkdirSync(sessionDir(session), { recursive: true, mode: 0o700 });
  if (enabled) writeFileSync(file, '1\n', { mode: 0o600 });
  else rmSync(file, { force: true });
  return { session, sensitive: enabled, path: file };
}
