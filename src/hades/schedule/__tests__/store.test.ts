import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ManualClock } from "../clock";
import {
  InMemoryJobStore,
  JsonFileJobStore,
  type JobRunRecord,
  type JobStore,
  type JobTask,
  type NewJobInput,
} from "../store";
import { CronParseError } from "../cron";

// ===========================================================================
// Shared contract — run once against InMemoryJobStore, once against
// JsonFileJobStore, exactly like connector-contract-all-platforms.test.ts
// proves the six platform connectors interchangeable. Any assertion here
// must hold for BOTH implementations for the store abstraction to be real.
// ===========================================================================

const VALID_CRON = "0 9 * * *";

function baseInput(): NewJobInput {
  return {
    name: "daily digest",
    cron: VALID_CRON,
    task: { kind: "digest", input: "daily" },
  };
}

function runJobStoreContractTests(
  label: string,
  makeStore: (clock: ManualClock) => JobStore,
  cleanup?: () => void,
): void {
  describe(`JobStore contract — ${label}`, () => {
    if (cleanup) afterAll(cleanup);

    it("add() applies documented defaults", () => {
      const clock = new ManualClock(1_000);
      const store = makeStore(clock);
      const job = store.add(baseInput());

      expect(job.timeZone).toBe("UTC");
      expect(job.misfire).toBe("skip");
      expect(job.catchUpLimit).toBe(5);
      expect(job.enabled).toBe(true);
      expect(job.createdAt).toBe(1_000);
      expect(job.updatedAt).toBe(1_000);
      expect(job.revision).toBe(1);
      expect(job.runCount).toBe(0);
      expect(job.failCount).toBe(0);
      expect(job.abstainCount).toBe(0);
      expect(job.history).toEqual([]);
      expect(job.lastFireAt).toBeUndefined();
      expect(typeof job.id).toBe("string");
      expect(job.id.length).toBeGreaterThan(0);
    });

    it("add() honors explicit overrides instead of defaults", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add({
        name: "custom",
        cron: "*/5 * * * *",
        timeZone: "America/New_York",
        task: { kind: "reminder", input: "x" },
        delivery: { platform: "slack", user: "U1", channel: "C1" },
        misfire: "catch-up",
        catchUpLimit: 10,
        enabled: false,
      });

      expect(job.timeZone).toBe("America/New_York");
      expect(job.delivery).toEqual({ platform: "slack", user: "U1", channel: "C1" });
      expect(job.misfire).toBe("catch-up");
      expect(job.catchUpLimit).toBe(10);
      expect(job.enabled).toBe(false);
    });

    it("add() rejects an empty (or whitespace-only) name, and persists nothing", () => {
      const store = makeStore(new ManualClock(0));
      expect(() => store.add({ ...baseInput(), name: "" })).toThrow(/name/i);
      expect(() => store.add({ ...baseInput(), name: "   " })).toThrow(/name/i);
      expect(store.list()).toHaveLength(0);
    });

    it("add() rejects a malformed cron expression, propagating CronParseError with its field, and persists nothing", () => {
      const store = makeStore(new ManualClock(0));
      let caught: unknown;
      try {
        store.add({ ...baseInput(), cron: "99 99 99 99 99" }); // out-of-range minute
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CronParseError);
      const field = (caught as CronParseError).field;
      expect(typeof field).toBe("string");
      expect((field ?? "").length).toBeGreaterThan(0);
      expect(store.list()).toHaveLength(0);
    });

    it("add() rejects an unrecognized IANA time zone, and persists nothing", () => {
      const store = makeStore(new ManualClock(0));
      expect(() => store.add({ ...baseInput(), timeZone: "Not/AZone" })).toThrow();
      expect(store.list()).toHaveLength(0);
    });

    it("add() rejects a task missing a non-empty kind or a string input", () => {
      const store = makeStore(new ManualClock(0));
      expect(() => store.add({ ...baseInput(), task: { kind: "", input: "x" } })).toThrow();
      expect(() => store.add({ ...baseInput(), task: undefined as unknown as JobTask })).toThrow();
      expect(store.list()).toHaveLength(0);
    });

    it("add() allows two jobs to share the same name — duplicates are id-based, not name-based", () => {
      const store = makeStore(new ManualClock(0));
      const a = store.add(baseInput());
      const b = store.add(baseInput());
      expect(a.id).not.toBe(b.id);
      expect(a.name).toBe(b.name);
      expect(store.list()).toHaveLength(2);
    });

    it("get() returns undefined for an unknown id", () => {
      const store = makeStore(new ManualClock(0));
      expect(store.get("does-not-exist")).toBeUndefined();
    });

    it("get()/list() hand out defensive copies — mutating the return value cannot corrupt the store", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());

      const fetched = store.get(job.id)!;
      fetched.name = "MUTATED";
      fetched.history.push({ firedAt: 1, scheduledFor: 1, outcome: "delivered", detail: "x", durationMs: 1 });

      expect(store.get(job.id)!.name).toBe(job.name);
      expect(store.get(job.id)!.history).toHaveLength(0);

      const listed = store.list();
      listed[0].name = "ALSO MUTATED";
      expect(store.get(job.id)!.name).toBe(job.name);
    });

    it("update() bumps revision by exactly 1 and refreshes updatedAt from the injected clock", () => {
      const clock = new ManualClock(1_000);
      const store = makeStore(clock);
      const job = store.add(baseInput());

      clock.advance(5_000);
      const updated = store.update(job.id, { name: "renamed" });

      expect(updated.revision).toBe(job.revision + 1);
      expect(updated.updatedAt).toBe(6_000);
      expect(updated.createdAt).toBe(job.createdAt);
      expect(updated.name).toBe("renamed");
    });

    it("update() applied repeatedly bumps revision by exactly 1 each time", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      const r1 = store.update(job.id, { enabled: false });
      const r2 = store.update(job.id, { enabled: true });
      const r3 = store.update(job.id, { name: "x" });
      expect([job.revision, r1.revision, r2.revision, r3.revision]).toEqual([1, 2, 3, 4]);
    });

    it("update() with a stale expectedRevision throws a conflict error naming actual vs expected revision", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      store.update(job.id, { name: "v2" }); // now at revision 2

      expect(() => store.update(job.id, { name: "v3" }, job.revision)).toThrow(
        /expected revision 1.*actual revision 2/is,
      );
      // The rejected attempt must not itself have mutated anything.
      expect(store.get(job.id)!.name).toBe("v2");
      expect(store.get(job.id)!.revision).toBe(2);
    });

    it("update() with a matching expectedRevision succeeds", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      const updated = store.update(job.id, { name: "v2" }, job.revision);
      expect(updated.name).toBe("v2");
      expect(updated.revision).toBe(2);
    });

    it("update() with no expectedRevision never conflicts", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      store.update(job.id, { name: "v2" });
      expect(() => store.update(job.id, { name: "v3" })).not.toThrow();
    });

    it("update() on an unknown id throws", () => {
      const store = makeStore(new ManualClock(0));
      expect(() => store.update("does-not-exist", { name: "x" })).toThrow(/not found/i);
    });

    it("update() re-validates a patched cron/timeZone, and rejects an invalid patch without mutating the job", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      expect(() => store.update(job.id, { cron: "garbage" })).toThrow();
      expect(() => store.update(job.id, { timeZone: "Not/AZone" })).toThrow();
      const stillThere = store.get(job.id)!;
      expect(stillThere.cron).toBe(job.cron);
      expect(stillThere.timeZone).toBe(job.timeZone);
      expect(stillThere.revision).toBe(job.revision);
    });

    it("remove() deletes an existing job and returns true; returns false for an unknown id (and is idempotent)", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      expect(store.remove("does-not-exist")).toBe(false);
      expect(store.remove(job.id)).toBe(true);
      expect(store.get(job.id)).toBeUndefined();
      expect(store.remove(job.id)).toBe(false);
    });

    it("recordRun() always increments runCount, plus failCount on 'failed' and abstainCount on 'abstained'/'withheld'", () => {
      const clock = new ManualClock(0);
      const store = makeStore(clock);
      const job = store.add(baseInput());

      const outcomes: JobRunRecord["outcome"][] = ["delivered", "failed", "abstained", "withheld", "skipped"];
      let last = job;
      for (const outcome of outcomes) {
        clock.advance(1);
        last = store.recordRun(job.id, {
          firedAt: clock.now(),
          scheduledFor: clock.now(),
          outcome,
          detail: outcome,
          durationMs: 10,
        });
      }

      expect(last.runCount).toBe(5);
      expect(last.failCount).toBe(1);
      expect(last.abstainCount).toBe(2); // abstained + withheld
      expect(last.history).toHaveLength(5);
      expect(last.lastFireAt).toBe(clock.now());
      expect(last.revision).toBe(job.revision + 5);
    });

    it("recordRun() caps history at 50 entries, FIFO (oldest dropped first)", () => {
      const clock = new ManualClock(0);
      const store = makeStore(clock);
      const job = store.add(baseInput());

      let last = job;
      for (let i = 0; i < 60; i++) {
        clock.advance(1);
        last = store.recordRun(job.id, {
          firedAt: clock.now(),
          scheduledFor: clock.now(),
          outcome: "delivered",
          detail: `run-${i}`,
          durationMs: 1,
        });
      }

      expect(last.history).toHaveLength(50);
      expect(last.history[0].detail).toBe("run-10");
      expect(last.history[49].detail).toBe("run-59");
      expect(last.runCount).toBe(60);
    });

    it("recordRun() on an unknown id throws", () => {
      const store = makeStore(new ManualClock(0));
      expect(() =>
        store.recordRun("does-not-exist", {
          firedAt: 1,
          scheduledFor: 1,
          outcome: "delivered",
          detail: "x",
          durationMs: 1,
        }),
      ).toThrow(/not found/i);
    });

    it("recordRun() rejects an invalid outcome", () => {
      const store = makeStore(new ManualClock(0));
      const job = store.add(baseInput());
      expect(() =>
        store.recordRun(job.id, {
          firedAt: 1,
          scheduledFor: 1,
          outcome: "bogus" as unknown as JobRunRecord["outcome"],
          detail: "x",
          durationMs: 1,
        }),
      ).toThrow();
    });

    it("loadReport() reports no recovery on a clean start", () => {
      const store = makeStore(new ManualClock(0));
      expect(store.loadReport().recovered).toBe(false);
    });
  });
}

runJobStoreContractTests("InMemoryJobStore", (clock) => new InMemoryJobStore(clock));

const fileContractDirs: string[] = [];
runJobStoreContractTests(
  "JsonFileJobStore",
  (clock) => {
    const dir = mkdtempSync(join(tmpdir(), "job-store-contract-"));
    fileContractDirs.push(dir);
    return new JsonFileJobStore(join(dir, "jobs.json"), clock);
  },
  () => {
    for (const dir of fileContractDirs) rmSync(dir, { recursive: true, force: true });
  },
);

// ===========================================================================
// InMemoryJobStore-specific
// ===========================================================================

describe("InMemoryJobStore", () => {
  it("uses crypto.randomUUID by default, producing distinct ids", () => {
    const store = new InMemoryJobStore(new ManualClock(0));
    const a = store.add(baseInput());
    const b = store.add(baseInput());
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("accepts a custom idFn", () => {
    let n = 0;
    const store = new InMemoryJobStore(new ManualClock(0), () => `job-${++n}`);
    const a = store.add(baseInput());
    const b = store.add(baseInput());
    expect(a.id).toBe("job-1");
    expect(b.id).toBe("job-2");
  });

  it("loadReport() is always { recovered: false } (nothing to recover, no file)", () => {
    const store = new InMemoryJobStore(new ManualClock(0));
    expect(store.loadReport()).toEqual({ recovered: false });
  });
});

// ===========================================================================
// JsonFileJobStore-specific durability + corruption recovery
// ===========================================================================

describe("JsonFileJobStore — durability", () => {
  const dirs: string[] = [];
  function freshPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "job-store-durability-"));
    dirs.push(dir);
    return join(dir, "jobs.json");
  }
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("missing file is NOT reported as recovered, and construction alone writes nothing", () => {
    const path = freshPath();
    const store = new JsonFileJobStore(path, new ManualClock(0));
    expect(store.loadReport()).toEqual({ path, recovered: false });
    expect(existsSync(path)).toBe(false);
  });

  it("creates the parent directory on first write if it doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-store-mkdir-"));
    dirs.push(dir);
    const path = join(dir, "nested", "deep", "jobs.json");
    const store = new JsonFileJobStore(path, new ManualClock(0));
    store.add(baseInput());
    expect(existsSync(path)).toBe(true);
  });

  it("round-trips jobs — including history and counters — across a fresh construction on the same path", () => {
    const path = freshPath();
    const clock = new ManualClock(1_000);
    const store1 = new JsonFileJobStore(path, clock);

    const job = store1.add({
      name: "n",
      cron: VALID_CRON,
      task: { kind: "k", input: "i" },
      delivery: { platform: "slack", user: "U1" },
    });
    clock.advance(10);
    store1.recordRun(job.id, {
      firedAt: clock.now(),
      scheduledFor: clock.now(),
      outcome: "failed",
      detail: "boom",
      durationMs: 5,
    });
    clock.advance(10);
    store1.update(job.id, { enabled: false });

    const expected = store1.list();
    expect(expected).toHaveLength(1);
    expect(expected[0].history).toHaveLength(1);

    const store2 = new JsonFileJobStore(path, new ManualClock(99_999));
    expect(store2.list()).toEqual(expected);
    expect(store2.loadReport().recovered).toBe(false);
  });

  it("never leaves a .tmp file behind after a write", () => {
    const path = freshPath();
    const store = new JsonFileJobStore(path, new ManualClock(0));
    store.add(baseInput());
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("a stale pre-existing .tmp file (simulated crash) is harmlessly overwritten by the next write", () => {
    const path = freshPath();
    writeFileSync(`${path}.tmp`, "stale garbage left by a simulated crash", "utf8");
    const store = new JsonFileJobStore(path, new ManualClock(0));
    store.add(baseInput());
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { jobs: unknown[] };
    expect(onDisk.jobs).toHaveLength(1);
  });

  it("recovers from literal garbage bytes: empty store, quarantine file preserved, honest loadReport()", () => {
    const path = freshPath();
    writeFileSync(path, "this is not json at all {{{", "utf8");

    const store = new JsonFileJobStore(path, new ManualClock(5_000));
    const report = store.loadReport();
    expect(report.recovered).toBe(true);
    expect(report.warning).toBeTruthy();
    expect(store.list()).toEqual([]);

    const quarantined = readdirSync(dirname(path)).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dirname(path), quarantined[0]), "utf8")).toContain("this is not json");

    // Subsequent add() persists cleanly on top of the quarantined file.
    store.add(baseInput());
    const reloaded = new JsonFileJobStore(path, new ManualClock(6_000));
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.loadReport().recovered).toBe(false);
  });

  it("recovers from truncated JSON", () => {
    const path = freshPath();
    writeFileSync(path, '{"version": 1, "jobs": [ { "id": "a", "name":', "utf8");

    const store = new JsonFileJobStore(path, new ManualClock(0));
    expect(store.loadReport().recovered).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dirname(path)).some((f) => f.includes(".corrupt-"))).toBe(true);

    store.add(baseInput());
    expect(new JsonFileJobStore(path, new ManualClock(1)).list()).toHaveLength(1);
  });

  it("recovers from valid JSON with an unsupported version", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ version: 99, jobs: [] }), "utf8");

    const store = new JsonFileJobStore(path, new ManualClock(0));
    const report = store.loadReport();
    expect(report.recovered).toBe(true);
    expect(report.warning).toMatch(/version/i);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dirname(path)).some((f) => f.includes(".corrupt-"))).toBe(true);

    store.add(baseInput());
    expect(new JsonFileJobStore(path, new ManualClock(1)).list()).toHaveLength(1);
  });

  it("recovers from valid JSON that is not an object (a bare array)", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify([1, 2, 3]), "utf8");

    const store = new JsonFileJobStore(path, new ManualClock(0));
    expect(store.loadReport().recovered).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dirname(path)).some((f) => f.includes(".corrupt-"))).toBe(true);

    store.add(baseInput());
    expect(new JsonFileJobStore(path, new ManualClock(1)).list()).toHaveLength(1);
  });

  it("recovers from a version-1 file whose jobs array contains a malformed record", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [{ id: "x" }] }), "utf8");

    const store = new JsonFileJobStore(path, new ManualClock(0));
    expect(store.loadReport().recovered).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dirname(path)).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("quarantine files don't collide when corruption is recovered twice at the same clock instant", () => {
    const path = freshPath();
    writeFileSync(path, "garbage-1", "utf8");
    const store = new JsonFileJobStore(path, new ManualClock(42));
    store.add(baseInput());

    // Corrupt it again, at the exact same fixed instant, and recover again.
    writeFileSync(path, "garbage-2", "utf8");
    const rewritten = readFileSync(path, "utf8");
    expect(rewritten).toBe("garbage-2");
    const store2 = new JsonFileJobStore(path, new ManualClock(42));
    expect(store2.list()).toEqual([]);

    const quarantined = readdirSync(dirname(path)).filter((f) => f.includes(".corrupt-"));
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
  });
});
