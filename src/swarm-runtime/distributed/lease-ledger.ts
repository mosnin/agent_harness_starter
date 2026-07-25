/**
 * @module swarm-runtime/distributed/lease-ledger
 *
 * The exactly-once safety net for a cross-node run. Two cooperating, pure
 * (clock-injected, no I/O) data structures:
 *
 *  - `LeaseLedger` — who owns a task right now, fenced by a strictly
 *    monotonic per-task token. A node that renews or re-reports must present
 *    the token it was granted; a stale token (because the task was already
 *    reassigned) can never renew, and a dead lease's slot reopens with a
 *    *fresh, higher* token so a resurrected node can never masquerade as the
 *    current owner.
 *
 *  - `VerifiedResultLedger` — the merge point where results reported by
 *    different nodes (possibly for the same task, possibly duplicated,
 *    possibly forged) become the single verified record. First write wins;
 *    disagreement is surfaced, never silently overwritten; stale-fenced
 *    zombie writes are refused outright; certificates are checked with real
 *    ed25519 verification when required.
 *
 * Both classes are pure logic over their injected clock / caller-supplied
 * timestamps — no timers, no network, no filesystem.
 */

import type { ConsensusSpec, VerificationReport, WorkerResult } from "../types";
import {
  certifiesOutput,
  verifyCertificate,
  type VerificationCertificate,
} from "../../hades/styx/certificate";

// ---------------------------------------------------------------------------
// LeaseLedger
// ---------------------------------------------------------------------------

/** A single-owner lease on a task, fenced by a strictly increasing token. */
export interface Lease {
  taskId: string;
  nodeId: string;
  /** Monotonically increasing per-task fencing token. Never reused. */
  fencing: number;
  /** Which attempt/dispatch of the task this lease represents. */
  attempt: number;
  grantedAt: number;
  expiresAt: number;
}

/**
 * Tracks the current lease holder for each task, plus a fencing counter per
 * task that only ever goes up — surviving grant/revoke/expire cycles so a
 * resurrected node can never present a token that looks current again.
 */
export class LeaseLedger {
  private readonly active = new Map<string, Lease>();
  private readonly fencingHighWater = new Map<string, number>();

  /**
   * The fencing token the *next* grant for `taskId` would receive, without
   * mutating any state. Safe to call repeatedly for a preview (e.g. so a
   * caller can hand out several ordinal tokens for concurrent replicas
   * before any of them are actually granted).
   */
  nextFencing(taskId: string): number {
    return (this.fencingHighWater.get(taskId) ?? 0) + 1;
  }

  /**
   * Grant a fresh lease. Always mints a fencing token strictly greater than
   * every token ever issued for this task, even if the previous lease was
   * revoked or expired — the counter never resets and never reuses a value.
   */
  grant(taskId: string, nodeId: string, attempt: number, now: number, ttlMs: number): Lease {
    if (ttlMs <= 0) throw new RangeError(`grant: ttlMs must be positive, got ${ttlMs}`);
    const fencing = this.nextFencing(taskId);
    this.fencingHighWater.set(taskId, fencing);
    const lease: Lease = { taskId, nodeId, fencing, attempt, grantedAt: now, expiresAt: now + ttlMs };
    this.active.set(taskId, lease);
    return lease;
  }

  /**
   * Renew an existing lease in place (same fencing token, later expiry).
   * Returns null — refusing the renewal — unless the caller is the *current*
   * owner presenting the *current* token before it expired: a non-owner, a
   * stale (superseded) fencing token, or an already-expired lease all fail
   * closed rather than silently extending someone else's slot.
   */
  renew(taskId: string, nodeId: string, fencing: number, now: number, ttlMs: number): Lease | null {
    if (ttlMs <= 0) throw new RangeError(`renew: ttlMs must be positive, got ${ttlMs}`);
    const current = this.active.get(taskId);
    if (!current) return null;
    if (current.nodeId !== nodeId) return null;
    if (current.fencing !== fencing) return null;
    if (now >= current.expiresAt) return null;
    const renewed: Lease = { ...current, expiresAt: now + ttlMs };
    this.active.set(taskId, renewed);
    return renewed;
  }

  /** Release a lease early (task finished, verified, or explicitly aborted). */
  revoke(taskId: string, reason: string): Lease | null {
    void reason; // kept for call-site clarity / future audit trail
    const current = this.active.get(taskId);
    if (!current) return null;
    this.active.delete(taskId);
    return current;
  }

  /**
   * Sweep every lease whose `expiresAt` has passed as of `now`, freeing the
   * task for reassignment. The fencing high-water mark is untouched, so the
   * next `grant` for that task still mints a strictly higher token.
   */
  expire(now: number): Lease[] {
    const expired: Lease[] = [];
    for (const [taskId, lease] of this.active) {
      if (now >= lease.expiresAt) {
        expired.push(lease);
        this.active.delete(taskId);
      }
    }
    return expired.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  /** The current lease holder for a task, if any (expired or not — call `expire` first to sweep). */
  owner(taskId: string): Lease | undefined {
    return this.active.get(taskId);
  }

  /** All currently-active leases, sorted deterministically by taskId. */
  all(): Lease[] {
    return [...this.active.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
  }
}

// ---------------------------------------------------------------------------
// VerifiedResultLedger
// ---------------------------------------------------------------------------

/** One node's report for one task, as federated across the cluster. */
export interface FederatedResultEntry {
  taskId: string;
  nodeId: string;
  fencing: number;
  result: WorkerResult;
  report: VerificationReport;
  certificate?: VerificationCertificate;
  /** Canonical text form of the output, used for certificate binding and
   * conflict comparison. If omitted, derived deterministically from `result.output`. */
  outputText?: string;
}

export type AcceptOutcome =
  | { accepted: true; first: boolean; quorumMet?: boolean }
  | {
      accepted: false;
      reason: "stale-fencing" | "duplicate" | "unverified" | "cert-invalid" | "conflict" | "unknown-task";
    };

interface TaskState {
  /** Highest fencing token that has ever been accepted for this task
   *  (single-owner mode only — see `accept` for why consensus mode skips this). */
  maxFencingAccepted: number;
  /** `${nodeId}#${fencing}` guard against exact resubmission. */
  acceptedKeys: Set<string>;
  /** Highest fencing this ledger has accepted *from this specific node*, used
   *  to catch a node regressing its own token even inside consensus mode. */
  lastFencingByNode: Map<string, number>;
  /** output signature -> distinct reporting nodeIds (accepted OR surfaced-as-conflict). */
  groups: Map<string, Set<string>>;
  /** signature this node's accepted entry carries, to catch self-contradiction. */
  nodeSignature: Map<string, string>;
  /** every entry that was actually accepted, in acceptance order. */
  entries: FederatedResultEntry[];
  verified: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    return out === undefined ? `"__undefined__"` : out;
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function deriveOutputText(e: FederatedResultEntry): string {
  return e.outputText ?? stableStringify(e.result.output);
}

function outputSignature(e: FederatedResultEntry): string {
  return deriveOutputText(e);
}

function isValidEntry(e: FederatedResultEntry): boolean {
  if (!e || typeof e !== "object") return false;
  if (typeof e.taskId !== "string" || e.taskId.length === 0) return false;
  if (typeof e.nodeId !== "string" || e.nodeId.length === 0) return false;
  if (typeof e.fencing !== "number" || !Number.isFinite(e.fencing) || e.fencing < 0) return false;
  if (!e.result || typeof e.result !== "object" || e.result.taskId !== e.taskId) return false;
  if (!e.report || typeof e.report !== "object" || e.report.taskId !== e.taskId) return false;
  return true;
}

/**
 * The federated, exactly-once merge point for verified results.
 *
 * Fencing semantics: in single-owner mode (no `consensus` configured on the
 * ledger) a task has exactly one legitimate writer at a time, so any entry
 * whose fencing token is lower than the highest ever accepted for that task
 * is refused as `stale-fencing` — this is the zombie-node guard. In
 * consensus/quorum mode multiple *concurrently valid* replicas legitimately
 * carry different fencing tokens (placement mints one ordinal token per
 * replica in the same round), so a global per-task floor would wrongly
 * reject a still-live low-numbered sibling; there the ledger instead guards
 * each node against regressing its *own* previously-accepted token.
 */
export class VerifiedResultLedger {
  private readonly requireCertificate: boolean;
  private readonly consensus?: ConsensusSpec;
  private readonly now: () => number;
  private readonly tasks = new Map<string, TaskState>();

  constructor(opts?: { requireCertificate?: boolean; consensus?: ConsensusSpec; now?: () => number }) {
    this.requireCertificate = opts?.requireCertificate ?? false;
    this.consensus = opts?.consensus;
    this.now = opts?.now ?? (() => Date.now());
  }

  private stateFor(taskId: string): TaskState {
    let s = this.tasks.get(taskId);
    if (!s) {
      s = {
        maxFencingAccepted: -Infinity,
        acceptedKeys: new Set(),
        lastFencingByNode: new Map(),
        groups: new Map(),
        nodeSignature: new Map(),
        entries: [],
        verified: false,
      };
      this.tasks.set(taskId, s);
    }
    return s;
  }

  async accept(e: FederatedResultEntry): Promise<AcceptOutcome> {
    if (!isValidEntry(e)) return { accepted: false, reason: "unknown-task" };

    if (e.report.verdict !== "accept") return { accepted: false, reason: "unverified" };

    if (this.requireCertificate) {
      if (!e.certificate) return { accepted: false, reason: "cert-invalid" };
      const sigOk = await verifyCertificate(e.certificate);
      if (!sigOk) return { accepted: false, reason: "cert-invalid" };
      const bound = await certifiesOutput(e.certificate, deriveOutputText(e));
      if (!bound) return { accepted: false, reason: "cert-invalid" };
    }

    const state = this.stateFor(e.taskId);
    const dupKey = `${e.nodeId}#${e.fencing}`;
    if (state.acceptedKeys.has(dupKey)) return { accepted: false, reason: "duplicate" };

    const inConsensusMode = this.consensus != null;

    if (!inConsensusMode) {
      if (e.fencing < state.maxFencingAccepted) return { accepted: false, reason: "stale-fencing" };
    } else {
      const priorFromNode = state.lastFencingByNode.get(e.nodeId);
      if (priorFromNode != null && e.fencing < priorFromNode) {
        return { accepted: false, reason: "stale-fencing" };
      }
    }

    const sig = outputSignature(e);
    const priorSigFromNode = state.nodeSignature.get(e.nodeId);
    if (priorSigFromNode != null && priorSigFromNode === sig) {
      // Same node, same content, different (renewed) fencing — idempotent.
      return { accepted: false, reason: "duplicate" };
    }
    if (priorSigFromNode != null && priorSigFromNode !== sig) {
      // The same node contradicting its own prior accepted submission.
      let group = state.groups.get(sig);
      if (!group) {
        group = new Set();
        state.groups.set(sig, group);
      }
      group.add(e.nodeId);
      return { accepted: false, reason: "conflict" };
    }

    const wasFirstEver = state.entries.length === 0;
    const hadAnyGroupBefore = state.groups.size > 0;
    const existedBefore = state.groups.has(sig);
    let group = state.groups.get(sig);
    if (!group) {
      group = new Set();
      state.groups.set(sig, group);
    }

    if (!inConsensusMode && hadAnyGroupBefore && !existedBefore) {
      // A genuinely different output for a task that already has an
      // accepted (first-write-wins) result: surface, never overwrite.
      group.add(e.nodeId);
      return { accepted: false, reason: "conflict" };
    }

    // Accepted.
    state.acceptedKeys.add(dupKey);
    state.nodeSignature.set(e.nodeId, sig);
    state.lastFencingByNode.set(e.nodeId, e.fencing);
    if (e.fencing > state.maxFencingAccepted || state.maxFencingAccepted === -Infinity) {
      state.maxFencingAccepted = e.fencing;
    }
    group.add(e.nodeId);
    state.entries.push(e);

    let quorumMet: boolean | undefined;
    if (inConsensusMode) {
      const spec = this.consensus as ConsensusSpec;
      const needed = Math.max(1, Math.ceil(spec.replicas * spec.quorum));
      quorumMet = group.size >= needed;
      if (quorumMet) state.verified = true;
    } else {
      state.verified = true;
    }

    return { accepted: true, first: wasFirstEver, quorumMet };
  }

  verifiedTaskIds(): string[] {
    return [...this.tasks.entries()]
      .filter(([, s]) => s.verified)
      .map(([taskId]) => taskId)
      .sort();
  }

  entriesFor(taskId: string): FederatedResultEntry[] {
    return [...(this.tasks.get(taskId)?.entries ?? [])];
  }

  conflicts(): Array<{ taskId: string; nodeIds: string[] }> {
    const out: Array<{ taskId: string; nodeIds: string[] }> = [];
    for (const [taskId, state] of this.tasks) {
      if (state.groups.size > 1) {
        const nodeIds = new Set<string>();
        for (const group of state.groups.values()) for (const n of group) nodeIds.add(n);
        out.push({ taskId, nodeIds: [...nodeIds].sort() });
      }
    }
    return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  /** Internal: flatten every accepted entry across all tasks, in a canonical
   *  (taskId, then fencing, then nodeId) order so replay-into-`accept` is
   *  well-defined regardless of the originating ledger's own insertion order. */
  private allAcceptedEntriesCanonical(): FederatedResultEntry[] {
    const all: FederatedResultEntry[] = [];
    for (const state of this.tasks.values()) all.push(...state.entries);
    return all.sort((a, b) => {
      if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
      if (a.fencing !== b.fencing) return a.fencing - b.fencing;
      return a.nodeId.localeCompare(b.nodeId);
    });
  }

  /**
   * Replay every entry `other` has accepted into `this` via `accept`.
   * Because entries are replayed in a canonical (taskId, fencing, nodeId)
   * order rather than `other`'s insertion order, and because `accept` is
   * idempotent on duplicates, repeated/out-of-order merges of the same
   * underlying entry set converge to the same final state — see the
   * commutativity/associativity/idempotency property test.
   */
  async merge(other: VerifiedResultLedger): Promise<{ added: number; rejected: number }> {
    let added = 0;
    let rejected = 0;
    for (const entry of other.allAcceptedEntriesCanonical()) {
      const outcome = await this.accept(entry);
      if (outcome.accepted) added++;
      else rejected++;
    }
    return { added, rejected };
  }

  snapshot(): unknown {
    const taskIds = [...this.tasks.keys()].sort();
    return {
      requireCertificate: this.requireCertificate,
      consensus: this.consensus ?? null,
      tasks: taskIds.map((taskId) => {
        const s = this.tasks.get(taskId) as TaskState;
        return {
          taskId,
          maxFencingAccepted: s.maxFencingAccepted,
          verified: s.verified,
          acceptedKeys: [...s.acceptedKeys].sort(),
          lastFencingByNode: [...s.lastFencingByNode.entries()].sort((a, b) => a[0].localeCompare(b[0])),
          nodeSignature: [...s.nodeSignature.entries()].sort((a, b) => a[0].localeCompare(b[0])),
          groups: [...s.groups.entries()]
            .map(([sig, nodes]) => [sig, [...nodes].sort()] as [string, string[]])
            .sort((a, b) => a[0].localeCompare(b[0])),
          entries: [...s.entries].sort((a, b) => a.fencing - b.fencing || a.nodeId.localeCompare(b.nodeId)),
        };
      }),
    };
  }

  static fromSnapshot(
    snap: unknown,
    opts?: { now?: () => number },
  ): VerifiedResultLedger {
    const raw = snap as {
      requireCertificate: boolean;
      consensus: ConsensusSpec | null;
      tasks: Array<{
        taskId: string;
        maxFencingAccepted: number;
        verified: boolean;
        acceptedKeys: string[];
        lastFencingByNode: Array<[string, number]>;
        nodeSignature: Array<[string, string]>;
        groups: Array<[string, string[]]>;
        entries: FederatedResultEntry[];
      }>;
    };
    const ledger = new VerifiedResultLedger({
      requireCertificate: raw.requireCertificate,
      consensus: raw.consensus ?? undefined,
      now: opts?.now,
    });
    for (const t of raw.tasks) {
      const state: TaskState = {
        maxFencingAccepted: t.maxFencingAccepted,
        verified: t.verified,
        acceptedKeys: new Set(t.acceptedKeys),
        lastFencingByNode: new Map(t.lastFencingByNode),
        nodeSignature: new Map(t.nodeSignature),
        groups: new Map(t.groups.map(([sig, nodes]) => [sig, new Set(nodes)])),
        entries: [...t.entries],
      };
      ledger.tasks.set(t.taskId, state);
    }
    return ledger;
  }
}
