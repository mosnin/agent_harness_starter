import { describe, it, expect, vi } from "vitest";
import {
  LEARNING_STATUS_VERSION,
  FileLearningStatusStore,
  persistingOnEvent,
  type LearningStatusFs,
  type PersistedLearningStatus,
} from "../learning-status-store";
import type { SwarmLearningEvent, SwarmLearningStatus } from "../swarm-learning";
import type { BanditArm } from "../route-bandit";

// ===========================================================================
// Fixtures
// ===========================================================================

function makeArm(overrides: Partial<BanditArm> = {}): BanditArm {
  return {
    pulls: 4,
    verified: 3,
    totalElapsedMs: 12000,
    totalUsd: 0.42,
    meanReward: 0.75,
    ucb: 1.23,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SwarmLearningStatus> = {}): SwarmLearningStatus {
  return {
    attached: true,
    counts: { recorded: 3, skipped: 1, duplicate: 0 },
    arms: {
      docker: makeArm(),
      modal: makeArm({ pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null }),
    },
    recent: [
      { type: "recorded", at: 1000, taskId: "t1", backend: "docker", detail: { elapsedMsNote: "measured" } },
      { type: "skipped", at: 1500, taskId: "t2", detail: { usdNote: "estimated" } },
    ],
    ...overrides,
  };
}

/** In-memory fake fs — real async round-trip semantics, no disk. Supports
 *  injected failures at each step to exercise atomicity. */
class FakeFs implements LearningStatusFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  failWriteFile = false;
  failRename: false | "throw" | "afterPersist" = false;
  failMkdir = false;
  failReadFile = false;

  async mkdir(path: string): Promise<unknown> {
    if (this.failMkdir) throw new Error("mkdir failed");
    this.dirs.add(path);
    return undefined;
  }

  async writeFile(path: string, data: string): Promise<void> {
    if (this.failWriteFile) throw new Error("disk full");
    this.files.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failRename === "throw") {
      // Simulate a crash BEFORE the rename takes effect: the tmp file
      // stays around but `to` is never touched.
      throw new Error("rename failed");
    }
    if (this.failRename === "afterPersist") {
      // Simulate a crash where the OS actually persisted the rename's
      // effect to `to` before the failure surfaced to the caller (rare but
      // real for some filesystems/power-loss scenarios) -- exercised
      // separately below via direct file manipulation, not through this
      // flag combination in the "throws" tests.
      throw new Error("rename failed after persist");
    }
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`ENOENT: no such file ${from}`);
    this.files.set(to, data);
    this.files.delete(from);
  }

  async readFile(path: string): Promise<string> {
    if (this.failReadFile) throw new Error("read failed");
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT: no such file ${path}`);
    return data;
  }
}

// ===========================================================================
// save() atomicity
// ===========================================================================

describe("FileLearningStatusStore.save", () => {
  it("writes a tmp file and renames it onto the final path", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs, now: () => 42 });
    const status = makeStatus();

    const result = await store.save(status);

    expect(result).toEqual({ saved: true });
    expect(fs.files.has("/state/learning.json.tmp")).toBe(false);
    expect(fs.files.has("/state/learning.json")).toBe(true);
    const persisted = JSON.parse(fs.files.get("/state/learning.json")!) as PersistedLearningStatus;
    expect(persisted).toEqual({ version: LEARNING_STATUS_VERSION, at: 42, status });
  });

  it("mkdir -p's the parent directory before writing", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/a/b/c/learning.json", fs, now: () => 1 });
    await store.save(makeStatus());
    expect(fs.dirs.has("/a/b/c")).toBe(true);
  });

  it("never throws and reports { saved:false, error } when mkdir fails", async () => {
    const fs = new FakeFs();
    fs.failMkdir = true;
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const result = await store.save(makeStatus());
    expect(result.saved).toBe(false);
    expect(result.error).toContain("mkdir failed");
  });

  it("never throws and reports { saved:false, error } when writeFile fails", async () => {
    const fs = new FakeFs();
    fs.failWriteFile = true;
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const result = await store.save(makeStatus());
    expect(result.saved).toBe(false);
    expect(result.error).toContain("disk full");
  });

  it("a rename failure leaves no corrupted final file, reports saved:false, and the untouched original still loads", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs, now: () => 1 });

    // Seed a real, previously-persisted good file.
    const original = makeStatus({ counts: { recorded: 99, skipped: 0, duplicate: 0 } });
    const firstSave = await store.save(original);
    expect(firstSave.saved).toBe(true);

    // Now simulate a crash during the SECOND save's rename step.
    fs.failRename = "throw";
    const secondStatus = makeStatus({ counts: { recorded: 1, skipped: 0, duplicate: 0 } });
    const result = await store.save(secondStatus);

    expect(result.saved).toBe(false);
    expect(result.error).toContain("rename failed");

    // The final path was NEVER touched by the failed rename -- reloading it
    // must still yield the original, untouched status, not a corrupted mix.
    const reloaded = await store.load();
    expect(reloaded?.status).toEqual(original);
  });

  it("a crash that persists the .tmp write but fails rename is re-loadable: the untouched original still loads via a fresh store pointed at the same path", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs, now: () => 1 });
    const original = makeStatus({ counts: { recorded: 7, skipped: 2, duplicate: 1 } });
    await store.save(original);

    fs.failRename = "throw";
    await store.save(makeStatus({ counts: { recorded: 500, skipped: 0, duplicate: 0 } }));

    // The .tmp write DID persist (per the fake), but rename never completed,
    // so the original final file is exactly as it was.
    expect(fs.files.has("/state/learning.json.tmp")).toBe(true);
    const freshStore = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const reloaded = await freshStore.load();
    expect(reloaded?.status).toEqual(original);
  });

  it("round-trips a full status deep-equal modulo the envelope", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs, now: () => 999 });
    const status = makeStatus();
    await store.save(status);
    const loaded = await store.load();
    expect(loaded).toEqual({ version: LEARNING_STATUS_VERSION, at: 999, status });
  });
});

// ===========================================================================
// load() validation matrix
// ===========================================================================

describe("FileLearningStatusStore.load", () => {
  it("returns undefined when the file does not exist", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/nope.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined for truncated/invalid JSON", async () => {
    const fs = new FakeFs();
    fs.files.set("/state/learning.json", '{"version": 1, "at": 1, "status": {');
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined when readFile itself throws", async () => {
    const fs = new FakeFs();
    fs.failReadFile = true;
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined for a non-object top-level payload", async () => {
    const fs = new FakeFs();
    fs.files.set("/state/learning.json", JSON.stringify([1, 2, 3]));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined for a wrong version", async () => {
    const fs = new FakeFs();
    fs.files.set(
      "/state/learning.json",
      JSON.stringify({ version: 999, at: 1, status: makeStatus() })
    );
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined when `at` is a non-numeric type", async () => {
    const fs = new FakeFs();
    fs.files.set(
      "/state/learning.json",
      JSON.stringify({ version: LEARNING_STATUS_VERSION, at: "not-a-number", status: makeStatus() })
    );
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined when `at` is null (e.g. from JSON.stringify(Infinity))", async () => {
    // JSON has no representation for Infinity/NaN; JSON.stringify(Infinity)
    // produces `null`, which is exactly the kind of malformed `at` a
    // corrupted or hand-edited file could contain. Must be rejected, not
    // coerced to some default.
    const fs = new FakeFs();
    fs.files.set(
      "/state/learning.json",
      JSON.stringify({ version: LEARNING_STATUS_VERSION, at: null, status: makeStatus() })
    );
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined for malformed top-level counts", async () => {
    const fs = new FakeFs();
    const bad = makeStatus();
    (bad as unknown as { counts: unknown }).counts = { recorded: -1, skipped: 0, duplicate: 0 };
    fs.files.set("/state/learning.json", JSON.stringify({ version: LEARNING_STATUS_VERSION, at: 1, status: bad }));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined when `attached` is not a boolean", async () => {
    const fs = new FakeFs();
    const bad = { ...makeStatus(), attached: "yes" };
    fs.files.set("/state/learning.json", JSON.stringify({ version: LEARNING_STATUS_VERSION, at: 1, status: bad }));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("drops an arm with NaN pulls while keeping the rest of arms", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: {
        ...status,
        arms: { ...status.arms, broken: { ...makeArm(), pulls: Number.NaN } },
      },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded).toBeDefined();
    expect(loaded!.status.arms.broken).toBeUndefined();
    expect(loaded!.status.arms.docker).toEqual(status.arms.docker);
  });

  it("drops an arm with negative pulls", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: { ...status, arms: { ...status.arms, broken: { ...makeArm(), pulls: -3 } } },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.arms.broken).toBeUndefined();
  });

  it("drops an arm with fractional (non-integer) pulls", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: { ...status, arms: { ...status.arms, broken: { ...makeArm(), pulls: 2.5 } } },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.arms.broken).toBeUndefined();
  });

  it("drops an arm whose ucb is a wrong type (string)", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: { ...status, arms: { ...status.arms, broken: { ...makeArm(), ucb: "high" } } },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.arms.broken).toBeUndefined();
  });

  it("keeps an arm whose ucb is null (never-pulled arm)", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    fs.files.set("/state/learning.json", JSON.stringify({ version: LEARNING_STATUS_VERSION, at: 1, status }));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.arms.modal.ucb).toBeNull();
  });

  it("drops a recent entry that is a bare string", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: { ...status, recent: [...status.recent, "not an event"] },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.recent).toHaveLength(status.recent.length);
  });

  it("drops a recent entry that is null", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: { ...status, recent: [...status.recent, null] },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.recent).toHaveLength(status.recent.length);
  });

  it("drops a recent entry missing a string `type`", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = {
      version: LEARNING_STATUS_VERSION,
      at: 1,
      status: { ...status, recent: [...status.recent, { at: 2, taskId: "x" }] },
    };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const loaded = await store.load();
    expect(loaded!.status.recent).toHaveLength(status.recent.length);
  });

  it("returns undefined when `arms` is not an object", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = { version: LEARNING_STATUS_VERSION, at: 1, status: { ...status, arms: "nope" } };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("returns undefined when `recent` is not an array", async () => {
    const fs = new FakeFs();
    const status = makeStatus();
    const raw = { version: LEARNING_STATUS_VERSION, at: 1, status: { ...status, recent: "nope" } };
    fs.files.set("/state/learning.json", JSON.stringify(raw));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    expect(await store.load()).toBeUndefined();
  });

  it("never throws even for wildly malformed input", async () => {
    const fs = new FakeFs();
    fs.files.set("/state/learning.json", JSON.stringify({ version: 1, at: 1, status: 42 }));
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("handles a completely empty file (empty string) without throwing", async () => {
    const fs = new FakeFs();
    fs.files.set("/state/learning.json", "");
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    await expect(store.load()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// persistingOnEvent
// ===========================================================================

describe("persistingOnEvent", () => {
  function makeTimerHarness() {
    const scheduled = new Map<number, () => void>();
    let nextId = 1;
    return {
      setTimer: (fn: () => void, _ms: number) => {
        const id = nextId++;
        scheduled.set(id, fn);
        return id;
      },
      clearTimer: (h: unknown) => {
        scheduled.delete(h as number);
      },
      fireAll: () => {
        const fns = [...scheduled.values()];
        scheduled.clear();
        for (const fn of fns) fn();
      },
      pendingCount: () => scheduled.size,
    };
  }

  it("debounces rapid feed events into exactly one save", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const saveSpy = vi.spyOn(store, "save");
    const status = makeStatus();
    const timers = makeTimerHarness();

    const handle = persistingOnEvent(store, () => status, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    for (let i = 0; i < 5; i++) {
      handle.onEvent({ type: "feed", at: i, detail: { type: "recorded" } } as SwarmLearningEvent);
    }
    expect(timers.pendingCount()).toBe(1);
    timers.fireAll();
    // allow the async save() promise chain to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("a detached event forces an immediate save even mid-debounce, bypassing the timer", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const saveSpy = vi.spyOn(store, "save");
    const status = makeStatus();
    const timers = makeTimerHarness();

    const handle = persistingOnEvent(store, () => status, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    handle.onEvent({ type: "feed", at: 1 } as SwarmLearningEvent);
    expect(timers.pendingCount()).toBe(1);

    handle.onEvent({ type: "detached", at: 2 } as SwarmLearningEvent);
    // The pending debounce timer must have been cancelled by the immediate save.
    expect(timers.pendingCount()).toBe(0);

    await handle.flush();
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("flush() awaits the pending save and returns its result", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const status = makeStatus();
    const timers = makeTimerHarness();

    const handle = persistingOnEvent(store, () => status, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    handle.onEvent({ type: "feed", at: 1 } as SwarmLearningEvent);
    const result = await handle.flush();
    expect(result.saved).toBe(true);

    const loaded = await store.load();
    expect(loaded?.status).toEqual(status);
  });

  it("flush() with nothing pending is a harmless no-op", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const saveSpy = vi.spyOn(store, "save");
    const handle = persistingOnEvent(store, () => makeStatus());

    const result = await handle.flush();
    expect(result.saved).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("dispose() cancels a pending timer and a post-dispose event triggers nothing", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const saveSpy = vi.spyOn(store, "save");
    const status = makeStatus();
    const timers = makeTimerHarness();

    const handle = persistingOnEvent(store, () => status, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    handle.onEvent({ type: "feed", at: 1 } as SwarmLearningEvent);
    expect(timers.pendingCount()).toBe(1);

    handle.dispose();
    expect(timers.pendingCount()).toBe(0);

    handle.onEvent({ type: "detached", at: 2 } as SwarmLearningEvent);
    handle.onEvent({ type: "feed", at: 3 } as SwarmLearningEvent);
    await Promise.resolve();
    await Promise.resolve();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("uses the real setTimeout/clearTimeout by default and still debounces", async () => {
    vi.useFakeTimers();
    try {
      const fs = new FakeFs();
      const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
      const saveSpy = vi.spyOn(store, "save");
      const status = makeStatus();

      const handle = persistingOnEvent(store, () => status, { debounceMs: 250 });
      handle.onEvent({ type: "feed", at: 1 } as SwarmLearningEvent);
      handle.onEvent({ type: "feed", at: 2 } as SwarmLearningEvent);
      handle.onEvent({ type: "feed", at: 3 } as SwarmLearningEvent);

      await vi.advanceTimersByTimeAsync(250);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores non-feed, non-detached events (e.g. attached, snapshot-loaded)", async () => {
    const fs = new FakeFs();
    const store = new FileLearningStatusStore({ path: "/state/learning.json", fs });
    const saveSpy = vi.spyOn(store, "save");
    const timers = makeTimerHarness();
    const handle = persistingOnEvent(store, () => makeStatus(), {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    handle.onEvent({ type: "attached", at: 1 } as SwarmLearningEvent);
    handle.onEvent({ type: "snapshot-loaded", at: 2 } as SwarmLearningEvent);
    expect(timers.pendingCount()).toBe(0);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
