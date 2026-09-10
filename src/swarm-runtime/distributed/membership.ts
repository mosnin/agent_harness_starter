/**
 * Phase 17 — Cluster Membership & Leadership.
 *
 * A SWIM-style ("Scalable Weakly-consistent Infection-style process group
 * Membership") gossip layer plus a quorum-guarded, epoch-fenced leader
 * election on top of it. This is pure in-process logic: it produces and
 * consumes plain `GossipDigest` objects, and knows nothing about sockets,
 * timers, or the wire. Team 2's transport is responsible for actually
 * shipping `digest()` output to peers and feeding received digests into
 * `apply()`. The wall clock is always injected (`now?: () => number`) so the
 * whole module is deterministically testable with a virtual clock.
 *
 * ── Merge model ─────────────────────────────────────────────────────────
 * Every non-self node is merged as a small join-semilattice: the comparison
 * key for an incoming fact about a node is the pair
 * `(incarnation, healthRank(health))`, compared lexicographically. Applying
 * the entry with the greater key always wins; a smaller key is stale and
 * rejected; an equal key is a no-op (byte-for-byte duplicate information).
 * Because "greater key wins" is commutative, associative, and idempotent,
 * the merge converges to the *same* final state for a given set of facts no
 * matter what order they are applied in — this is what makes the randomized
 * digest-arrival-order convergence property true by construction, not by
 * coincidence.
 *
 * Only a node itself may raise its own incarnation (via `refute()` /
 * `leave()` / `join()` on rejoin). Gossip about a node can never carry that
 * node past a health state that requires a strictly higher incarnation than
 * currently known for it — e.g. reviving a `dead` node to `alive` at the
 * *same* incarnation is rejected as stale; it takes a higher incarnation,
 * which only the node itself can mint.
 *
 * A node's *own* entry can never be mutated by gossip. If a digest claims
 * this node is `suspect`/`dead`, that claim is rejected (`self-downgrade`)
 * and answered by bumping this node's own incarnation and re-asserting
 * `alive` — the standard SWIM refutation move.
 *
 * ── Leadership ──────────────────────────────────────────────────────────
 * `electLeader` is a pure function: give it a membership view and a quorum
 * policy and it deterministically picks the lexicographically-smallest
 * `nodeId` among currently-`alive` nodes as leader, but *only* if that alive
 * set forms a majority (or `quorumPolicy: "single"` accepts any non-empty
 * alive set) of the total known cluster size. A minority partition can never
 * see a majority of the *known* cluster, so it deterministically elects no
 * leader at all — this is what makes split-brain structurally impossible
 * here rather than merely unlikely.
 *
 * `ClusterMembership` layers a local, monotonically increasing `epoch` on
 * top of `electLeader`: any time this node's local view of the alive set
 * changes, its epoch advances. The epoch is not a cross-node consensus term
 * (there is no consensus round here — quorum arithmetic alone is what
 * prevents two leaders); it exists so a consumer holding a stale
 * `LeaderView` can tell, just by comparing epochs, that its view is behind
 * this node's current one.
 */

import { EventEmitter } from "node:events";

import type { IsolationKind } from "../types";
import { sha256Hex } from "../../hades/styx/certificate";

// ---------------------------------------------------------------------------
// Public types (locked contract — do not change shapes without updating all
// three call sites: gossip transport, leader-dependent schedulers, tests).
// ---------------------------------------------------------------------------

export type NodeHealth = "alive" | "suspect" | "dead" | "left";

export interface NodeDescriptor {
  nodeId: string;
  managerUrl: string;
  capabilities: string[];
  capacity: { maxWorkers: number; providerKinds: IsolationKind[] };
  region?: string;
  costPerWorkerHourUsd?: number;
  publicKeyHex: string;
  startedAt: number;
}

export interface NodeState {
  descriptor: NodeDescriptor;
  health: NodeHealth;
  incarnation: number;
  lastSeenAt: number;
  suspectSince?: number;
  load: number;
  liveWorkers: number;
}

export interface GossipEntry {
  nodeId: string;
  incarnation: number;
  health: NodeHealth;
  descriptor?: NodeDescriptor;
  load: number;
  liveWorkers: number;
}

export interface GossipDigest {
  senderId: string;
  sentAt: number;
  epoch: number;
  entries: GossipEntry[];
  checksum: string;
}

export type GossipRejectReason =
  | "stale-incarnation"
  | "identity-mismatch"
  | "self-downgrade"
  | "clock-skew"
  | "unknown-node"
  | "malformed";

export interface GossipApplyResult {
  applied: number;
  rejected: Array<{ nodeId: string; reason: GossipRejectReason }>;
  changes: MembershipChange[];
}

export interface MembershipChange {
  nodeId: string;
  from: NodeHealth;
  to: NodeHealth;
  at: number;
}

export interface LeaderView {
  leaderId: string | null;
  epoch: number;
  quorum: boolean;
  voters: string[];
}

export interface MembershipOptions {
  self: NodeDescriptor;
  now?: () => number;
  suspectAfterMs?: number;
  deadAfterMs?: number;
  quorumPolicy?: "majority" | "single";
  maxClockSkewMs?: number;
  maxDigestEntries?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SUSPECT_AFTER_MS = 5_000;
const DEFAULT_DEAD_AFTER_MS = 15_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_DIGEST_ENTRIES = 64;

// Total order used to break ties at equal incarnation, and to prioritize
// digest truncation. Higher rank = "more newsworthy" / "more terminal".
const HEALTH_RANK: Record<NodeHealth, number> = { alive: 0, suspect: 1, dead: 2, left: 3 };

// ---------------------------------------------------------------------------
// Leader election — pure function.
// ---------------------------------------------------------------------------

export function electLeader(
  nodes: NodeState[],
  opts: { quorum: "majority" | "single"; epoch: number; knownSize: number },
): LeaderView {
  const voters = nodes
    .filter((n) => n.health === "alive")
    .map((n) => n.descriptor.nodeId)
    .sort();

  const required = opts.quorum === "single" ? 1 : Math.floor(opts.knownSize / 2) + 1;
  const quorum = voters.length >= required && voters.length > 0;
  const leaderId = quorum ? voters[0] : null;

  return { leaderId, epoch: opts.epoch, quorum, voters };
}

// ---------------------------------------------------------------------------
// Internal helpers: deterministic canonical JSON + checksum.
// ---------------------------------------------------------------------------

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}

function digestChecksum(entries: GossipEntry[]): string {
  return sha256Hex(stableJson(entries));
}

// ---------------------------------------------------------------------------
// Internal helpers: shape validation (defends apply() against malformed or
// adversarially-crafted digests — never trust the wire).
// ---------------------------------------------------------------------------

function isValidDescriptorShape(d: unknown): d is NodeDescriptor {
  if (!d || typeof d !== "object") return false;
  const rec = d as Record<string, unknown>;
  if (typeof rec.nodeId !== "string" || rec.nodeId.length === 0) return false;
  if (typeof rec.managerUrl !== "string") return false;
  if (!Array.isArray(rec.capabilities) || !rec.capabilities.every((c) => typeof c === "string")) return false;
  const capacity = rec.capacity as Record<string, unknown> | undefined;
  if (!capacity || typeof capacity !== "object") return false;
  if (!Number.isInteger(capacity.maxWorkers) || (capacity.maxWorkers as number) < 0) return false;
  if (!Array.isArray(capacity.providerKinds)) return false;
  if (rec.region !== undefined && typeof rec.region !== "string") return false;
  if (rec.costPerWorkerHourUsd !== undefined && typeof rec.costPerWorkerHourUsd !== "number") return false;
  if (typeof rec.publicKeyHex !== "string" || rec.publicKeyHex.length === 0) return false;
  if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) return false;
  return true;
}

function isValidEntryShape(e: unknown): e is GossipEntry {
  if (!e || typeof e !== "object") return false;
  const rec = e as Record<string, unknown>;
  if (typeof rec.nodeId !== "string" || rec.nodeId.length === 0) return false;
  if (!Number.isInteger(rec.incarnation) || (rec.incarnation as number) < 0) return false;
  if (
    rec.health !== "alive" &&
    rec.health !== "suspect" &&
    rec.health !== "dead" &&
    rec.health !== "left"
  ) {
    return false;
  }
  if (typeof rec.load !== "number" || !Number.isFinite(rec.load) || (rec.load as number) < 0) return false;
  if (!Number.isInteger(rec.liveWorkers) || (rec.liveWorkers as number) < 0) return false;
  if (rec.descriptor !== undefined && !isValidDescriptorShape(rec.descriptor)) return false;
  return true;
}

/** Comparison key ordering for the CRDT-style merge: >0 means `entry` wins. */
function compareEntry(
  entryIncarnation: number,
  entryHealth: NodeHealth,
  storedIncarnation: number,
  storedHealth: NodeHealth,
): number {
  if (entryIncarnation !== storedIncarnation) return entryIncarnation - storedIncarnation;
  return HEALTH_RANK[entryHealth] - HEALTH_RANK[storedHealth];
}

function safeEntryNodeId(e: unknown): string {
  if (e && typeof e === "object" && typeof (e as Record<string, unknown>).nodeId === "string") {
    return (e as Record<string, unknown>).nodeId as string;
  }
  return "";
}

// ---------------------------------------------------------------------------
// ClusterMembership
// ---------------------------------------------------------------------------

export class ClusterMembership extends EventEmitter {
  private readonly nowFn: () => number;
  private readonly selfId: string;
  private readonly suspectAfterMs: number;
  private readonly deadAfterMs: number;
  private readonly quorumPolicy: "majority" | "single";
  private readonly maxClockSkewMs: number;
  private readonly maxDigestEntries: number;

  private readonly nodeMap = new Map<string, NodeState>();
  private epoch = 0;
  private lastAliveSignature: string;
  private lastLeaderView: LeaderView;

  constructor(options: MembershipOptions) {
    super();

    const suspectAfterMs = options.suspectAfterMs ?? DEFAULT_SUSPECT_AFTER_MS;
    const deadAfterMs = options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS;
    if (!(suspectAfterMs > 0)) {
      throw new RangeError("ClusterMembership: suspectAfterMs must be > 0");
    }
    if (!(deadAfterMs > suspectAfterMs)) {
      throw new RangeError("ClusterMembership: deadAfterMs must be greater than suspectAfterMs");
    }

    this.nowFn = options.now ?? Date.now;
    this.selfId = options.self.nodeId;
    this.suspectAfterMs = suspectAfterMs;
    this.deadAfterMs = deadAfterMs;
    this.quorumPolicy = options.quorumPolicy ?? "majority";
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    this.maxDigestEntries = options.maxDigestEntries ?? DEFAULT_MAX_DIGEST_ENTRIES;

    const now = this.nowFn();
    this.nodeMap.set(this.selfId, {
      descriptor: options.self,
      health: "alive",
      incarnation: 0,
      lastSeenAt: now,
      load: 0,
      liveWorkers: 0,
    });

    this.lastAliveSignature = this.selfId;
    this.lastLeaderView = this.election();
  }

  private now(): number {
    return this.nowFn();
  }

  private get selfState(): NodeState {
    // Always present: constructor seeds it, and nothing ever deletes it.
    return this.nodeMap.get(this.selfId) as NodeState;
  }

  private emitHealthEvent(change: MembershipChange, state: NodeState): void {
    const snapshot = { ...state };
    switch (change.to) {
      case "suspect":
        this.emit("node:suspect", snapshot);
        break;
      case "dead":
        this.emit("node:dead", snapshot);
        break;
      case "alive":
        this.emit("node:recovered", snapshot);
        break;
      case "left":
        this.emit("node:left", snapshot);
        break;
    }
  }

  /** Bump self incarnation, force health back to alive. Shared by refute()/self-defense. */
  private applyRefute(now: number): number {
    const s = this.selfState;
    s.incarnation += 1;
    const prevHealth = s.health;
    s.health = "alive";
    s.lastSeenAt = now;
    s.suspectSince = undefined;
    if (prevHealth !== "alive") {
      this.emit("node:recovered", { ...s });
    }
    return s.incarnation;
  }

  /**
   * Recompute the local epoch + leader view. Called after any operation that
   * may have changed the alive set. Epoch advances exactly when this node's
   * own view of who is alive changes; `leader:changed` fires exactly when
   * the elected leaderId (including transitions to/from no-leader) changes.
   */
  private refreshLeader(): void {
    const aliveSignature = Array.from(this.nodeMap.values())
      .filter((n) => n.health === "alive")
      .map((n) => n.descriptor.nodeId)
      .sort()
      .join(",");

    if (aliveSignature !== this.lastAliveSignature) {
      this.epoch += 1;
      this.lastAliveSignature = aliveSignature;
    }

    const view = this.election();
    const leaderChanged = view.leaderId !== this.lastLeaderView.leaderId;
    this.lastLeaderView = view;
    if (leaderChanged) {
      this.emit("leader:changed", view);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  self(): NodeState {
    return { ...this.selfState };
  }

  join(d: NodeDescriptor): void {
    if (d.nodeId === this.selfId) {
      throw new Error("ClusterMembership.join: cannot join self");
    }
    const now = this.now();
    const existing = this.nodeMap.get(d.nodeId);

    if (!existing) {
      const state: NodeState = {
        descriptor: d,
        health: "alive",
        incarnation: 0,
        lastSeenAt: now,
        load: 0,
        liveWorkers: 0,
      };
      this.nodeMap.set(d.nodeId, state);
      this.emit("node:joined", { ...state });
      this.refreshLeader();
      return;
    }

    const wasDown = existing.health === "suspect" || existing.health === "dead" || existing.health === "left";
    existing.descriptor = d;
    existing.lastSeenAt = now;
    if (wasDown) {
      existing.incarnation += 1;
      existing.health = "alive";
      existing.suspectSince = undefined;
      this.emit("node:recovered", { ...existing });
      this.refreshLeader();
    }
  }

  apply(d: GossipDigest): GossipApplyResult {
    const now = this.now();

    if (
      !d ||
      typeof d !== "object" ||
      !Array.isArray(d.entries) ||
      typeof d.checksum !== "string" ||
      typeof d.sentAt !== "number" ||
      !Number.isFinite(d.sentAt) ||
      typeof d.senderId !== "string"
    ) {
      return { applied: 0, rejected: [{ nodeId: "", reason: "malformed" }], changes: [] };
    }

    const expectedChecksum = digestChecksum(d.entries);
    if (expectedChecksum !== d.checksum) {
      return {
        applied: 0,
        rejected: d.entries.map((e) => ({ nodeId: safeEntryNodeId(e), reason: "malformed" as const })),
        changes: [],
      };
    }

    if (Math.abs(now - d.sentAt) > this.maxClockSkewMs) {
      return {
        applied: 0,
        rejected: d.entries.map((e) => ({ nodeId: safeEntryNodeId(e), reason: "clock-skew" as const })),
        changes: [],
      };
    }

    // Receiving any well-formed, non-skewed digest is itself proof of life
    // for the sender: refresh its liveness clock regardless of whether any
    // individual entry carries new information. This is what lets routine
    // "nothing changed" anti-entropy rounds keep an already-alive peer from
    // drifting into suspicion — reviving a suspect/dead node still strictly
    // requires a higher incarnation, so this can never be used to bypass
    // the incarnation rules, only to keep an already-alive peer fresh. The
    // maxClockSkewMs check above already bounds how stale a replayed digest
    // may be before this freshness bump is even reachable.
    if (d.senderId !== this.selfId) {
      const sender = this.nodeMap.get(d.senderId);
      if (sender && sender.health === "alive") {
        sender.lastSeenAt = now;
      }
    }

    const rejected: GossipApplyResult["rejected"] = [];
    const changes: MembershipChange[] = [];
    let applied = 0;

    const entries = d.entries.slice(0, this.maxDigestEntries);

    for (const raw of entries) {
      if (!isValidEntryShape(raw)) {
        rejected.push({ nodeId: safeEntryNodeId(raw), reason: "malformed" });
        continue;
      }
      const entry = raw;

      if (entry.descriptor && entry.descriptor.nodeId !== entry.nodeId) {
        rejected.push({ nodeId: entry.nodeId, reason: "malformed" });
        continue;
      }

      if (entry.nodeId === this.selfId) {
        if (entry.health === "suspect" || entry.health === "dead") {
          rejected.push({ nodeId: entry.nodeId, reason: "self-downgrade" });
          if (this.selfState.health === "alive") {
            this.applyRefute(now);
          }
        }
        // A non-downgrade claim about self (alive/left) is never applied —
        // self state is only ever mutated locally (join/refute/leave). Not
        // an error, just a silent no-op so idempotent replay stays clean.
        continue;
      }

      const stored = this.nodeMap.get(entry.nodeId);

      if (!stored) {
        if (!entry.descriptor) {
          rejected.push({ nodeId: entry.nodeId, reason: "unknown-node" });
          continue;
        }
        const state: NodeState = {
          descriptor: entry.descriptor,
          health: entry.health,
          incarnation: entry.incarnation,
          lastSeenAt: now,
          load: entry.load,
          liveWorkers: entry.liveWorkers,
        };
        if (entry.health === "suspect") state.suspectSince = now;
        this.nodeMap.set(entry.nodeId, state);
        applied += 1;
        this.emit("node:joined", { ...state });
        continue;
      }

      if (entry.descriptor && entry.descriptor.publicKeyHex !== stored.descriptor.publicKeyHex) {
        rejected.push({ nodeId: entry.nodeId, reason: "identity-mismatch" });
        continue;
      }

      const cmp = compareEntry(entry.incarnation, entry.health, stored.incarnation, stored.health);
      if (cmp < 0) {
        rejected.push({ nodeId: entry.nodeId, reason: "stale-incarnation" });
        continue;
      }
      if (cmp === 0) {
        // Exact duplicate fact — true no-op. Never refreshes lastSeenAt:
        // a byte-identical replay must never be able to extend liveness.
        continue;
      }

      const prevHealth = stored.health;
      stored.incarnation = entry.incarnation;
      stored.health = entry.health;
      stored.lastSeenAt = now;
      stored.load = entry.load;
      stored.liveWorkers = entry.liveWorkers;
      if (entry.descriptor) stored.descriptor = entry.descriptor;
      stored.suspectSince = entry.health === "suspect" ? (prevHealth === "suspect" ? stored.suspectSince : now) : undefined;
      applied += 1;

      if (prevHealth !== entry.health) {
        const change: MembershipChange = { nodeId: entry.nodeId, from: prevHealth, to: entry.health, at: now };
        changes.push(change);
        this.emitHealthEvent(change, stored);
      }
    }

    if (changes.length > 0) {
      this.refreshLeader();
    }

    return { applied, rejected, changes };
  }

  digest(): GossipDigest {
    const now = this.now();
    const all = Array.from(this.nodeMap.values());

    const prioritized = [...all].sort((a, b) => {
      if (a.descriptor.nodeId === this.selfId) return -1;
      if (b.descriptor.nodeId === this.selfId) return 1;
      const rank = HEALTH_RANK[b.health] - HEALTH_RANK[a.health];
      if (rank !== 0) return rank;
      return a.descriptor.nodeId.localeCompare(b.descriptor.nodeId);
    });

    const capped = prioritized.slice(0, this.maxDigestEntries);
    const entries: GossipEntry[] = capped.map((s) => ({
      nodeId: s.descriptor.nodeId,
      incarnation: s.incarnation,
      health: s.health,
      descriptor: s.descriptor,
      load: s.load,
      liveWorkers: s.liveWorkers,
    }));

    return {
      senderId: this.selfId,
      sentAt: now,
      epoch: this.epoch,
      entries,
      checksum: digestChecksum(entries),
    };
  }

  tick(nowArg?: number): MembershipChange[] {
    const now = nowArg ?? this.now();
    const changes: MembershipChange[] = [];

    for (const state of this.nodeMap.values()) {
      if (state.descriptor.nodeId === this.selfId) continue;
      if (state.health === "dead" || state.health === "left") continue;

      const elapsed = now - state.lastSeenAt;
      let cur = state.health;

      if (cur === "alive" && elapsed > this.suspectAfterMs) {
        const change: MembershipChange = { nodeId: state.descriptor.nodeId, from: "alive", to: "suspect", at: now };
        state.health = "suspect";
        state.suspectSince = now;
        changes.push(change);
        this.emitHealthEvent(change, state);
        cur = "suspect";
      }

      if (cur === "suspect" && elapsed > this.deadAfterMs) {
        const change: MembershipChange = { nodeId: state.descriptor.nodeId, from: "suspect", to: "dead", at: now };
        state.health = "dead";
        changes.push(change);
        this.emitHealthEvent(change, state);
      }
    }

    if (changes.length > 0) {
      this.refreshLeader();
    }

    return changes;
  }

  markLocalLoad(load: number, liveWorkers: number): void {
    const s = this.selfState;
    s.load = load;
    s.liveWorkers = liveWorkers;
    s.lastSeenAt = this.now();
  }

  nodes(): NodeState[] {
    return Array.from(this.nodeMap.values())
      .map((s) => ({ ...s }))
      .sort((a, b) => a.descriptor.nodeId.localeCompare(b.descriptor.nodeId));
  }

  alive(): NodeState[] {
    return this.nodes().filter((n) => n.health === "alive");
  }

  get(nodeId: string): NodeState | undefined {
    const s = this.nodeMap.get(nodeId);
    return s ? { ...s } : undefined;
  }

  refute(): number {
    return this.applyRefute(this.now());
  }

  leave(): GossipDigest {
    const now = this.now();
    const s = this.selfState;
    if (s.health !== "left") {
      s.incarnation += 1;
      s.health = "left";
      s.lastSeenAt = now;
      s.suspectSince = undefined;
      this.emit("node:left", { ...s });
      this.refreshLeader();
    }
    return this.digest();
  }

  election(): LeaderView {
    return electLeader(Array.from(this.nodeMap.values()), {
      quorum: this.quorumPolicy,
      epoch: this.epoch,
      knownSize: this.nodeMap.size,
    });
  }

  isLeader(): boolean {
    return this.election().leaderId === this.selfId;
  }
}
