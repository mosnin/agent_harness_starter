/**
 * SwarmOutcomeFeed — turns the REAL `SwarmManager`'s task lifecycle events
 * (`../../swarm-runtime/manager/manager.ts`) into measured
 * `CostAwareRouteBandit.recordOutcome` calls, with durable bandit state.
 *
 * This module reimplements no part of the swarm's dispatch/verification
 * machinery: it listens to the manager's own real event stream
 * (`"task:dispatched"`, `"task:verified"`, `"task:rejected"`,
 * `"task:failed"` — verified against `manager.ts`'s `emit()` call sites) and
 * derives every number it reports from real measurements:
 *
 * - `elapsedMs` is the wall-clock delta (injected clock) between the most
 *   recent `"task:dispatched"` event for a task id and whichever terminal
 *   event closes it out. A terminal event with no matching dispatch on file
 *   (e.g. the feed attached mid-flight) records `elapsedMs: 0` and says so
 *   in the event detail — never a guessed duration.
 * - `usd` is the measured delta of `manager.telemetry(backend).accruedUsd`
 *   between the dispatch-time snapshot and the terminal-time reading for the
 *   SAME backend, floored at 0 (accrued cost is monotonic in practice, but
 *   the floor guards against any drift rather than ever reporting a
 *   fabricated negative or positive number). No matching dispatch snapshot,
 *   or a backend that changed between dispatch and terminal attribution,
 *   defaults to `usd: 0` with the same honesty note.
 * - `verified` is `true` only for `"task:verified"` whose
 *   `report.verdict === "accept"` — a consensus win still comes through
 *   `"task:verified"` with a synthesized accept-shaped report (see
 *   `manager.ts`'s `evaluateConsensus`), so this needs no special-casing.
 *
 * `resolveBackend` is caller-supplied and REQUIRED to do the real
 * task -> backend-name mapping (this module has no way to infer it — a
 * `WorkerTask` does not itself carry a backend name). Returning `undefined`
 * (or an empty string) means "don't know" and is honestly reported via
 * `onEvent({ type: "skipped" })`, recording nothing rather than guessing.
 *
 * Exactly one outcome is recorded per task id: the first terminal event that
 * successfully resolves a backend records it (also see `manager.ts` — a
 * task can be redispatched and pass through `"task:rejected"` more than
 * once before either exhausting attempts (`"task:failed"`) or eventually
 * clearing verification (`"task:verified"`); this feed treats whichever
 * terminal event closes the FIRST attempt as the outcome, matching the
 * literal event contract above). Every later terminal event for the same
 * task id is reported as `onEvent({ type: "duplicate" })` and never
 * recorded again.
 */

import type { BackendManager } from "./manager";
import { CostAwareRouteBandit, type RouteOutcome } from "./route-bandit";
import type { BanditSnapshotStore } from "./bandit-provisioner";
import type { WorkerTask, VerificationReport } from "../../swarm-runtime/types";

// ===========================================================================
// Public types
// ===========================================================================

/** The minimal shape `SwarmManager` (a Node `EventEmitter` subclass)
 *  satisfies structurally — this module never imports `SwarmManager` itself,
 *  only its event surface, so it composes with the real class without a
 *  hard runtime dependency on the whole swarm-runtime module graph. */
export type SwarmManagerLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
};

export type OutcomeFeedEvent = {
  type: "recorded" | "skipped" | "duplicate";
  at: number;
  taskId?: string;
  backend?: string;
  detail?: Record<string, unknown>;
};

export interface OutcomeFeedOptions {
  bandit: CostAwareRouteBandit;
  manager: BackendManager;
  /** Real task -> backend-name attribution. Returning `undefined` (or `""`)
   *  means "unknown" and is never guessed at. */
  resolveBackend: (task: WorkerTask) => string | undefined;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
  onEvent?: (e: OutcomeFeedEvent) => void;
  store?: BanditSnapshotStore;
}

// ===========================================================================
// Internals
// ===========================================================================

type TerminalKind = "verified" | "rejected" | "failed";

interface DispatchRecord {
  at: number;
  backend?: string;
  /** `manager.telemetry(backend).accruedUsd` at dispatch time, only present
   *  when `backend` resolved at dispatch time. */
  accruedUsdAtDispatch?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTask(v: unknown): v is WorkerTask {
  return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string";
}

// ===========================================================================
// SwarmOutcomeFeed
// ===========================================================================

export class SwarmOutcomeFeed {
  private readonly bandit: CostAwareRouteBandit;
  private readonly manager: BackendManager;
  private readonly resolveBackendFn: (task: WorkerTask) => string | undefined;
  private readonly now: () => number;
  private readonly onEventCb?: (e: OutcomeFeedEvent) => void;
  private readonly store?: BanditSnapshotStore;

  constructor(opts: OutcomeFeedOptions) {
    if (!opts || !(opts.bandit instanceof CostAwareRouteBandit)) {
      throw new RangeError("SwarmOutcomeFeed: opts.bandit must be a CostAwareRouteBandit instance");
    }
    if (typeof opts.resolveBackend !== "function") {
      throw new RangeError("SwarmOutcomeFeed: opts.resolveBackend must be a function");
    }
    this.bandit = opts.bandit;
    this.manager = opts.manager;
    this.resolveBackendFn = opts.resolveBackend;
    this.now = opts.now ?? (() => Date.now());
    this.onEventCb = opts.onEvent;
    this.store = opts.store;
  }

  private emit(fields: Omit<OutcomeFeedEvent, "at">): void {
    this.onEventCb?.({ at: this.now(), ...fields });
  }

  /** Never guesses: `""` from a caller's `resolveBackend` is treated exactly
   *  like `undefined`. */
  private resolveBackend(task: WorkerTask): string | undefined {
    const name = this.resolveBackendFn(task);
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }

  /**
   * Attach to a real (or structurally-compatible fake) `SwarmManager`.
   * Returns a detach function: removes every listener this call added (via
   * `m.off` when present, else a guard flag that makes every listener a
   * no-op post-detach). Idempotent — calling the returned function more than
   * once is a no-op after the first call.
   */
  attach(m: SwarmManagerLike): () => void {
    let detached = false;
    const dispatched = new Map<string, DispatchRecord>();
    const done = new Set<string>();

    const onDispatched = (...args: unknown[]) => {
      if (detached) return;
      const task = args[0];
      if (!isTask(task)) return;
      const backend = this.resolveBackend(task);
      dispatched.set(task.id, {
        at: this.now(),
        backend,
        accruedUsdAtDispatch: backend ? this.manager.telemetry(backend).accruedUsd : undefined,
      });
    };

    const makeTerminalHandler = (kind: TerminalKind) => (...args: unknown[]) => {
      if (detached) return;
      const task = args[0];
      if (!isTask(task)) return;
      const report = kind !== "failed" ? (args[1] as VerificationReport | undefined) : undefined;
      // Fire-and-forget: recording itself is synchronous, only the optional
      // persistence step is async. Errors from a malformed outcome (a
      // RangeError from `bandit.recordOutcome`) are intentionally NOT
      // caught here — they indicate a caller bug (e.g. `resolveBackend`
      // returning something that slipped past our own guard) and should
      // surface loudly rather than be swallowed.
      void this.handleTerminal(task, kind, report, dispatched, done);
    };

    const onVerified = makeTerminalHandler("verified");
    const onRejected = makeTerminalHandler("rejected");
    const onFailed = makeTerminalHandler("failed");

    m.on("task:dispatched", onDispatched);
    m.on("task:verified", onVerified);
    m.on("task:rejected", onRejected);
    m.on("task:failed", onFailed);

    return () => {
      if (detached) return;
      detached = true;
      if (m.off) {
        m.off("task:dispatched", onDispatched);
        m.off("task:verified", onVerified);
        m.off("task:rejected", onRejected);
        m.off("task:failed", onFailed);
      }
    };
  }

  private async handleTerminal(
    task: WorkerTask,
    kind: TerminalKind,
    report: VerificationReport | undefined,
    dispatched: Map<string, DispatchRecord>,
    done: Set<string>
  ): Promise<void> {
    const backend = this.resolveBackend(task);
    if (!backend) {
      this.emit({
        type: "skipped",
        taskId: task.id,
        detail: { event: `task:${kind}`, reason: "resolveBackend returned no backend" },
      });
      return;
    }

    if (done.has(task.id)) {
      this.emit({ type: "duplicate", taskId: task.id, backend, detail: { event: `task:${kind}` } });
      return;
    }

    const dispatch = dispatched.get(task.id);
    const at = this.now();

    let elapsedMs: number;
    let elapsedNote: string | undefined;
    if (dispatch) {
      elapsedMs = Math.max(0, at - dispatch.at);
    } else {
      elapsedMs = 0;
      elapsedNote = `no "task:dispatched" event recorded for task "${task.id}" before this terminal event; elapsedMs defaulted to 0 (never guessed)`;
    }

    let usd = 0;
    let usdNote: string | undefined;
    if (dispatch && dispatch.backend === backend && dispatch.accruedUsdAtDispatch !== undefined) {
      const accruedNow = this.manager.telemetry(backend).accruedUsd;
      usd = Math.max(0, accruedNow - dispatch.accruedUsdAtDispatch);
    } else if (dispatch && dispatch.backend !== undefined && dispatch.backend !== backend) {
      usdNote = `dispatch-time backend attribution ("${dispatch.backend}") differs from terminal-time backend ("${backend}") for task "${task.id}"; usd defaulted to 0 (never guessed)`;
    } else {
      usdNote = `no dispatch-time accruedUsd baseline for backend "${backend}" on task "${task.id}"; usd defaulted to 0 (never guessed)`;
    }

    const verified = kind === "verified" && report?.verdict === "accept";
    const outcome: RouteOutcome = { verified, elapsedMs, usd };

    // Real, intentionally uncaught: a RangeError here means the outcome we
    // just measured is malformed (should be structurally impossible given
    // the guards above) and must surface, not be silently dropped.
    this.bandit.recordOutcome(backend, outcome);
    done.add(task.id);

    const detail: Record<string, unknown> = { event: `task:${kind}`, verified, elapsedMs, usd };
    if (elapsedNote) detail.elapsedMsNote = elapsedNote;
    if (usdNote) detail.usdNote = usdNote;

    await this.persistBestEffort(detail);

    this.emit({ type: "recorded", taskId: task.id, backend, detail });
  }

  /** Best-effort persist the bandit's snapshot after a real recorded
   *  outcome. Never throws — a save failure is folded into the "recorded"
   *  event's `detail` (this feed's `onEvent` has no separate persistence
   *  event type), mirroring `BanditRoutedProvisioner`'s
   *  never-let-persistence-break-the-real-work discipline. */
  private async persistBestEffort(detail: Record<string, unknown>): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.save(this.bandit.snapshot());
      detail.saved = true;
    } catch (err) {
      detail.saveError = errorMessage(err);
    }
  }
}
