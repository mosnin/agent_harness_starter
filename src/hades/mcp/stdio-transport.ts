/**
 * The **stdio transport** for the MCP client — the byte channel that turns
 * `mcp/client.ts` from a protocol implementation into an actual way to reach
 * the world's MCP servers.
 *
 * WHY THIS EXISTS. `.plans/HADES_BEYOND_HERMES.md` (Phase 1) states the
 * strategy plainly: "speak MCP so Hades inherits the entire Hermes/Anthropic
 * tool ecosystem *for free* rather than rebuilding 90 tools." The client was
 * already written against an injectable {@link McpTransport}, but every
 * transport in the repo was in-process (`loopbackTransportPair`), so no
 * foreign server had ever been spoken to. This module is the missing half: it
 * spawns a real subprocess and frames JSON-RPC over its stdin/stdout exactly
 * as the MCP stdio transport specifies — newline-delimited JSON, diagnostics
 * on stderr.
 *
 * WHY IT IS BUILT THIS WAY.
 *  - **The spawn is a seam** ({@link StdioSpawnLike}). Every failure branch —
 *    a command that does not exist, a server that dies mid-handshake, a server
 *    that never answers — is unit-testable without a process, while the real
 *    implementation ({@link realStdioSpawn}) is a plain `child_process.spawn`
 *    with `shell: false` (no shell means no metacharacter injection, matching
 *    `tools/shell.ts`'s stance).
 *  - **A dead child is announced, never absorbed.** If the process exits or
 *    fails to start, the transport enters a permanent failure state, reports
 *    it through {@link StdioMcpTransport.onFatal} (so callers can fail fast
 *    instead of waiting out a request timeout), and throws on every subsequent
 *    `send`. There is no fallback path that fabricates a response — an
 *    unreachable MCP server must surface as an error, never as a mock.
 *  - **The child's stderr is captured (capped)** so the honest error can quote
 *    the server's own complaint instead of a generic "connection failed".
 *  - **Non-JSON stdout lines are skipped, not fatal.** Real servers print
 *    banners; the first few offending lines are retained for diagnostics so a
 *    server that prints garbage INSTEAD of protocol can still be diagnosed.
 *
 * Nothing here interprets MCP semantics — that is the client's job. This file
 * only moves bytes and tells the truth about the process at the other end.
 */

import { spawn } from "node:child_process";
import { McpProtocolError, type JsonRpcMessage, type McpTransport } from "./client";

/**
 * JSON-RPC error code used for client-side TRANSPORT failures (the child could
 * not be started, died, or its stdin is gone). Deliberately distinct from the
 * client's own `-32000` (timeout) / `-32001` (closed) so a caller can tell
 * "the server never existed" from "the server was slow".
 */
export const MCP_TRANSPORT_ERROR_CODE = -32010;

/** Default cap on retained child stderr, in bytes. */
const DEFAULT_MAX_STDERR_BYTES = 8192;
/** Default cap on retained non-JSON stdout lines. */
const DEFAULT_MAX_NOISE_LINES = 5;
/**
 * Default cap on a single un-terminated stdout frame, in bytes. A frame is
 * only dispatched at a newline, so a server that streams megabytes without one
 * would otherwise grow this buffer without bound. Generous enough for real
 * results (the tool-RPC bridge truncates at 256 KiB anyway) and finite, which
 * is the point: a hostile or broken server gets an honest transport failure
 * rather than the host's memory.
 */
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The handle the transport needs from a spawned child. Deliberately narrower
 * than `ChildProcess`: only the five capabilities the transport actually uses,
 * so a test double is a few lines rather than a process mock.
 */
export interface StdioProcessHandle {
  /** Write one frame (already newline-terminated) to the child's stdin. */
  write(frame: string): void;
  /** Register the stdout consumer. Called once. Chunks may split mid-line. */
  onStdout(cb: (chunk: string) => void): void;
  /** Register the stderr consumer. Called once. */
  onStderr(cb: (chunk: string) => void): void;
  /** Called when the child exits, for any reason. */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  /** Called when the child could not be spawned at all (ENOENT, EACCES, ...). */
  onError(cb: (err: Error) => void): void;
  /** Terminate the child. Must be safe to call more than once. */
  kill(): void;
  /** Process id when known (diagnostics only). */
  readonly pid?: number | undefined;
}

export interface StdioSpawnOptions {
  cwd?: string;
  /** Full environment for the child. Omitted => the child inherits this
   *  process's environment (the usual expectation for a CLI-launched MCP
   *  server, which needs PATH/HOME to function at all). */
  env?: Record<string, string | undefined>;
}

/** The injectable spawn seam. */
export type StdioSpawnLike = (
  command: string,
  args: string[],
  opts: StdioSpawnOptions
) => StdioProcessHandle;

/**
 * The real spawn: `node:child_process.spawn` with `shell: false` and all three
 * standard streams piped. No shell is involved anywhere, so a command
 * containing `;`, `|`, or `&&` is passed to `execvp` as a literal program name
 * and simply fails to start — it can never be interpreted.
 */
export function realStdioSpawn(): StdioSpawnLike {
  return (command, args, opts) => {
    const child = spawn(command, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    return {
      write(frame: string): void {
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed) {
          throw new Error("child stdin is not writable");
        }
        stdin.write(frame);
      },
      onStdout(cb): void {
        child.stdout?.on("data", (chunk: string | Buffer) => cb(String(chunk)));
      },
      onStderr(cb): void {
        child.stderr?.on("data", (chunk: string | Buffer) => cb(String(chunk)));
      },
      onExit(cb): void {
        child.on("exit", (code, signal) => cb(code, signal));
      },
      onError(cb): void {
        // `spawn` reports ENOENT/EACCES asynchronously on the 'error' event —
        // it does NOT throw — which is exactly why an unreachable server has to
        // be surfaced through this callback rather than a try/catch.
        child.on("error", (err: Error) => cb(err));
      },
      kill(): void {
        // stdin.end() first: a well-behaved MCP server exits on EOF, so the
        // usual path is a clean shutdown and SIGKILL is only the backstop.
        try {
          child.stdin?.end();
        } catch {
          /* already gone */
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      },
      get pid(): number | undefined {
        return child.pid;
      },
    };
  };
}

export interface StdioTransportOptions {
  /** Retained child stderr cap in bytes (default 8192). */
  maxStderrBytes?: number;
  /** Retained non-JSON stdout line cap (default 5). */
  maxNoiseLines?: number;
  /** Cap on one un-terminated stdout frame in bytes (default 8 MiB). */
  maxFrameBytes?: number;
}

/**
 * An {@link McpTransport} over a spawned child's stdin/stdout, framing
 * JSON-RPC as newline-delimited JSON per the MCP stdio transport.
 *
 * Lifecycle: construct (handlers attach immediately, so a child that dies
 * before the first `send` is already known to be dead), hand to `new
 * McpClient(...)`, and `close()` when done. `close()` is idempotent and marks
 * the shutdown as intentional, so the child's subsequent exit is NOT reported
 * as a fatal failure.
 */
export class StdioMcpTransport implements McpTransport {
  private readonly child: StdioProcessHandle;
  private readonly maxStderrBytes: number;
  private readonly maxNoiseLines: number;
  private readonly maxFrameBytes: number;

  private handler: ((msg: JsonRpcMessage) => void) | undefined;
  private buffer = "";
  private stderrText = "";
  private stderrTruncated = false;
  private readonly noise: string[] = [];
  private failureText: string | undefined;
  private intentionallyClosed = false;
  private readonly fatalListeners: Array<(reason: string) => void> = [];

  constructor(child: StdioProcessHandle, opts: StdioTransportOptions = {}) {
    this.child = child;
    this.maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.maxNoiseLines = opts.maxNoiseLines ?? DEFAULT_MAX_NOISE_LINES;
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

    child.onStdout((chunk) => this.ingest(chunk));
    child.onStderr((chunk) => this.captureStderr(chunk));
    child.onExit((code, signal) => {
      const how =
        signal !== null && signal !== undefined
          ? `signal ${signal}`
          : `exit code ${code === null || code === undefined ? "unknown" : code}`;
      this.fail(`the server process ended (${how})`);
    });
    child.onError((err) => {
      this.fail(`the server process could not be started: ${err.message}`);
    });
  }

  /** Split the stdout byte stream into newline-delimited JSON frames. */
  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== "") this.dispatchLine(line);
      nl = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxFrameBytes) {
      // Refuse to grow without bound for a server that never terminates a
      // frame. Drop the partial line and say so: a truncated frame silently
      // dropped would look like a hung request with no explanation.
      this.buffer = "";
      this.fail(
        `the server sent more than ${this.maxFrameBytes} bytes on stdout without a newline-terminated frame`
      );
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not protocol. Real servers print banners; keep a bounded sample so a
      // server that prints garbage instead of frames can still be diagnosed.
      if (this.noise.length < this.maxNoiseLines) this.noise.push(line.slice(0, 200));
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const handler = this.handler;
    if (!handler) return;
    try {
      handler(parsed as JsonRpcMessage);
    } catch {
      // The client's inbound handler is documented never to throw; if it ever
      // does, it must not take the transport (or the process) down with it.
    }
  }

  private captureStderr(chunk: string): void {
    if (this.stderrText.length >= this.maxStderrBytes) {
      this.stderrTruncated = true;
      return;
    }
    const room = this.maxStderrBytes - this.stderrText.length;
    if (chunk.length > room) {
      this.stderrText += chunk.slice(0, room);
      this.stderrTruncated = true;
    } else {
      this.stderrText += chunk;
    }
  }

  /** Enter the permanent failure state and notify fatal listeners once. */
  private fail(reason: string): void {
    if (this.intentionallyClosed || this.failureText !== undefined) return;
    this.failureText = reason;
    const listeners = [...this.fatalListeners];
    this.fatalListeners.length = 0;
    for (const listener of listeners) {
      try {
        listener(reason);
      } catch {
        /* a broken listener must not break the transport */
      }
    }
  }

  /**
   * Register a callback for the child dying / failing to start. Fires at most
   * once; if the transport has ALREADY failed, the callback is invoked
   * immediately (so a listener registered late cannot miss the event).
   */
  onFatal(cb: (reason: string) => void): void {
    if (this.failureText !== undefined) {
      cb(this.failureText);
      return;
    }
    this.fatalListeners.push(cb);
  }

  /** The failure reason, or `undefined` while the child is healthy. */
  get failure(): string | undefined {
    return this.failureText;
  }

  /** Captured child stderr (trimmed, capped, with a truncation marker). */
  stderrTail(): string {
    const text = this.stderrText.trim();
    if (text === "") return "";
    return this.stderrTruncated ? `${text} …(truncated)` : text;
  }

  /** Bounded sample of stdout lines that were not JSON-RPC frames. */
  noiseLines(): string[] {
    return [...this.noise];
  }

  send(msg: JsonRpcMessage): void {
    if (this.intentionallyClosed) {
      throw new McpProtocolError(MCP_TRANSPORT_ERROR_CODE, "transport is closed");
    }
    if (this.failureText !== undefined) {
      throw new McpProtocolError(MCP_TRANSPORT_ERROR_CODE, this.failureText);
    }
    try {
      this.child.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      const reason = `writing to the server process failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.fail(reason);
      throw new McpProtocolError(MCP_TRANSPORT_ERROR_CODE, reason);
    }
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  close(): void {
    if (this.intentionallyClosed) return;
    this.intentionallyClosed = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}
