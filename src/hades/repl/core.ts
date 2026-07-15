import { CommandHistory } from "./history";
import { MultilineBuffer } from "./multiline";

/** Output sink for the REPL — injectable so it tests without a terminal. */
export interface ReplIO {
  /** Streamed partial output (no trailing newline). */
  write(chunk: string): void;
  /** A complete line of output. */
  writeLine(line: string): void;
}

/**
 * The turn handler. It receives the user's (possibly multi-line) input and a
 * `stream` sink for token-by-token output, and resolves with the final text.
 */
export type ReplHandler = (input: string, stream: (chunk: string) => void) => Promise<string>;

export interface ReplOptions {
  history?: CommandHistory;
  prompt?: string;
  continuationPrompt?: string;
}

/**
 * Interactive REPL core: assembles multiline input, records history, and streams
 * the handler's output to an injectable {@link ReplIO}. It is driven line-by-line
 * (`feedLine`) rather than owning stdin, so the whole loop is unit-testable and
 * can back any front-end (raw TTY, a socket, a test harness).
 */
export class Repl {
  readonly history: CommandHistory;
  private buffer = new MultilineBuffer();
  private readonly prompt: string;
  private readonly continuationPrompt: string;

  constructor(
    private readonly io: ReplIO,
    private readonly handler: ReplHandler,
    opts: ReplOptions = {}
  ) {
    this.history = opts.history ?? new CommandHistory();
    this.prompt = opts.prompt ?? "hades> ";
    this.continuationPrompt = opts.continuationPrompt ?? "... ";
  }

  /** The prompt string to show for the next line (main or continuation). */
  currentPrompt(): string {
    return this.buffer.pending ? this.continuationPrompt : this.prompt;
  }

  /**
   * Feed one raw input line. If it completes a turn, the handler runs and its
   * output streams to the IO. Returns whether a turn was submitted and, if so,
   * the final result text.
   */
  async feedLine(line: string): Promise<{ submitted: boolean; result?: string }> {
    const { complete, text } = this.buffer.feed(line);
    if (!complete) return { submitted: false };
    if (!text.trim()) return { submitted: false };

    this.history.add(text);
    let final = "";
    const result = await this.handler(text, (chunk) => {
      final += chunk;
      this.io.write(chunk);
    });
    // If the handler returned text it never streamed, emit it now.
    const out = result || final;
    if (result && result !== final) this.io.write(result.slice(final.length));
    this.io.writeLine("");
    return { submitted: true, result: out };
  }

  /** Recall the previous history entry (up-arrow). */
  historyPrev(current: string): string {
    return this.history.prev(current);
  }
  /** Recall the next history entry (down-arrow). */
  historyNext(): string {
    return this.history.next();
  }
}
