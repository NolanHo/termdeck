const secretPatterns: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b((?:ghp|github_pat)_[A-Za-z0-9_]{16,})\b/g,
  /\b([A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
  /\b((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s"']+)/gi,
];

export function redactText(text: string): string {
  let out = text;
  out = out.replace(secretPatterns[0], '[REDACTED_OPENAI_KEY]');
  out = out.replace(secretPatterns[1], '[REDACTED_GITHUB_TOKEN]');
  out = out.replace(secretPatterns[2], '[REDACTED_BASIC_AUTH]');
  out = out.replace(secretPatterns[3], (_match, prefix: string) => `${prefix}[REDACTED]`);
  return out;
}

export function redactJsonl(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line) return line;
      try {
        return JSON.stringify(redactValue(JSON.parse(line) as unknown));
      } catch {
        return redactText(line);
      }
    })
    .join('\n');
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}
