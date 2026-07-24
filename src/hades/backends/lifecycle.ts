/**
 * LifecycleMachine — a formal, durable-friendly state machine for remote
 * worker lifecycle transitions.
 *
 * {@link RemoteBackendRegistry} (`./backend.ts`) already exposes `hibernate`
 * and `wake` as ad-hoc async calls on top of `RemoteState`. That is enough
 * for a single happy-path hibernate/wake, but it has no notion of *in-flight*
 * transition states, no retry/backoff policy for a flaky wake, no guard
 * against two concurrent wakes racing on the same worker, and no explicit,
 * exhaustively-documented table of which transitions are legal at all. This
 * module is that missing layer: a small, dependency-free state machine that
 * sits in front of a backend's hibernate/wake calls and gives the swarm
 * manager (and the crash-consistent `HandleStore` in `./handle-store.ts`) a
 * single source of truth for "what state is worker X in, and how did it get
 * there".
 *
 * Two transient states are added on top of the backend's own {@link
 * RemoteState}: `"hibernating"` (in-flight suspend) and `"waking"` (in-flight
 * resume). Backends never report these themselves — they are purely this
 * machine's bookkeeping around the moment a hibernate/wake operation is
 * actually running, so a crash or a concurrent call mid-operation has a
 * state to be caught in rather than silently racing.
 */

import type { RemoteState } from "./backend";

// ===========================================================================
// State + transition table
// ===========================================================================

/** Every state a tracked worker can be in, including the two transient
 *  in-flight states this machine adds on top of {@link RemoteState}. */
export type LifecycleState = RemoteState | "hibernating" | "waking";

/**
 * The single authoritative allowed-transition table. Every legal edge in the
 * lifecycle graph is listed here and nowhere else — {@link canTransition},
 * {@link LifecycleMachine.transition}, and this module's own `runHibernate`/
 * `runWake` orchestration all defer to this table rather than re-deriving
 * legality from scratch, so there is exactly one place to audit "can a
 * worker go from A to B".
 *
 * Semantics of each state and its outgoing edges:
 *
 * - `"provisioning"` — the backend is bringing the worker up for the first
 *   time. -> `"running"` on success, -> `"failed"` if provisioning errors.
 * - `"running"` — the worker is live and reachable. -> `"hibernating"` to
 *   begin a suspend, -> `"stopped"` on a deliberate terminate, -> `"failed"`
 *   if it dies/errors out from under us.
 * - `"hibernating"` — transient: a hibernate operation is in flight.
 *   -> `"hibernated"` once the backend confirms suspension, -> `"failed"` if
 *   the hibernate call itself throws. (No edge back to `"running"` — a
 *   failed hibernate attempt is a failure, not a rollback, because the
 *   backend's own state after a partial hibernate call is not something this
 *   machine can safely assume is still "running".)
 * - `"hibernated"` — suspended, at rest, zero (or near-zero) cost.
 *   -> `"waking"` to begin a resume, -> `"stopped"` if torn down while
 *   asleep, -> `"failed"` if the backend reports it can no longer be woken.
 * - `"waking"` — transient: a wake operation (with retry) is in flight.
 *   -> `"running"` once the backend confirms it is back up, -> `"failed"`
 *   once every retry attempt has been exhausted.
 * - `"failed"` — terminal except for one explicit escape hatch:
 *   -> `"provisioning"`, and ONLY as an explicit, deliberate re-provision
 *   decision made by the caller (never automatic). There is no edge from
 *   `"failed"` to anything else; a failed worker that is not re-provisioned
 *   stays failed forever.
 * - `"stopped"` — fully and permanently terminal. No outgoing edges at all.
 */
const TRANSITIONS_TABLE: Record<LifecycleState, readonly LifecycleState[]> = {
  provisioning: ["running", "failed"],
  running: ["hibernating", "stopped", "failed"],
  hibernating: ["hibernated", "failed"],
  hibernated: ["waking", "stopped", "failed"],
  waking: ["running", "failed"],
  failed: ["provisioning"],
  stopped: [],
};

export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(TRANSITIONS_TABLE) as Array<[LifecycleState, readonly LifecycleState[]]>).map(([state, edges]) => [
      state,
      Object.freeze([...edges]),
    ]),
  ) as Record<LifecycleState, readonly LifecycleState[]>,
);

/** All states the table knows about, for exhaustive iteration in tests and
 *  defensive validation elsewhere. */
export const ALL_LIFECYCLE_STATES: readonly LifecycleState[] = Object.freeze(
  Object.keys(LIFECYCLE_TRANSITIONS) as LifecycleState[],
);

/**
 * True iff `to` is a directly-allowed transition target from `from` per
 * {@link LIFECYCLE_TRANSITIONS}. This is pure table lookup — it does NOT
 * treat `from === to` as automatically legal; same-state idempotency (e.g.
 * hibernate-when-already-hibernated) is a {@link LifecycleMachine}-level
 * concept applied only where the contract calls for it (`"hibernated"` and
 * `"running"`), not a blanket rule baked into the table itself.
 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  const edges = LIFECYCLE_TRANSITIONS[from];
  if (!edges) return false;
  return edges.includes(to);
}

// ===========================================================================
// Errors + events
// ===========================================================================

/** Thrown by {@link LifecycleMachine.transition} (and anything built on top
 *  of it) when a caller asks for a transition {@link LIFECYCLE_TRANSITIONS}
 *  does not allow. */
export class TransitionError extends Error {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly workerId: string;

  constructor(workerId: string, from: LifecycleState, to: LifecycleState, detail?: string) {
    super(
      `LifecycleMachine: illegal transition for worker ${JSON.stringify(workerId)}: ` +
        `${JSON.stringify(from)} -> ${JSON.stringify(to)} is not allowed` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "TransitionError";
    this.from = from;
    this.to = to;
    this.workerId = workerId;
  }
}

/**
 * Thrown by {@link LifecycleMachine.runWake} once every retry attempt has
 * been exhausted. Carries every attempt's underlying error so callers (and
 * tests) can inspect the full failure history, not just the last one.
 * Modeled after the `AggregateError` shape (a `.errors` array + a summary
 * `.message`) without depending on `AggregateError` itself, since this needs
 * to also carry `workerId`/`attempts` and target the same ES2022 lib the
 * rest of the repo already assumes.
 */
export class WakeExhaustedError extends Error {
  readonly workerId: string;
  readonly attempts: number;
  readonly errors: readonly unknown[];

  constructor(workerId: string, attempts: number, errors: readonly unknown[]) {
    const causes = errors
      .map((e, i) => `  attempt ${i + 1}: ${e instanceof Error ? e.message : String(e)}`)
      .join("\n");
    super(
      `LifecycleMachine: wake exhausted for worker ${JSON.stringify(workerId)} after ${attempts} attempt(s):\n${causes}`,
    );
    this.name = "WakeExhaustedError";
    this.workerId = workerId;
    this.attempts = attempts;
    this.errors = errors;
  }
}

/** One recorded transition (or idempotent no-op) for a tracked worker. */
export interface LifecycleEvent {
  workerId: string;
  from: LifecycleState;
  to: LifecycleState;
  at: number;
  /** Present on retry-bearing transitions (wake attempts). */
  attempt?: number;
  reason?: string;
}

export interface LifecycleMachineOptions {
  /** Time source (ms). Injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Delay primitive used between wake retry attempts. Injectable so tests
   *  never wait on a real timer. Default a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Maximum wake attempts before giving up. Default 3. */
  wakeMaxAttempts?: number;
  /** Base backoff delay (ms) before the 2nd wake attempt, doubling each
   *  subsequent attempt (exponential x2). Default 500. */
  wakeBackoffMs?: number;
  /** Observability hook: fired for every transition (including idempotent
   *  no-ops and per-attempt wake events). */
  onEvent?: (e: LifecycleEvent) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// LifecycleMachine
// ===========================================================================

/** States for which re-requesting the SAME state is treated as an
 *  idempotent no-op (still recorded as an event) instead of a
 *  {@link TransitionError}, per the locked contract. */
const IDEMPOTENT_SELF_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(["hibernated", "running"]);

/**
 * Tracks lifecycle state per worker and enforces {@link LIFECYCLE_TRANSITIONS}
 * on every move. Two orchestration helpers, {@link runHibernate} and
 * {@link runWake}, wrap the transient `"hibernating"`/`"waking"` states around
 * an arbitrary backend operation so callers never have to hand-roll the
 * before/success/failure transition triple themselves.
 */
export class LifecycleMachine {
  private readonly states = new Map<string, LifecycleState>();
  private readonly log = new Map<string, LifecycleEvent[]>();
  /** Workers with a wake currently in flight — guards against a second
   *  concurrent `runWake` racing the first while state is `"waking"`. */
  private readonly wakingInFlight = new Set<string>();

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly wakeMaxAttempts: number;
  private readonly wakeBackoffMs: number;
  private readonly onEvent?: (e: LifecycleEvent) => void;

  constructor(opts: LifecycleMachineOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.wakeMaxAttempts = opts.wakeMaxAttempts ?? 3;
    this.wakeBackoffMs = opts.wakeBackoffMs ?? 500;
    this.onEvent = opts.onEvent;
    if (this.wakeMaxAttempts < 1) {
      throw new RangeError("LifecycleMachine: wakeMaxAttempts must be >= 1");
    }
    if (this.wakeBackoffMs < 0) {
      throw new RangeError("LifecycleMachine: wakeBackoffMs must be >= 0");
    }
  }

  /** Current tracked state, or `undefined` if the worker isn't tracked. */
  state(workerId: string): LifecycleState | undefined {
    return this.states.get(workerId);
  }

  /** Begin tracking a worker at `initial` state. Overwrites any prior
   *  tracking for the same id (e.g. re-tracking after `untrack`). Does not
   *  itself emit an event — there is no "from" state for a first sighting. */
  track(workerId: string, initial: LifecycleState): void {
    this.states.set(workerId, initial);
    this.log.set(workerId, []);
    this.wakingInFlight.delete(workerId);
  }

  /** Stop tracking a worker entirely, discarding its state and history. */
  untrack(workerId: string): void {
    this.states.delete(workerId);
    this.log.delete(workerId);
    this.wakingInFlight.delete(workerId);
  }

  private ensureTracked(workerId: string): LifecycleState {
    const current = this.states.get(workerId);
    if (current === undefined) {
      throw new TransitionError(workerId, "stopped", "stopped", "worker is not tracked; call track() first");
    }
    return current;
  }

  private record(workerId: string, from: LifecycleState, to: LifecycleState, opts?: { attempt?: number; reason?: string }): void {
    const event: LifecycleEvent = {
      workerId,
      from,
      to,
      at: this.now(),
      ...(opts?.attempt !== undefined ? { attempt: opts.attempt } : {}),
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
    };
    const list = this.log.get(workerId) ?? [];
    list.push(event);
    this.log.set(workerId, list);
    this.onEvent?.(event);
  }

  /**
   * Move `workerId` to `to`. Throws {@link TransitionError} if the move is
   * not present in {@link LIFECYCLE_TRANSITIONS} AND is not one of the two
   * documented idempotent self-transitions (`hibernated`->`hibernated`,
   * `running`->`running`), which succeed as a recorded no-op event instead.
   */
  transition(workerId: string, to: LifecycleState, reason?: string): void {
    const from = this.ensureTracked(workerId);

    if (from === to && IDEMPOTENT_SELF_STATES.has(from)) {
      // Documented idempotent no-op (hibernate-when-hibernated,
      // wake-when-running): succeed with a recorded event instead of
      // consulting the table, since no state legally lists itself as a
      // transition target.
      this.record(workerId, from, to, { reason: reason ?? `idempotent no-op: already ${from}` });
      return;
    }

    if (!canTransition(from, to)) {
      throw new TransitionError(workerId, from, to);
    }

    this.states.set(workerId, to);
    this.record(workerId, from, to, reason !== undefined ? { reason } : undefined);
  }

  /** Full recorded event history for a worker, most-recent-last. `limit`
   *  caps how many of the MOST RECENT events are returned. */
  history(workerId: string, limit?: number): LifecycleEvent[] {
    const list = this.log.get(workerId) ?? [];
    if (limit === undefined || limit >= list.length) return [...list];
    if (limit <= 0) return [];
    return list.slice(list.length - limit);
  }

  /**
   * `running` -> `hibernating` -> `hibernated`, running `op` (the actual
   * backend hibernate call) while in the transient `hibernating` state. On
   * `op` throwing, the worker is moved to `failed` and the original error is
   * rethrown (never swallowed).
   *
   * Idempotent per the locked contract: if the worker is already
   * `hibernated`, this is a no-op-with-event and `op` is NOT invoked (it
   * already ran the first time; re-running a suspend op against an already
   * suspended backend is exactly the kind of redundant side effect
   * idempotency exists to avoid).
   */
  async runHibernate(workerId: string, op: () => Promise<void>): Promise<void> {
    const current = this.ensureTracked(workerId);
    if (current === "hibernated") {
      this.transition(workerId, "hibernated");
      return;
    }

    this.transition(workerId, "hibernating");
    try {
      await op();
    } catch (err) {
      this.transition(workerId, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
    this.transition(workerId, "hibernated");
  }

  /**
   * `hibernated` -> `waking` -> `running`, retrying `op` up to
   * `wakeMaxAttempts` times with exponential backoff (`wakeBackoffMs`,
   * `wakeBackoffMs*2`, `wakeBackoffMs*4`, ...) between attempts via the
   * injected `sleep`. Emits one event per attempt (`attempt` 1-based) in
   * addition to the state-transition events. On success the worker ends
   * `running`; if every attempt fails the worker ends `failed` and a
   * {@link WakeExhaustedError} carrying every attempt's error is thrown.
   *
   * Idempotent per the locked contract: if the worker is already `running`,
   * this is a no-op-with-event and `op` is NOT invoked.
   *
   * Concurrency guard: a second `runWake` call for the same worker while one
   * is already in flight (state `"waking"`, or this call itself mid-flight)
   * is rejected deterministically with a {@link TransitionError} rather than
   * being allowed to race the first call's retries or state transitions.
   */
  async runWake(workerId: string, op: () => Promise<void>): Promise<void> {
    const current = this.ensureTracked(workerId);
    if (current === "running") {
      this.transition(workerId, "running");
      return;
    }

    if (current === "waking" || this.wakingInFlight.has(workerId)) {
      throw new TransitionError(workerId, current, "waking", "a wake is already in flight for this worker");
    }

    this.wakingInFlight.add(workerId);
    try {
      this.transition(workerId, "waking");

      const errors: unknown[] = [];
      for (let attempt = 1; attempt <= this.wakeMaxAttempts; attempt++) {
        try {
          await op();
          this.states.set(workerId, "running");
          this.record(workerId, "waking", "running", { attempt, reason: "wake attempt succeeded" });
          return;
        } catch (err) {
          errors.push(err);
          this.record(workerId, "waking", "waking", {
            attempt,
            reason: `wake attempt failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          if (attempt < this.wakeMaxAttempts) {
            const backoff = this.wakeBackoffMs * 2 ** (attempt - 1);
            await this.sleep(backoff);
          }
        }
      }

      this.transition(workerId, "failed", `wake exhausted after ${this.wakeMaxAttempts} attempt(s)`);
      throw new WakeExhaustedError(workerId, this.wakeMaxAttempts, errors);
    } finally {
      this.wakingInFlight.delete(workerId);
    }
  }
}
