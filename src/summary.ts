import { requestWithDaemon, tailLines } from './client.js';
import type { Response } from './protocol.js';

export type SummaryOptions = {
  session: string;
  lines?: number;
  events?: number;
  autostart?: boolean;
};

function errorLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => /\b(error|failed|exception|traceback|panic|fatal|segmentation fault)\b/i.test(line))
    .slice(-10);
}

export async function sessionSummary(opts: SummaryOptions): Promise<Response> {
  const lines = opts.lines ?? 80;
  const eventLimit = opts.events ?? 20;
  const meta = await requestWithDaemon({ op: 'metadata', session: opts.session }, opts.autostart);
  if (!meta.ok) return meta;
  const screen = await requestWithDaemon({ op: 'screen', session: opts.session }, opts.autostart);
  const log = await requestWithDaemon({ op: 'log', session: opts.session, lines }, opts.autostart);
  const events = await requestWithDaemon({ op: 'events', session: opts.session, afterSeq: Math.max(0, (meta.lastSeq ?? 0) - eventLimit), limit: eventLimit }, opts.autostart);
  const logText = log.logText ?? '';
  return {
    id: meta.id,
    ok: true,
    status: meta.status,
    prompt: meta.prompt,
    reason: meta.reason,
    lastSeq: meta.lastSeq,
    screen: tailLines(screen.screen ?? '', Math.min(20, lines)),
    metadata: {
      session: opts.session,
      cwd: typeof meta.metadata?.cwd === 'string' ? meta.metadata.cwd : undefined,
      transcriptPath: typeof meta.metadata?.transcript === 'string' ? meta.metadata.transcript : undefined,
      outputTail: tailLines(logText, lines),
      recentEvents: events.eventsText ?? '',
      errors: errorLines(logText),
      outputTruncated: log.outputTruncated ?? false,
    },
  };
}
