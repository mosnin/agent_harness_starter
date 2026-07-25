/**
 * `hades tui` — the interactive live terminal dashboard over the real swarm.
 *
 * This is the surface that runs headless today: no Tauri window, no
 * `src/app/**` web scaffolding — just a keyboard-driven view of the swarm
 * rendered straight to the terminal, the Hermes-style "a real terminal
 * interface" counterpart to the desktop app's sidecar bridge.
 *
 * The actual state machine and renderer already exist and are fully
 * unit-tested on their own (`src/swarm-runtime/tui/app.ts`'s `TuiApp` /
 * `TuiController`, `src/swarm-runtime/tui/render.ts`'s `TuiState`). This file
 * is the thin main-loop that:
 *   - builds a real swarm via `realSwarmFactory()` (or an injected factory),
 *   - adapts it to a `TuiController` (`dispatchGoal`/`scalePool`/`cancel`),
 *   - polls `SwarmHandle.snapshot()` and maps it to `TuiState`,
 *   - pipes raw-mode stdin keypresses into `TuiApp.handleKey`, and
 *   - writes `TuiApp.frame()` to stdout whenever it changes.
 *
 * Like the rest of `hades`'s CLI surfaces, the non-interactive entry point
 * (`runTuiCommand`) is terminal-free — `{ code, lines }`, no `console.log`,
 * no `process.exit` — so `hades tui --help` unit-tests without a shell. The
 * real interactive loop (`runTuiInteractive`) does touch stdin/stdout, but
 * every dependency (streams, the swarm factory, the clock, the poll
 * interval) is injectable, and `deps.once` renders exactly one frame from an
 * initial snapshot and returns — deterministic, no timers, no raw mode —
 * which is what makes it testable headless too.
 *
 * Not wired into `cli.ts`/`index.ts` (the main router owns that centrally),
 * but fully self-contained: importing `runTuiCommand`/`runTuiInteractive`
 * from this module is enough to run the command on its own.
 */

import { TuiApp } from "../../swarm-runtime/tui/app";
import type { TuiController } from "../../swarm-runtime/tui/app";
import type { TuiState } from "../../swarm-runtime/tui/render";
import type {
  FleetPaneBackendRow,
  FleetPaneBanditRow,
  FleetPaneWorkerRow,
} from "../../swarm-runtime/tui/fleet-pane";
import type { ShowdownPaneResult } from "../../swarm-runtime/tui/showdown-pane";
import { runShowdown, verifyAuditChain } from "../bench/showdown";
import type { ShowdownResult } from "../bench/showdown";
import type { BackendManager } from "../backends/manager";
import type { BanditArm } from "../backends/route-bandit";
import { realSwarmFactory } from "../../desktop/core/sidecar";
import type { SwarmFactory, SwarmHandle } from "../../desktop/core/sidecar";

export interface TuiCommandResult {
  code: number;
  lines: string[];
}

export interface TuiDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Injectable swarm for tests; defaults to {@link realSwarmFactory}. */
  factory?: SwarmFactory;
  now?: () => number;
  /** Render one frame and return (for tests/CI) — no timers, no raw mode. */
  once?: boolean;
  /** Swarm isolation mode passed to the factory. Default "inline". */
  mode?: "inline" | "process" | "docker";
  /** Initial worker pool size requested from the factory. Default 3. */
  poolSize?: number;
  /** Snapshot poll interval in ms. Default 500. */
  pollIntervalMs?: number;
  /** Task count for the SHOWDOWN pane's `r` (modeled) run. Default 24. */
  showdownTasks?: number;
  /** Showdown engine override for tests; defaults to the real `runShowdown`. */
  runShowdownFn?: typeof runShowdown;
}

const HELP_LINES = [
  "hades tui — interactive live terminal dashboard over the swarm",
  "",
  "Usage: hades tui",
  "",
  "Keybindings:",
  "  g       start a new goal (compose mode)",
  "  +/-     scale worker pool up/down",
  "  c       cancel the active goal",
  "  ↑/↓     navigate the task list",
  "  f       toggle the FLEET pane (real BackendManager telemetry + route bandit)",
  "  s       toggle the SHOWDOWN pane (r runs a real modeled showdown in-place)",
  "  w       toggle the GATEWAY pane (real env connector probes + engine probe)",
  "  ?       toggle the help overlay",
  "  q       quit  (also Ctrl-C)",
  "  (fleet pane) ↑/↓ or j/k select worker, r refresh, esc/q back",
  "  (showdown pane) r run, esc/q back — every figure of a modeled run is",
  "                  labeled (modeled); nothing live is simulated",
  "  (gateway pane) ↑/↓ scroll traffic, r refresh, esc/q back — probes name env",
  "                 VARIABLE NAMES only; live traffic belongs to `hades gateway start`",
  "  (compose mode) type to build the objective, Enter to submit, Esc to cancel",
];

/**
 * Non-interactive help/usage path (terminal-free, like the other hades
 * commands) — returns `{ code, lines }`. With no recognized subcommand this
 * hands off to the real interactive loop, so a central router can wire
 * `case "tui": return runTuiCommand(rest)` and get both behaviors for free.
 */
export async function runTuiCommand(args: string[], deps: TuiDeps = {}): Promise<TuiCommandResult> {
  const [sub] = args;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    return { code: 0, lines: HELP_LINES };
  }
  if (sub !== undefined) {
    return { code: 1, lines: [`Unknown tui argument: ${sub}`, "Run `hades tui --help` for usage."] };
  }
  const code = await runTuiInteractive(deps);
  return { code, lines: [] };
}

// ---------------------------------------------------------------------------
// Swarm snapshot -> TuiState mapping
// ---------------------------------------------------------------------------

type WorkerRow = NonNullable<TuiState["workers"]>[number];
type TaskRow = NonNullable<TuiState["tasks"]>[number];
type LogRow = NonNullable<TuiState["logs"]>[number];

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function toWorkerRow(raw: unknown): WorkerRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const workerId = pickString(r.workerId, r.id);
  const status = typeof r.status === "string" ? r.status : undefined;
  if (!workerId || !status) return null;
  const capabilities = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === "string")
    : undefined;
  return { workerId, status, capabilities };
}

function toTaskRow(raw: unknown): TaskRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const description = typeof r.description === "string" ? r.description : undefined;
  const status = typeof r.status === "string" ? r.status : undefined;
  if (description === undefined || !status) return null;
  return { description, status };
}

/**
 * Map a raw {@link SwarmHandle} snapshot to the `TuiState` the render layer
 * understands. Defensive like `sidecar.ts`'s view mappers: an entry missing
 * required fields is dropped rather than rendered as garbage; a malformed
 * `metrics` blob is simply omitted (the dashboard renders fine without it).
 */
export function snapshotToTuiState(
  snapshot: ReturnType<SwarmHandle["snapshot"]>,
  mode: string,
  logs: LogRow[] = []
): TuiState {
  const workers = (Array.isArray(snapshot.workers) ? snapshot.workers : [])
    .map(toWorkerRow)
    .filter((w): w is WorkerRow => w !== null);
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : [])
    .map(toTaskRow)
    .filter((t): t is TaskRow => t !== null);
  const metrics =
    snapshot.metrics && typeof snapshot.metrics === "object"
      ? (snapshot.metrics as TuiState["metrics"])
      : undefined;

  return {
    mode,
    metrics,
    workers,
    tasks,
    logs,
    groundingRate: metrics?.verification.groundingRate,
  };
}

/**
 * `SwarmManager`'s `log` event fires as `(workerId, line)`; `realSwarmFactory`
 * forwards that through `SwarmHandle.on` as `[workerId, line]`. Normalize
 * whatever shape arrives (including a fake test handle emitting a plain
 * string or `{ workerId, line }`) into the `TuiState.logs` row shape.
 */
function normalizeLogPayload(payload: unknown): LogRow {
  if (Array.isArray(payload)) {
    const [a, b] = payload;
    if (typeof a === "string" && typeof b === "string") return { workerId: a, line: b };
    if (typeof a === "string") return { workerId: "swarm", line: a };
  }
  if (typeof payload === "string") return { workerId: "swarm", line: payload };
  if (payload && typeof payload === "object") {
    const r = payload as Record<string, unknown>;
    if (typeof r.line === "string") {
      return { workerId: typeof r.workerId === "string" ? r.workerId : "swarm", line: r.line };
    }
  }
  return { workerId: "swarm", line: "log" };
}

// ---------------------------------------------------------------------------
// FLEET pane wiring — real BackendManager rows, no adapter fabrication
// ---------------------------------------------------------------------------

/**
 * Map the REAL fleet substrate to the TUI FLEET pane's plain row shapes:
 * BACKENDS from `manager.descriptors()` + `manager.telemetry(name)` (with
 * `availability` from a real `manager.probeAll()` pass — `undefined` renders
 * the honest "unprobed", never a guessed "ready"), WORKERS from
 * `manager.list()` (the live registry, including crash-recovery-adopted
 * handles), and ROUTING from a real `CostAwareRouteBandit.arms()` snapshot.
 * Every figure is copied straight through; nothing is computed here.
 */
export function fleetPaneDataFromManager(
  manager: BackendManager,
  availability: Record<string, boolean>,
  arms: Record<string, BanditArm>
): { backends: FleetPaneBackendRow[]; workers: FleetPaneWorkerRow[]; bandit: FleetPaneBanditRow[] } {
  const backends: FleetPaneBackendRow[] = manager.descriptors().map((d) => {
    const t = manager.telemetry(d.name);
    const probed = availability[d.name];
    return {
      name: d.name,
      kind: d.kind,
      state: probed === true ? "available" : probed === false ? "unavailable" : "unprobed",
      provisions: t.provisions,
      accruedUsd: t.accruedUsd,
      provisionLatencyEmaMs: t.provisionLatencyEmaMs,
    };
  });

  const workers: FleetPaneWorkerRow[] = manager
    .list()
    .map((w) => ({
      workerId: w.handle.workerId,
      backend: w.handle.backend,
      lifecycle: w.handle.state,
      idleMs: w.idleMs,
    }))
    .sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0));

  const bandit: FleetPaneBanditRow[] = Object.keys(arms)
    .sort()
    .map((name) => ({
      name,
      pulls: arms[name].pulls,
      verified: arms[name].verified,
      meanReward: arms[name].meanReward,
      ucb: arms[name].ucb,
    }));

  return { backends, workers, bandit };
}

// ---------------------------------------------------------------------------
// SHOWDOWN pane wiring — a real modeled run through the real engine
// ---------------------------------------------------------------------------

/** Copy the REAL `ShowdownResult` figures into the pane's row shape, with
 *  `auditOk` from a genuine `verifyAuditChain` re-check (never assumed). */
export function showdownPaneResultFrom(result: ShowdownResult): ShowdownPaneResult {
  return {
    swarmVtph: result.swarmReport.vtphPerDollar,
    baselineVtph: result.baselineReport.vtphPerDollar,
    multiple: result.comparison.vtphPerDollarSpeedup,
    swarmVerified: result.swarmReport.verifiedCorrect,
    baselineVerified: result.baselineReport.verifiedCorrect,
    swarmSilentWrong: result.swarmReport.silentWrong,
    baselineSilentWrong: result.baselineReport.silentWrong,
    auditOk: verifyAuditChain(result.audit).ok,
  };
}

/**
 * Build the SHOWDOWN pane's `r` handler: kicks off ONE real
 * `runShowdown({ mode: "modeled" })` (deterministic, no keys, no network —
 * and every rendered figure carries the pane's own `(modeled)` label) and
 * streams its progress into `app.applyShowdownEvent`. The pane's `start`
 * event is only emitted once the engine reports its own real task-run total
 * via `onProgress` — the total is never precomputed here. A second `r` while
 * a run is in flight is a no-op (the pane reducer also guards this).
 */
export function createTuiShowdownRunner(
  app: TuiApp,
  opts: { taskCount?: number; seed?: number; render?: () => void; runShowdownFn?: typeof runShowdown } = {}
): () => void {
  const runFn = opts.runShowdownFn ?? runShowdown;
  const taskCount = opts.taskCount ?? 24;
  const seed = opts.seed ?? 42;
  const render = opts.render ?? ((): void => {});
  let running = false;

  return (): void => {
    if (running) return;
    running = true;
    let started = false;
    const ensureStarted = (total: number): void => {
      if (started) return;
      started = true;
      app.applyShowdownEvent({ type: "start", mode: "modeled", total });
    };

    void runFn({
      mode: "modeled",
      seed,
      taskCount,
      onProgress: (done, total) => {
        ensureStarted(total);
        app.applyShowdownEvent({ type: "progress", done });
        render();
      },
    })
      .then((result) => {
        ensureStarted(result.audit.length);
        app.applyShowdownEvent({ type: "done", result: showdownPaneResultFrom(result) });
      })
      .catch((err: unknown) => {
        ensureStarted(0);
        app.applyShowdownEvent({ type: "fail", error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = false;
        render();
      });
  };
}

// ---------------------------------------------------------------------------
// TuiController wiring
// ---------------------------------------------------------------------------

/**
 * Adapt a {@link SwarmHandle} to the `TuiController` surface `TuiApp` drives
 * key presses through. Kept as a standalone factory (rather than inlined in
 * `runTuiInteractive`) so it is directly unit-testable against a scripted
 * fake handle with no terminal, timers, or raw-mode stdin involved.
 *
 * `scalePool` on the controller is relative (+/-1 per keypress); the swarm's
 * `scalePool` is absolute, so this tracks the last-known pool size and turns
 * deltas into an absolute size, clamped at 0. `cancel` targets whichever goal
 * was most recently dispatched (the TUI only ever has one goal in flight at a
 * time from the operator's perspective); it's a no-op until a goal exists.
 */
export function createSwarmController(handle: SwarmHandle, opts: { poolSize?: number } = {}): TuiController {
  let poolSize = Math.max(0, opts.poolSize ?? 0);
  let activeGoalId: string | undefined;

  return {
    dispatchGoal(objective: string): void {
      void Promise.resolve(handle.dispatchGoal(objective))
        .then((res) => {
          activeGoalId = res?.goalId;
        })
        .catch(() => {
          /* failures surface via the swarm's own log/event stream, if any */
        });
    },
    scalePool(delta: number): void {
      poolSize = Math.max(0, poolSize + delta);
      void Promise.resolve(handle.scalePool?.(poolSize)).catch(() => {});
    },
    cancel(): void {
      if (!activeGoalId) return;
      void Promise.resolve(handle.cancelGoal?.(activeGoalId)).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// The real interactive loop
// ---------------------------------------------------------------------------

type RawStdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown };

/**
 * The real interactive loop: raw-mode stdin keypresses -> `TuiApp.handleKey`;
 * poll the swarm snapshot -> `TuiState` -> `app.setState`; render
 * `app.frame()` to stdout on change; quit on q/Ctrl-C, restoring the
 * terminal. Resolves with the process exit code.
 *
 * `deps.once` short-circuits all of that: build the handle, read exactly one
 * snapshot, render exactly one frame, close the handle, and return 0 — no
 * stdin is touched at all (so raw mode is never entered), no timers are
 * started. That's the path tests drive.
 */
export async function runTuiInteractive(deps: TuiDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const now = deps.now ?? Date.now;
  const mode = deps.mode ?? "inline";
  const poolSize = deps.poolSize ?? 3;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;

  const factory = deps.factory ?? realSwarmFactory();
  const handle = await factory({ mode, poolSize });

  const logs: LogRow[] = [];
  handle.on?.("log", (payload: unknown) => {
    logs.push(normalizeLogPayload(payload));
    if (logs.length > 50) logs.splice(0, logs.length - 50);
  });

  // Pane hooks are late-bound: the fleet/gateway refreshes and showdown
  // runner need the app (and the interactive loop's `render`) to exist first,
  // so the controller closes over mutable slots that the loop fills in below.
  // In `once` mode they stay honest no-ops — a single non-interactive frame
  // never probes backends, probes gateway env, or starts a showdown.
  let fleetRefresh: () => void = () => {};
  let showdownRun: () => void = () => {};
  let gatewayRefresh: () => void = () => {};
  const controller: TuiController = {
    ...createSwarmController(handle, { poolSize }),
    refreshFleet: () => fleetRefresh(),
    runShowdown: () => showdownRun(),
    refreshGateway: () => gatewayRefresh(),
  };
  const app = new TuiApp({ controller });

  const readState = (): TuiState => snapshotToTuiState(handle.snapshot(), mode, logs.slice(-5));

  if (deps.once) {
    app.setState(readState());
    stdout.write(app.frame());
    await Promise.resolve(handle.close?.()).catch(() => {});
    return 0;
  }

  void now; // reserved clock hook (kept for parity with the rest of the desktop/sidecar deps)

  const stdin = (deps.stdin ?? process.stdin) as RawStdin;

  return new Promise<number>((resolveExit) => {
    let lastFrame = "";
    let finished = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const render = (): void => {
      try {
        app.setState(readState());
      } catch (err) {
        stdout.write(`\n[tui] snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }
      const frame = app.frame();
      if (frame !== lastFrame) {
        lastFrame = frame;
        stdout.write(`\x1b[2J\x1b[H${frame}\n`);
      }
    };

    // SHOWDOWN pane: `r` runs a real modeled showdown through the real
    // engine, progress streaming straight into the pane reducer.
    showdownRun = createTuiShowdownRunner(app, {
      taskCount: deps.showdownTasks,
      render,
      runShowdownFn: deps.runShowdownFn,
    });

    // FLEET pane: the real fleet substrate (BackendManager + FleetSupervisor
    // + the shared route-bandit history at <dataDir>/route-bandit.json — the
    // SAME files `hades backends` and the desktop app use), built lazily on
    // the first refresh so opening the TUI never probes docker unasked.
    let fleetRigPromise:
      | Promise<{ manager: BackendManager; arms: () => Promise<Record<string, BanditArm>> }>
      | undefined;
    const getFleetRig = (): NonNullable<typeof fleetRigPromise> => {
      fleetRigPromise ??= (async () => {
        const { createRealFleet } = await import("../../desktop/core/fleet-wiring");
        const fleet = createRealFleet({});
        await fleet.restore();
        return { manager: fleet.manager, arms: () => fleet.routeBanditArms() };
      })();
      return fleetRigPromise;
    };
    fleetRefresh = (): void => {
      void (async () => {
        const rig = await getFleetRig();
        const availability = await rig.manager.probeAll();
        const arms = await rig.arms();
        app.setFleetData(fleetPaneDataFromManager(rig.manager, availability, arms));
        render();
      })().catch((err: unknown) => {
        logs.push({ workerId: "fleet", line: `refresh failed: ${err instanceof Error ? err.message : String(err)}` });
        render();
      });
    };

    // GATEWAY pane: real env probing through the SAME code paths `hades
    // gateway` uses — buildConnectorsFromEnv's probe report (variable NAMES
    // only, never values) via a real, never-started GatewayProcess, plus the
    // PURE probeGatewayEngine decision (nothing heavy is ever constructed).
    // The counters shown are this process's own gateway counters — a real
    // zero tally from a real unstarted process, because the TUI does not run
    // the gateway; live traffic/badges belong to `hades gateway start`.
    let gatewayProcPromise: Promise<import("../gateway/process").GatewayProcess> | undefined;
    gatewayRefresh = (): void => {
      void (async () => {
        gatewayProcPromise ??= (async () => {
          const { GatewayProcess } = await import("../gateway/process");
          // The handler is unreachable: this process is never start()ed.
          return new GatewayProcess({
            handler: async () => ({ text: "", accepted: false }),
            env: process.env,
          });
        })();
        const [proc, { probeGatewayEngine }] = await Promise.all([
          gatewayProcPromise,
          import("../gateway/engine-select"),
        ]);
        const s = proc.status();
        const probe = probeGatewayEngine(process.env);
        app.applyGatewayStatus({
          probes: s.platforms,
          counters: s.counters,
          engine: { requested: probe.requested, mode: probe.mode, detail: probe.detail },
        });
        render();
      })().catch((err: unknown) => {
        logs.push({ workerId: "gateway", line: `refresh failed: ${err instanceof Error ? err.message : String(err)}` });
        render();
      });
    };

    const onData = (chunk: string | Buffer): void => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const result = app.handleKey(key);
      if (result.quit) {
        void finish(0);
        return;
      }
      render();
    };

    const finish = async (code: number): Promise<void> => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      stdin.removeListener?.("data", onData);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause?.();
      await Promise.resolve(handle.close?.()).catch(() => {});
      resolveExit(code);
    };

    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.setEncoding?.("utf8");
    stdin.resume?.();
    stdin.on?.("data", onData);

    timer = setInterval(render, pollIntervalMs);
    render();
  });
}
