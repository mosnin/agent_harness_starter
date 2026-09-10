/**
 * SwarmLearningLoop — the self-improving routing loop's production wiring:
 * hydrate a {@link CostAwareRouteBandit} from its last persisted snapshot,
 * attach the REAL {@link SwarmOutcomeFeed} (`./outcome-feed.ts`) to a REAL
 * `SwarmManager` (structurally, via {@link SwarmManagerLike}), and expose an
 * honest, introspectable status/report surface for the CLI/TUI/desktop
 * surfaces to poll.
 *
 * ## What this module delegates vs. what it owns
 *
 * Every number this loop reports is either read straight out of, or
 * assembled without alteration from, modules that already own that
 * responsibility:
 *
 * - **All routing math** (UCB1, mean reward, cost efficiency) is owned
 *   entirely by {@link CostAwareRouteBandit} (`./route-bandit.ts`). This
 *   module never recomputes or approximates a reward or a UCB score — it
 *   only reads `bandit.arms()` back out for {@link SwarmLearningStatus}.
 * - **All outcome measurement** (elapsedMs, usd deltas, verified/not,
 *   exactly-once-per-task, duplicate detection, best-effort persistence
 *   after every recorded outcome) is owned entirely by
 *   {@link SwarmOutcomeFeed} (`./outcome-feed.ts`). This module never
 *   touches `manager.telemetry()` or a `WorkerTask`'s dispatch/terminal
 *   lifecycle directly — it only listens to the feed's own `onEvent` stream.
 * - **Snapshot validation and per-arm defensive dropping of corrupt state**
 *   is owned entirely by `CostAwareRouteBandit.fromState` — this module
 *   never inspects a loaded snapshot's shape itself; a bad snapshot becomes
 *   whatever `fromState` decides it means (invalid arms dropped, valid ones
 *   kept, or a wholly fresh bandit for an unrecognized shape/version).
 *
 * What THIS module owns, and only this:
 *
 * 1. **Snapshot-load precedence at attach time** — deciding whether to use a
 *    caller-supplied bandit as-is, hydrate one from a {@link
 *    BanditSnapshotStore}, or start fresh (see {@link
 *    SwarmLearningLoop.attach}), and reporting which of those three
 *    happened, honestly, via a `"attached"` event's `detail.banditSource` —
 *    never silently.
 * 2. **Re-aggregating the feed's raw `OutcomeFeedEvent` stream** into the
 *    `recorded`/`skipped`/`duplicate` counters and a capped ring buffer
 *    (newest last) that {@link SwarmLearningStatus} exposes, and re-emitting
 *    every one of those events verbatim as a `"feed"`-typed
 *    {@link SwarmLearningEvent} for anyone else observing this loop's event
 *    stream (mirroring `FleetSupervisor`'s single `onEvent` discipline, see
 *    `./fleet-supervisor.ts`).
 * 3. **Attach/detach lifecycle bookkeeping** — a loop instance may be
 *    attached exactly once (a second internal attach attempt is a
 *    programmer-error `RangeError`: double-listening on the same swarm would
 *    silently double-count every outcome, which is exactly the kind of
 *    fabricated-looking number this codebase refuses to produce) and
 *    `detach()` is idempotent, doing one final best-effort snapshot save
 *    whose failure is reported, never thrown.
 * 4. **`renderLearningReport`** — a pure, plain-text (no ANSI — every real
 *    surface, CLI/TUI/desktop, can style it however it wants) rendering of a
 *    {@link SwarmLearningStatus} snapshot. It never fabricates a number for
 *    an arm that has never been pulled (renders `"never pulled"`, not a
 *    misleading `0.00`) and surfaces the feed's own honesty notes
 *    (`elapsedMsNote`/`usdNote`) verbatim rather than paraphrasing them.
 */

import { BackendManager } from "./manager";
import { SwarmOutcomeFeed, type SwarmManagerLike, type OutcomeFeedEvent } from "./outcome-feed";
import { CostAwareRouteBandit, type BanditArm } from "./route-bandit";
import type { BanditSnapshotStore } from "./bandit-provisioner";
import type { WorkerTask } from "../../swarm-runtime/types";

// ===========================================================================
// Public types
// ===========================================================================

export type SwarmLearningEvent = {
  type: "attached" | "detached" | "snapshot-loaded" | "snapshot-load-failed" | "feed";
  at: number;
  detail?: Record<string, unknown>;
};

export interface SwarmLearningOptions {
  /** The real backend substrate the bandit routes over. Required. */
  manager: BackendManager;
  /** The real (or structurally-compatible) `SwarmManager` to learn from. */
  swarm: SwarmManagerLike;
  /** Real task -> backend-name attribution, forwarded unchanged to the
   *  underlying `SwarmOutcomeFeed`. See `./outcome-feed.ts` for the honesty
   *  contract around an unresolved backend. */
  resolveBackend: (task: WorkerTask) => string | undefined;
  /** Optional durable snapshot store. When present (and no explicit `bandit`
   *  is passed), the bandit is hydrated from it at attach time, and every
   *  outcome the feed records is best-effort persisted back through it. */
  store?: BanditSnapshotStore;
  /** An already-constructed bandit to use as-is. When passed, `store` (if
   *  also present) is used ONLY for outcome persistence going forward — it
   *  is never loaded from at attach time. See {@link SwarmLearningLoop.attach}. */
  bandit?: CostAwareRouteBandit;
  /** Forwarded to a freshly-constructed bandit (ignored when `bandit` is
   *  passed explicitly, or when hydrating via `fromState` — those use their
   *  own already-decided options). */
  explorationC?: number;
  baselineUsdPerHour?: number;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
  /** Max entries kept in `status().recent`. Must be a positive integer. Default 200. */
  historyLimit?: number;
  onEvent?: (e: SwarmLearningEvent) => void;
}

export interface SwarmLearningStatus {
  attached: boolean;
  counts: { recorded: number; skipped: number; duplicate: number };
  /** Every tracked arm, canonically ordered by name (see `bandit.arms()`). */
  arms: Record<string, BanditArm>;
  /** Ring buffer of the feed's raw events, newest last, capped at `historyLimit`. */
  recent: OutcomeFeedEvent[];
}

// ===========================================================================
// Internals
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_HISTORY_LIMIT = 200;

// ===========================================================================
// SwarmLearningLoop
// ===========================================================================

export class SwarmLearningLoop {
  private readonly manager: BackendManager;
  private readonly swarm: SwarmManagerLike;
  private readonly banditInstance: CostAwareRouteBandit;
  private readonly feed: SwarmOutcomeFeed;
  private readonly store?: BanditSnapshotStore;
  private readonly now: () => number;
  private readonly historyLimit: number;
  private readonly onEventCb?: (e: SwarmLearningEvent) => void;

  private detachFeedFn?: () => void;
  /** Guards against this SAME instance ever wiring up its feed twice — see
   *  file header point 3. Set exactly once, in {@link subscribeToSwarm}. */
  private subscribed = false;
  private attachedFlag = false;
  private detachedFlag = false;

  private readonly counts = { recorded: 0, skipped: 0, duplicate: 0 };
  private readonly ring: OutcomeFeedEvent[] = [];

  private constructor(fields: {
    manager: BackendManager;
    swarm: SwarmManagerLike;
    bandit: CostAwareRouteBandit;
    resolveBackend: (task: WorkerTask) => string | undefined;
    store?: BanditSnapshotStore;
    now: () => number;
    historyLimit: number;
    onEvent?: (e: SwarmLearningEvent) => void;
  }) {
    this.manager = fields.manager;
    this.swarm = fields.swarm;
    this.banditInstance = fields.bandit;
    this.store = fields.store;
    this.now = fields.now;
    this.historyLimit = fields.historyLimit;
    this.onEventCb = fields.onEvent;
    // The REAL outcome feed, constructed here (not before) so its `onEvent`
    // closure can capture `this` — nothing about outcome measurement is
    // reimplemented, this loop only listens.
    this.feed = new SwarmOutcomeFeed({
      bandit: fields.bandit,
      manager: fields.manager,
      resolveBackend: fields.resolveBackend,
      now: fields.now,
      store: fields.store,
      onEvent: (e) => this.handleFeedEvent(e),
    });
  }

  // ---------------------------------------------------------------------
  // Attach
  // ---------------------------------------------------------------------

  /**
   * Hydrate a bandit (see precedence below), construct the real
   * `SwarmOutcomeFeed` wired to it, and attach to `opts.swarm`. Never throws
   * for a snapshot-load failure — that is reported via a
   * `"snapshot-load-failed"` event and falls back to a fresh bandit.
   *
   * Precedence:
   * 1. `opts.bandit` explicitly passed -> used as-is. Any `opts.store` is
   *    used ONLY for future outcome persistence — never loaded from here.
   * 2. No explicit bandit, `opts.store` present -> hydrate via
   *    `CostAwareRouteBandit.fromState(..., await opts.store.load())`. A
   *    rejected `load()` is caught: falls back to a fresh bandit and emits
   *    `"snapshot-load-failed"` with the error's message.
   * 3. Neither -> a fresh bandit.
   */
  static async attach(opts: SwarmLearningOptions): Promise<SwarmLearningLoop> {
    if (!opts || !(opts.manager instanceof BackendManager)) {
      throw new RangeError("SwarmLearningLoop.attach: opts.manager must be a BackendManager instance");
    }
    if (!opts.swarm || typeof opts.swarm.on !== "function") {
      throw new RangeError("SwarmLearningLoop.attach: opts.swarm must be a SwarmManagerLike (an .on(event, listener) emitter)");
    }
    if (typeof opts.resolveBackend !== "function") {
      throw new RangeError("SwarmLearningLoop.attach: opts.resolveBackend must be a function");
    }
    const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (typeof historyLimit !== "number" || !Number.isInteger(historyLimit) || historyLimit <= 0) {
      throw new RangeError("SwarmLearningLoop.attach: opts.historyLimit must be a positive integer");
    }
    const now = opts.now ?? (() => Date.now());

    let bandit: CostAwareRouteBandit;
    let banditSource: "explicit" | "store" | "fresh";
    let snapshotEvent: { type: "snapshot-loaded" | "snapshot-load-failed"; detail: Record<string, unknown> } | undefined;

    if (opts.bandit) {
      bandit = opts.bandit;
      banditSource = "explicit";
    } else if (opts.store) {
      const banditOpts = { manager: opts.manager, explorationC: opts.explorationC, baselineUsdPerHour: opts.baselineUsdPerHour };
      try {
        const state = await opts.store.load();
        bandit = CostAwareRouteBandit.fromState(banditOpts, state);
        banditSource = "store";
        snapshotEvent = { type: "snapshot-loaded", detail: { armCount: Object.keys(bandit.snapshot().arms).length } };
      } catch (err) {
        bandit = new CostAwareRouteBandit(banditOpts);
        banditSource = "fresh";
        snapshotEvent = { type: "snapshot-load-failed", detail: { error: errorMessage(err) } };
      }
    } else {
      bandit = new CostAwareRouteBandit({ manager: opts.manager, explorationC: opts.explorationC, baselineUsdPerHour: opts.baselineUsdPerHour });
      banditSource = "fresh";
    }

    const loop = new SwarmLearningLoop({
      manager: opts.manager,
      swarm: opts.swarm,
      bandit,
      resolveBackend: opts.resolveBackend,
      store: opts.store,
      now,
      historyLimit,
      onEvent: opts.onEvent,
    });

    if (snapshotEvent) loop.emit(snapshotEvent.type, snapshotEvent.detail);
    loop.subscribeToSwarm(banditSource);
    return loop;
  }

  /** Wires the real feed to `this.swarm`. Only ever called once per instance
   *  — from `attach()` — see file header point 3. */
  private subscribeToSwarm(banditSource: "explicit" | "store" | "fresh"): void {
    if (this.subscribed) {
      throw new RangeError(
        "SwarmLearningLoop: this instance is already attached to a swarm; double-listening would double-count outcomes"
      );
    }
    this.detachFeedFn = this.feed.attach(this.swarm);
    this.subscribed = true;
    this.attachedFlag = true;
    this.emit("attached", { banditSource, armCount: Object.keys(this.banditInstance.snapshot().arms).length });
  }

  // ---------------------------------------------------------------------
  // Feed event re-aggregation
  // ---------------------------------------------------------------------

  private handleFeedEvent(e: OutcomeFeedEvent): void {
    if (e.type === "recorded") this.counts.recorded += 1;
    else if (e.type === "skipped") this.counts.skipped += 1;
    else if (e.type === "duplicate") this.counts.duplicate += 1;

    this.ring.push(e);
    if (this.ring.length > this.historyLimit) {
      this.ring.splice(0, this.ring.length - this.historyLimit);
    }

    // Verbatim: the whole OutcomeFeedEvent, unaltered, as this event's detail.
    this.emit("feed", e as unknown as Record<string, unknown>, e.at);
  }

  private emit(type: SwarmLearningEvent["type"], detail?: Record<string, unknown>, at?: number): void {
    this.onEventCb?.({ type, at: at ?? this.now(), detail });
  }

  // ---------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------

  bandit(): CostAwareRouteBandit {
    return this.banditInstance;
  }

  status(): SwarmLearningStatus {
    return {
      attached: this.attachedFlag,
      counts: { ...this.counts },
      arms: this.banditInstance.arms(),
      recent: [...this.ring],
    };
  }

  // ---------------------------------------------------------------------
  // Detach
  // ---------------------------------------------------------------------

  /**
   * Detach from the swarm (idempotent — a second call is a no-op and emits
   * nothing further) and do one final best-effort `store.save` of the
   * bandit's current snapshot. A save failure is folded into the
   * `"detached"` event's `detail`, never thrown — mirrors
   * `SwarmOutcomeFeed.persistBestEffort` / `FleetSupervisor.persist()`'s
   * never-let-persistence-break-the-real-work discipline.
   */
  async detach(): Promise<void> {
    if (this.detachedFlag) return;
    this.detachedFlag = true;
    this.detachFeedFn?.();
    this.attachedFlag = false;

    if (!this.store) {
      this.emit("detached", { saved: false, reason: "no store configured" });
      return;
    }
    try {
      await this.store.save(this.banditInstance.snapshot());
      this.emit("detached", { saved: true });
    } catch (err) {
      this.emit("detached", { saved: false, error: errorMessage(err) });
    }
  }
}

// ===========================================================================
// renderLearningReport
// ===========================================================================

/**
 * Plain-text (no ANSI) rendering of a {@link SwarmLearningStatus} snapshot,
 * for the CLI/TUI/desktop surfaces to print or embed as-is. Every figure
 * comes straight from `status` — this function computes nothing new and
 * fabricates nothing: a zero-pull arm renders `"never pulled"`, never a
 * misleading `0.00`, and a `null` UCB (only possible for a zero-pull arm)
 * renders `"—"`.
 */
export function renderLearningReport(status: SwarmLearningStatus): string[] {
  const lines: string[] = [];
  lines.push(
    `Swarm learning loop — recorded=${status.counts.recorded} skipped=${status.counts.skipped} duplicate=${status.counts.duplicate}`
  );
  lines.push("");
  lines.push("Arms:");

  const armNames = Object.keys(status.arms).sort();
  if (armNames.length === 0) {
    lines.push("  (none)");
  } else {
    for (const name of armNames) {
      const arm = status.arms[name];
      if (arm.pulls === 0) {
        lines.push(`  ${name}: never pulled`);
      } else {
        const ucbStr = arm.ucb === null ? "—" : arm.ucb.toFixed(2);
        lines.push(
          `  ${name}: pulls=${arm.pulls} verified=${arm.verified} meanReward=${arm.meanReward.toFixed(2)} ucb=${ucbStr}`
        );
      }
    }
  }

  lines.push("");
  lines.push("Recent events (up to 10, newest last):");
  const recentSlice = status.recent.slice(-10);
  if (recentSlice.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of recentSlice) {
      const taskId = e.taskId ?? "-";
      const backend = e.backend ?? "-";
      lines.push(`  ${e.type} task=${taskId} backend=${backend}`);
      const elapsedMsNote = e.detail?.elapsedMsNote;
      if (typeof elapsedMsNote === "string") lines.push(`    elapsedMsNote: ${elapsedMsNote}`);
      const usdNote = e.detail?.usdNote;
      if (typeof usdNote === "string") lines.push(`    usdNote: ${usdNote}`);
    }
  }

  return lines;
}
