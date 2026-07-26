/**
 * FleetService — turns `FleetCommand`s into `FleetEvent`s for the desktop
 * sidecar, over whatever backend substrate implements `FleetPort`.
 *
 * `FleetPort` is a structural (not nominal) match for the real
 * `BackendManager` (`src/hades/backends/manager.ts`) plus an optional
 * `lifecycleMap()` hook for a richer lifecycle supervisor layered on top
 * (e.g. one that distinguishes "hibernating"/"waking" in-flight states that
 * `BackendManager`'s own `RemoteState` doesn't). A bare `BackendManager`
 * instance already satisfies `FleetPort` (`lifecycleMap` is optional), so
 * the sidecar can hand this service the exact same manager `build.ts`
 * composes with no adapter required.
 *
 * Every method here is honest about what it knows: `handle()` never
 * rejects (any port failure becomes a `fleet.error` event), and a lifecycle
 * state string this module doesn't recognize is reported as `"failed"`
 * rather than invented.
 */

import type {
  BackendCostView,
  BackendTelemetryView,
  BackendView,
  FleetCommand,
  FleetEvent,
  FleetLifecycleState,
  FleetWorkerView,
} from "../ipc/fleet-contract";

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * The subset of `BackendManager` (+ an optional lifecycle-supervisor hook)
 * `FleetService` needs. Structural on purpose: verified field-for-field
 * against `descriptors()`, `telemetry()`, `list()`, `probeAll()`,
 * `hibernate()`, `wake()`, `terminate()` in `src/hades/backends/manager.ts`
 * and `descriptor.ts`, so a real `BackendManager` satisfies this interface
 * without wrapping.
 */
export interface FleetPort {
  descriptors(): Array<{
    name: string;
    kind: string;
    capabilities: string[];
    locality: "local" | "remote";
    supportsHibernate: boolean;
    cost: BackendCostView;
  }>;
  telemetry(name: string): BackendTelemetryView;
  list(): Array<{
    handle: { workerId: string; backend: string; nativeId: string; state: string; startedAt: number };
    idleMs: number;
  }>;
  probeAll(): Promise<Record<string, boolean>>;
  hibernate(workerId: string): Promise<unknown>;
  wake(workerId: string): Promise<unknown>;
  terminate(workerId: string): Promise<void>;
  /**
   * Optional richer lifecycle view (workerId -> state string) from a
   * lifecycle supervisor layered above the port. When present its value for
   * a worker wins over `handle.state`; when absent (or it has no entry for
   * a given worker) `handle.state` is used instead.
   */
  lifecycleMap?(): Record<string, string>;
}

export interface FleetServiceOptions {
  /** ms clock, default () => Date.now(). Injectable for deterministic tests. */
  now?: () => number;
}

type FleetPortHandle = ReturnType<FleetPort["list"]>[number]["handle"];
type FleetPortEntry = ReturnType<FleetPort["list"]>[number];
type FleetPortDescriptor = ReturnType<FleetPort["descriptors"]>[number];

// ---------------------------------------------------------------------------
// Lifecycle state resolution
// ---------------------------------------------------------------------------

const FLEET_LIFECYCLE_STATES: readonly FleetLifecycleState[] = [
  "provisioning",
  "running",
  "hibernating",
  "hibernated",
  "waking",
  "failed",
  "stopped",
];

function isFleetLifecycleState(x: string): x is FleetLifecycleState {
  return (FLEET_LIFECYCLE_STATES as readonly string[]).includes(x);
}

/**
 * `lifecycleMap()`'s value for a worker wins over `handle.state` when
 * present. Either way, an unrecognized state string maps to `"failed"` —
 * never invented, never silently coerced into something more hopeful.
 */
function resolveLifecycleState(
  workerId: string,
  handleState: string,
  lifecycleMap: Record<string, string> | undefined
): FleetLifecycleState {
  const fromMap = lifecycleMap?.[workerId];
  if (fromMap !== undefined) {
    return isFleetLifecycleState(fromMap) ? fromMap : "failed";
  }
  return isFleetLifecycleState(handleState) ? handleState : "failed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FleetService {
  private readonly now: () => number;
  /** Serializes `handle()` calls so overlapping commands never interleave a snapshot read. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly port: FleetPort,
    opts: FleetServiceOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Run one command to completion and return the resulting events. Never
   * rejects: any error thrown by the port (unknown worker, unsupported
   * operation, backend fault, …) is caught and reported as a single
   * `fleet.error` event instead. Calls are serialized against each other so
   * two overlapping `handle()` invocations can never race and produce a
   * snapshot that mixes state from two different mutations.
   */
  async handle(cmd: FleetCommand): Promise<FleetEvent[]> {
    const run = this.queue.then(() => this.handleSerialized(cmd));
    // Keep the queue alive even if this call's result settles with an
    // (already-caught) error — `handleSerialized` itself never rejects, but
    // guard defensively so one bad link can never wedge the chain.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Build a `fleet.snapshot` event. `probe: true` runs a real `probeAll()`; `false` leaves `available: null`. */
  async snapshot(probe: boolean): Promise<FleetEvent> {
    const availability = probe ? await this.port.probeAll() : undefined;
    const backends = this.port.descriptors().map((d) => this.buildBackendView(d, availability));
    const lifecycleMap = this.port.lifecycleMap?.();
    const workers = this.port
      .list()
      .map((entry) => this.buildWorkerView(entry.handle, entry.idleMs, lifecycleMap));
    return { kind: "fleet.snapshot", backends, workers, at: this.now() };
  }

  private async handleSerialized(cmd: FleetCommand): Promise<FleetEvent[]> {
    try {
      switch (cmd.kind) {
        case "fleet.list":
          return [await this.snapshot(false)];
        case "fleet.probe":
          return [await this.snapshot(true)];
        case "fleet.hibernate":
          return await this.mutate("hibernate", cmd.workerId);
        case "fleet.wake":
          return await this.mutate("wake", cmd.workerId);
        case "fleet.terminate":
          return await this.mutate("terminate", cmd.workerId);
      }
    } catch (err) {
      return [this.errorEvent(errorMessage(err), workerIdOf(cmd))];
    }
  }

  private async mutate(
    op: "hibernate" | "wake" | "terminate",
    workerId: string
  ): Promise<FleetEvent[]> {
    const preEntry = this.findEntry(workerId);
    if (!preEntry) {
      return [this.errorEvent(`unknown worker: "${workerId}"`, workerId)];
    }

    try {
      if (op === "hibernate") await this.port.hibernate(workerId);
      else if (op === "wake") await this.port.wake(workerId);
      else await this.port.terminate(workerId);
    } catch (err) {
      return [this.errorEvent(errorMessage(err), workerId)];
    }

    let worker: FleetWorkerView;
    if (op === "terminate") {
      // `terminate` drops the handle from the registry entirely — there is
      // nothing left to re-read, but the outcome is unambiguous, so report
      // it directly instead of pretending we can still look it up.
      worker = {
        workerId: preEntry.handle.workerId,
        backend: preEntry.handle.backend,
        nativeId: preEntry.handle.nativeId,
        state: "stopped",
        startedAt: preEntry.handle.startedAt,
        idleMs: 0,
      };
    } else {
      const postEntry = this.findEntry(workerId);
      if (!postEntry) {
        return [this.errorEvent(`worker "${workerId}" vanished during ${op}`, workerId)];
      }
      const lifecycleMap = this.port.lifecycleMap?.();
      worker = this.buildWorkerView(postEntry.handle, postEntry.idleMs, lifecycleMap);
    }

    const snap = await this.snapshot(false);
    return [{ kind: "fleet.worker.upsert", worker }, snap];
  }

  private findEntry(workerId: string): FleetPortEntry | undefined {
    return this.port.list().find((e) => e.handle.workerId === workerId);
  }

  private buildBackendView(
    d: FleetPortDescriptor,
    availability: Record<string, boolean> | undefined
  ): BackendView {
    return {
      name: d.name,
      kind: d.kind,
      capabilities: d.capabilities,
      locality: d.locality,
      supportsHibernate: d.supportsHibernate,
      available: availability === undefined ? null : (availability[d.name] ?? false),
      cost: d.cost,
      telemetry: this.port.telemetry(d.name),
    };
  }

  private buildWorkerView(
    handle: FleetPortHandle,
    idleMs: number,
    lifecycleMap: Record<string, string> | undefined
  ): FleetWorkerView {
    return {
      workerId: handle.workerId,
      backend: handle.backend,
      nativeId: handle.nativeId,
      state: resolveLifecycleState(handle.workerId, handle.state, lifecycleMap),
      startedAt: handle.startedAt,
      idleMs,
    };
  }

  private errorEvent(message: string, workerId: string | undefined): FleetEvent {
    return workerId === undefined
      ? { kind: "fleet.error", message, at: this.now() }
      : { kind: "fleet.error", message, workerId, at: this.now() };
  }
}

function workerIdOf(cmd: FleetCommand): string | undefined {
  return cmd.kind === "fleet.hibernate" || cmd.kind === "fleet.wake" || cmd.kind === "fleet.terminate"
    ? cmd.workerId
    : undefined;
}
