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
import {
  Sidecar,
  realSwarmFactory,
  type SwarmFactory,
  type SkillsHandler,
  type FleetHandler,
  type FleetProvisionHandler,
  type LearningStatusHandler,
  type InferenceInfo,
} from "./core/sidecar";
import { SkillsService } from "./core/skills-service";
import { detectInference } from "./core/inference";
import { createRealFleet } from "./core/fleet-wiring";
import { LearningService } from "./core/learning-service";
import {
  FileLearningStatusStore,
  persistingOnEvent,
  type PersistingOnEventHandle,
} from "../hades/backends/learning-status-store";
import type { SwarmLearningLoop } from "../hades/backends/swarm-learning";
import { loadConfig } from "../hades/config/config";

export interface RunSidecarOptions {
  /** Defaults to a `Sidecar` backed by {@link realSwarmFactory}. Tests inject a scripted fake instead. */
  factory?: SwarmFactory;
  /** Clock override for `log` event timestamps, for deterministic tests. */
  now?: () => number;
  /** Real skills backend; defaults to a {@link SkillsService} over the local skills dir. */
  skills?: SkillsHandler;
  /** Real fleet backend; defaults to {@link createRealFleet}'s `FleetService`
   *  over the real `BackendManager` + `FleetSupervisor` (local + docker
   *  backends, crash-consistent persistence at `<dataDir>/fleet.json`). */
  fleet?: FleetHandler;
  /** Real fleet-provision backend (`fleet.provision` + `fleet.restored`);
   *  defaults to {@link createRealFleet}'s `FleetProvisionService` (bandit-
   *  routed backend selection + registry adoption on restore) whenever
   *  `fleet` is also defaulted. Injecting `fleet` without `provision` leaves
   *  provisioning honestly unconfigured (the sidecar reports it as such). */
  provision?: FleetProvisionHandler;
  /** Inference mode reported on start; defaults to {@link detectInference} over `process.env`. */
  inference?: InferenceInfo;
  /** Real learning-status backend for `learning.get`; defaults (when `fleet`
   *  is also defaulted) to a {@link LearningService} preferring the live
   *  attached loop and falling back to the durable snapshot at
   *  `<dataDir>/learning-status.json` — the SAME file `hades backends learn`
   *  reads, so the desktop and the terminal see one learning history. */
  learningStatus?: LearningStatusHandler;
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

  let fleet = opts.fleet;
  let provision = opts.provision;
  let learning: ConstructorParameters<typeof Sidecar>[0]["learning"];
  let learningStatus = opts.learningStatus;
  let factory = opts.factory;
  if (!fleet) {
    // Real fleet stack (BackendManager + FleetSupervisor + HandleStore +
    // bandit-routed provisioning + registry adoption). Construction is
    // side-effect free; restore() is a best-effort async crash-recovery pass
    // (probe + adopt) that never throws and never blocks startup.
    const dataDir = loadConfig({ env: process.env }).dataDir;
    const realFleet = createRealFleet({ now, dataDir });
    void realFleet.restore();
    fleet = realFleet.service;
    provision ??= realFleet.provision;
    // Durable learning-status snapshots at <dataDir>/learning-status.json —
    // the SAME file `hades backends learn` reads, so the desktop and the
    // terminal report one learning history. Saves are debounced off the
    // loop's own "feed" events and forced on "detached"; every save is
    // atomic (tmp + rename) and never throws (see learning-status-store.ts).
    const learningStore = new FileLearningStatusStore({ path: `${dataDir}/learning-status.json`, now });
    // The currently-attached live loop, if any — `learning.get` prefers it
    // over the on-disk snapshot and labels the answer honestly either way.
    let liveLoop: SwarmLearningLoop | undefined;
    // Self-improving routing loop: the sidecar attaches this to every started
    // swarm's raw event stream. Outcomes feed the SAME route bandit the
    // fleet.provision path routes with (one shared learned history at
    // <dataDir>/route-bandit.json).
    learning = async (swarm) => {
      let persisting: PersistingOnEventHandle | undefined;
      const loop = await realFleet.attachLearning(swarm, (e) => persisting?.onEvent(e));
      persisting = persistingOnEvent(learningStore, () => loop.status(), { now });
      liveLoop = loop;
      return {
        detach: async () => {
          if (liveLoop === loop) liveLoop = undefined;
          try {
            // loop.detach() emits a final "detached" event, which persisting
            // turns into an immediate (non-debounced) snapshot save.
            await loop.detach();
          } finally {
            await persisting?.flush();
            persisting?.dispose();
          }
        },
      };
    };
    // `learning.get` answers from the live loop when one is attached (source:
    // "live"), else from the durable snapshot (source: "snapshot"), else with
    // the honest "no learning status available" error — never a fabricated
    // empty status. The service is rebuilt per command so it always sees the
    // CURRENT liveLoop, not the one captured at startup.
    learningStatus ??= {
      handle: (cmd, emit) =>
        new LearningService({
          ...(liveLoop ? { source: liveLoop } : {}),
          loadPersisted: async () => {
            const persisted = await learningStore.load();
            return persisted ? { at: persisted.at, status: persisted.status } : undefined;
          },
          now,
        }).handle(cmd, emit),
    };
    // Real spawn-path attribution: process/docker workers spawned by the
    // engine are recorded in the fleet's worker->backend attribution map and
    // adopted into the live registry, so the learning loop's resolveBackend
    // answers with measured facts instead of "unknown". Only wired when the
    // factory is also defaulted — an injected factory keeps full control.
    factory ??= realSwarmFactory({ decorateProvider: (p, mode) => realFleet.decorateProvider(p, mode) });
  }

  const sidecar = new Sidecar({
    factory,
    now,
    emit: (event: AppEvent) => output(encodeEvent(event)),
    skills: opts.skills ?? new SkillsService(),
    fleet,
    provision,
    inference: opts.inference ?? detectInference(),
    learning,
    learningStatus,
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
    // No explicit factory: runSidecar wires the real engine factory itself,
    // decorated with the real fleet's worker->backend attribution.
    await runSidecar(process.stdin, output, {});
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
