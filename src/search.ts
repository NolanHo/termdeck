import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from './redact.js';
import { rootDir, sessionsDir } from './paths.js';

export type SearchKind = 'transcript' | 'events' | 'commands' | 'metadata' | 'tasks';

export type SearchOptions = {
  query: string;
  regex?: boolean;
  ignoreCase?: boolean;
  limit?: number;
  context?: number;
  session?: string;
  cwd?: string;
  task?: string;
  kinds?: SearchKind[];
  redact?: boolean;
};

export type SearchHit = {
  source: 'session' | 'task';
  kind: SearchKind;
  session?: string;
  task?: string;
  cwd?: string;
  file: string;
  line: number;
  seq?: number;
  tsMs?: number;
  text: string;
  before: string[];
  after: string[];
};

export type SearchResult = {
  query: string;
  regex: boolean;
  ignoreCase: boolean;
  limit: number;
  context: number;
  truncated: boolean;
  hits: SearchHit[];
};

const allKinds: SearchKind[] = ['transcript', 'events', 'commands', 'metadata', 'tasks'];
const tasksDir = join(rootDir, 'tasks');

type SessionMeta = {
  id?: string;
  cwd?: string;
};

type Matcher = {
  test(line: string): boolean;
};

function makeMatcher(opts: SearchOptions): Matcher {
  if (!opts.query) throw new Error('search query must not be empty');
  if (opts.regex) {
    const flags = opts.ignoreCase === false ? '' : 'i';
    const re = new RegExp(opts.query, flags);
    return { test: (line) => re.test(line) };
  }
  const needle = opts.ignoreCase === false ? opts.query : opts.query.toLowerCase();
  return {
    test: (line) => {
      const haystack = opts.ignoreCase === false ? line : line.toLowerCase();
      return haystack.includes(needle);
    },
  };
}

function normalizeKinds(kinds?: SearchKind[]): Set<SearchKind> {
  if (!kinds || kinds.length === 0) return new Set(allKinds);
  return new Set(kinds);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function sessionMetas(): Array<{ id: string; dir: string; meta: SessionMeta }> {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const dir = join(sessionsDir, entry.name);
    const meta = readJson<SessionMeta>(join(dir, 'session.json')) ?? { id: entry.name };
    return [{ id: meta.id ?? entry.name, dir, meta }];
  });
}

function taskFiles(): Array<{ name: string; file: string; data: Record<string, unknown>; session?: string }> {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) return [];
    const file = join(tasksDir, entry.name);
    const data = readJson<Record<string, unknown>>(file);
    if (!data) return [];
    return [{ name: String(data.name ?? entry.name.replace(/\.json$/, '')), file, data, session: typeof data.session === 'string' ? data.session : undefined }];
  });
}

function lineContext(lines: string[], index: number, context: number, redact: boolean): { before: string[]; after: string[] } {
  const start = Math.max(0, index - context);
  const end = Math.min(lines.length, index + context + 1);
  const before = lines.slice(start, index);
  const after = lines.slice(index + 1, end);
  return {
    before: before.map((line) => redact ? redactText(line) : line),
    after: after.map((line) => redact ? redactText(line) : line),
  };
}

function eventMeta(kind: SearchKind, line: string): Pick<SearchHit, 'seq' | 'tsMs'> {
  if (kind !== 'events' && kind !== 'commands') return {};
  try {
    const data = JSON.parse(line) as { seq?: unknown; tsMs?: unknown };
    return {
      seq: typeof data.seq === 'number' ? data.seq : undefined,
      tsMs: typeof data.tsMs === 'number' ? data.tsMs : undefined,
    };
  } catch {
    return {};
  }
}

function searchFile(params: {
  file: string;
  source: 'session' | 'task';
  kind: SearchKind;
  matcher: Matcher;
  context: number;
  redact: boolean;
  session?: string;
  task?: string;
  cwd?: string;
  remaining: () => number;
}): { hits: SearchHit[]; truncated: boolean } {
  if (!existsSync(params.file) || params.remaining() <= 0) return { hits: [], truncated: false };
  const lines = readFileSync(params.file, 'utf8').split(/\r?\n/);
  const hits: SearchHit[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!params.matcher.test(line)) continue;
    const { before, after } = lineContext(lines, index, params.context, params.redact);
    hits.push({
      source: params.source,
      kind: params.kind,
      session: params.session,
      task: params.task,
      cwd: params.cwd,
      file: params.file,
      line: index + 1,
      ...eventMeta(params.kind, line),
      text: params.redact ? redactText(line) : line,
      before,
      after,
    });
    if (hits.length >= params.remaining()) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}

export function searchTermDeck(opts: SearchOptions): SearchResult {
  const limit = Number.isFinite(opts.limit) && opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  const context = Number.isFinite(opts.context) && opts.context !== undefined && opts.context >= 0 ? Math.floor(opts.context) : 1;
  const ignoreCase = opts.ignoreCase ?? true;
  const redact = opts.redact ?? true;
  const matcher = makeMatcher({ ...opts, ignoreCase });
  const kinds = normalizeKinds(opts.kinds);
  const hits: SearchHit[] = [];
  let truncated = false;
  const remaining = () => Math.max(0, limit - hits.length);

  for (const { id, dir, meta } of sessionMetas()) {
    if (remaining() <= 0) break;
    if (opts.session && !id.includes(opts.session)) continue;
    if (opts.cwd && meta.cwd !== opts.cwd) continue;
    const files: Array<[SearchKind, string]> = [
      ['transcript', join(dir, 'transcript.log')],
      ['events', join(dir, 'events.jsonl')],
      ['commands', join(dir, 'commands.log')],
      ['metadata', join(dir, 'session.json')],
    ];
    for (const [kind, file] of files) {
      if (!kinds.has(kind) || remaining() <= 0) continue;
      const found = searchFile({ file, source: 'session', kind, matcher, context, redact, session: id, cwd: meta.cwd, remaining });
      hits.push(...found.hits);
      truncated ||= found.truncated;
      if (truncated) break;
    }
  }

  if (kinds.has('tasks') && remaining() > 0) {
    for (const task of taskFiles()) {
      if (remaining() <= 0) break;
      const taskCwd = typeof task.data.cwd === 'string' ? task.data.cwd : undefined;
      if (opts.task && !task.name.includes(opts.task)) continue;
      if (opts.cwd && taskCwd !== opts.cwd) continue;
      const found = searchFile({ file: task.file, source: 'task', kind: 'tasks', matcher, context, redact, task: task.name, session: task.session, cwd: taskCwd, remaining });
      hits.push(...found.hits);
      truncated ||= found.truncated;
    }
  }

  return {
    query: opts.query,
    regex: Boolean(opts.regex),
    ignoreCase,
    limit,
    context,
    truncated,
    hits,
  };
}
