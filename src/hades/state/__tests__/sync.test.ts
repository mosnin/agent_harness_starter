import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkspaceStore } from "../store";
import { recordHash, type ActorId, type WorkspaceRecord } from "../record";
import { InMemoryMirror, SyncEngine, SyncMirrorError, type ConflictPolicy, type SyncConflict } from "../sync";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-sync-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkStore(actor: ActorId, extra: Partial<{ now: () => number; fsync: boolean; root: string }> = {}) {
  return new WorkspaceStore({ root: extra.root ?? root, actor, fsync: extra.fsync ?? false, now: extra.now });
}

function clockNow(startMs = 1_700_000_000_000) {
  let t = startMs;
  return () => (t += 1);
}

function byKey(records: WorkspaceRecord[]): Map<string, WorkspaceRecord> {
  return new Map(records.map((r) => [`${r.domain}/${r.key}`, r]));
}

/** Sorts + strips nothing — used to compare two record sets for byte-identical convergence. */
function normalize(records: WorkspaceRecord[]): unknown {
  return [...records]
    .sort((a, b) => (a.domain + a.key < b.domain + b.key ? -1 : 1))
    .map((r) => ({ domain: r.domain, key: r.key, rev: r.rev, clock: r.clock, updatedAt: r.updatedAt, actor: r.actor, deleted: r.deleted, hash: r.hash, value: r.value }));
}

// ===========================================================================
// InMemoryMirror basics
// ===========================================================================

describe("InMemoryMirror", () => {
  it("stage() creates a live record and adds it to both snapshot() and drain()", () => {
    const mirror = new InMemoryMirror();
    const r = mirror.stage("memory", "note", { text: "hi" });
    expect(r.deleted).toBe(false);
    expect(r.value).toEqual({ text: "hi" });
    expect(mirror.snapshot().map((x) => x.key)).toEqual(["note"]);

    const drained = mirror.drain();
    expect(drained.map((x) => x.key)).toEqual(["note"]);
    // draining clears the staged queue but the record remains in the logical view
    expect(mirror.snapshot().map((x) => x.key)).toEqual(["note"]);
    expect(mirror.drain()).toEqual([]); // already drained
  });

  it("remove() creates a tombstone that stage()d records never resurrect on their own", () => {
    const mirror = new InMemoryMirror();
    mirror.stage("memory", "note", "v1");
    mirror.drain();
    const tomb = mirror.remove("memory", "note");
    expect(tomb.deleted).toBe(true);
    expect(tomb.value).toBeNull();
    expect(tomb.hash).toBe("");
    expect(mirror.snapshot().find((r) => r.key === "note")!.deleted).toBe(true);
  });

  it("apply() reconciles incoming records against the current REAL (non-draft) view via real vector-clock merge, never letting a stale incoming record clobber a dominant one", () => {
    const mirror = new InMemoryMirror();
    // Seed a "real" (already-synced, non-draft-actor) record directly, then
    // confirm a causally-STALE incoming record can't clobber it.
    const current: WorkspaceRecord = {
      domain: "memory",
      key: "k",
      rev: 2,
      clock: { "cli:alice": 2 },
      updatedAt: 5000,
      actor: "cli:alice",
      deleted: false,
      value: "current-value",
      hash: "a".repeat(64),
    };
    mirror.apply([current]);
    expect(mirror.snapshot().find((r) => r.key === "k")!.value).toBe("current-value");

    const stale: WorkspaceRecord = {
      domain: "memory",
      key: "k",
      rev: 1,
      clock: { "cli:alice": 1 }, // strictly dominated by current's clock
      updatedAt: 9999, // a later timestamp does not matter — clock domination decides first
      actor: "cli:alice",
      deleted: false,
      value: "stale-remote",
      hash: "b".repeat(64), // isWorkspaceRecord only checks hash FORMAT, not hash-vs-value correctness
    };
    mirror.apply([stale]);
    expect(mirror.snapshot().find((r) => r.key === "k")!.value).toBe("current-value");
  });

  it("apply() always lets a properly-attributed incoming record supersede an unconfirmed local draft (protection against clobbering happens upstream, in SyncEngine's own diff)", () => {
    const mirror = new InMemoryMirror();
    mirror.stage("memory", "k", "local-draft");
    expect(mirror.snapshot().find((r) => r.key === "k")!.value).toBe("local-draft");

    const confirmed: WorkspaceRecord = {
      domain: "memory",
      key: "k",
      rev: 1,
      clock: { "cli:alice": 1 },
      updatedAt: 1,
      actor: "cli:alice",
      deleted: false,
      value: "confirmed-elsewhere",
      hash: "c".repeat(64),
    };
    mirror.apply([confirmed]);
    expect(mirror.snapshot().find((r) => r.key === "k")!.value).toBe("confirmed-elsewhere");
    // The draft's staged-ness is cleared too — a future drain() must not
    // try to push the now-superseded intent.
    expect(mirror.drain()).toEqual([]);
  });

  it("constructor rejects a structurally invalid seed record", () => {
    expect(() => new InMemoryMirror([{ nonsense: true } as unknown as WorkspaceRecord])).toThrow(RangeError);
  });

  it("stage() validates domain, key, and value strictly", () => {
    const mirror = new InMemoryMirror();
    expect(() => mirror.stage("not-a-domain" as never, "k", "v")).toThrow();
    expect(() => mirror.stage("memory", "bad/key", "v")).toThrow();
    expect(() => mirror.stage("memory", "k", Number.NaN as never)).toThrow();
  });
});

// ===========================================================================
// pull() / push() basics
// ===========================================================================

describe("pull()", () => {
  it("pulls everything the store has into an empty mirror", () => {
    const store = mkStore({ kind: "cli", id: "alice" }, { now: clockNow() });
    store.put("memory", "a", 1);
    store.put("config", "theme", "dark");

    const mirror = new InMemoryMirror();
    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" }, now: clockNow() });
    const report = engine.pull();

    expect(report.pulled.length).toBe(2);
    expect(report.pushed).toEqual([]);
    expect(mirror.snapshot().length).toBe(2);
    store.close();
  });

  it("pull() applied a store-side delete as a tombstone in the mirror, and it is reported in `deleted`", () => {
    const store = mkStore({ kind: "cli", id: "alice" });
    store.put("memory", "a", 1);
    store.delete("memory", "a");

    const mirror = new InMemoryMirror();
    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });
    const report = engine.pull();
    expect(report.deleted.length).toBe(1);
    expect(mirror.snapshot().find((r) => r.key === "a")!.deleted).toBe(true);
    store.close();
  });
});

describe("push()", () => {
  it("pushes a staged mirror edit into the store, properly attributed to the engine's real actor (not the mirror's internal placeholder)", () => {
    const store = mkStore({ kind: "cli", id: "alice" });
    const mirror = new InMemoryMirror();
    mirror.stage("memory", "note", "hello");

    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });
    const report = engine.push();

    expect(report.pushed.length).toBe(1);
    expect(report.pushed[0].actor).toBe("desktop:d1");
    expect(report.pushed[0].actor).not.toBe("draft:mirror");

    const stored = store.get("memory", "note");
    expect(stored).toBeDefined();
    expect(stored!.value).toBe("hello");
    expect(stored!.actor).toBe("desktop:d1");
    store.close();
  });

  it("pushing a delete removes the value from the store as a tombstone", () => {
    const store = mkStore({ kind: "cli", id: "alice" });
    store.put("memory", "note", "hello");

    const mirror = new InMemoryMirror(store.snapshot().records);
    mirror.remove("memory", "note");

    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });
    const report = engine.push();
    expect(report.deleted.length).toBe(1);
    expect(store.get("memory", "note")!.deleted).toBe(true);
    store.close();
  });

  it("a foreign record whose hash disagrees with its value is rejected at push, counted in `skipped`, and never reaches the store", () => {
    const store = mkStore({ kind: "cli", id: "alice" });
    const forged: WorkspaceRecord = {
      domain: "memory",
      key: "evil",
      rev: 1,
      clock: { "desktop:attacker": 1 },
      updatedAt: 100,
      actor: "desktop:attacker",
      deleted: false,
      value: "not what the hash says",
      hash: "0".repeat(64), // deliberately wrong
    };
    const mirror = new InMemoryMirror([forged]);
    // Seed via constructor puts it straight into `merged` but NOT `staged`;
    // stage a harmless edit too so push() has something to actually drain,
    // while the forged record is picked up via the push-candidate diff
    // (mirror has it, store does not => a push candidate regardless of the
    // staged/drain bookkeeping).
    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });
    const report = engine.push();

    expect(report.skipped).toBeGreaterThanOrEqual(1);
    expect(report.pushed.find((r) => r.key === "evil")).toBeUndefined();
    expect(store.get("memory", "evil")).toBeUndefined();
    store.close();
  });
});

// ===========================================================================
// Idempotence & plan() zero-writes
// ===========================================================================

describe("idempotence and plan()", () => {
  it("reconcile() run twice is a strict no-op the second time: pushed/pulled empty, no new journal entries, no mtimes change", () => {
    const store = mkStore({ kind: "cli", id: "alice" });
    store.put("memory", "a", 1);
    const mirror = new InMemoryMirror();
    mirror.stage("memory", "b", 2);
    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });

    const first = engine.reconcile();
    expect(first.pushed.length + first.pulled.length).toBeGreaterThan(0);

    const seqBefore = store.snapshot().journalSeq;
    const segmentPath = join(root, "domains", "memory.json");
    const mtimeBefore = statSync(segmentPath).mtimeMs;

    const second = engine.reconcile();
    expect(second.pushed).toEqual([]);
    expect(second.pulled).toEqual([]);
    expect(second.conflicts).toEqual([]);

    const seqAfter = store.snapshot().journalSeq;
    expect(seqAfter).toBe(seqBefore);
    expect(statSync(segmentPath).mtimeMs).toBe(mtimeBefore);
    store.close();
  });

  it("plan() writes nothing (journal seq + mtimes unchanged) yet returns the same conflicts reconcile() would", () => {
    const storeA = mkStore({ kind: "cli", id: "alice" }, { now: clockNow() });
    storeA.put("memory", "k", "store-value");
    storeA.close();

    const storeB = mkStore({ kind: "cli", id: "alice" }, { now: clockNow() });
    const mirror = new InMemoryMirror();
    // Force a genuine concurrent conflict: mirror has a DIFFERENT clock
    // entry for the same key that neither dominates nor is dominated by
    // the store's clock, by seeding directly with a hand-built concurrent
    // record (same rev basis, disjoint actor clock entry).
    const storeRecord = storeB.get("memory", "k")!;
    const concurrentBody = {
      domain: "memory" as const,
      key: "k",
      rev: 1,
      clock: { "desktop:other": 1 },
      updatedAt: storeRecord.updatedAt + 1000,
      actor: "desktop:other",
      deleted: false,
      value: "mirror-value",
    };
    // A REAL, correctly-computed hash — unlike the InMemoryMirror.apply()
    // tests above, this record needs to survive push()'s real
    // store.applyRemote() hash check later in this test, not just
    // isWorkspaceRecord's format check.
    const concurrent: WorkspaceRecord = { ...concurrentBody, hash: recordHash(concurrentBody) };
    mirror.apply([concurrent]);

    const segmentPath = join(root, "domains", "memory.json");
    const mtimeBefore = statSync(segmentPath).mtimeMs;
    const seqBefore = storeB.snapshot().journalSeq;

    const engine = new SyncEngine({ store: storeB, mirror, actor: { kind: "desktop", id: "d1" } });
    const planned = engine.plan();
    expect(planned.conflicts.length).toBe(1);

    expect(statSync(segmentPath).mtimeMs).toBe(mtimeBefore);
    expect(storeB.snapshot().journalSeq).toBe(seqBefore);

    const reconciled = engine.reconcile();
    expect(reconciled.conflicts.length).toBe(planned.conflicts.length);
    expect(reconciled.conflicts[0].resolution).toBe(planned.conflicts[0].resolution);
    storeB.close();
  });
});

// ===========================================================================
// Delete-vs-edit conflicts, tombstone stability, and manual deferral
// ===========================================================================

function makeConcurrentDeleteVsEditFixture(policy: ConflictPolicy) {
  const storeRoot = mkdtempSync(join(tmpdir(), "hades-sync-fixture-"));
  const store = mkStore({ kind: "cli", id: "alice" }, { root: storeRoot, now: clockNow() });
  const base = store.put("memory", "k", "base");

  // Simulate two actors who both observed `base` and then diverged:
  // actor A deletes (in the store), actor B edits (staged in the mirror),
  // with clocks that are genuinely concurrent (each has an entry the other
  // lacks) rather than one dominating the other.
  store.delete("memory", "k"); // store side: tombstone, clock now {cli:alice: 2}

  const mirror = new InMemoryMirror([base]); // mirror starts from the SAME base as the store did
  mirror.stage("memory", "k", "concurrent-edit"); // mirror side: live edit, clock {cli:alice:1, draft:mirror:1} -> materialized to {cli:alice:1, desktop:d1:1}

  const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" }, policy });
  return { store, mirror, engine, storeRoot };
}

describe("delete-vs-edit conflicts are deterministic and never resurrect a tombstone", () => {
  const policies: ConflictPolicy[] = ["last-writer-wins", "prefer-local", "prefer-remote"];

  for (const policy of policies) {
    it(`policy "${policy}": the tombstone wins and is never resurrected`, () => {
      const { store, engine, storeRoot } = makeConcurrentDeleteVsEditFixture(policy);
      const report = engine.reconcile();

      expect(store.get("memory", "k")!.deleted).toBe(true); // never resurrected in the store
      expect(report.conflicts.length).toBeGreaterThanOrEqual(1);
      const c = report.conflicts.find((x) => x.key === "k")!;
      expect(c.resolution).toBe(c.remote.deleted ? "remote" : "local"); // whichever side IS the tombstone
      store.close();
      rmSync(storeRoot, { recursive: true, force: true });
    });
  }

  it('policy "manual" without a resolver defers instead of guessing, and the SAME conflict is still present on the next call (no silent drop)', () => {
    const { store, engine, storeRoot } = makeConcurrentDeleteVsEditFixture("manual");

    const first = engine.plan();
    expect(first.conflicts.length).toBe(1);
    expect(first.conflicts[0].resolution).toBe("deferred");

    // Nothing applied to either side.
    expect(store.get("memory", "k")!.deleted).toBe(true);

    const second = engine.plan();
    expect(second.conflicts.length).toBe(1);
    expect(second.conflicts[0].resolution).toBe("deferred");
    expect(second.conflicts[0].key).toBe(first.conflicts[0].key);

    // reconcile() under manual policy with no resolver must not silently
    // apply anything either.
    const rep = engine.reconcile();
    expect(rep.pushed.find((r) => r.key === "k")).toBeUndefined();
    expect(rep.pulled.find((r) => r.key === "k")).toBeUndefined();
    expect(store.get("memory", "k")!.deleted).toBe(true);

    store.close();
    rmSync(storeRoot, { recursive: true, force: true });
  });

  it("a resolver can still explicitly choose to defer, and gets consulted even under a non-manual policy", () => {
    const { engine, store, storeRoot } = (() => {
      const storeRoot2 = mkdtempSync(join(tmpdir(), "hades-sync-fixture2-"));
      const store2 = mkStore({ kind: "cli", id: "alice" }, { root: storeRoot2, now: clockNow() });
      const base = store2.put("memory", "k", "base");
      store2.delete("memory", "k");
      const mirror2 = new InMemoryMirror([base]);
      mirror2.stage("memory", "k", "concurrent-edit");
      const seen: SyncConflict[] = [] as unknown as SyncConflict[];
      void seen;
      const engine2 = new SyncEngine({
        store: store2,
        mirror: mirror2,
        actor: { kind: "desktop", id: "d1" },
        policy: "last-writer-wins",
        resolver: () => "defer",
      });
      return { engine: engine2, store: store2, storeRoot: storeRoot2 };
    })();

    const report = engine.plan();
    expect(report.conflicts[0].resolution).toBe("deferred");
    expect(store.get("memory", "k")!.deleted).toBe(true);
    store.close();
    rmSync(storeRoot, { recursive: true, force: true });
  });
});

// ===========================================================================
// Mirror failure containment
// ===========================================================================

describe("mirror failure containment", () => {
  it("a mirror whose snapshot() throws is contained: SyncEngine surfaces a SyncMirrorError and the store stays consistent (no writes attempted)", () => {
    const store = mkStore({ kind: "cli", id: "alice" });
    store.put("memory", "a", 1);
    const seqBefore = store.snapshot().journalSeq;

    const brokenMirror = {
      snapshot(): WorkspaceRecord[] {
        throw new Error("disk exploded");
      },
      apply(): void {
        throw new Error("should never be called");
      },
      drain(): WorkspaceRecord[] {
        throw new Error("should never be called");
      },
    };

    const engine = new SyncEngine({ store, mirror: brokenMirror, actor: { kind: "desktop", id: "d1" } });
    expect(() => engine.pull()).toThrow(SyncMirrorError);
    expect(() => engine.push()).toThrow(SyncMirrorError);
    expect(() => engine.plan()).toThrow(SyncMirrorError);

    expect(store.snapshot().journalSeq).toBe(seqBefore); // no writes happened
    store.close();
  });
});

// ===========================================================================
// Convergence under different interleavings
// ===========================================================================

function twoEngineFixture() {
  const storeRoot = mkdtempSync(join(tmpdir(), "hades-sync-conv-"));
  const clock = clockNow();
  const storeA = mkStore({ kind: "cli", id: "alice" }, { root: storeRoot, now: clock });
  const storeB = mkStore({ kind: "desktop", id: "bob" }, { root: storeRoot, now: clock });

  const mirrorA = new InMemoryMirror();
  const mirrorB = new InMemoryMirror();
  const engineA = new SyncEngine({ store: storeA, mirror: mirrorA, actor: { kind: "cli", id: "alice" }, now: clock });
  const engineB = new SyncEngine({ store: storeB, mirror: mirrorB, actor: { kind: "desktop", id: "bob" }, now: clock });

  return { storeRoot, storeA, storeB, mirrorA, mirrorB, engineA, engineB };
}

describe("convergence across interleavings", () => {
  const interleavings: Array<(a: () => void, b: () => void) => void> = [
    (a, b) => {
      a();
      b();
    },
    (a, b) => {
      b();
      a();
    },
    (a, b) => {
      a();
      a();
      b();
      b();
    },
  ];

  interleavings.forEach((run, idx) => {
    it(`interleaving #${idx + 1}: two SyncEngines with different actors over the same store converge to byte-identical snapshots`, () => {
      const { storeA, storeB, mirrorA, mirrorB, engineA, engineB, storeRoot } = twoEngineFixture();

      mirrorA.stage("memory", "alice-note", "from alice");
      mirrorB.stage("memory", "bob-note", "from bob");

      run(
        () => engineA.reconcile(),
        () => engineB.reconcile(),
      );
      // A second full round ensures both sides have seen everything even if
      // the first interleaving only pushed one direction before the other
      // read.
      engineA.reconcile();
      engineB.reconcile();
      engineA.reconcile();
      engineB.reconcile();

      const finalStore = normalize(storeA.snapshot().records);
      expect(normalize(storeB.snapshot().records)).toEqual(finalStore);
      expect(normalize(mirrorA.snapshot())).toEqual(finalStore);
      expect(normalize(mirrorB.snapshot())).toEqual(finalStore);

      const keys = storeA.snapshot().records.map((r) => r.key).sort();
      expect(keys).toEqual(["alice-note", "bob-note"]);

      storeA.close();
      storeB.close();
      rmSync(storeRoot, { recursive: true, force: true });
    });
  });

  it("concurrent edits to the SAME key from two actors converge deterministically (last-writer-wins by default)", () => {
    const { storeA, storeB, mirrorA, mirrorB, engineA, engineB, storeRoot } = twoEngineFixture();

    mirrorA.stage("config", "shared", "alice-wins-if-later");
    mirrorB.stage("config", "shared", "bob-wins-if-later");

    engineA.push();
    engineB.push(); // this push races against A's write via applyRemote's own conflict detection
    engineA.pull();
    engineB.pull();
    engineA.reconcile();
    engineB.reconcile();

    const finalA = normalize(storeA.snapshot().records);
    expect(normalize(storeB.snapshot().records)).toEqual(finalA);
    expect(normalize(mirrorA.snapshot())).toEqual(finalA);
    expect(normalize(mirrorB.snapshot())).toEqual(finalA);

    storeA.close();
    storeB.close();
    rmSync(storeRoot, { recursive: true, force: true });
  });
});

// ===========================================================================
// Performance sanity (bound, not a benchmark)
// ===========================================================================

describe("performance sanity", () => {
  it("pull() over 10k records completes within a generous linear-time bound (not a benchmark — a bound)", () => {
    const store = mkStore({ kind: "cli", id: "alice" }, { fsync: false });
    const N = 10_000;
    const CHUNK = 200;
    for (let i = 0; i < N / CHUNK; i++) {
      store.putMany(
        Array.from({ length: CHUNK }, (_, j) => ({
          domain: "memory" as const,
          key: `k${i * CHUNK + j}`,
          value: i * CHUNK + j,
        })),
      );
    }

    const mirror = new InMemoryMirror();
    const engine = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });

    const startedAt = Date.now();
    const report = engine.pull();
    const elapsedMs = Date.now() - startedAt;

    expect(report.pulled.length).toBe(N);
    // Generous bound: real, measured wall-clock time must stay well under a
    // quadratic blowup. This is a sanity bound, not a performance claim.
    expect(elapsedMs).toBeLessThan(10_000);
    store.close();
  }, 30_000);
});
