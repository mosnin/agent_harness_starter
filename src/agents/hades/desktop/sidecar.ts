/**
 * Stdio sidecar loop — what Tauri's Rust supervisor spawns.
 *
 *   node dist/hades/desktop/sidecar.js
 *   npx tsx src/agents/hades/desktop/sidecar-entry.ts
 *
 * Reads DesktopCommand lines on stdin, writes DesktopEvent lines on stdout.
 */

import { createDesktopHost, type DesktopHostOptions } from "./host";
import {
  decodeDesktopCommand,
  encodeDesktopMessage,
  MAX_DESKTOP_LINE_CHARS,
  type DesktopEvent,
} from "./contract";

/** Drop a line that grows past `max` before JSON.parse. readline would buffer it. */
export async function* readCappedLines(
  input: AsyncIterable<string | Buffer>,
  max = MAX_DESKTOP_LINE_CHARS
): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of input) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > max) {
        throw new Error("desktop command exceeds size cap");
      }
      yield line;
      idx = buf.indexOf("\n");
    }
    if (buf.length > max) {
      throw new Error("desktop command exceeds size cap");
    }
  }
  if (buf.trim()) {
    if (buf.length > max) {
      throw new Error("desktop command exceeds size cap");
    }
    yield buf;
  }
}

export interface SidecarOptions extends DesktopHostOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function runDesktopSidecar(options: SidecarOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const write = (event: DesktopEvent) => {
    output.write(encodeDesktopMessage(event));
    options.onEvent?.(event);
  };
  const host = createDesktopHost({ ...options, onEvent: write });

  try {
    for await (const line of readCappedLines(input)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const command = decodeDesktopCommand(trimmed);
        await host.handle(command);
      } catch (error) {
        write({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          code: "sidecar",
        });
      }
    }
  } catch (error) {
    write({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
      code: "sidecar",
    });
  }
}
