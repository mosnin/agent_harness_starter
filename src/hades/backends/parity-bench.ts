/**
 * parity-bench — the Phase 6 checkpoint: drives EVERY backend the fleet
 * knows about through the complete lifecycle (provision -> status ->
 * hibernate -> wake -> terminate, skipping hibernate honestly on backends
 * that don't support it) on ONE shared `BackendManager`, with the full
 * `BackendProvenanceLedger` hash chain wired to every manager event via
 * `ledgerEventSink`.
 *
 * REAL vs FAKE, explicitly:
 *  - `local` (`LocalProcessBackend`) runs a genuine OS child process (no
 *    injected spawn) — `transport: "real"`. `provisionMs`/`wakeMs` are the
 *    actual wall-clock delta around the real `BackendManager` calls,
 *    measured with the SAME injectable clock the manager itself uses
 *    (default `performance.now`), so the numbers in the report are exactly
 *    what the manager's own telemetry saw, never a separate guess.
 *  - `docker` (`DockerBackend`) is attempted with a REAL `docker` CLI
 *    (`transport: "real"`) ONLY when `opts.includeDocker` is true AND its
 *    own `isAvailable()` probe against the real binary passes; otherwise it
 *    is EXCLUDED entirely (never added to the fleet, never appears in
 *    `results`) with an honest skip line via `opts.log`. A missing/broken
 *    docker is never faked as a real result.
 *  - `modal` / `daytona` / `ssh` / `singularity` run their REAL backend
 *    classes (`ModalBackend`, `DaytonaBackend`, `SshBackend`,
 *    `SingularityBackend`) against IN-FILE deterministic fake
 *    transports/clients (`transport: "fake"`, printed and reported as
 *    such) — there is no real Modal account, Daytona account, SSH host, or
 *    Singularity node available in this environment, so the injectable
 *    seam each class already exposes is fed a fake that behaves like the
 *    real thing structurally (spawns/starts/execs return well-formed
 *    responses, `status`/`poll`/`getState` reflect what was actually done)
 *    without ever claiming to be `"real"`.
 *
 * Every number in {@link ParityBenchReport} is measured from this actual
 * run: `provisionMs`/`wakeMs` are real clock deltas around real
 * `BackendManager` calls (finite, >= 0, never a constant); `certificate`
 * comes from `BackendProvenanceLedger.toCertificateFields()` after every
 * lifecycle event genuinely emitted by `BackendManager.onEvent` was
 * appended to the chain; `chainVerified` is the result of actually
 * re-walking that chain with `ledger.verifyChain()`.
 */

import { BackendManager, type BackendManagerEvent } from "./manager";
import { BackendProvenanceLedger, ledgerEventSink } from "./provenance";
import type { BackendDescriptor } from "./descriptor";
import type { RemoteSpec } from "./backend";
import { LocalProcessBackend } from "./local";
import { DockerBackend } from "./docker";
import { ModalBackend, type ModalCall, type ModalCallStatus, type ModalClient, type ModalSpawnInput } from "./modal";
import { DaytonaBackend, type DaytonaClient, type DaytonaCreateInput, type DaytonaState, type DaytonaWorkspace } from "./daytona";
import { SshBackend, type ExecResult, type SshTransport } from "./ssh";
import { SingularityBackend, type CommandRunner } from "./singularity";

// ===========================================================================
// Public contract (LOCKED)
// ===========================================================================

export interface ParityBenchOptions {
  /** Attempt a REAL docker backend only if `docker version` (via
   *  `DockerBackend#isAvailable()`) actually passes; otherwise docker is
   *  excluded entirely with an honest skip — never faked as real. Default
   *  false (docker is not even probed unless explicitly opted in). */
  includeDocker?: boolean;
  /** Injectable clock, shared with the `BackendManager` this bench builds
   *  and used to measure `provisionMs`/`wakeMs`/`totalMs`. Default
   *  `performance.now`. */
  now?: () => number;
  /** Observability sink for human-readable progress lines (never required
   *  for correctness — the report is the source of truth). */
  log?: (line: string) => void;
}

export interface ParityBenchBackendResult {
  backend: string;
  kind: string;
  /** Honest transport label: "real" for local/docker, "fake" for the
   *  serverless/remote backends run against in-file deterministic fakes. */
  transport: "real" | "fake";
  provisioned: boolean;
  hibernated: boolean;
  woken: boolean;
  terminated: boolean;
  provisionMs: number | null;
  wakeMs: number | null;
  error?: string;
}

export interface ParityBenchReport {
  results: ParityBenchBackendResult[];
  chainVerified: boolean;
  certificate: { traceRoot: string; head: string; length: number };
  totalMs: number;
  allLifecyclesComplete: boolean;
}

/**
 * Return type of {@link runParityBenchDetailed} — the same report PLUS the
 * live `BackendProvenanceLedger` instance the run built, so callers that
 * need to inspect or (in tests) deliberately tamper with the chain post-run
 * can do so without `runParityBench`'s locked, ledger-free return type
 * getting in the way.
 */
export interface ParityBenchDetailedResult {
  report: ParityBenchReport;
  ledger: BackendProvenanceLedger;
}

// ===========================================================================
// Deterministic in-file fakes for the serverless/remote backend seams.
// Each is a genuine, real implementation of the class's own injectable
// interface (real code runs, real state machines advance) — only the
// "network" behind it is a fake, in-memory Map-backed simulation. Nothing
// here reports itself as `transport: "real"`.
// ===========================================================================

/** Set to "1" to make the fake Modal client's `spawn()` throw, for testing
 *  the honest-failure path end to end without touching the locked
 *  `ParityBenchOptions` shape. Never read anywhere in production code paths
 *  outside this file's own fake. */
export const FORCE_MODAL_SPAWN_FAILURE_ENV = "HADES_PARITY_BENCH_FORCE_MODAL_FAILURE";

function makeFakeModalClient(): ModalClient {
  let counter = 0;
  const calls = new Map<string, ModalCallStatus>();
  return {
    async isConfigured(): Promise<boolean> {
      return true;
    },
    async spawn(_input: ModalSpawnInput): Promise<ModalCall> {
      if (process.env[FORCE_MODAL_SPAWN_FAILURE_ENV] === "1") {
        throw new Error("fake modal: spawn failed (forced for testing via " + FORCE_MODAL_SPAWN_FAILURE_ENV + ")");
      }
      counter += 1;
      const callId = `fake-modal-call-${counter}`;
      calls.set(callId, "running");
      return { callId, url: `https://fake-modal.local/${callId}` };
    },
    async poll(callId: string): Promise<ModalCallStatus> {
      return calls.get(callId) ?? "failed";
    },
    async cancel(callId: string): Promise<void> {
      calls.set(callId, "cancelled");
    },
    async logs(callId: string, tailLines?: number): Promise<string> {
      return `fake modal logs for ${callId} (tail=${tailLines ?? 100})`;
    },
  };
}

function makeFakeDaytonaClient(): DaytonaClient {
  let counter = 0;
  const states = new Map<string, DaytonaState>();
  return {
    async isConfigured(): Promise<boolean> {
      return true;
    },
    async createWorkspace(_input: DaytonaCreateInput): Promise<DaytonaWorkspace> {
      counter += 1;
      const workspaceId = `fake-daytona-ws-${counter}`;
      states.set(workspaceId, "started");
      return { workspaceId, url: `https://fake-daytona.local/${workspaceId}` };
    },
    async startWorkspace(workspaceId: string): Promise<DaytonaWorkspace> {
      states.set(workspaceId, "started");
      return { workspaceId, url: `https://fake-daytona.local/${workspaceId}` };
    },
    async stopWorkspace(workspaceId: string): Promise<void> {
      states.set(workspaceId, "stopped");
    },
    async deleteWorkspace(workspaceId: string): Promise<void> {
      states.set(workspaceId, "deleted");
    },
    async getState(workspaceId: string): Promise<DaytonaState> {
      return states.get(workspaceId) ?? "error";
    },
    async logs(workspaceId: string): Promise<string> {
      return `fake daytona logs for ${workspaceId}`;
    },
  };
}

/** Simulates a remote process table over SSH: `nohup ... & echo $!` style
 *  provisioning, `kill -0` liveness, and `kill` termination — matching
 *  exactly the shell fragments `SshBackend` (`./ssh.ts`) actually sends. */
function makeFakeSshTransport(): SshTransport {
  let pidCounter = 20000;
  const alive = new Set<number>();
  return {
    async exec(remoteCommand: string): Promise<ExecResult> {
      if (remoteCommand === "echo hades-ok") {
        return { stdout: "hades-ok\n", stderr: "", code: 0 };
      }
      if (remoteCommand.includes("nohup")) {
        pidCounter += 1;
        alive.add(pidCounter);
        return { stdout: `${pidCounter}\n`, stderr: "", code: 0 };
      }
      const killZero = remoteCommand.match(/^kill -0 (\d+)/);
      if (killZero) {
        const pid = Number(killZero[1]);
        return { stdout: alive.has(pid) ? "alive\n" : "dead\n", stderr: "", code: 0 };
      }
      const kill = remoteCommand.match(/^kill (\d+)/);
      if (kill) {
        const pid = Number(kill[1]);
        alive.delete(pid);
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

/** Simulates the `apptainer`/`singularity` CLI's instance table, matching
 *  exactly the argv shapes `SingularityBackend` (`./singularity.ts`)
 *  actually runs. */
function makeFakeSingularityRunner(): CommandRunner {
  const running = new Set<string>();
  return {
    async run(_bin: string, args: string[]): Promise<ExecResult> {
      if (args[0] === "--version") return { stdout: "fake-apptainer version 1.0.0\n", stderr: "", code: 0 };
      if (args[0] === "instance" && args[1] === "start") {
        const instance = args[args.length - 1];
        running.add(instance);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "instance" && args[1] === "list") {
        return { stdout: [...running].join("\n"), stderr: "", code: 0 };
      }
      if (args[0] === "instance" && args[1] === "stop") {
        const instance = args[2];
        running.delete(instance);
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

// ===========================================================================
// Fleet assembly
// ===========================================================================

const CONFIGURED_ZERO_COST = { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" as const };

interface FleetEntry {
  name: string;
  kind: string;
  transport: "real" | "fake";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register every backend this bench can exercise onto `manager`, honoring
 * the real-vs-fake rules documented at the top of this file. Returns the
 * ordered list of entries actually registered (docker may be absent).
 */
async function assembleFleet(
  manager: BackendManager,
  nowFn: () => number,
  includeDocker: boolean,
  log: (line: string) => void,
): Promise<FleetEntry[]> {
  const entries: FleetEntry[] = [];

  // A short grace period keeps the real SIGTERM->SIGKILL teardown snappy in
  // CI/tests without changing what actually happens: the worker still gets
  // a genuine chance to exit cleanly on SIGTERM before SIGKILL follows.
  const local = new LocalProcessBackend({ name: "local", now: nowFn, graceMs: 200 });
  const localDescriptor: BackendDescriptor = {
    name: "local",
    kind: "local",
    capabilities: ["shell", "local"],
    cost: CONFIGURED_ZERO_COST,
    supportsHibernate: true,
    locality: "local",
  };
  manager.register(local, localDescriptor);
  entries.push({ name: "local", kind: "local", transport: "real" });

  if (includeDocker) {
    const docker = new DockerBackend({ name: "docker", now: nowFn, defaultImage: "hello-world" });
    let available = false;
    try {
      available = await docker.isAvailable();
    } catch {
      available = false;
    }
    if (available) {
      const dockerDescriptor: BackendDescriptor = {
        name: "docker",
        kind: "container",
        capabilities: ["docker", "container"],
        cost: CONFIGURED_ZERO_COST,
        supportsHibernate: true,
        locality: "local",
      };
      manager.register(docker, dockerDescriptor);
      entries.push({ name: "docker", kind: "container", transport: "real" });
      log("[parity-bench] docker: probe passed — included as a REAL backend.");
    } else {
      log("[parity-bench] docker: probe failed (docker not available on this host) — excluded honestly, never faked.");
    }
  } else {
    log("[parity-bench] docker: includeDocker not set — skipped without probing.");
  }

  const modal = new ModalBackend(makeFakeModalClient(), { name: "modal", now: nowFn });
  manager.register(modal, {
    name: "modal",
    kind: "serverless",
    capabilities: ["serverless", "python"],
    cost: { perRunningHourUsd: 0.3, perHibernatedHourUsd: 0, perProvisionUsd: 0.001, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
  });
  entries.push({ name: "modal", kind: "serverless", transport: "fake" });

  const daytona = new DaytonaBackend(makeFakeDaytonaClient(), { name: "daytona", now: nowFn, image: "fake-daytona-image" });
  manager.register(daytona, {
    name: "daytona",
    kind: "workspace",
    capabilities: ["workspace", "persistent-disk"],
    cost: { perRunningHourUsd: 0.2, perHibernatedHourUsd: 0.01, perProvisionUsd: 0, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
  });
  entries.push({ name: "daytona", kind: "workspace", transport: "fake" });

  const ssh = new SshBackend(makeFakeSshTransport(), { name: "ssh", now: nowFn });
  manager.register(ssh, {
    name: "ssh",
    kind: "ssh",
    capabilities: ["ssh", "byo-host"],
    cost: CONFIGURED_ZERO_COST,
    supportsHibernate: false,
    locality: "remote",
  });
  entries.push({ name: "ssh", kind: "ssh", transport: "fake" });

  const singularity = new SingularityBackend(makeFakeSingularityRunner(), { name: "singularity", now: nowFn, image: "fake.sif" });
  manager.register(singularity, {
    name: "singularity",
    kind: "hpc",
    capabilities: ["hpc", "gpu"],
    cost: CONFIGURED_ZERO_COST,
    supportsHibernate: false,
    locality: "remote",
  });
  entries.push({ name: "singularity", kind: "hpc", transport: "fake" });

  return entries;
}

// ===========================================================================
// Per-backend lifecycle drive
// ===========================================================================

let workerCounter = 0;

async function driveOneBackend(
  manager: BackendManager,
  entry: FleetEntry,
  nowFn: () => number,
  log: (line: string) => void,
): Promise<ParityBenchBackendResult> {
  const result: ParityBenchBackendResult = {
    backend: entry.name,
    kind: entry.kind,
    transport: entry.transport,
    provisioned: false,
    hibernated: false,
    woken: false,
    terminated: false,
    provisionMs: null,
    wakeMs: null,
  };

  workerCounter += 1;
  const workerId = `parity-${entry.name}-${workerCounter}`;

  const spec: RemoteSpec = {
    workerId,
    capabilities: [],
    managerUrl: "http://127.0.0.1:0/parity-bench",
    authToken: "parity-bench-token",
    ...(entry.name === "docker" ? { image: "hello-world" } : {}),
    ...(entry.name === "singularity" ? { image: "fake.sif" } : {}),
  };

  const otherNames = manager.descriptors().map((d) => d.name).filter((n) => n !== entry.name);
  const requirements = { exclude: otherNames };

  const provisionStart = nowFn();
  let provisionResult: Awaited<ReturnType<BackendManager["provision"]>>;
  try {
    provisionResult = await manager.provision(spec, requirements);
  } catch (err) {
    result.error = errMsg(err);
    log(`[parity-bench] ${entry.name}: provision FAILED: ${result.error}`);
    return result;
  }
  result.provisionMs = nowFn() - provisionStart;
  result.provisioned = true;
  log(
    `[parity-bench] ${entry.name}: provisioned worker=${workerId} nativeId=${provisionResult.handle.nativeId} in ${result.provisionMs.toFixed(3)}ms`,
  );

  try {
    await manager.status(workerId);
  } catch (err) {
    log(`[parity-bench] ${entry.name}: status probe failed (non-fatal): ${errMsg(err)}`);
  }

  const supportsHibernate = manager.descriptor(entry.name)?.supportsHibernate ?? false;
  if (supportsHibernate) {
    try {
      await manager.hibernate(workerId);
      result.hibernated = true;
      const wakeStart = nowFn();
      await manager.wake(workerId);
      result.wakeMs = nowFn() - wakeStart;
      result.woken = true;
      log(`[parity-bench] ${entry.name}: hibernate/wake cycle complete (wake took ${result.wakeMs.toFixed(3)}ms)`);
    } catch (err) {
      result.error = errMsg(err);
      log(`[parity-bench] ${entry.name}: hibernate/wake FAILED: ${result.error}`);
    }
  } else {
    log(`[parity-bench] ${entry.name}: hibernate/wake not supported by this backend — skipped honestly (not a failure).`);
  }

  try {
    await manager.terminate(workerId);
    result.terminated = true;
    log(`[parity-bench] ${entry.name}: terminated worker=${workerId}`);
  } catch (err) {
    result.error = result.error ?? errMsg(err);
    log(`[parity-bench] ${entry.name}: terminate FAILED: ${errMsg(err)}`);
  }

  return result;
}

// ===========================================================================
// runParityBench / runParityBenchDetailed
// ===========================================================================

/**
 * The detailed entry point: same work as {@link runParityBench}, but also
 * returns the live {@link BackendProvenanceLedger} instance so a caller (or
 * a test exercising tamper-detection) can inspect or deliberately corrupt
 * it post-run without the locked, ledger-free {@link ParityBenchReport}
 * shape getting in the way. {@link runParityBench} is a thin wrapper that
 * discards the ledger and returns just `report`.
 */
export async function runParityBenchDetailed(opts: ParityBenchOptions = {}): Promise<ParityBenchDetailedResult> {
  const nowFn = opts.now ?? (() => performance.now());
  const log = opts.log ?? (() => {});

  const startedAt = nowFn();

  const ledger = new BackendProvenanceLedger({ now: nowFn });
  const manager = new BackendManager({
    now: nowFn,
    onEvent: (e: BackendManagerEvent) => ledgerEventSink(ledger)(e),
  });

  const entries = await assembleFleet(manager, nowFn, opts.includeDocker ?? false, log);

  const results: ParityBenchBackendResult[] = [];
  for (const entry of entries) {
    const result = await driveOneBackend(manager, entry, nowFn, log);
    results.push(result);
  }

  const totalMs = nowFn() - startedAt;
  const chainVerdict = ledger.verifyChain();
  const certificate = ledger.toCertificateFields();

  const allLifecyclesComplete = results.every((r) => {
    if (r.error !== undefined) return false;
    if (!r.provisioned || !r.terminated) return false;
    const supportsHibernate = manager.descriptor(r.backend)?.supportsHibernate ?? false;
    if (supportsHibernate && !(r.hibernated && r.woken)) return false;
    return true;
  });

  const report: ParityBenchReport = {
    results,
    chainVerified: chainVerdict.ok,
    certificate,
    totalMs,
    allLifecyclesComplete,
  };

  log(
    `[parity-bench] done: ${results.length} backend(s), chainVerified=${chainVerdict.ok}, allLifecyclesComplete=${allLifecyclesComplete}, totalMs=${totalMs.toFixed(3)}`,
  );

  return { report, ledger };
}

/**
 * Assemble a `BackendManager` fleet (real local child processes, a real
 * docker backend when opted in and available, fake-transport serverless/
 * remote backends), drive every registered backend through its full
 * lifecycle, and verify the resulting `BackendProvenanceLedger` chain.
 */
export async function runParityBench(opts?: ParityBenchOptions): Promise<ParityBenchReport> {
  const { report } = await runParityBenchDetailed(opts);
  return report;
}
