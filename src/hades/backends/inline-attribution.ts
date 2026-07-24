/**
 * Inline-mode attribution — closes the learning-loop debt that exists when a
 * swarm runs entirely in-process via {@link
 * ../../swarm-runtime/factory.ts | createInlineSwarm}.
 *
 * ## The debt this module closes
 *
 * {@link ./swarm-learning.ts | SwarmLearningLoop} attaches a real {@link
 * ./outcome-feed.ts | SwarmOutcomeFeed} to a real `SwarmManager`, but the
 * feed can only ever record an outcome when its `resolveBackend` callback
 * names a real backend for the task's worker id. {@link
 * ./worker-attribution.ts | resolveBackendForTask} builds exactly that
 * callback off a {@link ./worker-attribution.ts | WorkerAttributionRegistry}
 * — but NOTHING populates that registry for the DEFAULT swarm mode
 * (`InlineProvider`, no remote backend, no `AttributedContainerProvider`
 * from `./fleet-provider.ts`). Every task in inline mode therefore resolves
 * to `undefined` and the learning loop silently skips every single outcome.
 *
 * The fix is this module: {@link attachInlineAttribution} listens to the
 * REAL `SwarmManager`'s own worker lifecycle events —
 * `"worker:spawned"` / `"worker:killed"` / `"worker:dead"`, emitted by
 * `spawnWorker`/`killWorker`/the health monitor in
 * `../../swarm-runtime/manager/manager.ts` — and mirrors them into the
 * registry under a single synthetic backend name, {@link
 * INLINE_BACKEND_NAME}. This is not a guess: every inline worker really did
 * "run on" the in-process substrate, and `INLINE_BACKEND_NAME` is exactly
 * the label a caller registers a matching {@link ./manager.ts |
 * BackendManager} entry under (a fake/local backend representing "this
 * process") so `SwarmOutcomeFeed`'s cost/telemetry lookups resolve too.
 *
 * {@link attachInlineLearning} is the one-call composition a caller
 * actually wants: build (or restore) the registry, wire the attribution
 * listeners, and attach a real {@link ./swarm-learning.ts | SwarmLearningLoop}
 * on top — all against real modules, no reimplementation of any of their
 * logic.
 *
 * ## Exception safety
 *
 * A `SwarmManager` is a Node `EventEmitter`; an exception thrown out of one
 * of its listeners propagates synchronously through `emit()` and would abort
 * whatever internal operation (`spawnWorker`, `killWorker`, the health
 * monitor sweep) triggered it. Every listener body here is therefore
 * structured so that a throwing `registry.record`/`registry.release` (a
 * caller-poisoned registry, or the documented cross-backend `RangeError`)
 * NEVER escapes the listener — it is caught, reported honestly via
 * `onEvent`, and the swarm keeps running. `registry.persist()` is awaited
 * out-of-band (fire-and-forget from the listener's point of view) so a slow
 * or failing store never blocks worker lifecycle handling either.
 */

import { WorkerAttributionRegistry, resolveBackendForTask, type AttributionStore } from "./worker-attribution";
import { SwarmLearningLoop, type SwarmLearningEvent } from "./swarm-learning";
import { BackendManager } from "./manager";
import type { BanditSnapshotStore } from "./bandit-provisioner";
import type { SwarmManager, WorkerRecord } from "../../swarm-runtime/manager/manager";

// ===========================================================================
// Public constants & types
// ===========================================================================

/** The synthetic backend name inline-mode workers are attributed to. A
 *  caller wanting cost/telemetry to resolve through `BackendManager` too
 *  registers a backend under this exact name (see `./fake-backend.ts` for a
 *  suitable in-process one). */
export const INLINE_BACKEND_NAME = "inline";

/**
 * The minimal worker-lifecycle event surface {@link attachInlineAttribution}
 * needs from a swarm manager. Deliberately structural (not a hard import of
 * the `SwarmManager` class) so a test double satisfies it too — but the real
 * `SwarmManager` (`../../swarm-runtime/manager/manager.ts`, a Node
 * `EventEmitter`) satisfies it as-is, with no adapter.
 */
export interface SwarmWorkerEventSource {
  on(event: "worker:spawned", l: (rec: WorkerRecord) => void): unknown;
  on(event: "worker:killed", l: (rec: WorkerRecord, reason: string) => void): unknown;
  on(event: "worker:dead", l: (rec: WorkerRecord, reason: string) => void): unknown;
  off(event: string, l: (...a: never[]) => void): unknown;
}

export type InlineAttributionEvent = {
  type: "recorded" | "released" | "collision" | "persist-failed";
  at: number;
  workerId?: string;
  detail?: Record<string, unknown>;
};

export interface InlineAttributionOptions {
  /** The real (or structurally-compatible) swarm to listen to. */
  swarm: SwarmWorkerEventSource;
  /** The registry mutated on every worker lifecycle event. */
  registry: WorkerAttributionRegistry;
  /** Backend name every spawned worker is attributed to. Default {@link INLINE_BACKEND_NAME}. */
  backendName?: string;
  /** Best-effort persist the registry after every mutation. Default `true`. */
  persistAfterMutation?: boolean;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
  onEvent?: (e: InlineAttributionEvent) => void;
}

export interface InlineAttributionHandle {
  /** Unsubscribe all three listeners. Idempotent — a second call is a no-op. */
  detach(): void;
}

export interface InlineLearningOptions {
  /** The real backend substrate the bandit routes over (and, typically, the
   *  one an {@link INLINE_BACKEND_NAME}-named backend is registered on). */
  manager: BackendManager;
  /** The real `SwarmManager` to attribute workers on and learn from. */
  swarm: SwarmManager;
  /** Reuse an existing registry instead of constructing a fresh one. When
   *  omitted, a fresh registry is constructed and — when {@link
   *  attributionStore} is given — restored from it before any listener
   *  attaches, so no live event can race a stale in-flight restore. */
  registry?: WorkerAttributionRegistry;
  /** Durable store for the (freshly constructed) attribution registry.
   *  Ignored when {@link registry} is passed explicitly — an
   *  already-constructed registry owns its own persistence wiring. */
  attributionStore?: AttributionStore;
  /** Durable store for the learning loop's bandit snapshot. */
  banditStore?: BanditSnapshotStore;
  backendName?: string;
  explorationC?: number;
  baselineUsdPerHour?: number;
  now?: () => number;
  historyLimit?: number;
  onLearningEvent?: (e: SwarmLearningEvent) => void;
  onAttributionEvent?: (e: InlineAttributionEvent) => void;
}

export interface InlineLearningHandle {
  loop: SwarmLearningLoop;
  attribution: InlineAttributionHandle;
  registry: WorkerAttributionRegistry;
  /** `attribution.detach()` then `loop.detach()`. Idempotent — safe to call
   *  more than once (both underlying detaches are themselves idempotent). */
  detach(): Promise<void>;
}

// ===========================================================================
// Internals
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The real `SwarmManager` (a Node `EventEmitter` subclass) satisfies {@link
 * SwarmWorkerEventSource} at runtime — `.on("worker:spawned", ...)` and
 * `.off(...)` behave exactly as this module needs. The cast here routes
 * around a known `@types/node` typing quirk: `EventEmitter`'s generic
 * `off<K>(eventName, listener)` override does not structurally match a
 * plain `(event: string, l: (...a: never[]) => void)` signature even though
 * calling it that way is correct and safe (verified against the real class
 * in this module's tests).
 */
function asWorkerEventSource(swarm: SwarmManager): SwarmWorkerEventSource {
  return swarm as unknown as SwarmWorkerEventSource;
}

// ===========================================================================
// attachInlineAttribution
// ===========================================================================

/**
 * Mirror `swarm`'s real worker lifecycle into `registry` under
 * `backendName`. See the file header for the exception-safety contract:
 * NOTHING thrown by `registry.record`/`registry.release`/`registry.persist`
 * (a documented `RangeError` collision, or an arbitrary poisoned-registry
 * failure) is ever allowed to propagate back into the swarm's `EventEmitter`.
 */
export function attachInlineAttribution(opts: InlineAttributionOptions): InlineAttributionHandle {
  if (!opts || !opts.swarm || typeof opts.swarm.on !== "function" || typeof opts.swarm.off !== "function") {
    throw new RangeError("attachInlineAttribution: opts.swarm must be a SwarmWorkerEventSource (.on/.off)");
  }
  if (!(opts.registry instanceof WorkerAttributionRegistry)) {
    throw new RangeError("attachInlineAttribution: opts.registry must be a WorkerAttributionRegistry instance");
  }

  const swarm = opts.swarm;
  const registry = opts.registry;
  const backendName = opts.backendName ?? INLINE_BACKEND_NAME;
  const persistAfterMutation = opts.persistAfterMutation ?? true;
  const now = opts.now ?? (() => Date.now());
  const onEventCb = opts.onEvent;

  let detached = false;

  function emit(type: InlineAttributionEvent["type"], workerId: string | undefined, detail?: Record<string, unknown>): void {
    onEventCb?.({ type, at: now(), workerId, detail });
  }

  /** Fire-and-forget best-effort persist. Never throws, never rejects
   *  unhandled — `registry.persist()` is documented never to throw, but a
   *  poisoned test double may violate that, so this still guards. */
  function persistBestEffort(workerId: string | undefined): void {
    if (!persistAfterMutation) return;
    void (async () => {
      try {
        const result = await registry.persist();
        if (!result.saved) {
          emit("persist-failed", workerId, { error: result.error });
        }
      } catch (err) {
        emit("persist-failed", workerId, { error: errorMessage(err) });
      }
    })();
  }

  const onSpawned = (rec: WorkerRecord): void => {
    if (detached) return;
    try {
      registry.record(rec.workerId, backendName, { nativeId: rec.handle.nativeId });
    } catch (err) {
      // The documented contract: a cross-backend collision surfaces as
      // registry.record throwing RangeError. A poisoned registry may throw
      // something else entirely — either way, this listener body must never
      // rethrow into the manager's EventEmitter, so every failure mode here
      // is folded into the same honest "collision" report.
      emit("collision", rec.workerId, { error: errorMessage(err), backend: backendName });
      return;
    }
    emit("recorded", rec.workerId, { backend: backendName, nativeId: rec.handle.nativeId, status: rec.status });
    persistBestEffort(rec.workerId);
  };

  const onKilled = (rec: WorkerRecord, reason: string): void => {
    if (detached) return;
    let released: boolean;
    try {
      released = registry.release(rec.workerId);
    } catch (err) {
      // No dedicated event type exists for a release failure (the LOCKED
      // contract reserves "collision" for record()'s cross-backend case) —
      // absorb it silently rather than mis-label it, but NEVER let it
      // escape into the emitter. Worker lifecycle handling proceeds either way.
      return;
    }
    emit("released", rec.workerId, { reason, event: "worker:killed", releasedExisting: released });
    persistBestEffort(rec.workerId);
  };

  const onDead = (rec: WorkerRecord, reason: string): void => {
    if (detached) return;
    let released: boolean;
    try {
      released = registry.release(rec.workerId);
    } catch {
      return;
    }
    emit("released", rec.workerId, { reason, event: "worker:dead", releasedExisting: released });
    persistBestEffort(rec.workerId);
  };

  swarm.on("worker:spawned", onSpawned);
  swarm.on("worker:killed", onKilled);
  swarm.on("worker:dead", onDead);

  return {
    detach(): void {
      if (detached) return;
      detached = true;
      swarm.off("worker:spawned", onSpawned);
      swarm.off("worker:killed", onKilled);
      swarm.off("worker:dead", onDead);
    },
  };
}

// ===========================================================================
// attachInlineLearning
// ===========================================================================

/**
 * One-call composition: build/restore the attribution registry, wire {@link
 * attachInlineAttribution} to `opts.swarm`, then attach a real {@link
 * SwarmLearningLoop} over `opts.manager` using {@link resolveBackendForTask}
 * backed by that same registry — proving `SwarmLearningLoop` records real
 * outcomes for inline-mode tasks instead of skipping every one of them.
 *
 * Never edits `./factory.ts`/`./manager.ts` (the swarm-runtime seam) — this
 * is purely additive composition of the existing real modules.
 */
export async function attachInlineLearning(opts: InlineLearningOptions): Promise<InlineLearningHandle> {
  if (!opts || !(opts.manager instanceof BackendManager)) {
    throw new RangeError("attachInlineLearning: opts.manager must be a BackendManager instance");
  }
  if (!opts.swarm || typeof (opts.swarm as unknown as { on?: unknown }).on !== "function") {
    throw new RangeError("attachInlineLearning: opts.swarm must be a real SwarmManager");
  }

  const now = opts.now ?? (() => Date.now());

  let registry: WorkerAttributionRegistry;
  if (opts.registry) {
    registry = opts.registry;
  } else {
    registry = new WorkerAttributionRegistry({ store: opts.attributionStore, now });
    if (opts.attributionStore) {
      // Hydrate BEFORE any listener attaches, so a live "worker:spawned"
      // firing during restore can never race a still-in-flight load.
      await registry.restore();
    }
  }

  const attribution = attachInlineAttribution({
    swarm: asWorkerEventSource(opts.swarm),
    registry,
    backendName: opts.backendName,
    // Honesty: when THIS function built the registry, it knows whether a
    // durable store was configured — a store-less registry's persist() can
    // only ever report `{ saved: false, error: "no store configured" }`, so
    // firing a "persist-failed" event per mutation would be noise dressed up
    // as a failure. A caller-supplied registry keeps the default (the caller
    // owns its persistence wiring and may well have configured a store).
    ...(opts.registry ? {} : { persistAfterMutation: Boolean(opts.attributionStore) }),
    now,
    onEvent: opts.onAttributionEvent,
  });

  const loop = await SwarmLearningLoop.attach({
    manager: opts.manager,
    swarm: opts.swarm,
    resolveBackend: resolveBackendForTask(registry),
    store: opts.banditStore,
    explorationC: opts.explorationC,
    baselineUsdPerHour: opts.baselineUsdPerHour,
    now,
    historyLimit: opts.historyLimit,
    onEvent: opts.onLearningEvent,
  });

  return {
    loop,
    attribution,
    registry,
    async detach(): Promise<void> {
      attribution.detach();
      await loop.detach();
    },
  };
}
