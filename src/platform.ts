import { platform } from 'node:os';
import { readFileSync } from 'node:fs';
import process from 'node:process';

export const isWindows = platform() === 'win32';

export function signalProcessGroup(pid: number, signal: string): { mode: 'process-group' | 'process'; detail: string } {
  signal = normalizeSignal(signal);
  if (!isWindows) {
    const fg = foregroundProcessGroup(pid) ?? pid;
    try {
      process.kill(-fg, signal as NodeJS.Signals);
      return { mode: 'process-group', detail: `sent ${signal} to process group ${fg}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  process.kill(pid, signal as NodeJS.Signals);
  return { mode: 'process', detail: `sent ${signal} to process ${pid}` };
}

function foregroundProcessGroup(shellPid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${shellPid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const tpgid = Number(fields[5]);
    return Number.isFinite(tpgid) && tpgid > 0 ? tpgid : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSignal(signal: string): string {
  const s = signal.toUpperCase();
  return s.startsWith('SIG') ? s : `SIG${s}`;
}

export function socketAccessMode(): number {
  return 0o600;
}
