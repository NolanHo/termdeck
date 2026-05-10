import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

function safePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return safe || 'project';
}

export function projectSessionName(cwd = process.cwd(), name?: string): string {
  const root = resolve(cwd);
  const label = safePart(name ?? basename(root) ?? 'project').slice(0, 40);
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  return `project-${label}-${hash}`;
}
