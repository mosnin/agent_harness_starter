import { CommandHistory } from "./history";
import { MultilineBuffer } from "./multiline";
import { SlashCommandRegistry } from "./commands";

/** Output sink for the REPL — injectable so it tests without a terminal. */
export interface ReplIO {
  /** Streamed partial output (no trailing newline). */
  write(chunk: string): void;
  /** A complete line of output. */
  writeLine(line: string): void;
}

/**
 * The turn handler. It receives the user's (possibly multi-line) input, a
 * `stream` sink for token-by-token output, and an `AbortSignal` that fires when
 * the turn is interrupted (Ctrl-C / redirect). It resolves with the final text.
 */
export type ReplHandler = (input: string, stream: (chunk: string) => void, signal: AbortSignal) => Promise<string>;

export interface ReplOptions {
  history?: CommandHistory;
  prompt?: string;
  continuationPrompt?: string;
  /** Slash-command registry consulted before the handler for `/`-lines. */
  commands?: SlashCommandRegistry;
}

/**
 * Interactive REPL core: assembles multiline input, records history, and streams
 * the handler's output to an injectable {@link ReplIO}. It is driven line-by-line
 * (`feedLine`) rather than owning stdin, so the whole loop is unit-testable and
 * can back any front-end (raw TTY, a socket, a test harness).
 */
export class Repl {
  readonly history: CommandHistory;
  readonly commands?: SlashCommandRegistry;
  private buffer = new MultilineBuffer();
  private readonly prompt: string;
  private readonly continuationPrompt: string;
  private inflight?: AbortController;

  constructor(
    private readonly io: ReplIO,
    private readonly handler: ReplHandler,
    opts: ReplOptions = {}
  ) {
    this.history = opts.history ?? new CommandHistory();
    this.commands = opts.commands;
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

    // Slash commands short-circuit the handler.
    if (this.commands?.isCommand(text)) {
      const res = await this.commands.dispatch(text, (l) => this.io.writeLine(l));
      return { submitted: true, result: res.output };
    }

    const controller = new AbortController();
    this.inflight = controller;
    let final = "";
    try {
      const result = await this.handler(
        text,
        (chunk) => {
          final += chunk;
          this.io.write(chunk);
        },
        controller.signal
      );
      // If the handler returned text it never streamed, emit it now.
      const out = result || final;
      if (result && result !== final) this.io.write(result.slice(final.length));
      this.io.writeLine("");
      return { submitted: true, result: out };
    } finally {
      if (this.inflight === controller) this.inflight = undefined;
    }
  }

  /** Interrupt the in-flight turn (Ctrl-C). Returns whether one was running. */
  interrupt(): boolean {
    if (!this.inflight) return false;
    this.inflight.abort();
    this.io.writeLine("^C");
    return true;
  }

  /** Autocomplete candidates for the current input (slash commands + history). */
  complete(input: string): string[] {
    if (this.commands && input.trimStart().startsWith("/")) {
      return this.commands.complete(input.trimStart());
    }
    if (!input) return [];
    // Fall back to distinct history entries that extend the input.
    const seen = new Set<string>();
    for (const entry of this.history.all()) {
      if (entry.startsWith(input) && entry !== input) seen.add(entry);
    }
    return [...seen];
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
