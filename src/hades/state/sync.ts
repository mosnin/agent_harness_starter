/**
 * `SyncEngine` — a real bidirectional merge engine reconciling an
 * in-memory `WorkspaceMirror` with a durable `WorkspaceStore`, with honest
 * conflict reporting instead of silent last-write-wins guessing (unless
 * that IS the policy the caller asked for).
 *
 * ## The comparison primitive
 *
 * Every operation (`pull`, `push`, `reconcile`, `plan`) is built from the
 * SAME read-only diff: `mirror.snapshot()` is compared key-by-key against
 * every record currently in the store's configured domains, using Team 1's
 * `mergeRecords` — the real vector-clock join, not a re-implementation.
 * `mergeRecords`'s `reason` classifies each key:
 *
 *  - `"identical"` — nothing to do.
 *  - `"local-newer"` — the mirror's record causally dominates the store's;
 *    a push candidate.
 *  - `"remote-newer"` — the store's record causally dominates the mirror's;
 *    a pull candidate.
 *  - `"concurrent-tiebreak"` — genuine concurrency (or, defensively, equal
 *    clocks with divergent content). This is the only case actually
 *    reported as a {@link SyncConflict}; it is resolved via `resolver` (if
 *    supplied) or `policy`, never silently.
 *
 * Because `plan()` runs exactly this comparison without calling
 * `store.applyRemote`, `mirror.apply`, or `mirror.drain`, it is guaranteed
 * to report the same conflicts `push()`/`pull()`/`reconcile()` would, with
 * zero writes.
 *
 * ## Conflict policy
 *
 * `"last-writer-wins"` reproduces `mergeRecords`'s own deterministic
 * tie-break (tombstone beats a concurrent live edit, then higher
 * `updatedAt`, then greater `hash`, then greater `actor`) so the two stay
 * in lock-step. `"prefer-local"` / `"prefer-remote"` are explicit user
 * overrides for VALUE-vs-VALUE conflicts — but a delete is not a value, it
 * is an authoritative retraction: for any conflict where exactly one side
 * is a tombstone, the tombstone wins regardless of policy, so no built-in
 * policy can ever resurrect a delete by "preferring" the other side.
 * `"manual"` (or any conflict a `resolver` explicitly defers) always
 * resolves to `"deferred"` — neither side is touched, and the SAME
 * conflict is reported again on the next call until something actually
 * changes the underlying data (or a resolver decides).
 *
 * ## Mirror-authored records
 *
 * `InMemoryMirror.stage`/`remove` cannot know the caller's real
 * `ActorId` (the type only takes an optional seed), so drafts are stamped
 * with an internal placeholder actor (`"draft:mirror"`). Before a draft is
 * compared against the store or actually pushed, `SyncEngine` rewraps it
 * with the engine's REAL `actor` (dropping the placeholder's clock entry,
 * re-ticking under the real actor key) — otherwise two `SyncEngine`s with
 * different real actors syncing the same store would both stamp writes
 * with the identical placeholder actor key and corrupt each other's causal
 * history.
 */

import {
  actorKey,
  canonicalJson,
  isWorkspaceDomain,
  isWorkspaceRecord,
  mergeRecords,
  recordHash,
  tickClock,
  validateKey,
  WORKSPACE_DOMAINS,
  type ActorId,
  type ActorKey,
  type JsonValue,
  type WorkspaceDomain,
  type WorkspaceRecord,
} from "./record";
import type { WorkspaceStore } from "./store";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConflictPolicy = "last-writer-wins" | "prefer-local" | "prefer-remote" | "manual";

export interface SyncConflict {
  domain: WorkspaceDomain;
  key: string;
  local: WorkspaceRecord;
  remote: WorkspaceRecord;
  resolution: "local" | "remote" | "deferred";
  reason: string;
}

export interface SyncReport {
  pulled: WorkspaceRecord[];
  pushed: WorkspaceRecord[];
  conflicts: SyncConflict[];
  deleted: WorkspaceRecord[];
  skipped: number;
  at: number;
  durationMs: number;
}

export interface WorkspaceMirror {
  snapshot(): WorkspaceRecord[];
  apply(records: WorkspaceRecord[]): void;
  drain(): WorkspaceRecord[];
}

export class SyncMirrorError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SyncMirrorError";
  }
}

// ---------------------------------------------------------------------------
// InMemoryMirror
// ---------------------------------------------------------------------------

/**
 * The placeholder actor every `InMemoryMirror` draft is stamped with until
 * `SyncEngine.materialize` rewraps it under a real `ActorId`. It uses the
 * dedicated non-durable `"draft"` {@link ActorKind} (see `./record.ts`), so
 * it can never collide with a genuine writer's records, and `WorkspaceStore`
 * refuses to persist anything still carrying it.
 */
const DRAFT_ACTOR_KEY: ActorKey = "draft:mirror";

function mirrorKey(domain: WorkspaceDomain, key: string): string {
  return `${domain}/${key}`;
}

function byDomainThenKeyRecord(a: WorkspaceRecord, b: WorkspaceRecord): number {
  if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * A trivial, fully in-process `WorkspaceMirror`. `merged` is the mirror's
 * whole logical view (what `snapshot()` returns); `staged` tracks which
 * keys hold a LOCAL edit not yet handed to `push()` (what `drain()`
 * harvests and clears). `apply()` reconciles incoming (remote-origin)
 * records against whatever is already merged via the real `mergeRecords`,
 * so a pull can never silently clobber an uncommitted local edit that
 * causally dominates it.
 */
export class InMemoryMirror implements WorkspaceMirror {
  private readonly merged = new Map<string, WorkspaceRecord>();
  private readonly staged = new Set<string>();
  private draftTick = 0;

  constructor(seed: WorkspaceRecord[] = []) {
    for (const r of seed) {
      if (!isWorkspaceRecord(r)) {
        throw new RangeError("InMemoryMirror: seed contains a structurally invalid WorkspaceRecord");
      }
      this.merged.set(mirrorKey(r.domain, r.key), r);
    }
  }

  snapshot(): WorkspaceRecord[] {
    return [...this.merged.values()].sort(byDomainThenKeyRecord);
  }

  apply(records: WorkspaceRecord[]): void {
    for (const incoming of records) {
      if (!isWorkspaceRecord(incoming)) {
        throw new RangeError(
          `InMemoryMirror.apply: record for "${String((incoming as Partial<WorkspaceRecord>)?.domain)}/${String((incoming as Partial<WorkspaceRecord>)?.key)}" is not a structurally valid WorkspaceRecord`,
        );
      }
      const k = mirrorKey(incoming.domain, incoming.key);
      const existing = this.merged.get(k);
      if (!existing) {
        this.merged.set(k, incoming);
        continue;
      }
      if (existing.actor === DRAFT_ACTOR_KEY) {
        // `incoming` is, by construction, either the confirmed durable
        // record our own draft was just pushed as (SyncEngine.push() syncs
        // the mirror back after a successful write), or a store record the
        // caller's own diff already determined should win over this draft.
        // Either way a properly-attributed incoming record always
        // supersedes an unconfirmed placeholder-actor draft — comparing
        // their clocks directly would spuriously read as "concurrent"
        // (the draft's clock key never appears in the store's history) and
        // mint a bogus rewritten record neither side actually has.
        this.merged.set(k, incoming);
        this.staged.delete(k);
        continue;
      }
      const { winner } = mergeRecords(existing, incoming);
      this.merged.set(k, winner);
    }
  }

  drain(): WorkspaceRecord[] {
    const out: WorkspaceRecord[] = [];
    for (const k of this.staged) {
      const r = this.merged.get(k);
      if (r) out.push(r);
    }
    this.staged.clear();
    return out;
  }

  stage(domain: WorkspaceDomain, key: string, value: JsonValue): WorkspaceRecord {
    if (!isWorkspaceDomain(domain)) throw new RangeError(`InMemoryMirror.stage: invalid domain ${JSON.stringify(domain)}`);
    validateKey(key);
    canonicalJson(value); // throws on a non-strict JsonValue (NaN, -0, cycles, ...)

    const k = mirrorKey(domain, key);
    const prior = this.merged.get(k);
    const clock = tickClock(prior?.clock ?? {}, DRAFT_ACTOR_KEY);
    const rev = (prior?.rev ?? 0) + 1;
    const body: Omit<WorkspaceRecord, "hash"> = {
      domain,
      key,
      rev,
      clock,
      updatedAt: this.draftTick++,
      actor: DRAFT_ACTOR_KEY,
      deleted: false,
      value,
    };
    const record: WorkspaceRecord = { ...body, hash: recordHash(body) };
    this.merged.set(k, record);
    this.staged.add(k);
    return record;
  }

  remove(domain: WorkspaceDomain, key: string): WorkspaceRecord {
    if (!isWorkspaceDomain(domain)) throw new RangeError(`InMemoryMirror.remove: invalid domain ${JSON.stringify(domain)}`);
    validateKey(key);

    const k = mirrorKey(domain, key);
    const prior = this.merged.get(k);
    const clock = tickClock(prior?.clock ?? {}, DRAFT_ACTOR_KEY);
    const rev = (prior?.rev ?? 0) + 1;
    const record: WorkspaceRecord = {
      domain,
      key,
      rev,
      clock,
      updatedAt: this.draftTick++,
      actor: DRAFT_ACTOR_KEY,
      deleted: true,
      hash: "",
      value: null,
    };
    this.merged.set(k, record);
    this.staged.add(k);
    return record;
  }
}

// ---------------------------------------------------------------------------
// SyncEngine
// ---------------------------------------------------------------------------

export interface SyncEngineOptions {
  store: WorkspaceStore;
  mirror: WorkspaceMirror;
  actor: ActorId;
  policy?: ConflictPolicy;
  resolver?: (c: Omit<SyncConflict, "resolution" | "reason">) => "local" | "remote" | "defer";
  now?: () => number;
  domains?: WorkspaceDomain[];
}

function splitMirrorKey(k: string): [WorkspaceDomain, string] {
  const idx = k.indexOf("/");
  return [k.slice(0, idx) as WorkspaceDomain, k.slice(idx + 1)];
}

/**
 * Reproduces `mergeRecords`'s own deterministic tie-break priority
 * (tombstone > higher `updatedAt` > greater `hash` > greater `actor`) so
 * `"last-writer-wins"` policy resolution never diverges from what
 * `mergeRecords` would have picked on its own.
 */
function pickRecencyWinner(local: WorkspaceRecord, remote: WorkspaceRecord): "local" | "remote" {
  if (local.deleted !== remote.deleted) return local.deleted ? "local" : "remote";
  if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt ? "local" : "remote";
  if (local.hash !== remote.hash) return local.hash > remote.hash ? "local" : "remote";
  if (local.actor !== remote.actor) return local.actor > remote.actor ? "local" : "remote";
  return "local";
}

interface ComputedPlan {
  pushCandidates: WorkspaceRecord[];
  pullCandidates: WorkspaceRecord[];
  conflicts: SyncConflict[];
}

export class SyncEngine {
  private readonly store: WorkspaceStore;
  private readonly mirror: WorkspaceMirror;
  private readonly actor: ActorId;
  private readonly actorK: ActorKey;
  private readonly policy: ConflictPolicy;
  private readonly resolver: SyncEngineOptions["resolver"];
  private readonly nowFn: () => number;
  private readonly domains: WorkspaceDomain[];

  constructor(opts: SyncEngineOptions) {
    if (!opts || !opts.store) throw new RangeError("SyncEngineOptions.store is required");
    if (!opts.mirror) throw new RangeError("SyncEngineOptions.mirror is required");
    if (!opts.actor || typeof opts.actor.id !== "string" || opts.actor.id.length === 0) {
      throw new RangeError("SyncEngineOptions.actor must be a valid ActorId");
    }
    this.store = opts.store;
    this.mirror = opts.mirror;
    this.actor = opts.actor;
    this.actorK = actorKey(opts.actor);
    this.policy = opts.policy ?? "last-writer-wins";
    this.resolver = opts.resolver;
    this.nowFn = opts.now ?? Date.now;
    this.domains = opts.domains && opts.domains.length > 0 ? [...opts.domains] : [...WORKSPACE_DOMAINS];
  }

  private wrapMirrorError(op: string, err: unknown): SyncMirrorError {
    return new SyncMirrorError(`SyncEngine: mirror.${op}() failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }

  /** Rewraps a mirror-authored draft (placeholder `"draft:mirror"` actor) under this engine's real actor identity. Records not authored by the mirror's own draft mechanism pass through unchanged. */
  private materialize(r: WorkspaceRecord): WorkspaceRecord {
    if (r.actor !== DRAFT_ACTOR_KEY) return r;
    const baseClock: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.clock)) {
      if (k === DRAFT_ACTOR_KEY) continue;
      baseClock[k] = v;
    }
    const clock = tickClock(Object.freeze(baseClock), this.actorK);
    const body: Omit<WorkspaceRecord, "hash"> = {
      domain: r.domain,
      key: r.key,
      rev: r.rev,
      clock,
      updatedAt: this.nowFn(),
      actor: this.actorK,
      deleted: r.deleted,
      value: r.value,
    };
    return { ...body, hash: recordHash(body) };
  }

  private resolveConflict(c: { domain: WorkspaceDomain; key: string; local: WorkspaceRecord; remote: WorkspaceRecord }): {
    resolution: "local" | "remote" | "deferred";
    reason: string;
  } {
    if (this.resolver) {
      const r = this.resolver({ domain: c.domain, key: c.key, local: c.local, remote: c.remote });
      if (r === "defer") return { resolution: "deferred", reason: "resolver requested manual deferral" };
      return { resolution: r, reason: `resolver selected ${r} for ${c.domain}/${c.key}` };
    }
    if (this.policy === "manual") {
      return { resolution: "deferred", reason: "policy is 'manual' and no resolver was supplied — never guessed" };
    }
    if (c.local.deleted !== c.remote.deleted) {
      // A delete is an authoritative retraction, not a value to weigh
      // against another value — no built-in policy resurrects it.
      const winner = c.local.deleted ? "local" : "remote";
      return { resolution: winner, reason: "a tombstone never loses to a concurrent live edit, regardless of policy" };
    }
    if (this.policy === "prefer-local") return { resolution: "local", reason: "policy 'prefer-local'" };
    if (this.policy === "prefer-remote") return { resolution: "remote", reason: "policy 'prefer-remote'" };
    const w = pickRecencyWinner(c.local, c.remote);
    return { resolution: w, reason: `policy 'last-writer-wins' tie-break selected ${w}` };
  }

  private computePlan(): ComputedPlan {
    let mirrorRecords: WorkspaceRecord[];
    try {
      mirrorRecords = this.mirror.snapshot();
    } catch (err) {
      throw this.wrapMirrorError("snapshot", err);
    }

    const domainSet = new Set<WorkspaceDomain>(this.domains);
    const mirrorByKey = new Map<string, WorkspaceRecord>();
    for (const r of mirrorRecords) {
      if (!domainSet.has(r.domain)) continue;
      mirrorByKey.set(mirrorKey(r.domain, r.key), this.materialize(r));
    }

    const storeByKey = new Map<string, WorkspaceRecord>();
    for (const domain of this.domains) {
      for (const r of this.store.list(domain, { includeDeleted: true })) {
        storeByKey.set(mirrorKey(domain, r.key), r);
      }
    }

    const allKeys = new Set<string>([...mirrorByKey.keys(), ...storeByKey.keys()]);
    const pushCandidates: WorkspaceRecord[] = [];
    const pullCandidates: WorkspaceRecord[] = [];
    const conflicts: SyncConflict[] = [];

    for (const k of allKeys) {
      const local = mirrorByKey.get(k);
      const remote = storeByKey.get(k);
      if (local && !remote) {
        pushCandidates.push(local);
        continue;
      }
      if (!local && remote) {
        pullCandidates.push(remote);
        continue;
      }
      if (!local || !remote) continue; // unreachable — allKeys only contains keys present in at least one map

      const { reason } = mergeRecords(local, remote);
      if (reason === "identical") continue;
      if (reason === "local-newer") {
        pushCandidates.push(local);
        continue;
      }
      if (reason === "remote-newer") {
        pullCandidates.push(remote);
        continue;
      }

      const [domain, key] = splitMirrorKey(k);
      const { resolution, reason: rr } = this.resolveConflict({ domain, key, local, remote });
      conflicts.push({ domain, key, local, remote, resolution, reason: rr });
      if (resolution === "local") pushCandidates.push(local);
      else if (resolution === "remote") pullCandidates.push(remote);
    }

    return { pushCandidates, pullCandidates, conflicts };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  plan(): SyncReport {
    const startedAt = this.nowFn();
    const { pushCandidates, pullCandidates, conflicts } = this.computePlan();
    const deleted = [...pushCandidates, ...pullCandidates].filter((r) => r.deleted);
    return {
      pulled: pullCandidates,
      pushed: pushCandidates,
      conflicts,
      deleted,
      skipped: 0,
      at: startedAt,
      durationMs: this.nowFn() - startedAt,
    };
  }

  pull(): SyncReport {
    const startedAt = this.nowFn();
    const { pullCandidates, conflicts } = this.computePlan();

    if (pullCandidates.length > 0) {
      try {
        this.mirror.apply(pullCandidates);
      } catch (err) {
        throw this.wrapMirrorError("apply", err);
      }
    }

    const deleted = pullCandidates.filter((r) => r.deleted);
    return {
      pulled: pullCandidates,
      pushed: [],
      conflicts,
      deleted,
      skipped: 0,
      at: startedAt,
      durationMs: this.nowFn() - startedAt,
    };
  }

  push(): SyncReport {
    const startedAt = this.nowFn();
    const { pushCandidates, conflicts } = this.computePlan();

    // Fulfil the "mirror staged edits -> store" contract: let the mirror
    // clear its own dirty-bookkeeping now that we hold a consistent,
    // independently-computed view of what needs pushing (computePlan()
    // above already read a non-destructive snapshot). We deliberately do
    // NOT use drain()'s return value as our source of truth — that keeps
    // push() and plan() in agreement byte-for-byte.
    if (pushCandidates.length === 0) {
      try {
        this.mirror.drain();
      } catch (err) {
        throw this.wrapMirrorError("drain", err);
      }
      return { pulled: [], pushed: [], conflicts, deleted: [], skipped: 0, at: startedAt, durationMs: this.nowFn() - startedAt };
    }

    const result = this.store.applyRemote(pushCandidates);

    // The store write already committed at this point; any mirror failure
    // below is surfaced honestly rather than pretended away, but it can no
    // longer roll back the durable write (WorkspaceStore has no rollback).
    try {
      this.mirror.drain();
    } catch (err) {
      throw this.wrapMirrorError("drain", err);
    }
    if (result.applied.length > 0) {
      try {
        // Sync the mirror's own view back to what was ACTUALLY committed
        // (real actor, real clock, real hash) — never leave the mirror
        // holding the stale placeholder-actor draft that produced this
        // push, or the next comparison would spuriously see it as
        // diverging from the very record it just became.
        this.mirror.apply(result.applied);
      } catch (err) {
        throw this.wrapMirrorError("apply", err);
      }
    }

    const pushed = result.applied;
    const deleted = pushed.filter((r) => r.deleted);
    const skipped = result.rejected.length;

    // A policy-driven "resolution: local" push is, by definition, pushing a
    // record that does NOT causally dominate the store's current value —
    // applyRemote's own mergeRecords will therefore rediscover the exact
    // same concurrency we already resolved above and report it again. That
    // is expected, not a new race, so it is not double-reported. Only a
    // key applyRemote flags that computePlan() did NOT already know about
    // is a genuinely new race (another writer landed inside the lock
    // window between our read and this write) and gets surfaced as such.
    const alreadyKnown = new Set(conflicts.map((c) => mirrorKey(c.domain, c.key)));
    const raceConflicts: SyncConflict[] = result.conflicts
      .filter((c) => !alreadyKnown.has(mirrorKey(c.domain, c.key)))
      .map((c) => ({
        domain: c.domain,
        key: c.key,
        local: c.loser,
        remote: c.winner,
        resolution: "remote" as const,
        reason: `store.applyRemote resolved a concurrent race during push: ${c.reason}`,
      }));

    return {
      pulled: [],
      pushed,
      conflicts: [...conflicts, ...raceConflicts],
      deleted,
      skipped,
      at: startedAt,
      durationMs: this.nowFn() - startedAt,
    };
  }

  reconcile(): SyncReport {
    const startedAt = this.nowFn();
    const pushReport = this.push();
    const pullReport = this.pull();
    return {
      pulled: pullReport.pulled,
      pushed: pushReport.pushed,
      conflicts: [...pushReport.conflicts, ...pullReport.conflicts],
      deleted: [...pushReport.deleted, ...pullReport.deleted],
      skipped: pushReport.skipped + pullReport.skipped,
      at: startedAt,
      durationMs: this.nowFn() - startedAt,
    };
  }
}
