/**
 * AttributedContainerProvider — decorates the REAL `ContainerProvider` spawn
 * path (`../../swarm-runtime/types`'s `LocalProcessProvider` /
 * `DockerProvider`) so a worker's backend becomes knowable AND durable, via
 * `./worker-attribution.ts`'s `WorkerAttributionRegistry`, without changing
 * how workers are actually launched.
 *
 * This module reimplements no part of spawn/stop/liveness/logs: `spawn()`
 * calls the injected `inner.spawn` FIRST and unchanged, and only after it
 * genuinely succeeds does this module (a) record the attribution and (b)
 * best-effort adopt the worker into a fleet-tracking port. `isAvailable`,
 * `isAlive`, and `logs` are pure delegation with zero added behavior — the
 * real provider answers those questions exactly as it always did.
 *
 * ## Ownership split (delegated vs owned)
 *
 * - DELEGATED to `inner` (the real provider): actually starting/stopping the
 *   OS process or container, liveness probing, log capture. This module
 *   never duplicates any of that.
 * - OWNED by this module: writing the `workerId -> backend` attribution
 *   record via `WorkerAttributionRegistry.record`/`.release`, and telling an
 *   injected `FleetTrackingPort` (centrally satisfied by the manager's
 *   `RemoteBackendRegistry`, `./backend.ts`) about the newly-spawned worker
 *   via `adopt`/`release` so it shows up as a trackable fleet handle
 *   alongside remotely-provisioned workers.
 *
 * ## Rollback on tracking failure
 *
 * `FleetTrackingPort.adopt` throws on a duplicate workerId (mirroring
 * `RemoteBackendRegistry.adopt`'s real throw-on-duplicate backstop,
 * `./backend.ts`). If that happens AFTER `inner.spawn` already produced a
 * real running unit, this module does NOT leave it orphaned: it stops the
 * just-spawned inner handle, releases the attribution it just recorded, and
 * rethrows the ORIGINAL adopt error unchanged (never a wrapped/rewritten
 * one) so the caller sees exactly what went wrong. If `inner.stop` ALSO
 * throws during that rollback, both failures are surfaced honestly in the
 * emitted `"rolled-back"` event's `detail` — never silently swallowed —
 * while the original adopt error is still what gets thrown.
 */

import type { WorkerAttributionRegistry } from "./worker-attribution";
import type { RemoteHandle } from "./backend";
import type { ContainerHandle, ContainerProvider, IsolationKind, SpawnSpec } from "../../swarm-runtime/types";

// ===========================================================================
// Public types
// ===========================================================================

/**
 * Minimal fleet-tracking surface this module needs. Centrally satisfied by
 * `RemoteBackendRegistry` (`./backend.ts`), which already throws on a
 * duplicate `workerId` in `adopt()` — this module's rollback path exists
 * specifically to react to that real throw, not a contrived one. Tests
 * exercise fakes with the identical throw-on-duplicate contract.
 */
export interface FleetTrackingPort {
  adopt(handle: RemoteHandle): void;
  release(workerId: string): boolean | void;
}

export interface AttributedProviderOptions {
  /** The real `ContainerProvider` (e.g. `LocalProcessProvider`/`DockerProvider`) being decorated. */
  inner: ContainerProvider;
  /** Backend name recorded against every worker this provider spawns. */
  backendName: string;
  registry: WorkerAttributionRegistry;
  /** Optional fleet-tracking sink (typically the manager's `RemoteBackendRegistry`). */
  tracking?: FleetTrackingPort;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
  onEvent?: (e: AttributedProviderEvent) => void;
}

export type AttributedProviderEvent = {
  type: "spawned" | "stopped" | "track-failed" | "rolled-back";
  at: number;
  workerId?: string;
  backend?: string;
  detail?: Record<string, unknown>;
};

// ===========================================================================
// Internals
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// AttributedContainerProvider
// ===========================================================================

export class AttributedContainerProvider implements ContainerProvider {
  readonly kind: IsolationKind;

  private readonly inner: ContainerProvider;
  private readonly backendName: string;
  private readonly registry: WorkerAttributionRegistry;
  private readonly tracking?: FleetTrackingPort;
  private readonly nowFn: () => number;
  private readonly onEventCb?: (e: AttributedProviderEvent) => void;

  constructor(opts: AttributedProviderOptions) {
    if (!opts?.inner) {
      throw new RangeError("AttributedContainerProvider: opts.inner is required");
    }
    if (typeof opts.backendName !== "string" || opts.backendName.trim().length === 0) {
      throw new RangeError("AttributedContainerProvider: opts.backendName must be a non-empty string");
    }
    if (!opts.registry) {
      throw new RangeError("AttributedContainerProvider: opts.registry is required");
    }
    this.inner = opts.inner;
    this.backendName = opts.backendName;
    this.registry = opts.registry;
    this.tracking = opts.tracking;
    this.nowFn = opts.now ?? (() => Date.now());
    this.onEventCb = opts.onEvent;
    this.kind = this.inner.kind;
  }

  private emit(fields: Omit<AttributedProviderEvent, "at">): void {
    this.onEventCb?.({ at: this.nowFn(), ...fields });
  }

  /** Pure delegation — the real provider answers this exactly as it always did. */
  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  /** Pure delegation — the real provider answers this exactly as it always did. */
  async isAlive(handle: ContainerHandle): Promise<boolean> {
    return this.inner.isAlive(handle);
  }

  /** Pure delegation — the real provider answers this exactly as it always did. */
  async logs(handle: ContainerHandle, tailLines?: number): Promise<string> {
    return this.inner.logs(handle, tailLines);
  }

  /**
   * Spawn via the REAL inner provider first (the actual worker path is
   * unchanged); only on real success do we record attribution and
   * best-effort adopt a fleet handle. `inner.spawn` rejecting propagates
   * unchanged with ZERO side effects here — nothing recorded, nothing
   * adopted.
   */
  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const handle = await this.inner.spawn(spec);

    // Real spawn succeeded — record attribution against the REAL handle's
    // native id. A RangeError here (blank id, or a genuine duplicate-id
    // conflict against a DIFFERENT backend) is a real bug surfaced
    // unchanged; there is no rollback for it because nothing was adopted
    // yet and the caller has a real, running unit they still own.
    this.registry.record(handle.workerId, this.backendName, { nativeId: handle.nativeId });

    if (this.tracking) {
      const remoteHandle: RemoteHandle = {
        workerId: handle.workerId,
        backend: this.backendName,
        state: "running",
        nativeId: handle.nativeId,
        startedAt: handle.startedAt,
      };
      try {
        this.tracking.adopt(remoteHandle);
      } catch (adoptErr) {
        // Tracking rejected this worker (duplicate id) — do not leave the
        // real spawn orphaned. Stop it, release the attribution we just
        // recorded, and rethrow the ORIGINAL adopt error unchanged.
        let stopError: string | undefined;
        try {
          await this.inner.stop(handle);
        } catch (stopErr) {
          stopError = errorMessage(stopErr);
        }
        this.registry.release(handle.workerId);
        this.emit({
          type: "rolled-back",
          workerId: handle.workerId,
          backend: this.backendName,
          detail: {
            reason: "tracking.adopt threw",
            adoptError: errorMessage(adoptErr),
            ...(stopError ? { stopError } : {}),
          },
        });
        throw adoptErr;
      }
    }

    this.emit({ type: "spawned", workerId: handle.workerId, backend: this.backendName, detail: { nativeId: handle.nativeId } });
    return handle;
  }

  /**
   * Delegate the actual stop to `inner`, then release attribution/tracking.
   * Release failures (unknown handle to `tracking.release`, or any thrown
   * error from it) are folded into the `"stopped"` event's `detail` and
   * NEVER thrown — this method's contract is "the real unit is stopped",
   * which `inner.stop` already guarantees by the time we get here.
   */
  async stop(handle: ContainerHandle, graceMs?: number): Promise<void> {
    await this.inner.stop(handle, graceMs);

    const attributionReleased = this.registry.release(handle.workerId);

    let trackingReleased: boolean | undefined;
    let trackingError: string | undefined;
    if (this.tracking) {
      try {
        const result = this.tracking.release(handle.workerId);
        trackingReleased = result === undefined ? true : result;
      } catch (err) {
        trackingError = errorMessage(err);
      }
    }

    this.emit({
      type: "stopped",
      workerId: handle.workerId,
      backend: this.backendName,
      detail: {
        attributionReleased,
        ...(trackingReleased !== undefined ? { trackingReleased } : {}),
        ...(trackingError ? { trackingError } : {}),
      },
    });
  }
}
