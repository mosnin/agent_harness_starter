/**
 * Multiline input assembly for the REPL. A turn spans several typed lines when
 * the user continues explicitly (trailing backslash) or leaves a construct open
 * (unbalanced brackets, an open fenced code block). `feed` accumulates lines and
 * reports when the turn is complete; a blank line force-submits whatever's
 * buffered so the user is never stuck.
 */
export class MultilineBuffer {
  private lines: string[] = [];

  get pending(): boolean {
    return this.lines.length > 0;
  }

  /** Current buffered text (joined with newlines). */
  text(): string {
    return this.lines.join("\n");
  }

  clear(): void {
    this.lines = [];
  }

  /**
   * Feed one raw input line. Returns `{ complete }`; when complete, `text` holds
   * the full multi-line turn and the buffer is reset.
   */
  feed(line: string): { complete: boolean; text: string } {
    // Blank line: force-submit the buffer (or an empty turn).
    if (line.trim() === "" && this.pending) {
      const text = this.text();
      this.clear();
      return { complete: true, text };
    }

    // Explicit continuation: trailing backslash.
    if (line.endsWith("\\")) {
      this.lines.push(line.slice(0, -1));
      return { complete: false, text: "" };
    }

    this.lines.push(line);
    const combined = this.text();
    if (this.isIncomplete(combined)) {
      return { complete: false, text: "" };
    }
    this.clear();
    return { complete: true, text: combined };
  }

  /** Heuristic: unbalanced brackets or an open ``` fence means keep reading. */
  private isIncomplete(text: string): boolean {
    const fences = (text.match(/```/g) ?? []).length;
    if (fences % 2 === 1) return true;
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (const ch of text) {
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (!inSingle && !inDouble) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      }
    }
    return depth > 0;
  }
}
