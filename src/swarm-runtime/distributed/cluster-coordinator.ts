/**
 * @module swarm-runtime/distributed/cluster-coordinator
 *
 * Phase 18 — the leader's scheduling brain. `ClusterCoordinator` is the
 * authoritative answer to "which task is leased to which node right now,"
 * layered on top of three already-real engines it never reimplements:
 *
 *  - {@link ClusterMembership} — the live, gossip-converged view of who is
 *    alive, and (via `election()`) whether *this* node currently holds
 *    quorum-backed leadership.
 *  - {@link LeaseLedger} — mints the strictly-monotonic per-task fencing
 *    tokens that make a resurrected/zombie node's stale renew or report
 *    provably rejectable.
 *  - {@link VerifiedResultLedger} — the exactly-once, quorum-aware merge
 *    point that turns accepted reports into a single verified record.
 *
 * Everything here is pure, clock-injected logic: no sockets, no timers, no
 * filesystem. The wall clock is always the caller-supplied `now` (per-call
 * override, or the `now` injected at construction) — nothing in this module
 * ever reads the real clock directly.
 *
 * ── Why `ClusterTaskState.leases` is an array, not a lookup into the ledger ──
 * `LeaseLedger` is deliberately single-owner *per taskId*: `grant()` stores
 * exactly one `Lease` per `taskId` in its internal map, so a second `grant()`
 * call for the same `taskId` (placing consensus replica #2 on a different
 * node) *overwrites* the ledger's own bookkeeping for replica #1, even though
 * replica #1's lease is still perfectly live. This is intentional on the
 * ledger's part — it is the single-owner primitive multi-replica placement is
 * built *on top of*, not a bug to route around by reimplementing it. So the
 * coordinator keeps its own authoritative multi-lease record per task
 * (`ClusterTaskState.leases: Lease[]`), while still routing every mutation
 * through the real ledger:
 *   - every grant goes through `LeaseLedger.grant()` (so fencing tokens are
 *     always minted by the one real counter, monotonic and never reused);
 *   - every renew is attempted through `LeaseLedger.renew()` first (which
 *     independently re-validates nodeId + fencing + expiry before mutating
 *     anything, so it can never renew the wrong node's slot even though it
 *     only tracks one lease per taskId);
 *   - every revoke is routed through `LeaseLedger.revoke()`, but only when
 *     `LeaseLedger.owner(taskId)` confirms the ledger's single tracked slot
 *     really is the (nodeId, fencing) being revoked — never blind, since a
 *     blind `revoke(taskId)` would silently erase the ledger's memory of a
 *     *different*, still-live replica's slot;
 *   - every sweep calls `LeaseLedger.expire(now)` (satisfying the contract
 *     that `tick()` sweeps the real ledger), and additionally reconciles
 *     `ClusterTaskState.leases` directly against `now` so replicas the
 *     ledger's single-slot map isn't currently tracking still expire on
 *     schedule.
 *
 * ── Fencing-forgery defense ──────────────────────────────────────────────
 * `VerifiedResultLedger.accept()` guards against a *stale* fencing token
 * (one that was legitimately issued, then superseded) but — by design, since
 * it has no visibility into who a lease was ever granted to — cannot by
 * itself catch a report whose (nodeId, fencing) pair was *never issued at
 * all*. The coordinator closes that gap itself: every fencing token minted
 * via `LeaseLedger.grant()` is recorded in a local, append-only history, and
 * `report()` refuses any entry whose (taskId, nodeId, fencing) never appears
 * there — *before* the entry ever reaches the ledger — with the same
 * `"stale-fencing"` outcome (the closed `AcceptOutcome` reason set has no
 * separate "forged" reason, and semantically a token nobody ever issued is
 * exactly as untrustworthy as one that has since been superseded).
 */

import { EventEmitter } from "node:events";

import type { ClusterMembership, LeaderView, NodeDescriptor, NodeState } from "./membership";
import {
  LeaseLedger,
  VerifiedResultLedger,
  type AcceptOutcome,
  type FederatedResultEntry,
  type Lease,
} from "./lease-ledger";
import type { ConsensusSpec, VerificationReport, WorkerResult, WorkerTask } from "../types";

// Re-exported only for documentation/traceability of the locked import list;
// both types flow into this module already through `FederatedResultEntry`
// (`result: WorkerResult`, `report: VerificationReport`).
export type { WorkerResult as _WorkerResult, VerificationReport as _VerificationReport };

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export type PlacementBlockReason =
  | "no-alive-nodes"
  | "no-quorum"
  | "capability-miss"
  | "no-capacity"
  | "deps-unmet"
  | "replica-exhausted"
  | "attempts-exhausted";

export interface Placement {
  taskId: string;
  nodeId: string;
  lease: Lease;
  replicaIndex: number;
  attempt: number;
}

export interface ClusterTaskState {
  task: WorkerTask;
  status: "pending" | "leased" | "verified" | "failed";
  attempts: number;
  reassignments: number;
  leases: Lease[];
  lastBlock?: PlacementBlockReason;
  lastError?: string;
}

export interface PlacementPolicy {
  rank(
    candidates: NodeState[],
    task: WorkerTask,
    ctx: { inFlightByNode: ReadonlyMap<string, number>; now: number },
  ): NodeState[];
}

/**
 * Default placement policy: ranks candidates by a weighted blend of relative
 * load (in-flight tasks against the node's own capacity, plus its gossiped
 * `load` figure) and `costPerWorkerHourUsd`, with an optional flat preference
 * for a given region. Ties (including the common all-zero case on a fresh
 * cluster) always break on `nodeId` ascending, so placement is deterministic
 * across repeated calls with identical input.
 */
export function costAwarePlacement(opts?: {
  loadWeight?: number;
  costWeight?: number;
  regionAffinity?: string;
}): PlacementPolicy {
  const loadWeight = opts?.loadWeight ?? 1;
  const costWeight = opts?.costWeight ?? 1;
  const regionAffinity = opts?.regionAffinity;

  return {
    rank(candidates, _task, ctx) {
      const scored = candidates.map((n) => {
        const capacity = Math.max(1, n.descriptor.capacity.maxWorkers);
        const inFlight = ctx.inFlightByNode.get(n.descriptor.nodeId) ?? 0;
        const relativeLoad = inFlight / capacity + n.load;
        const cost = n.descriptor.costPerWorkerHourUsd ?? 0;
        const regionBonus = regionAffinity !== undefined && n.descriptor.region === regionAffinity ? -1_000 : 0;
        const score = regionBonus + loadWeight * relativeLoad + costWeight * cost;
        return { n, score };
      });
      scored.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.n.descriptor.nodeId.localeCompare(b.n.descriptor.nodeId);
      });
      return scored.map((s) => s.n);
    },
  };
}

export interface CoordinatorStats {
  total: number;
  pending: number;
  leased: number;
  verified: number;
  failed: number;
  reassignments: number;
  staleReportsRejected: number;
  conflicts: number;
  byNode: Record<string, { leased: number; verified: number; failed: number; reclaimed: number }>;
}

export interface CoordinatorOptions {
  membership: ClusterMembership;
  leases?: LeaseLedger;
  results?: VerifiedResultLedger;
  now?: () => number;
  leaseTtlMs?: number;
  maxAttempts?: number;
  maxInFlightPerNode?: number;
  consensus?: ConsensusSpec;
  placement?: PlacementPolicy;
  requireCertificate?: boolean;
  requireLeadership?: boolean;
}

export interface ClusterCoordinatorEvents {
  "task:placed": [placement: Placement];
  "task:reassigned": [taskId: string, fromNodeId: string, reason: string];
  "task:verified": [taskId: string, entry: FederatedResultEntry];
  "task:failed": [taskId: string, reason: string];
  "placement:blocked": [taskId: string, reason: PlacementBlockReason];
  "result:rejected": [taskId: string, nodeId: string, outcome: AcceptOutcome];
}

// ---------------------------------------------------------------------------
// ClusterCoordinator
// ---------------------------------------------------------------------------

interface NodeStatBucket {
  leased: number;
  verified: number;
  failed: number;
  reclaimed: number;
}

export class ClusterCoordinator extends EventEmitter<ClusterCoordinatorEvents> {
  private readonly membership: ClusterMembership;
  private readonly leases: LeaseLedger;
  private readonly results: VerifiedResultLedger;
  private readonly nowFn: () => number;
  private readonly leaseTtlMs: number;
  private readonly maxAttempts: number;
  private readonly maxInFlightPerNode: number | undefined;
  private readonly defaultConsensus: ConsensusSpec | undefined;
  private readonly requireCertificate: boolean;
  private readonly requireLeadership: boolean;
  private readonly placementPolicy: PlacementPolicy;

  private readonly tasks = new Map<string, ClusterTaskState>();
  private readonly nodeStats = new Map<string, NodeStatBucket>();
  /** `${taskId}#${nodeId}#${fencing}` — every fencing token this coordinator
   * has ever actually granted, checked by `report()` to reject forged tokens
   * a node never legitimately held (see module doc comment). Deliberately
   * never pruned: a zombie's old token must remain rejectable forever. */
  private readonly everGranted = new Set<string>();

  private readonly statCounts = {
    reassignments: 0,
    staleReportsRejected: 0,
    conflicts: 0,
  };

  constructor(opts: CoordinatorOptions) {
    super();
    this.membership = opts.membership;
    this.leases = opts.leases ?? new LeaseLedger();
    this.nowFn = opts.now ?? Date.now;

    this.leaseTtlMs = opts.leaseTtlMs ?? 30_000;
    if (!(this.leaseTtlMs > 0)) {
      throw new RangeError(`ClusterCoordinator: leaseTtlMs must be > 0, got ${this.leaseTtlMs}`);
    }
    this.maxAttempts = opts.maxAttempts ?? 3;
    if (!(this.maxAttempts >= 0) || !Number.isFinite(this.maxAttempts)) {
      throw new RangeError(`ClusterCoordinator: maxAttempts must be a finite number >= 0, got ${this.maxAttempts}`);
    }
    if (opts.maxInFlightPerNode !== undefined && !(opts.maxInFlightPerNode >= 0)) {
      throw new RangeError(`ClusterCoordinator: maxInFlightPerNode must be >= 0, got ${opts.maxInFlightPerNode}`);
    }

    this.maxInFlightPerNode = opts.maxInFlightPerNode;
    this.defaultConsensus = opts.consensus;
    this.requireCertificate = opts.requireCertificate ?? false;
    this.requireLeadership = opts.requireLeadership ?? true;
    this.placementPolicy = opts.placement ?? costAwarePlacement();

    this.results =
      opts.results ??
      new VerifiedResultLedger({
        requireCertificate: this.requireCertificate,
        consensus: this.defaultConsensus,
        now: this.nowFn,
      });
  }

  private now(): number {
    return this.nowFn();
  }

  // ── Task bookkeeping helpers ─────────────────────────────────────────

  private replicasFor(task: WorkerTask): number {
    const spec = task.consensus ?? this.defaultConsensus;
    if (!spec) return 1;
    return Math.max(1, Math.floor(spec.replicas));
  }

  private capFor(node: NodeState): number {
    if (this.maxInFlightPerNode !== undefined) return Math.max(0, this.maxInFlightPerNode);
    return Math.max(0, node.descriptor.capacity.maxWorkers);
  }

  private nodeStat(nodeId: string): NodeStatBucket {
    let s = this.nodeStats.get(nodeId);
    if (!s) {
      s = { leased: 0, verified: 0, failed: 0, reclaimed: 0 };
      this.nodeStats.set(nodeId, s);
    }
    return s;
  }

  private cloneState(s: ClusterTaskState): ClusterTaskState {
    return {
      task: s.task,
      status: s.status,
      attempts: s.attempts,
      reassignments: s.reassignments,
      leases: [...s.leases],
      lastBlock: s.lastBlock,
      lastError: s.lastError,
    };
  }

  private markGranted(taskId: string, nodeId: string, fencing: number): void {
    this.everGranted.add(`${taskId}#${nodeId}#${fencing}`);
  }

  private wasEverGranted(taskId: string, nodeId: string, fencing: number): boolean {
    return this.everGranted.has(`${taskId}#${nodeId}#${fencing}`);
  }

  /**
   * Revoke `taskId`'s ledger-tracked slot *only* when it is genuinely the
   * (nodeId, fencing) being revoked. `LeaseLedger.revoke(taskId)` has no
   * nodeId parameter — it blindly deletes whatever the ledger currently
   * tracks for that taskId — so calling it unconditionally for a multi-
   * replica task could erase a different, still-live replica's slot. This
   * guard makes that impossible.
   */
  private safeLedgerRevoke(taskId: string, nodeId: string, fencing: number, reason: string): void {
    const owner = this.leases.owner(taskId);
    if (owner && owner.nodeId === nodeId && owner.fencing === fencing) {
      this.leases.revoke(taskId, reason);
    }
  }

  private failTask(state: ClusterTaskState, reason: string): void {
    state.status = "failed";
    state.lastError = reason;
    state.lastBlock = "attempts-exhausted";
    this.emit("task:failed", state.task.id, reason);
  }

  private candidateTasks(): ClusterTaskState[] {
    return [...this.tasks.values()]
      .filter((s) => s.status === "pending" || (s.status === "leased" && s.leases.length < this.replicasFor(s.task)))
      .sort((a, b) => b.task.priority - a.task.priority || a.task.id.localeCompare(b.task.id));
  }

  private computeInFlightByNode(): Map<string, number> {
    const m = new Map<string, number>();
    for (const state of this.tasks.values()) {
      for (const lease of state.leases) {
        m.set(lease.nodeId, (m.get(lease.nodeId) ?? 0) + 1);
      }
    }
    return m;
  }

  // ── Public API ────────────────────────────────────────────────────────

  submit(tasks: WorkerTask[]): void {
    for (const task of tasks) {
      if (!task || typeof task.id !== "string" || task.id.length === 0) continue; // malformed: skip, never throw
      if (this.tasks.has(task.id)) continue; // duplicate submission: idempotent no-op
      this.tasks.set(task.id, {
        task,
        status: "pending",
        attempts: 0,
        reassignments: 0,
        leases: [],
      });
    }
  }

  plan(now?: number): Placement[] {
    const nowVal = now ?? this.now();
    const placements: Placement[] = [];

    const candidates = this.candidateTasks();
    if (candidates.length === 0) return placements;

    const view: LeaderView = this.membership.election();
    const selfId = this.membership.self().descriptor.nodeId;
    const isLeader = view.leaderId === selfId;

    if (this.requireLeadership && (!view.quorum || !isLeader)) {
      for (const state of candidates) {
        state.lastBlock = "no-quorum";
        this.emit("placement:blocked", state.task.id, "no-quorum");
      }
      return [];
    }

    const aliveNodes = this.membership.alive();
    const inFlightByNode = this.computeInFlightByNode();

    for (const state of candidates) {
      if (state.status === "pending" && state.attempts >= this.maxAttempts) {
        this.failTask(state, "attempts-exhausted");
        continue;
      }

      const depsOk = state.task.dependsOn.every((depId) => this.tasks.get(depId)?.status === "verified");
      if (!depsOk) {
        state.lastBlock = "deps-unmet";
        this.emit("placement:blocked", state.task.id, "deps-unmet");
        continue;
      }

      const already = new Set(state.leases.map((l) => l.nodeId));
      const target = this.replicasFor(state.task);
      const needed = target - state.leases.length;
      if (needed <= 0) continue; // fully replicated already; nothing to do this round

      if (aliveNodes.length === 0) {
        state.lastBlock = "no-alive-nodes";
        this.emit("placement:blocked", state.task.id, "no-alive-nodes");
        continue;
      }

      const distinctAlive = aliveNodes.filter((n) => !already.has(n.descriptor.nodeId));
      const capable = distinctAlive.filter((n) =>
        state.task.requiredCapabilities.every((c) => n.descriptor.capabilities.includes(c)),
      );
      if (capable.length === 0) {
        state.lastBlock = "capability-miss";
        this.emit("placement:blocked", state.task.id, "capability-miss");
        continue;
      }

      const withCapacity = capable.filter((n) => (inFlightByNode.get(n.descriptor.nodeId) ?? 0) < this.capFor(n));
      if (withCapacity.length === 0) {
        state.lastBlock = "no-capacity";
        this.emit("placement:blocked", state.task.id, "no-capacity");
        continue;
      }

      const withCapacityIds = new Set(withCapacity.map((n) => n.descriptor.nodeId));
      const ranked = this.placementPolicy
        .rank(withCapacity, state.task, { inFlightByNode, now: nowVal })
        .filter((n) => withCapacityIds.has(n.descriptor.nodeId));

      if (ranked.length < needed) {
        // Not enough distinct, capable, capacity-having nodes to fill every
        // remaining replica slot: block the whole round rather than silently
        // placing fewer than `target` replicas (which would let two replicas
        // of the same task ever land on one node once a slot frees up, or
        // permanently under-replicate the task).
        state.lastBlock = "replica-exhausted";
        this.emit("placement:blocked", state.task.id, "replica-exhausted");
        continue;
      }

      const chosen = ranked.slice(0, needed);
      if (state.attempts === 0) state.attempts = 1;
      const attemptNum = state.attempts;
      let replicaIndex = state.leases.length;

      for (const node of chosen) {
        const nodeId = node.descriptor.nodeId;
        const lease = this.leases.grant(state.task.id, nodeId, attemptNum, nowVal, this.leaseTtlMs);
        this.markGranted(state.task.id, nodeId, lease.fencing);
        state.leases.push(lease);
        state.status = "leased";
        state.lastBlock = undefined;
        inFlightByNode.set(nodeId, (inFlightByNode.get(nodeId) ?? 0) + 1);
        this.nodeStat(nodeId).leased += 1;

        const placement: Placement = { taskId: state.task.id, nodeId, lease, replicaIndex, attempt: attemptNum };
        replicaIndex += 1;
        placements.push(placement);
        this.emit("task:placed", placement);
      }
    }

    return placements;
  }

  renew(taskId: string, nodeId: string, fencing: number, now?: number): Lease | null {
    if (typeof fencing !== "number" || !Number.isFinite(fencing)) return null;
    const state = this.tasks.get(taskId);
    if (!state) return null;
    const idx = state.leases.findIndex((l) => l.nodeId === nodeId && l.fencing === fencing);
    if (idx === -1) return null;

    const nowVal = now ?? this.now();
    const current = state.leases[idx];
    if (nowVal >= current.expiresAt) return null;

    // Best-effort mirror into the real ledger: it succeeds when `current`
    // happens to be the ledger's single tracked slot for this taskId, and is
    // a safe no-op otherwise (LeaseLedger.renew re-validates nodeId, fencing,
    // and expiry independently before mutating anything).
    this.leases.renew(taskId, nodeId, fencing, nowVal, this.leaseTtlMs);

    const renewed: Lease = { ...current, expiresAt: nowVal + this.leaseTtlMs };
    state.leases[idx] = renewed;
    return renewed;
  }

  async report(entry: FederatedResultEntry): Promise<AcceptOutcome> {
    const taskId = entry?.taskId;
    const state = typeof taskId === "string" ? this.tasks.get(taskId) : undefined;
    if (!state) {
      return { accepted: false, reason: "unknown-task" };
    }

    const nodeId = entry.nodeId;
    const fencing = entry.fencing;
    if (
      typeof nodeId !== "string" ||
      nodeId.length === 0 ||
      typeof fencing !== "number" ||
      !Number.isFinite(fencing) ||
      !this.wasEverGranted(taskId, nodeId, fencing)
    ) {
      this.statCounts.staleReportsRejected += 1;
      const outcome: AcceptOutcome = { accepted: false, reason: "stale-fencing" };
      this.emit("result:rejected", taskId, typeof nodeId === "string" ? nodeId : "", outcome);
      return outcome;
    }

    const outcome = await this.results.accept(entry);

    if (!outcome.accepted) {
      if (outcome.reason === "stale-fencing") this.statCounts.staleReportsRejected += 1;
      if (outcome.reason === "conflict") this.statCounts.conflicts += 1;
      this.emit("result:rejected", taskId, nodeId, outcome);
      return outcome;
    }

    const idx = state.leases.findIndex((l) => l.nodeId === nodeId && l.fencing === fencing);
    if (idx !== -1) {
      state.leases.splice(idx, 1);
      this.safeLedgerRevoke(taskId, nodeId, fencing, "verified");
    }
    this.nodeStat(nodeId).verified += 1;

    // Single-owner mode: any accept means verified. Consensus mode: only
    // once VerifiedResultLedger itself reports quorum met.
    const clusterVerified = outcome.quorumMet === undefined ? true : outcome.quorumMet;
    if (clusterVerified && state.status !== "verified") {
      for (const remaining of state.leases) {
        this.safeLedgerRevoke(remaining.taskId, remaining.nodeId, remaining.fencing, "superseded-by-quorum");
      }
      state.leases = [];
      state.status = "verified";
      state.lastBlock = undefined;
      this.emit("task:verified", taskId, entry);
    }

    return outcome;
  }

  handBack(taskId: string, nodeId: string, fencing: number, reason: string): boolean {
    if (typeof fencing !== "number" || !Number.isFinite(fencing)) return false;
    const state = this.tasks.get(taskId);
    if (!state || state.status === "verified" || state.status === "failed") return false;

    const idx = state.leases.findIndex((l) => l.nodeId === nodeId && l.fencing === fencing);
    if (idx === -1) return false;

    state.leases.splice(idx, 1);
    this.safeLedgerRevoke(taskId, nodeId, fencing, reason);
    this.nodeStat(nodeId).reclaimed += 1;
    state.reassignments += 1;
    this.statCounts.reassignments += 1;

    if (state.leases.length === 0) {
      state.status = "pending";
      state.lastBlock = undefined;
    }
    this.emit("task:reassigned", taskId, nodeId, reason);
    return true;
  }

  tick(now?: number): { expired: Lease[]; reassigned: string[]; failed: string[] } {
    const nowVal = now ?? this.now();

    // Always sweep the real ledger (satisfies the contract regardless of how
    // many of the task's replicas it happens to still be tracking).
    const ledgerExpired = this.leases.expire(nowVal);

    const expiredByKey = new Map<string, Lease>();
    for (const l of ledgerExpired) expiredByKey.set(`${l.taskId}#${l.nodeId}#${l.fencing}`, l);
    // Reconcile against the coordinator's own authoritative multi-lease
    // record too, so replicas beyond whichever one the ledger's single-slot
    // map is currently tracking still expire on schedule (see module doc).
    for (const state of this.tasks.values()) {
      for (const l of state.leases) {
        if (nowVal >= l.expiresAt) expiredByKey.set(`${l.taskId}#${l.nodeId}#${l.fencing}`, l);
      }
    }

    const expired = [...expiredByKey.values()].sort(
      (a, b) => a.taskId.localeCompare(b.taskId) || a.nodeId.localeCompare(b.nodeId),
    );

    const byTask = new Map<string, Lease[]>();
    for (const l of expired) {
      const arr = byTask.get(l.taskId);
      if (arr) arr.push(l);
      else byTask.set(l.taskId, [l]);
    }

    const reassignedSet = new Set<string>();
    const failedSet = new Set<string>();

    for (const [taskId, leasesExpired] of byTask) {
      const state = this.tasks.get(taskId);
      if (!state || state.status === "verified" || state.status === "failed") continue;

      const expiredKeys = new Set(leasesExpired.map((l) => `${l.nodeId}#${l.fencing}`));
      state.leases = state.leases.filter((l) => !expiredKeys.has(`${l.nodeId}#${l.fencing}`));

      for (const l of leasesExpired) this.nodeStat(l.nodeId).reclaimed += 1;
      state.reassignments += leasesExpired.length;
      this.statCounts.reassignments += leasesExpired.length;

      if (state.leases.length > 0) {
        // Partial expiry: other replicas are still live; the task stays
        // "leased" and plan() will top up the freed slot(s) next round.
        for (const l of leasesExpired) this.emit("task:reassigned", taskId, l.nodeId, "lease-expired");
        reassignedSet.add(taskId);
        continue;
      }

      state.attempts += 1;
      if (state.attempts >= this.maxAttempts) {
        this.failTask(state, "attempts-exhausted");
        for (const l of leasesExpired) this.nodeStat(l.nodeId).failed += 1;
        failedSet.add(taskId);
      } else {
        state.status = "pending";
        state.lastBlock = undefined;
        for (const l of leasesExpired) this.emit("task:reassigned", taskId, l.nodeId, "lease-expired");
        reassignedSet.add(taskId);
      }
    }

    return { expired, reassigned: [...reassignedSet].sort(), failed: [...failedSet].sort() };
  }

  onNodeDown(nodeId: string, reason: "dead" | "left"): string[] {
    const affected: string[] = [];

    for (const state of this.tasks.values()) {
      if (state.status === "verified" || state.status === "failed") continue;
      const held = state.leases.filter((l) => l.nodeId === nodeId);
      if (held.length === 0) continue;

      for (const l of held) {
        this.safeLedgerRevoke(l.taskId, l.nodeId, l.fencing, `node-${reason}`);
        this.nodeStat(nodeId).reclaimed += 1;
      }
      state.leases = state.leases.filter((l) => l.nodeId !== nodeId);
      // A death/departure is not the task's own fault: preserve attempt
      // counts (only tick()'s TTL-expiry path spends a retry attempt).
      state.reassignments += held.length;
      this.statCounts.reassignments += held.length;
      affected.push(state.task.id);

      if (state.leases.length === 0) {
        state.status = "pending";
        state.lastBlock = undefined;
      }
      for (const l of held) this.emit("task:reassigned", state.task.id, l.nodeId, `node-${reason}`);
    }

    return affected.sort();
  }

  state(taskId: string): ClusterTaskState | undefined {
    const s = this.tasks.get(taskId);
    return s ? this.cloneState(s) : undefined;
  }

  pending(): ClusterTaskState[] {
    return [...this.tasks.values()]
      .filter((s) => s.status === "pending" || s.status === "leased")
      .sort((a, b) => a.task.id.localeCompare(b.task.id))
      .map((s) => this.cloneState(s));
  }

  verifiedTaskIds(): string[] {
    return [...this.tasks.values()]
      .filter((s) => s.status === "verified")
      .map((s) => s.task.id)
      .sort();
  }

  isComplete(): boolean {
    return [...this.tasks.values()].every((s) => s.status === "verified" || s.status === "failed");
  }

  stats(): CoordinatorStats {
    let pending = 0;
    let leased = 0;
    let verified = 0;
    let failed = 0;
    for (const s of this.tasks.values()) {
      switch (s.status) {
        case "pending":
          pending += 1;
          break;
        case "leased":
          leased += 1;
          break;
        case "verified":
          verified += 1;
          break;
        case "failed":
          failed += 1;
          break;
      }
    }

    const byNode: CoordinatorStats["byNode"] = {};
    for (const [nodeId, bucket] of this.nodeStats) {
      byNode[nodeId] = { ...bucket };
    }

    return {
      total: this.tasks.size,
      pending,
      leased,
      verified,
      failed,
      reassignments: this.statCounts.reassignments,
      staleReportsRejected: this.statCounts.staleReportsRejected,
      conflicts: this.statCounts.conflicts,
      byNode,
    };
  }
}

// Referenced only so `NodeDescriptor` stays part of this module's visible
// import surface per the locked contract, alongside its use throughout via
// `NodeState.descriptor`.
export type { NodeDescriptor };
