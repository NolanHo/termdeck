export class TextRing {
  private text = '';
  private start = 0;
  private end = 0;

  constructor(private readonly maxChars = 1_000_000) {}

  push(s: string): void {
    if (!s) return;
    this.text += s;
    this.end += s.length;
    if (this.text.length > this.maxChars) {
      const dropped = this.text.length - this.maxChars;
      this.text = this.text.slice(dropped);
      this.start += dropped;
    }
  }

  mark(): number {
    return this.end;
  }

  all(): string {
    return this.text;
  }

  since(mark: number): string {
    return this.sinceWithStats(mark).text;
  }

  sinceWithStats(mark: number): { text: string; truncated: boolean; droppedChars: number } {
    const droppedChars = Math.max(0, this.start - mark);
    const i = Math.max(0, Math.min(this.text.length, mark - this.start));
    return { text: this.text.slice(i), truncated: droppedChars > 0, droppedChars };
  }

  stats(): { start: number; end: number; retainedChars: number; droppedChars: number } {
    return { start: this.start, end: this.end, retainedChars: this.text.length, droppedChars: this.start };
  }
}
