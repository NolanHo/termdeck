import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const userRootDir = join(homedir(), '.termdeck');
const systemRootDir = '/var/lib/termdeck';

function initialRootDir(): string {
  if (process.env.TERMDECK_HOME) return process.env.TERMDECK_HOME;
  if (!process.env.TERMDECK_SOCKET && existsSync(join(systemRootDir, 'termdeckd.sock'))) return systemRootDir;
  return userRootDir;
}

export let rootDir = initialRootDir();
export let socketPath = process.env.TERMDECK_SOCKET ?? join(rootDir, 'termdeckd.sock');
export let sessionsDir = join(rootDir, 'sessions');
export let daemonLogPath = join(rootDir, 'termdeckd.log');

export function setActiveTermDeckRoot(nextRootDir: string, nextSocketPath = join(nextRootDir, 'termdeckd.sock')): void {
  rootDir = nextRootDir;
  socketPath = nextSocketPath;
  sessionsDir = join(rootDir, 'sessions');
  daemonLogPath = join(rootDir, 'termdeckd.log');
}

export function candidateSockets(): Array<{ rootDir: string; socketPath: string }> {
  if (process.env.TERMDECK_SOCKET) {
    return [{ rootDir, socketPath: process.env.TERMDECK_SOCKET }];
  }
  if (process.env.TERMDECK_HOME) {
    return [{ rootDir: process.env.TERMDECK_HOME, socketPath }];
  }
  const candidates = [
    { rootDir: systemRootDir, socketPath: join(systemRootDir, 'termdeckd.sock') },
    { rootDir: userRootDir, socketPath: join(userRootDir, 'termdeckd.sock') },
  ];
  return candidates.filter((candidate, index) => candidates.findIndex((item) => item.socketPath === candidate.socketPath) === index);
}

export function sessionDir(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(sessionsDir, safe);
}
