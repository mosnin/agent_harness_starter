/**
 * BanditRoutedProvisioner — makes routing real.
 *
 * Every other provision path in this repo (`BackendManager.provision`,
 * `FleetSupervisor`) picks a backend via `BackendManager.select()`'s static,
 * deterministic scoring (`./descriptor.ts`). `CostAwareRouteBandit`
 * (`./route-bandit.ts`) is the learned alternative — cost-and-verification
 * aware, UCB1-driven — but on its own it only ANSWERS "which backend should
 * we use"; nothing actually drives a provision through that answer. This
 * module is that missing wire.
 *
 * ## The pinning rule (compositional, zero engine edits)
 *
 * `BanditRoutedProvisioner` never bypasses `BackendManager` to talk to a
 * backend or the registry directly (that would skip the manager's own
 * probe/telemetry/event bookkeeping — the same bookkeeping the bandit itself
 * reads back out of `manager.telemetry()`). Instead, once
 * `bandit.choose(r)` picks a name, this module asks the REAL
 * `manager.provision()` for exactly that backend by excluding every other
 * registered backend from the requirement set:
 *
 *   manager.provision(spec, { ...r, exclude: [...r.exclude, ...allOtherNames] })
 *
 * `BackendManager.select()` -> `matchesRequirements()` then has exactly one
 * backend left that can pass (the bandit's pick), so the manager's own
 * select/probe/telemetry/`"selected"`/`"provisioned"`/`"provision-failed"`
 * event path runs completely unmodified and deterministically lands on the
 * bandit's choice. If that backend's availability flipped between
 * `choose()` and this call (or any other real reason the pinned provision
 * fails), the manager's own honest "no backend available" error surfaces
 * unchanged — this module never manufactures a friendlier one.
 *
 * ## Fallback
 *
 * `bandit.choose()` returning `undefined` (no candidate survived filtering +
 * probing) or throwing (a bug or a misconfigured bandit) both fall back to
 * plain `manager.provision(spec, r)` — the bandit is strictly additive, never
 * a single point of failure for provisioning. A thrown bandit error is
 * reported via `onEvent` and never rethrown in its place.
 *
 * ## Outcome bookkeeping
 *
 * `recordOutcome()` delegates to the real `bandit.recordOutcome` (same
 * `RangeError` validation, propagated unchanged) then best-effort persists
 * `bandit.snapshot()` via an injected {@link BanditSnapshotStore} — mirroring
 * `FleetSupervisor.persist()`'s discipline (`./fleet-supervisor.ts`):
 * persistence failures are reported via `onEvent`, never thrown. A pinned
 * provision that throws records a measured `{ verified: false, elapsedMs,
 * usd: 0 }` outcome for the pinned backend (via the injected clock) before
 * rethrowing the original provisioning error unchanged, so the bandit learns
 * from its own failed pins without the caller having to remember to tell it.
 */

import { BackendManager } from "./manager";
import type { ProvisionResult, RemoteSpec } from "./backend";
import type { BackendRequirements } from "./descriptor";
import { CostAwareRouteBandit, type RouteBanditState, type RouteDecision, type RouteOutcome } from "./route-bandit";

// ===========================================================================
// Public types
// ===========================================================================

/**
 * Persistence seam for the bandit's learned history. Deliberately Promise-
 * returning (unlike the CLI's synchronous `BanditStateStore` in
 * `../cli/backends-command.ts`) so a real async store (file I/O, a remote
 * KV) can be plugged in directly; a synchronous store can always satisfy
 * this by wrapping its return values in `Promise.resolve(...)`.
 */
export interface BanditSnapshotStore {
  load(): Promise<unknown>;
  save(state: RouteBanditState): Promise<void>;
}

/** How one `provision()` call's backend was chosen. */
export type ProvisionDecision =
  | { source: "bandit"; decision: RouteDecision }
  | { source: "manager-fallback"; reason: "no-candidate" | "bandit-error" };

export type BanditProvisionerEvent = {
  type: "routed" | "fallback" | "outcome-recorded" | "state-saved" | "state-save-failed";
  at: number;
  backend?: string;
  detail?: Record<string, unknown>;
};

export interface BanditRoutedProvisionerOptions {
  manager: BackendManager;
  bandit: CostAwareRouteBandit;
  store?: BanditSnapshotStore;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
  onEvent?: (e: BanditProvisionerEvent) => void;
}

// ===========================================================================
// Internals
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// BanditRoutedProvisioner
// ===========================================================================

export class BanditRoutedProvisioner {
  private readonly manager: BackendManager;
  private readonly bandit: CostAwareRouteBandit;
  private readonly store?: BanditSnapshotStore;
  private readonly now: () => number;
  private readonly onEventCb?: (e: BanditProvisionerEvent) => void;

  constructor(opts: BanditRoutedProvisionerOptions) {
    if (!opts || !(opts.manager instanceof BackendManager)) {
      throw new RangeError("BanditRoutedProvisioner: opts.manager must be a BackendManager instance");
    }
    if (!opts.bandit || !(opts.bandit instanceof CostAwareRouteBandit)) {
      throw new RangeError("BanditRoutedProvisioner: opts.bandit must be a CostAwareRouteBandit instance");
    }
    this.manager = opts.manager;
    this.bandit = opts.bandit;
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.onEventCb = opts.onEvent;
  }

  private emit(type: BanditProvisionerEvent["type"], fields: Omit<BanditProvisionerEvent, "type" | "at"> = {}): void {
    this.onEventCb?.({ type, at: this.now(), ...fields });
  }

  // ---------------------------------------------------------------------
  // Provisioning
  // ---------------------------------------------------------------------

  /**
   * Route + provision `spec`. See the file header for the full pinning /
   * fallback contract. Never wraps or rewrites a manager-thrown error — the
   * caller always sees exactly what `BackendManager.provision` threw.
   */
  async provision(spec: RemoteSpec, r?: BackendRequirements): Promise<ProvisionResult & { routing: ProvisionDecision }> {
    let decision: RouteDecision | undefined;
    let banditThrew = false;
    let banditErr: unknown;
    try {
      decision = await this.bandit.choose(r);
    } catch (err) {
      banditThrew = true;
      banditErr = err;
    }

    if (banditThrew) {
      this.emit("fallback", { detail: { reason: "bandit-error", error: errorMessage(banditErr) } });
      const result = await this.manager.provision(spec, r);
      return { ...result, routing: { source: "manager-fallback", reason: "bandit-error" } };
    }

    if (!decision) {
      this.emit("fallback", { detail: { reason: "no-candidate" } });
      const result = await this.manager.provision(spec, r);
      return { ...result, routing: { source: "manager-fallback", reason: "no-candidate" } };
    }

    const name = decision.name;
    // Exclude every OTHER registered backend, so the manager's own
    // select() -> matchesRequirements() has exactly one survivor: the
    // bandit's pick. Never touches registry.provision directly — the
    // manager's probe/telemetry/event path runs in full.
    const others = this.manager.descriptors().map((d) => d.name).filter((n) => n !== name);
    const pinnedReq: BackendRequirements = { ...(r ?? {}), exclude: [...(r?.exclude ?? []), ...others] };

    const start = this.now();
    let result: ProvisionResult;
    try {
      result = await this.manager.provision(spec, pinnedReq);
    } catch (err) {
      const elapsedMs = this.now() - start;
      try {
        // Best-effort: never let outcome bookkeeping mask the original
        // provisioning error below.
        await this.recordOutcome(name, { verified: false, elapsedMs, usd: 0 });
      } catch {
        /* recordOutcome's own RangeError validation cannot fail on this
         * internally-constructed, always-valid outcome; guarded anyway so a
         * theoretical failure here can never replace the real error. */
      }
      throw err;
    }

    this.emit("routed", {
      backend: name,
      detail: { reason: decision.reason, ucb: decision.ucb, candidateCount: decision.candidates.length },
    });
    return { ...result, routing: { source: "bandit", decision } };
  }

  // ---------------------------------------------------------------------
  // Outcome bookkeeping
  // ---------------------------------------------------------------------

  /**
   * Record one measured outcome for `backend` (delegates to the real
   * `CostAwareRouteBandit.recordOutcome` — same `RangeError` validation,
   * propagated unchanged, never swallowed), then best-effort persists the
   * bandit's snapshot. Persistence failures are reported via `onEvent` and
   * NEVER thrown (mirrors `FleetSupervisor.persist()`).
   */
  async recordOutcome(backend: string, o: RouteOutcome): Promise<void> {
    this.bandit.recordOutcome(backend, o);
    this.emit("outcome-recorded", { backend, detail: { verified: o.verified, elapsedMs: o.elapsedMs, usd: o.usd } });
    await this.persistSnapshot();
  }

  /** Best-effort persist the bandit's current snapshot. No-op without a store. */
  async flush(): Promise<void> {
    await this.persistSnapshot();
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.store) return;
    try {
      const state = this.bandit.snapshot();
      await this.store.save(state);
      this.emit("state-saved", { detail: { armCount: Object.keys(state.arms).length } });
    } catch (err) {
      this.emit("state-save-failed", { detail: { error: errorMessage(err) } });
    }
  }
}
