import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HistoryOptions {
  /** Max entries retained. Default 500. */
  max?: number;
}

/**
 * Command history with up/down navigation, matching a terminal REPL. Consecutive
 * duplicates are coalesced; navigation walks from newest to oldest and back to a
 * live draft. In-memory base + atomic-write file subclass for persistence across
 * sessions.
 */
export class CommandHistory {
  protected entries: string[] = [];
  private cursor = -1; // -1 = live draft (not navigating)
  private draft = "";
  private readonly max: number;

  constructor(opts: HistoryOptions = {}) {
    this.max = opts.max ?? 500;
  }

  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] === trimmed) {
      this.resetCursor();
      return;
    }
    this.entries.push(trimmed);
    if (this.entries.length > this.max) this.entries.shift();
    this.resetCursor();
    this.persist();
  }

  all(): string[] {
    return [...this.entries];
  }
  size(): number {
    return this.entries.length;
  }

  /** Navigate to the previous (older) entry. `current` is the live draft. */
  prev(current: string): string {
    if (this.cursor === -1) {
      this.draft = current;
      this.cursor = this.entries.length;
    }
    this.cursor = Math.max(0, this.cursor - 1);
    return this.entries[this.cursor] ?? this.draft;
  }

  /** Navigate to the next (newer) entry, ending back at the live draft. */
  next(): string {
    if (this.cursor === -1) return this.draft;
    this.cursor++;
    if (this.cursor >= this.entries.length) {
      const draft = this.draft;
      this.resetCursor();
      return draft;
    }
    return this.entries[this.cursor];
  }

  private resetCursor(): void {
    this.cursor = -1;
    this.draft = "";
  }

  protected persist(): void {}
}

export class FileCommandHistory extends CommandHistory {
  constructor(
    private readonly path: string,
    opts: HistoryOptions = {}
  ) {
    super(opts);
    try {
      this.entries = readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch {
      /* fresh */
    }
  }
  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.entries.join("\n"));
    renameSync(tmp, this.path);
  }
}
