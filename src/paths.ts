import { homedir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';

export const rootDir = process.env.TERMDECK_HOME ?? join(homedir(), '.termdeck');
export const socketPath = process.env.TERMDECK_SOCKET ?? (platform() === 'win32' ? '\\\\.\\pipe\\termdeckd' : join(rootDir, 'termdeckd.sock'));
export const sessionsDir = join(rootDir, 'sessions');
export const daemonLogPath = join(rootDir, 'termdeckd.log');

export function sessionDir(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(sessionsDir, safe);
}
