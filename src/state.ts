import type { Status } from './protocol.js';

export type StateResult = { status: Status; reason: string };

const passwordRx = /(?:password|passphrase).*:\s*$/i;
const confirmRx = /(?:yes\/no|y\/n|\[[yY]\/[nN]\]|\[[nN]\/[yY]\])\s*$/i;
const defaultPromptRx = /(?:^|\n).*(?:[$#%]|>)\s*$/;

export function detectState(screen: string, promptRegex?: string, exited = false): StateResult {
  if (exited) return { status: 'eof', reason: 'pty exited' };
  const lines = screen.split(/\r?\n/).map((s) => s.trimEnd()).filter((s) => s.length > 0);
  const recent = lines.slice(-3).join('\n');
  if (passwordRx.test(recent)) return { status: 'password', reason: 'password prompt' };
  if (confirmRx.test(recent)) return { status: 'confirm', reason: 'confirmation prompt' };

  const last = lines.at(-1) ?? '';
  const rx = promptRegex ? new RegExp(promptRegex) : defaultPromptRx;
  if (rx.test(last)) return { status: 'ready', reason: promptRegex ? 'custom prompt regex' : 'default prompt regex' };
  return { status: 'running', reason: 'no prompt detected' };
}
