import { platform } from 'node:os';
import process from 'node:process';

export const isWindows = platform() === 'win32';

export function signalProcessGroup(pid: number, signal: string): { mode: 'process-group' | 'process'; detail: string } {
  if (!isWindows) {
    try {
      process.kill(-pid, signal as NodeJS.Signals);
      return { mode: 'process-group', detail: `sent ${signal} to process group ${pid}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  process.kill(pid, signal as NodeJS.Signals);
  return { mode: 'process', detail: `sent ${signal} to process ${pid}` };
}

export function socketAccessMode(): number {
  return 0o600;
}
