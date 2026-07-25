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
  type GatewayHandler,
  type ScheduleHandler,
  type StateHandler,
  type MigrateHandler,
  type TrustHandler,
  type MarketHandler,
  type InferenceInfo,
} from "./core/sidecar";
import { StateService } from "./core/state-service";
import { MigrateService } from "./core/migrate-service";
import { TrustService } from "./core/trust-service";
import { MarketService } from "./core/market-service";
import { defaultMigrateDeps } from "../hades/cli/migrate-command";
import type { StateEvent } from "./ipc/state-contract";
import { createWorkspaceStack } from "../hades/state/wiring";
import { SkillsService } from "./core/skills-service";
import { SkillTrustService } from "./core/skill-trust-service";
import { GatewayService } from "./core/gateway-service";
import { buildGatewayDeps } from "../hades/cli/gateway-deps";
import { probeGatewayEngine } from "../hades/gateway/engine-select";
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
  /** Real skills backend; defaults to a {@link SkillsService} over the local
   *  skills dir, with a real {@link SkillTrustService} attached so every
   *  `skills.list` entry carries its fail-closed trust badge (read from the
   *  SAME `<dataDir>/skill-trust.json` + `<dataDir>/skill-track.json` files
   *  `hades skill trust`/`track` write). */
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
  /** Real gateway backend for `gateway.status.get` / `gateway.pair.issue`;
   *  defaults to a {@link GatewayService} over the REAL `buildGatewayDeps`
   *  composition — the same env probing, `<dataDir>/gateway/trust.json`
   *  trust store, and pairing guard `hades gateway` uses, so a code issued
   *  from the desktop redeems against the same trust file the terminal
   *  gateway enforces. Built lazily on the first gateway command so sidecar
   *  startup never touches the gateway stack unasked. */
  gateway?: GatewayHandler;
  /** Real scheduler backend for `schedule.*`; defaults to a `ScheduleService`
   *  over the SAME `<dataDir>/schedule.json` job store `hades schedule`
   *  writes, with a real `SchedulerRunner` attached for `schedule.job.run`
   *  (note + swarm.goal executors; the swarm executor runs the honestly-
   *  labeled mock echo engine — the REAL engine belongs to
   *  `hades gateway start --schedule`), and every delivery receipt appended
   *  to the hash-chained ledger at `<dataDir>/schedule-receipts.json`. Built
   *  fresh per command so the desktop always sees what the CLI just wrote. */
  schedule?: ScheduleHandler;
  /** Real shared-workspace backend for `state.*`; defaults to a
   *  {@link StateService} over the REAL `WorkspaceStore`/`SyncEngine`/
   *  `WorkspaceFeed` stack at `<dataDir>/state` — the SAME journal
   *  `hades state` writes — under this desktop install's own stable
   *  `desktop` actor identity. Built lazily on the first `state.*` command
   *  so sidecar startup never takes the workspace lock unasked, and torn
   *  down (feed timer + store handle) when stdin ends. */
  state?: StateHandler;
  /** Real migration backend for `migrate.*`; defaults to a
   *  {@link MigrateService} over the REAL discover/read/plan/apply pipeline
   *  rooted at this install's `<dataDir>` — the SAME engine and the SAME
   *  data directory `hades migrate` uses, so a plan previewed here and a
   *  plan previewed in a terminal are the same plan. Built lazily on the
   *  first `migrate.*` command so sidecar startup never probes the
   *  filesystem for foreign installs unasked. */
  migrate?: MigrateHandler;
  /** Real trust-gate backend for `trust.*`; defaults to a
   *  {@link TrustService} over the REAL `openTrustStack()` rooted at this
   *  install's `<dataDir>/trust` — the SAME registry, ed25519 signing
   *  identity, hash-chained budget and persisted calibration `hades trust`
   *  uses, so a certificate issued in a terminal verifies here and both
   *  surfaces spend from one budget chain. Built lazily on the first
   *  `trust.*` command so sidecar startup never mints a signing key or opens
   *  the ledger unasked. */
  trust?: TrustHandler;
  /** Real market backend for `market.*`; defaults to a lazily-constructed
   *  `MarketService` over `openMarket()` rooted at this install's
   *  `<dataDir>` — the SAME hash-chained reputation ledger, economy,
   *  certificate replay registry and trusted ed25519 issuer `hades market`
   *  uses, so a certificate spent in a terminal cannot be re-spent in the
   *  desktop app. Lazy: nothing is read or deserialized until a `market.*`
   *  command actually arrives. */
  market?: MarketHandler;
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

  // Real gateway lane: GatewayService over the SAME buildGatewayDeps
  // composition `hades gateway` runs — same env probes (variable NAMES only,
  // never values), same <dataDir>/gateway trust/identity files, so desktop-
  // issued pairing codes redeem against the terminal gateway's trust store.
  // The stack is built lazily on the first gateway command and cached; the
  // engine probe is the PURE probeGatewayEngine (nothing heavy is ever
  // constructed just to answer a status snapshot).
  let gateway = opts.gateway;
  if (!gateway) {
    let realGatewayService: GatewayService | undefined;
    gateway = {
      handle: async (cmd, emit) => {
        if (!realGatewayService) {
          const config = loadConfig({ env: process.env });
          const deps = buildGatewayDeps(config, process.env);
          realGatewayService = new GatewayService({
            source: deps.process,
            pairing: deps.pairing,
            engineProbe: () => probeGatewayEngine(process.env),
            now,
          });
        }
        await realGatewayService.handle(cmd, emit);
      },
    };
  }

  // Real schedule lane: ScheduleService over the SAME <dataDir>/schedule.json
  // job store the `hades schedule` CLI writes. The stack is rebuilt on every
  // command — JsonFileJobStore reads its file at construction, and the
  // desktop must see jobs added from a terminal since the last look, never a
  // stale cache. `schedule.job.run` fires through a real SchedulerRunner
  // whose executor registry routes "note" to the honest no-evidence builtin
  // and "swarm.goal" to a SwarmJobExecutor over the honestly-labeled mock
  // echo engine (probe mode "mock" — the sidecar never spins up the real
  // swarm engine unasked; that belongs to `hades gateway start --schedule`).
  // Zero outbound senders are registered, so a delivery-bearing run resolves
  // honestly (abstained/failed), and every receipt lands in the hash-chained
  // ledger at <dataDir>/schedule-receipts.json — the SAME file
  // `hades schedule receipts` verifies.
  let schedule = opts.schedule;
  if (!schedule) {
    schedule = {
      handle: async (cmd) => {
        const [{ join }, { JsonFileJobStore }, { systemClock }, cron, { SchedulerRunner }, { VerifiedDeliveryRouter }, { ExecutorRegistry }, { SwarmJobExecutor, SWARM_TASK_KIND }, { DeliveryReceiptLedger, LedgeredDeliverer }, { BuiltinNoteExecutor }, { ScheduleService }, { echoEngine }] =
          await Promise.all([
            import("node:path"),
            import("../hades/schedule/store"),
            import("../hades/schedule/clock"),
            import("../hades/schedule/cron"),
            import("../hades/schedule/runner"),
            import("../hades/schedule/delivery"),
            import("../hades/schedule/executor-registry"),
            import("../hades/schedule/swarm-executor"),
            import("../hades/schedule/receipt-ledger"),
            import("../hades/cli/schedule-command"),
            import("./core/schedule-service"),
            import("../hades/gateway/agent-handler"),
          ]);
        const dataDir = loadConfig({ env: process.env }).dataDir;
        const store = new JsonFileJobStore(join(dataDir, "schedule.json"), systemClock);
        const registry = new ExecutorRegistry();
        registry.register("note", new BuiltinNoteExecutor());
        registry.register(
          SWARM_TASK_KIND,
          new SwarmJobExecutor({
            engine: echoEngine(),
            // Honest probe for the engine actually constructed above: the
            // sidecar always runs the mock echo engine for scheduled swarm
            // goals — never a fabricated "real" label.
            probe: {
              requested: "swarm",
              mode: "mock",
              detail:
                "desktop sidecar schedule lane runs the mock echo engine; run swarm.goal jobs through `hades gateway start --schedule` for the real engine",
            },
          }),
        );
        const ledger = new DeliveryReceiptLedger({ path: join(dataDir, "schedule-receipts.json"), clock: systemClock });
        const deliverer = new LedgeredDeliverer(
          new VerifiedDeliveryRouter({ senders: [], clock: systemClock }),
          ledger,
        );
        const runner = new SchedulerRunner({ store, clock: systemClock, executor: registry, deliverer });
        const service = new ScheduleService({
          jobs: store,
          runner,
          nextFire: (cronExpr, after, tz) => cron.nextFireTime(cron.parseCron(cronExpr), after, tz),
          now,
        });
        return service.handle(cmd);
      },
    };
  }

  // Real shared-workspace lane: one `WorkspaceStore` + `SyncEngine` +
  // `WorkspaceFeed` rooted at `<dataDir>/state` — byte-for-byte the same
  // journal `hades state` reads and writes — opened under this install's
  // STABLE `desktop` actor identity (persisted at `<root>/actors/desktop.json`,
  // see `../hades/state/wiring.ts`), so the desktop is one durable causal
  // participant rather than a new one per launch. Built lazily on the first
  // `state.*` command: sidecar startup must never take the workspace's
  // cross-process lock for an app that may never open the workspace view.
  // Feed errors are surfaced as honest `state.error` events, never swallowed.
  let state = opts.state;
  if (!state) {
    let stack: ReturnType<typeof createWorkspaceStack> | undefined;
    let service: StateService | undefined;
    let serviceUnsubscribe: (() => void) | undefined;
    // Subscribers registered BEFORE the stack exists (the `Sidecar`
    // constructor subscribes up front). Holding them here — rather than
    // building the stack just to have something to subscribe to — is what
    // keeps construction genuinely lazy: nothing opens the workspace, and
    // nothing takes its cross-process lock, until a `state.*` command
    // actually arrives.
    const pending = new Set<(e: StateEvent) => void>();
    const fanOut = (e: StateEvent): void => {
      for (const cb of [...pending]) {
        try {
          cb(e);
        } catch {
          /* one bad subscriber must never break another, or the feed */
        }
      }
    };

    const ensure = (): StateService => {
      if (service) return service;
      const dataDir = loadConfig({ env: process.env }).dataDir;
      stack = createWorkspaceStack({
        dataDir,
        kind: "desktop",
        env: process.env,
        now,
        // The feed's own error channel rides the same lane, so a watcher
        // that dies is reported to the renderer instead of the app silently
        // degrading to "nothing ever changes".
        onFeedError: (e) => fanOut({ kind: "state.error", op: "state.watch", message: e.message }),
      });
      service = new StateService({ store: stack.store, sync: stack.sync, feed: stack.feed, now });
      serviceUnsubscribe = service.subscribe(fanOut);
      return service;
    };

    state = {
      handle: async (cmd) => {
        try {
          return await ensure().handle(cmd);
        } catch (err) {
          // Only reachable if the stack itself fails to construct (an
          // unreadable data dir, a wedged lock); StateService.handle never
          // throws on its own. Report the REAL reason.
          return [{ kind: "state.error", op: cmd.kind, message: errMsg(err) }];
        }
      },
      subscribe: (emit) => {
        pending.add(emit);
        return () => {
          pending.delete(emit);
        };
      },
      close: () => {
        try {
          serviceUnsubscribe?.();
          service?.close();
        } finally {
          stack?.close();
          serviceUnsubscribe = undefined;
          service = undefined;
          stack = undefined;
          pending.clear();
        }
      },
    };
  }

  // Real migration lane: the same pipeline `hades migrate` drives, rooted at
  // the same `<dataDir>`. Lazy — nothing scans the filesystem for a
  // Hermes/OpenClaw install until a `migrate.*` command actually arrives —
  // and the service itself refuses to write without `confirm: true`.
  let migrate = opts.migrate;
  if (!migrate) {
    let service: MigrateService | undefined;
    migrate = {
      handle: async (cmd) => {
        try {
          service ??= new MigrateService({
            deps: {
              ...defaultMigrateDeps(process.env),
              dataDir: loadConfig({ env: process.env }).dataDir,
            },
            now,
          });
          return await service.handle(cmd);
        } catch (err) {
          // MigrateService.handle catches its own failures; this only fires
          // if constructing it (or resolving config) throws. Report the REAL
          // reason rather than an empty scan.
          return { kind: "migrate.error", op: cmd.kind, message: errMsg(err), at: now() };
        }
      },
    };
  }

  // Real trust lane: the same `openTrustStack()` handles `hades trust`
  // drives, rooted at the same `<dataDir>/trust`. Lazy — no signing key is
  // minted or read, and no budget ledger is opened, until a `trust.*`
  // command actually arrives — and the service refuses to persist a
  // calibration without `confirm: true`.
  let trust = opts.trust;
  if (!trust) {
    let service: TrustService | undefined;
    trust = {
      handle: async (cmd) => {
        try {
          service ??= new TrustService({
            stackOptions: { env: process.env, dataDir: loadConfig({ env: process.env }).dataDir },
            now,
          });
          return await service.handle(cmd);
        } catch (err) {
          // TrustService.handle catches its own failures; this only fires if
          // constructing it (or resolving config) throws. Report the REAL
          // reason rather than a synthesized healthy-looking status.
          return { kind: "trust.error", op: cmd.kind, message: errMsg(err), at: now() };
        }
      },
    };
  }

  // Real market lane: the same `openMarket()` handles `hades market` drives,
  // rooted at the same `<dataDir>` (and therefore trusting the same
  // `<dataDir>/trust/signing-key` the trust gate signs with). Lazy — no
  // ledger is deserialized and no key is read until a `market.*` command
  // actually arrives. `market.book` is a pure read: it prices an order book
  // and never settles money.
  let market = opts.market;
  if (!market) {
    let marketService: MarketService | undefined;
    market = {
      handle: async (cmd) => {
        try {
          marketService ??= new MarketService({
            stackOptions: { env: process.env, dataDir: loadConfig({ env: process.env }).dataDir },
            now,
          });
          return await marketService.handle(cmd);
        } catch (err) {
          // MarketService.handle catches its own failures; this only fires if
          // constructing it (or resolving config) throws. Report the REAL
          // reason rather than a synthesized empty market.
          return { kind: "market.error", op: cmd.kind, message: errMsg(err), at: now() };
        }
      },
    };
  }

  const sidecar = new Sidecar({
    factory,
    now,
    emit: (event: AppEvent) => output(encodeEvent(event)),
    // Real skills backend with real trust badges: SkillTrustService reads the
    // SAME <dataDir>/skill-trust.json + skill-track.json the `hades skill`
    // CLI writes, so the desktop's badges and the terminal's `trust show`
    // report one truth. `badges()` never throws — a corrupt store degrades to
    // per-skill integrity-error badges, never a dead skills list.
    skills: opts.skills ?? new SkillsService({ trust: new SkillTrustService() }),
    fleet,
    provision,
    inference: opts.inference ?? detectInference(),
    learning,
    learningStatus,
    gateway,
    schedule,
    state,
    migrate,
    trust,
    market,
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
    // `dispose`, not `close`: stdin has ended, so this is process-lifetime
    // teardown — the workspace feed's timer/watcher and the store handle
    // must go with it, not just the swarm handle.
    await sidecar.dispose();
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
