#!/usr/bin/env node
/**
 * Hades desktop sidecar — Node entry point.
 *
 * The Rust native shell (`src-tauri/src/main.rs`) spawns this file as a
 * child process (`node dist/desktop/sidecar-entry.js` by default, overridable
 * via `HADES_SIDECAR`) and pipes its own stdin/stdout straight through to it.
 * On the wire, that pipe carries the desktop IPC contract
 * (`./ipc/contract.ts`): newline-delimited `Command` JSON in, newline-
 * delimited `AppEvent` JSON out.
 *
 * This file is just the process shell around that: read lines from stdin,
 * decode them as `Command`s, hand them to a `Sidecar` (`./core/sidecar.ts`)
 * wired to the real swarm engine via `realSwarmFactory()`, and write every
 * `AppEvent` the sidecar emits back out as an encoded JSON line. All of the
 * actual command handling / engine bridging lives in `Sidecar` — this file
 * owns none of that logic, only the stdio plumbing.
 *
 * `runSidecar` is exported separately from `main` precisely so that plumbing
 * can be exercised in tests against a fake input stream and a fake swarm
 * factory, with no real stdio and no child processes involved.
 */

import { encodeEvent, decodeCommand } from "./ipc/contract";
import type { AppEvent, Command } from "./ipc/contract";
import { Sidecar, realSwarmFactory, type SwarmFactory, type SkillsHandler, type InferenceInfo } from "./core/sidecar";
import { SkillsService } from "./core/skills-service";
import { detectInference } from "./core/inference";

export interface RunSidecarOptions {
  /** Defaults to a `Sidecar` backed by {@link realSwarmFactory}. Tests inject a scripted fake instead. */
  factory?: SwarmFactory;
  /** Clock override for `log` event timestamps, for deterministic tests. */
  now?: () => number;
  /** Real skills backend; defaults to a {@link SkillsService} over the local skills dir. */
  skills?: SkillsHandler;
  /** Inference mode reported on start; defaults to {@link detectInference} over `process.env`. */
  inference?: InferenceInfo;
}

/**
 * Split a stream of raw chunks into newline-delimited lines, buffering a
 * trailing partial line across chunk boundaries. This is what makes
 * `runSidecar` accept either a raw byte/string stream (real process stdin,
 * which has no notion of "one command per chunk") or a test fixture that
 * hands over one full command per chunk — both come out the same way.
 */
async function* lineBuffer(input: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Drive the sidecar end to end: decode each input line as a `Command`, hand
 * it to a `Sidecar`, and write every `AppEvent` the sidecar emits back out
 * via `output`. A line that isn't valid JSON, or doesn't decode to a known
 * `Command`, never crashes the process — it becomes a `log` `AppEvent`
 * instead (the same fate as any other sidecar-side failure; `Sidecar.handle`
 * itself never throws).
 *
 * Fully testable in isolation: `input` can be any async iterable of chunks
 * (not just real stdin), `output` can be a plain array-pushing function, and
 * `opts.factory` can replace the real swarm engine with a scripted fake so
 * no actual worker pool ever spins up in a test.
 */
export async function runSidecar(
  input: AsyncIterable<string | Buffer> | NodeJS.ReadableStream,
  output: (line: string) => void,
  opts: RunSidecarOptions = {}
): Promise<void> {
  const now = opts.now ?? Date.now;

  const sidecar = new Sidecar({
    factory: opts.factory,
    now,
    emit: (event: AppEvent) => output(encodeEvent(event)),
    skills: opts.skills ?? new SkillsService(),
    inference: opts.inference ?? detectInference(),
  });

  try {
    for await (const rawLine of lineBuffer(input as AsyncIterable<string | Buffer>)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      let command: Command;
      try {
        command = decodeCommand(line);
      } catch (err) {
        output(
          encodeEvent({
            kind: "log",
            line: `malformed command, ignored: ${errMsg(err)}`,
            at: now(),
          })
        );
        continue;
      }

      // Sequential, awaited handling: each command's resulting AppEvents are
      // fully emitted before the next line is read, so output order tracks
      // input order one-to-one.
      await sidecar.handle(command);
    }
  } finally {
    await sidecar.close();
  }
}

/** Wires the real process stdio to {@link runSidecar}. Only invoked when this file is the process entry point (see the guard below) — never by tests. */
export async function main(): Promise<void> {
  const output = (line: string): void => {
    process.stdout.write(line);
  };

  try {
    await runSidecar(process.stdin, output, { factory: realSwarmFactory() });
  } catch (err) {
    // Last-resort guard: a bug in runSidecar's own plumbing (not in a
    // command handler, which Sidecar already isolates) should still surface
    // as a log line the renderer/TUI can show, rather than an unhandled
    // rejection with no trace.
    output(
      encodeEvent({
        kind: "log",
        line: `sidecar-entry fatal: ${errMsg(err)}`,
        at: Date.now(),
      })
    );
    process.exitCode = 1;
  }
}

// Only auto-run when invoked directly by the Rust supervisor (`node
// dist/desktop/sidecar-entry.js`), never when imported by a test.
const invokedDirectly =
  process.argv[1]?.endsWith("sidecar-entry.ts") || process.argv[1]?.endsWith("sidecar-entry.js");
if (invokedDirectly) {
  void main();
}
