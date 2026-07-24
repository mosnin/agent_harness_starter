/**
 * FleetProvisionService — turns a `fleet.provision` command into the events
 * the desktop renderer's provision view understands, over whatever real
 * provisioning substrate implements `FleetProvisionPort`.
 *
 * `FleetProvisionPort` is a small, structural seam: at central integration
 * it is satisfied by composing the REAL bandit-routed backend selector, the
 * REAL `FleetSupervisor`, and a REAL handle-adoption service (see
 * `fleet-wiring.ts`) — this module never talks to those directly and never
 * mocks them; it only depends on the port shape. That keeps this file
 * (and this team's tests) honest: every behavior asserted here is a
 * property of `FleetProvisionService` itself, not of a stand-in for the
 * routing/supervision stack.
 *
 * Locked semantics:
 *   - `handle()` NEVER throws. Every error the port raises (provisioning
 *     failure, routing rejection, backend fault, ...) is caught and turned
 *     into exactly one `fleet.provision.error` event carrying the port's
 *     message and the request's own `requestId` — never a rejected promise.
 *   - A `workerId` the port already tracks is rejected as
 *     `fleet.provision.error` BEFORE `port.provision()` is ever called —
 *     the port is never asked to double-provision a worker this service
 *     already believes is live.
 *   - Two overlapping `handle()` calls that share a `requestId` are
 *     serialized: the second waits for the first to settle, then resolves
 *     to a `fleet.provision.error` reporting the duplicate — the port's
 *     `provision()` is invoked at most once per `requestId` in flight.
 *   - Every `at` timestamp comes from the injected clock (`now`), so tests
 *     never race the real wall clock.
 */

import type { FleetProvisionCommand, FleetProvisionEvent } from "../ipc/fleet-provision-contract";
import type { FleetWorkerView, FleetLifecycleState } from "../ipc/fleet-contract";

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface FleetProvisionPort {
  /**
   * Provisions one worker for `spec`, honoring `requirements` (backend
   * selection filters — required capabilities, hibernate support, a cost
   * ceiling, excluded backends). Throws on any failure (no eligible
   * backend, the chosen backend's `provision()` faults, ...); the service
   * is solely responsible for turning that throw into a wire event.
   */
  provision(
    spec: { workerId: string; capabilities: string[]; image?: string },
    requirements?: FleetProvisionCommand["requirements"]
  ): Promise<{
    backend: string;
    handle: { workerId: string; backend: string; nativeId: string; state: string; startedAt: number };
    routing?: { source: string; reason?: string };
  }>;

  /**
   * Best-effort description of whatever crash-recovery restore already ran
   * against the real fleet. `undefined` means "no restore has run" (the
   * honest default before startup restore executes, or when this port
   * never performs one) — never fabricated as an empty result, which would
   * claim a restore ran and adopted nothing when in fact none happened at
   * all.
   */
  restoredView(): Promise<
    | { workers: FleetWorkerView[]; adoptedIds: string[]; dropped: Array<{ workerId: string; reason: string }> }
    | undefined
  >;

  /** True when `workerId` is already tracked (live or previously adopted). */
  isTracked(workerId: string): boolean;
}

export interface FleetProvisionServiceOptions {
  /** ms clock, default () => Date.now(). Injectable for deterministic tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Lifecycle state resolution — same honesty rule as fleet-service.ts: an
// unrecognized state string from the port is reported as "failed", never
// invented into something more hopeful.
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FleetProvisionService {
  private readonly now: () => number;
  /**
   * One in-flight promise per `requestId`. A second `handle()` call sharing
   * a `requestId` with an in-flight one awaits the same promise (so the
   * port is invoked at most once) and then reports the duplicate — it never
   * re-runs `handleOnce`.
   */
  private readonly inFlight = new Map<string, Promise<FleetProvisionEvent[]>>();

  constructor(
    private readonly port: FleetProvisionPort,
    opts: FleetProvisionServiceOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Runs one `fleet.provision` command to completion. Never rejects: every
   * failure mode (already-tracked worker, a throwing port, a duplicate
   * `requestId`) resolves to a single `fleet.provision.error` event.
   */
  async handle(cmd: FleetProvisionCommand): Promise<FleetProvisionEvent[]> {
    const { requestId } = cmd;

    const existing = this.inFlight.get(requestId);
    if (existing !== undefined) {
      // Wait for the original request to settle (success or failure) before
      // reporting the duplicate, so the two never race and the port is
      // never invoked twice for the same requestId.
      await existing.catch(() => undefined);
      return [this.errorEvent(requestId, `duplicate requestId already in flight: "${requestId}"`)];
    }

    const run = this.handleOnce(cmd);
    this.inFlight.set(requestId, run);
    try {
      return await run;
    } finally {
      // Only ever removes the entry this call installed — a later request
      // reusing the same requestId (after this one has fully settled) is a
      // legitimate fresh request, not a duplicate.
      if (this.inFlight.get(requestId) === run) {
        this.inFlight.delete(requestId);
      }
    }
  }

  /**
   * Reports whatever crash-recovery restore already happened, as a single
   * `fleet.restored` event. Returns `undefined` (not an event) when the
   * port reports no restore ran at all — the sidecar should simply not
   * emit anything in that case, rather than claim an empty restore.
   */
  async restoredSnapshot(): Promise<FleetProvisionEvent | undefined> {
    const restored = await this.port.restoredView();
    if (restored === undefined) return undefined;
    return {
      kind: "fleet.restored",
      workers: restored.workers.slice(),
      adoptedIds: restored.adoptedIds.slice(),
      dropped: restored.dropped.slice(),
      at: this.now(),
    };
  }

  private async handleOnce(cmd: FleetProvisionCommand): Promise<FleetProvisionEvent[]> {
    const { requestId, spec, requirements } = cmd;

    let tracked: boolean;
    try {
      tracked = this.port.isTracked(spec.workerId);
    } catch (err) {
      return [this.errorEvent(requestId, errorMessage(err))];
    }
    if (tracked) {
      return [this.errorEvent(requestId, `worker already tracked: "${spec.workerId}"`)];
    }

    try {
      const result = await this.port.provision(spec, requirements);
      const worker: FleetWorkerView = {
        workerId: result.handle.workerId,
        backend: result.handle.backend,
        nativeId: result.handle.nativeId,
        state: isFleetLifecycleState(result.handle.state) ? result.handle.state : "failed",
        startedAt: result.handle.startedAt,
        idleMs: 0,
      };
      const event: FleetProvisionEvent = {
        kind: "fleet.provisioned",
        requestId,
        worker,
        backend: result.backend,
        at: this.now(),
        ...(result.routing !== undefined
          ? {
              routing: {
                source: result.routing.source,
                backend: result.backend,
                ...(result.routing.reason !== undefined ? { reason: result.routing.reason } : {}),
              },
            }
          : {}),
      };
      return [event];
    } catch (err) {
      return [this.errorEvent(requestId, errorMessage(err))];
    }
  }

  private errorEvent(requestId: string, message: string): FleetProvisionEvent {
    return { kind: "fleet.provision.error", requestId, message, at: this.now() };
  }
}
