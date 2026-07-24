import { describe, it, expect } from "vitest";
import {
  ATTRIBUTION_STATE_VERSION,
  WorkerAttributionRegistry,
  resolveBackendForTask,
  type AttributionState,
  type AttributionStore,
} from "../worker-attribution";
import type { WorkerTask } from "../../../swarm-runtime/types";

// ===========================================================================
// Fixtures
// ===========================================================================

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

/** In-memory fake store — real async round-trip, no filesystem. */
class MemoryStore implements AttributionStore {
  public saved: AttributionState[] = [];
  public failNextSave = false;
  public failLoad = false;
  private data: unknown = undefined;

  async save(s: AttributionState): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("disk full");
    }
    this.saved.push(s);
    // Deep-copy on write, like a real serialized store would.
    this.data = JSON.parse(JSON.stringify(s));
  }

  async load(): Promise<unknown> {
    if (this.failLoad) throw new Error("read error");
    return this.data;
  }

  /** Test helper: inject arbitrary (possibly malformed) raw data as if written externally. */
  setRaw(raw: unknown): void {
    this.data = raw;
  }
}

let taskCounter = 0;
function task(overrides: Partial<WorkerTask> = {}): WorkerTask {
  taskCounter += 1;
  return {
    id: overrides.id ?? `task-${taskCounter}`,
    goalId: "goal-1",
    description: "do the thing",
    requiredCapabilities: [],
    input: {},
    dependsOn: [],
    priority: 0,
    status: "dispatched",
    attempts: 0,
    maxAttempts: 3,
    createdAt: 0,
    ...overrides,
  };
}

// ===========================================================================
// record / lookup / release / ids
// ===========================================================================

describe("WorkerAttributionRegistry — basic record/lookup/release", () => {
  it("records and looks up a backend for a worker id", () => {
    const clock = makeClock(1000);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    reg.record("w1", "docker");
    expect(reg.lookup("w1")).toBe("docker");
  });

  it("lookup of an unknown id returns undefined", () => {
    const reg = new WorkerAttributionRegistry();
    expect(reg.lookup("ghost")).toBeUndefined();
  });

  it("release removes an entry and returns true; releasing again returns false", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    expect(reg.release("w1")).toBe(true);
    expect(reg.lookup("w1")).toBeUndefined();
    expect(reg.release("w1")).toBe(false);
  });

  it("releasing an unknown id returns false", () => {
    const reg = new WorkerAttributionRegistry();
    expect(reg.release("never-existed")).toBe(false);
  });

  it("ids() returns sorted tracked worker ids", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w3", "docker");
    reg.record("w1", "local");
    reg.record("w2", "docker");
    expect(reg.ids()).toEqual(["w1", "w2", "w3"]);
  });

  it("stores nativeId when provided via meta", () => {
    const clock = makeClock(500);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    reg.record("w1", "docker", { nativeId: "container-abc" });
    const snap = reg.snapshot();
    expect(snap.entries["w1"]).toEqual({ backend: "docker", at: 500, nativeId: "container-abc" });
  });

  it("omits nativeId from the entry when not provided", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    const snap = reg.snapshot();
    expect(snap.entries["w1"]).not.toHaveProperty("nativeId");
  });
});

// ===========================================================================
// Validation errors
// ===========================================================================

describe("WorkerAttributionRegistry — validation", () => {
  it("throws RangeError for an empty workerId", () => {
    const reg = new WorkerAttributionRegistry();
    expect(() => reg.record("", "docker")).toThrow(RangeError);
  });

  it("throws RangeError for a blank (whitespace-only) workerId", () => {
    const reg = new WorkerAttributionRegistry();
    expect(() => reg.record("   ", "docker")).toThrow(RangeError);
  });

  it("throws RangeError for an empty backend name", () => {
    const reg = new WorkerAttributionRegistry();
    expect(() => reg.record("w1", "")).toThrow(RangeError);
  });

  it("throws RangeError for a blank backend name", () => {
    const reg = new WorkerAttributionRegistry();
    expect(() => reg.record("w1", "  ")).toThrow(RangeError);
  });
});

// ===========================================================================
// Duplicate-workerId collision matrix
// ===========================================================================

describe("WorkerAttributionRegistry — duplicate-workerId collision matrix", () => {
  it("re-recording the SAME workerId with the SAME backend is a no-op (no throw)", () => {
    const clock = makeClock(0);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    reg.record("w1", "docker");
    clock.advance(100);
    expect(() => reg.record("w1", "docker")).not.toThrow();
    // Refreshes `at` on the identical-backend re-record.
    expect(reg.snapshot().entries["w1"].at).toBe(100);
  });

  it("re-recording the SAME workerId with a DIFFERENT backend throws RangeError", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    expect(() => reg.record("w1", "local")).toThrow(RangeError);
    // The original attribution is preserved — the throw is a backstop, not a partial mutation.
    expect(reg.lookup("w1")).toBe("docker");
  });

  it("record-after-release allows re-attribution to a different backend", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    reg.release("w1");
    expect(() => reg.record("w1", "local")).not.toThrow();
    expect(reg.lookup("w1")).toBe("local");
  });

  it("two distinct worker ids can map to the same backend without conflict", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    reg.record("w2", "docker");
    expect(reg.lookup("w1")).toBe("docker");
    expect(reg.lookup("w2")).toBe("docker");
  });

  it("fromState with duplicate-normalized keys keeps the last-applied entry (JS object key semantics)", () => {
    // Object.entries on a real JS object cannot literally contain duplicate
    // keys, but the same runtime worker id can appear differently-cased in
    // adversarial serialized data — validated purely per-key here, this
    // documents that fromState does not attempt cross-key de-duplication
    // beyond what plain object key identity already guarantees.
    const raw = {
      version: ATTRIBUTION_STATE_VERSION,
      entries: {
        w1: { backend: "docker", at: 10 },
      },
    };
    const reg = WorkerAttributionRegistry.fromState(raw);
    expect(reg.ids()).toEqual(["w1"]);
    expect(reg.lookup("w1")).toBe("docker");
  });
});

// ===========================================================================
// snapshot()
// ===========================================================================

describe("WorkerAttributionRegistry — snapshot", () => {
  it("produces a deep copy: mutating the snapshot never affects the registry", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker", { nativeId: "abc" });
    const snap = reg.snapshot();
    snap.entries["w1"].backend = "corrupted";
    (snap.entries["w1"] as { nativeId?: string }).nativeId = "corrupted";
    snap.entries["w2"] = { backend: "ghost", at: 0 };
    expect(reg.lookup("w1")).toBe("docker");
    expect(reg.ids()).toEqual(["w1"]);
  });

  it("uses canonical (sorted) key order", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("zeta", "docker");
    reg.record("alpha", "local");
    const snap = reg.snapshot();
    expect(Object.keys(snap.entries)).toEqual(["alpha", "zeta"]);
  });

  it("stamps version ATTRIBUTION_STATE_VERSION", () => {
    const reg = new WorkerAttributionRegistry();
    expect(reg.snapshot().version).toBe(ATTRIBUTION_STATE_VERSION);
  });

  it("empty registry snapshots to an empty entries object", () => {
    const reg = new WorkerAttributionRegistry();
    expect(reg.snapshot()).toEqual({ version: ATTRIBUTION_STATE_VERSION, entries: {} });
  });
});

// ===========================================================================
// fromState — never throws, defensive per-entry validation
// ===========================================================================

describe("WorkerAttributionRegistry.fromState — defensive parsing", () => {
  it("round-trips through snapshot()/fromState() exactly", () => {
    const clock = makeClock(42);
    const reg = new WorkerAttributionRegistry({ now: clock.now });
    reg.record("w1", "docker", { nativeId: "n1" });
    reg.record("w2", "local");
    const snap = reg.snapshot();
    const restored = WorkerAttributionRegistry.fromState(snap);
    expect(restored.snapshot()).toEqual(snap);
  });

  it.each([undefined, null, "a string", 42, [], true])("never throws on non-object top-level state: %p", (bad) => {
    expect(() => WorkerAttributionRegistry.fromState(bad)).not.toThrow();
    const reg = WorkerAttributionRegistry.fromState(bad);
    expect(reg.ids()).toEqual([]);
  });

  it("wrong version yields an empty registry, never a crash", () => {
    const raw = { version: ATTRIBUTION_STATE_VERSION + 1, entries: { w1: { backend: "docker", at: 1 } } };
    const reg = WorkerAttributionRegistry.fromState(raw);
    expect(reg.ids()).toEqual([]);
  });

  it("missing version yields an empty registry", () => {
    const raw = { entries: { w1: { backend: "docker", at: 1 } } };
    const reg = WorkerAttributionRegistry.fromState(raw);
    expect(reg.ids()).toEqual([]);
  });

  it("non-object entries field yields an empty registry", () => {
    const raw = { version: ATTRIBUTION_STATE_VERSION, entries: "not-an-object" };
    const reg = WorkerAttributionRegistry.fromState(raw);
    expect(reg.ids()).toEqual([]);
  });

  it("drops individually malformed entries while keeping valid siblings", () => {
    const raw = {
      version: ATTRIBUTION_STATE_VERSION,
      entries: {
        good: { backend: "docker", at: 10 },
        missingBackend: { at: 10 },
        blankBackend: { backend: "   ", at: 10 },
        nonStringBackend: { backend: 42, at: 10 },
        missingAt: { backend: "docker" },
        nonNumberAt: { backend: "docker", at: "yesterday" },
        nanAt: { backend: "docker", at: NaN },
        nonObjectEntry: "not-an-object",
        nullEntry: null,
        badNativeId: { backend: "docker", at: 10, nativeId: 123 },
        good2: { backend: "local", at: 20, nativeId: "abc" },
      },
    };
    const reg = WorkerAttributionRegistry.fromState(raw);
    expect(reg.ids()).toEqual(["good", "good2"]);
    expect(reg.lookup("good")).toBe("docker");
    expect(reg.lookup("good2")).toBe("local");
  });

  it("drops entries keyed by an empty or blank workerId", () => {
    const raw = {
      version: ATTRIBUTION_STATE_VERSION,
      entries: {
        "": { backend: "docker", at: 1 },
        "  ": { backend: "docker", at: 1 },
        w1: { backend: "docker", at: 1 },
      },
    };
    const reg = WorkerAttributionRegistry.fromState(raw);
    expect(reg.ids()).toEqual(["w1"]);
  });

  it("passes through opts (store/now) to the constructed registry", async () => {
    const store = new MemoryStore();
    const clock = makeClock(999);
    const reg = WorkerAttributionRegistry.fromState(undefined, { store, now: clock.now });
    reg.record("w1", "docker");
    expect(reg.snapshot().entries["w1"].at).toBe(999);
    const result = await reg.persist();
    expect(result.saved).toBe(true);
    expect(store.saved).toHaveLength(1);
  });
});

// ===========================================================================
// persist() / restore() — atomic-ish semantics, never throw
// ===========================================================================

describe("WorkerAttributionRegistry — persist()", () => {
  it("reports saved:false with a message when no store is configured", async () => {
    const reg = new WorkerAttributionRegistry();
    const result = await reg.persist();
    expect(result).toEqual({ saved: false, error: "no store configured" });
  });

  it("persists the current snapshot through a real store round-trip", async () => {
    const store = new MemoryStore();
    const reg = new WorkerAttributionRegistry({ store });
    reg.record("w1", "docker");
    const result = await reg.persist();
    expect(result).toEqual({ saved: true });
    expect(store.saved).toEqual([{ version: ATTRIBUTION_STATE_VERSION, entries: { w1: { backend: "docker", at: expect.any(Number) } } }]);
  });

  it("survives a store failure honestly: {saved:false, error} never throws", async () => {
    const store = new MemoryStore();
    store.failNextSave = true;
    const reg = new WorkerAttributionRegistry({ store });
    reg.record("w1", "docker");
    const result = await reg.persist();
    expect(result.saved).toBe(false);
    expect(result.error).toBe("disk full");
    // Failure is transient (per MemoryStore.failNextSave) — a subsequent persist succeeds.
    const result2 = await reg.persist();
    expect(result2.saved).toBe(true);
  });

  it("persist() failure never throws even for a non-Error rejection", async () => {
    const store: AttributionStore = {
      save: async () => {
        // eslint-disable-next-line no-throw-literal
        throw "boom";
      },
      load: async () => undefined,
    };
    const reg = new WorkerAttributionRegistry({ store });
    reg.record("w1", "docker");
    const result = await reg.persist();
    expect(result.saved).toBe(false);
    expect(result.error).toBe("boom");
  });
});

describe("WorkerAttributionRegistry — restore()", () => {
  it("reports loaded:false, dropped:0 with no store configured", async () => {
    const reg = new WorkerAttributionRegistry();
    expect(await reg.restore()).toEqual({ loaded: false, dropped: 0 });
  });

  it("reports loaded:false when the store has nothing saved yet", async () => {
    const store = new MemoryStore();
    const reg = new WorkerAttributionRegistry({ store });
    expect(await reg.restore()).toEqual({ loaded: false, dropped: 0 });
  });

  it("reports loaded:false when store.load() rejects, never throwing", async () => {
    const store = new MemoryStore();
    store.failLoad = true;
    const reg = new WorkerAttributionRegistry({ store });
    await expect(reg.restore()).resolves.toEqual({ loaded: false, dropped: 0 });
  });

  it("restores a clean, previously-persisted snapshot with dropped:0", async () => {
    const store = new MemoryStore();
    const writer = new WorkerAttributionRegistry({ store });
    writer.record("w1", "docker", { nativeId: "n1" });
    writer.record("w2", "local");
    await writer.persist();

    const reader = new WorkerAttributionRegistry({ store });
    const result = await reader.restore();
    expect(result).toEqual({ loaded: true, dropped: 0 });
    expect(reader.ids()).toEqual(["w1", "w2"]);
    expect(reader.lookup("w1")).toBe("docker");
  });

  it("drops malformed entries individually and counts them, keeping valid ones", async () => {
    const store = new MemoryStore();
    store.setRaw({
      version: ATTRIBUTION_STATE_VERSION,
      entries: {
        good: { backend: "docker", at: 10 },
        bad1: { backend: "", at: 10 },
        bad2: { backend: "docker" },
        bad3: "not-an-object",
      },
    });
    const reg = new WorkerAttributionRegistry({ store });
    const result = await reg.restore();
    expect(result.loaded).toBe(true);
    expect(result.dropped).toBe(3);
    expect(reg.ids()).toEqual(["good"]);
  });

  it("version mismatch yields loaded:false, dropped:0 — never a crash", async () => {
    const store = new MemoryStore();
    store.setRaw({ version: 999, entries: { w1: { backend: "docker", at: 1 } } });
    const reg = new WorkerAttributionRegistry({ store });
    const result = await reg.restore();
    expect(result).toEqual({ loaded: false, dropped: 0 });
    expect(reg.ids()).toEqual([]);
  });

  it("merges into existing in-memory entries rather than clobbering them wholesale", async () => {
    const store = new MemoryStore();
    store.setRaw({ version: ATTRIBUTION_STATE_VERSION, entries: { w2: { backend: "local", at: 5 } } });
    const reg = new WorkerAttributionRegistry({ store });
    reg.record("w1", "docker");
    await reg.restore();
    expect(reg.ids()).toEqual(["w1", "w2"]);
  });

  it("a restored entry that conflicts with an existing in-memory entry for the SAME id silently overwrites (restore is not record())", async () => {
    // restore() merges raw validated entries directly, bypassing record()'s
    // duplicate-backend guard — it represents "what was durably true",
    // not a live re-attribution event.
    const store = new MemoryStore();
    store.setRaw({ version: ATTRIBUTION_STATE_VERSION, entries: { w1: { backend: "local", at: 99 } } });
    const reg = new WorkerAttributionRegistry({ store });
    reg.record("w1", "docker");
    await reg.restore();
    expect(reg.lookup("w1")).toBe("local");
  });
});

// ===========================================================================
// resolveBackendForTask
// ===========================================================================

describe("resolveBackendForTask", () => {
  it("resolves via task.result.workerId when present and known", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("replica-7", "docker");
    const resolve = resolveBackendForTask(reg);
    const t = task({
      assignedTo: "replica-7",
      result: { taskId: "t1", workerId: "replica-7", output: {}, claims: [], toolTrace: [], startedAt: 0, finishedAt: 1 },
    });
    expect(resolve(t)).toBe("docker");
  });

  it("consensus task: result.workerId is a DIFFERENT replica id than assignedTo — result wins", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("assigned-primary", "local");
    reg.record("replica-winner", "docker");
    const resolve = resolveBackendForTask(reg);
    const t = task({
      assignedTo: "assigned-primary",
      consensus: { replicas: 3, quorum: 2 },
      result: { taskId: "t1", workerId: "replica-winner", output: {}, claims: [], toolTrace: [], startedAt: 0, finishedAt: 1 },
    });
    expect(resolve(t)).toBe("docker");
  });

  it("falls back to task.assignedTo when no result is present", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    const resolve = resolveBackendForTask(reg);
    const t = task({ assignedTo: "w1" });
    expect(resolve(t)).toBe("docker");
  });

  it("falls back to assignedTo when result.workerId is unknown to the registry", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    const resolve = resolveBackendForTask(reg);
    const t = task({
      assignedTo: "w1",
      result: { taskId: "t1", workerId: "ghost-worker", output: {}, claims: [], toolTrace: [], startedAt: 0, finishedAt: 1 },
    });
    expect(resolve(t)).toBe("docker");
  });

  it("returns undefined when neither field is set", () => {
    const reg = new WorkerAttributionRegistry();
    const resolve = resolveBackendForTask(reg);
    const t = task();
    expect(resolve(t)).toBeUndefined();
  });

  it("returns undefined when both fields name workers unknown to the registry", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("someone-else", "docker");
    const resolve = resolveBackendForTask(reg);
    const t = task({
      assignedTo: "unknown-1",
      result: { taskId: "t1", workerId: "unknown-2", output: {}, claims: [], toolTrace: [], startedAt: 0, finishedAt: 1 },
    });
    expect(resolve(t)).toBeUndefined();
  });

  it("treats an empty-string assignedTo as unknown, never a lookup key", () => {
    // record() itself rejects "" (RangeError), so an empty-string id can
    // never legitimately be registered — resolveBackendForTask must still
    // treat it as "unknown" defensively rather than attempting the lookup.
    const reg = new WorkerAttributionRegistry();
    const resolve = resolveBackendForTask(reg);
    const t = task({ assignedTo: "" });
    expect(resolve(t)).toBeUndefined();
  });

  it("NEVER guesses a backend from an unrelated but similarly-shaped registry entry", () => {
    const reg = new WorkerAttributionRegistry();
    reg.record("w1", "docker");
    const resolve = resolveBackendForTask(reg);
    const t = task({ assignedTo: "w2" });
    expect(resolve(t)).toBeUndefined();
  });
});
