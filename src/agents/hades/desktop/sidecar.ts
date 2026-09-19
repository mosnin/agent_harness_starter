/**
 * Stdio sidecar loop — what Tauri's Rust supervisor spawns.
 *
 *   node dist/hades/desktop/sidecar.js
 *   npx tsx src/agents/hades/desktop/sidecar-entry.ts
 *
 * Reads DesktopCommand lines on stdin, writes DesktopEvent lines on stdout.
 */

import { createInterface } from "node:readline";
import { createDesktopHost, type DesktopHostOptions } from "./host";
import {
  decodeDesktopCommand,
  encodeDesktopMessage,
  type DesktopEvent,
} from "./contract";

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

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
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
}
