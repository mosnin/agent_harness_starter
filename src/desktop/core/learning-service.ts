/**
 * LearningService — turns `LearningCommand`s into `LearningEvent`s for the
 * desktop sidecar, projecting the real swarm learning loop's status
 * (`src/hades/backends/swarm-learning.ts`'s `SwarmLearningLoop`) into the
 * wire-safe `LearningStatusView` (`../ipc/learning-contract.ts`).
 *
 * Two sources of truth, tried in order, and always honestly labeled:
 *
 *   1. `opts.source` — a live, in-process `SwarmLearningLoop` (structurally,
 *      via `LearningStatusSource`; the real loop's `.status()` method
 *      already satisfies this). When present, its status is projected with
 *      `source: "live"` (`savedAt: null` — nothing was "saved", this is
 *      happening right now).
 *   2. `opts.loadPersisted` — a loader over a durable
 *      `FileLearningStatusStore` (`../../hades/backends/learning-status-store.ts`).
 *      Used only when no live source is configured; its result is projected
 *      with `source: "snapshot"` and `savedAt` set to the record's own save
 *      time, so a stale-on-disk snapshot can never be mistaken for a live
 *      read.
 *
 * Neither source configured (or a configured `loadPersisted` resolving
 * `undefined`, meaning nothing was ever persisted) emits a single honest
 * `learning.error`, never a fabricated empty status. A THROWING `source` or
 * `loadPersisted` is caught and reported the same way — `handle()` never
 * rejects, and it calls `emit` exactly once per command.
 */

import type { SwarmLearningStatus } from "../../hades/backends/swarm-learning";
import type { LearningArmView, LearningCommand, LearningEvent, LearningStatusView } from "../ipc/learning-contract";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The subset of `SwarmLearningLoop` this service needs. Structural on
 * purpose: a real `SwarmLearningLoop` instance (which exposes a
 * `status(): SwarmLearningStatus` method) satisfies this without wrapping.
 */
export interface LearningStatusSource {
  status(): SwarmLearningStatus;
}

/**
 * Loads the last durably-persisted learning status, or `undefined` when
 * nothing has ever been saved. Matches `FileLearningStatusStore.load()`'s
 * shape (`{ at, status }` from its `PersistedLearningStatus` envelope, minus
 * the `version` field this service doesn't need).
 */
export interface PersistedStatusLoader {
  (): Promise<{ at: number; status: SwarmLearningStatus } | undefined>;
}

export interface LearningServiceOptions {
  /** A live, attached learning loop. Preferred over `loadPersisted` when present. */
  source?: LearningStatusSource;
  /** A durable-snapshot loader, used only when `source` is absent. */
  loadPersisted?: PersistedStatusLoader;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Pure projection from the engine's `SwarmLearningStatus` to the wire-safe
 * `LearningStatusView`. Computes nothing new about routing math or outcome
 * measurement — it only reshapes and, critically, enforces the one honesty
 * rule that isn't already true of the engine's own `BanditArm` shape: a
 * never-pulled arm (`pulls === 0`) always renders `meanReward: null` (the
 * engine stores a `0` there — see `BanditArm.meanReward` in
 * `../../hades/backends/route-bandit.ts` — which this projection refuses to
 * forward as though it were a real measurement) alongside `ucb: null` (the
 * engine already stores `null` there for a never-pulled arm; enforced here
 * too so the guarantee never depends on the engine never changing).
 *
 * `recentNotes` pulls the feed's own `elapsedMsNote`/`usdNote` strings
 * (`OutcomeFeedEvent.detail`, see `../../hades/backends/outcome-feed.ts`)
 * verbatim — never paraphrased — in event order, then keeps only the newest
 * 20 (oldest dropped first).
 */
export function projectLearningStatus(
  s: SwarmLearningStatus,
  meta: { source: "live" | "snapshot"; savedAt: number | null; at: number }
): LearningStatusView {
  const arms: LearningArmView[] = Object.entries(s.arms)
    .map(([name, arm]) => ({
      name,
      pulls: arm.pulls,
      verified: arm.verified,
      meanReward: arm.pulls === 0 ? null : arm.meanReward,
      ucb: arm.pulls === 0 ? null : arm.ucb,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const notes: string[] = [];
  for (const event of s.recent) {
    const elapsedMsNote = event.detail?.elapsedMsNote;
    if (typeof elapsedMsNote === "string") notes.push(elapsedMsNote);
    const usdNote = event.detail?.usdNote;
    if (typeof usdNote === "string") notes.push(usdNote);
  }
  const recentNotes = notes.slice(-20);

  return {
    attached: s.attached,
    source: meta.source,
    savedAt: meta.savedAt,
    counts: { ...s.counts },
    arms,
    recentNotes,
    at: meta.at,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LearningService {
  private readonly source?: LearningStatusSource;
  private readonly loadPersisted?: PersistedStatusLoader;
  private readonly now: () => number;

  constructor(opts: LearningServiceOptions = {}) {
    this.source = opts.source;
    this.loadPersisted = opts.loadPersisted;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Handle one `LearningCommand`, calling `emit` exactly once with the
   * resulting `LearningEvent`. Never rejects: any error thrown or returned
   * by `source`/`loadPersisted` becomes a `learning.error` event instead of
   * propagating.
   */
  async handle(cmd: LearningCommand, emit: (e: LearningEvent) => void): Promise<void> {
    switch (cmd.kind) {
      case "learning.get":
        await this.handleGet(emit);
        return;
      default: {
        // Exhaustiveness guard: a new LearningCommand kind added upstream
        // without a case here fails to compile.
        const _exhaustive: never = cmd.kind;
        void _exhaustive;
      }
    }
  }

  private async handleGet(emit: (e: LearningEvent) => void): Promise<void> {
    if (this.source) {
      let status: SwarmLearningStatus;
      try {
        status = this.source.status();
      } catch (err) {
        emit({ kind: "learning.error", message: errorMessage(err), at: this.now() });
        return;
      }
      emit({
        kind: "learning.status",
        status: projectLearningStatus(status, { source: "live", savedAt: null, at: this.now() }),
      });
      return;
    }

    if (this.loadPersisted) {
      let loaded: { at: number; status: SwarmLearningStatus } | undefined;
      try {
        loaded = await this.loadPersisted();
      } catch (err) {
        emit({ kind: "learning.error", message: errorMessage(err), at: this.now() });
        return;
      }
      if (loaded) {
        emit({
          kind: "learning.status",
          status: projectLearningStatus(loaded.status, {
            source: "snapshot",
            savedAt: loaded.at,
            at: this.now(),
          }),
        });
        return;
      }
    }

    emit({ kind: "learning.error", message: "no learning status available", at: this.now() });
  }
}
