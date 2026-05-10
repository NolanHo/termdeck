import type { Status } from './protocol.js';

export type PromptKind = 'shell' | 'python' | 'pdb' | 'node' | 'ruby' | 'sql' | 'editor' | 'continuation' | 'none' | 'unknown';
export type StateResult = { status: Status; reason: string; prompt: PromptKind };

const passwordRx = /(?:password|passphrase).*:\s*$/i;
const confirmRx = /(?:yes\/no|y\/n|\[[yY]\/[nN]\]|\[[nN]\/[yY]\]|do you want to continue\?|are you sure\?)\s*(?:\??\s*)$/i;
const defaultPromptRx = /(?:^|\n).*(?:(?:[$#%>]|➜)(?:\s|$)|[✗✔]\s*$)/;
const continuationRx = /^(?:quote>|dquote>|bquote>|heredoc>|>)\s?$/;
const editorRx = /(?:--\s*(?:INSERT|NORMAL|VISUAL|REPLACE)\s*--|\b(?:GNU nano|File Name to Write|Write Out|Read File|Where Is|Save modified buffer)\b|\b(?:emacs|fundamental|text|lisp|python|typescript|javascript)-mode\b)/i;
const pagerRx = /(?:\b(?:less|more|man)\b|\(END\)|^:|^--More--)\s*$/i;

export function detectState(screen: string, promptRegex?: string, exited = false): StateResult {
  if (exited) return { status: 'eof', reason: 'pty exited', prompt: 'none' };
  const lines = screen.split(/\r?\n/).map((s) => s.trimEnd()).filter((s) => s.length > 0);
  const recent = lines.slice(-3).join('\n');
  if (passwordRx.test(recent)) return { status: 'password', reason: 'password prompt', prompt: 'none' };
  if (confirmRx.test(recent)) return { status: 'confirm', reason: 'confirmation prompt', prompt: 'none' };

  const last = lines.at(-1) ?? '';
  if (/^>>>\s?$|^\.\.\.\s?$/.test(last)) return { status: 'repl', reason: 'python prompt', prompt: 'python' };
  if (/^\(Pdb\)\s?$/.test(last)) return { status: 'repl', reason: 'pdb prompt', prompt: 'pdb' };
  if (/^>\s?$/.test(last) && /Welcome to Node\.js|Type "\.help"/i.test(recent)) return { status: 'repl', reason: 'node prompt', prompt: 'node' };
  if (/^irb\([^)]*\):\d+:\d+>\s?$/.test(last)) return { status: 'repl', reason: 'ruby prompt', prompt: 'ruby' };
  if (/^(?:sqlite>|mysql>|mariadb>|postgres>|[A-Za-z0-9_-]+=#|[A-Za-z0-9_-]+=>)\s?$/.test(last)) return { status: 'repl', reason: 'sql prompt', prompt: 'sql' };
  if (continuationRx.test(last)) return { status: 'running', reason: 'shell continuation prompt', prompt: 'continuation' };
  if (/(:|\(END\)|--More--)\s?$/.test(last) && pagerRx.test(recent)) return { status: 'pager', reason: 'pager marker', prompt: 'none' };
  if (editorRx.test(recent)) return { status: 'editor', reason: 'editor marker', prompt: 'editor' };

  const rx = promptRegex ? new RegExp(promptRegex) : defaultPromptRx;
  if (rx.test(last)) return { status: 'ready', reason: promptRegex ? 'custom prompt regex' : 'default prompt regex', prompt: 'shell' };
  return { status: 'running', reason: 'no prompt detected', prompt: 'unknown' };
}
