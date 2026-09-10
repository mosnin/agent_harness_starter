import type { RemoteBackendRegistry } from "./backend";
import type { RemoteHandle } from "./backend";

export interface ScaleToZeroOptions {
  /** Idle time before a running worker is auto-hibernated. Default 5 min. */
  idleMs?: number;
  /** Time source (ms). Injectable for deterministic tests. */
  now?: () => number;
  /** Observability hook for lifecycle transitions. */
  onEvent?: (event: ScaleEvent) => void;
}

export interface ScaleEvent {
  type: "active" | "hibernated" | "woken" | "skipped";
  workerId: string;
  at: number;
  /** Why a hibernate was skipped (backend can't hibernate, already hibernated…). */
  reason?: string;
}

/**
 * Serverless scale-to-zero lifecycle — Phase C's capstone. Wraps a
 * {@link RemoteBackendRegistry} and drives idle workers down to zero cost and
 * back:
 *
 * - `markActive` stamps a worker's last-use time.
 * - `sweep` hibernates every running worker idle longer than `idleMs` (only on
 *   backends that support hibernate — SSH/Singularity are skipped).
 * - `ensureAwake` wakes a hibernated worker on demand and returns its endpoint.
 * - `acquire` = ensureAwake + markActive, the call sites use before dispatching.
 *
 * The clock is injectable, so the idle reaper is fully deterministic in tests.
 */
export class ScaleToZeroManager {
  private lastActive = new Map<string, number>();
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (event: ScaleEvent) => void;

  constructor(
    private readonly registry: RemoteBackendRegistry,
    opts: ScaleToZeroOptions = {}
  ) {
    this.idleMs = opts.idleMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  private emit(type: ScaleEvent["type"], workerId: string, reason?: string): void {
    this.onEvent?.({ type, workerId, at: this.now(), reason });
  }

  /** Record that a worker was just used (resets its idle timer). */
  markActive(workerId: string): void {
    this.lastActive.set(workerId, this.now());
    this.emit("active", workerId);
  }

  /** Milliseconds since a worker was last active (Infinity if never seen). */
  idleFor(workerId: string): number {
    const last = this.lastActive.get(workerId);
    return last == null ? Infinity : this.now() - last;
  }

  private supportsHibernate(handle: RemoteHandle): boolean {
    return !!this.registry.get(handle.backend)?.hibernate;
  }

  /**
   * Hibernate every running worker idle longer than `idleMs`. Returns the ids
   * actually hibernated. Backends without hibernate support are skipped (with a
   * `skipped` event), never errored — mixed fleets are fine.
   */
  async sweep(): Promise<string[]> {
    const hibernated: string[] = [];
    for (const handle of this.registry.list()) {
      if (handle.state !== "running") continue;
      if (this.idleFor(handle.workerId) < this.idleMs) continue;
      if (!this.supportsHibernate(handle)) {
        this.emit("skipped", handle.workerId, "backend has no hibernate");
        continue;
      }
      await this.registry.hibernate(handle.workerId);
      this.lastActive.delete(handle.workerId);
      this.emit("hibernated", handle.workerId);
      hibernated.push(handle.workerId);
    }
    return hibernated;
  }

  /**
   * Ensure a worker is running, waking it from hibernation if needed. Returns the
   * live handle, or undefined if the worker is unknown.
   */
  async ensureAwake(workerId: string): Promise<RemoteHandle | undefined> {
    const handle = this.registry.handle(workerId);
    if (!handle) return undefined;
    if (handle.state === "hibernated") {
      const woken = await this.registry.wake(workerId);
      this.emit("woken", workerId);
      return woken;
    }
    return handle;
  }

  /** Wake-if-needed then mark active — the guard call sites use before dispatch. */
  async acquire(workerId: string): Promise<RemoteHandle | undefined> {
    const handle = await this.ensureAwake(workerId);
    if (handle) this.markActive(workerId);
    return handle;
  }
}
