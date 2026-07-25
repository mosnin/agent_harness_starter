import { describe, expect, it } from "vitest";

import { ManualClock } from "../clock";
import { InMemoryJobStore, type JobStore, type JobRunRecord, type NewJobInput, type ScheduledJob } from "../store";
import { parseCron, nextFireTime } from "../cron";
import { buildSchedulePaneSnapshot } from "../pane-snapshot";

// A local structural-seam import: proves buildSchedulePaneSnapshot's row
// shapes really are assignable into the pure pane's own imported types,
// with zero adapter code — the whole point of the structural duplicate
// declared in pane-snapshot.ts. This import crosses only for TYPES, at
// compile time; `schedule-pane.ts` itself remains untouched by any runtime
// import from this module (its own zero-import contract is unaffected).
import type {
  SchedulePaneJobRow as PureJobRow,
  SchedulePaneRunRow as PureRunRow,
  SchedulePaneTally as PureTally,
} from "../../../swarm-runtime/tui/schedule-pane";

const VALID_CRON = "0 9 * * *";

function baseInput(overrides: Partial<NewJobInput> = {}): NewJobInput {
  return {
    name: "daily digest",
    cron: VALID_CRON,
    task: { kind: "digest", input: "x" },
    ...overrides,
  };
}

function run(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    firedAt: 1_000,
    scheduledFor: 1_000,
    outcome: "delivered",
    detail: "ok",
    durationMs: 5,
    ...overrides,
  };
}

// ===========================================================================
// Compile-time structural seam — assigning a real snapshot's rows into the
// pane's own imported types. Any field drift between schedule-pane.ts and
// pane-snapshot.ts breaks `tsc`, not just this test's runtime assertions.
// ===========================================================================

describe("structural seam with the pure pane's row types", () => {
  it("assigns buildSchedulePaneSnapshot()'s rows into the pane's own SchedulePaneJobRow/RunRow/Tally types", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    store.add(baseInput());

    const snap = buildSchedulePaneSnapshot(store, clock);

    // The type-level assertions the contract requires: if these shapes ever
    // drift out of field-for-field sync with schedule-pane.ts's exports,
    // this file fails to compile.
    const jobs: PureJobRow[] = snap.jobs;
    const runs: PureRunRow[] = snap.runs;
    const tally: PureTally | null = snap.tally;

    expect(Array.isArray(jobs)).toBe(true);
    expect(Array.isArray(runs)).toBe(true);
    expect(tally === null || typeof tally === "object").toBe(true);
  });
});

// ===========================================================================
// Real InMemoryJobStore + ManualClock — core semantics
// ===========================================================================

describe("buildSchedulePaneSnapshot: core job-row semantics against the real store", () => {
  it("computes nextFireAt for an enabled job using the real cron engine, cross-checked directly", () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput({ cron: "15 3 * * *", timeZone: "UTC" }));

    const schedule = parseCron(job.cron);
    const expected = nextFireTime(schedule, clock.now(), job.timeZone);

    const snap = buildSchedulePaneSnapshot(store, clock);
    const row = snap.jobs.find((j) => j.id === job.id);
    expect(row).toBeDefined();
    expect(row!.nextFireAt).toBe(expected);
    expect(row!.nextFireAt).not.toBeNull();
  });

  it("America/New_York DST spring-forward boundary: nextFireAt tracks the real UTC-offset shift, cross-checked against the cron engine on both sides", () => {
    // 2026-03-08 is the America/New_York spring-forward date. "30 9 * * 1-5"
    // fires at 09:30 local time regardless of DST, but the *UTC instant* it
    // corresponds to shifts by exactly one hour across the transition.
    const beforeDst = new ManualClock(Date.UTC(2026, 2, 1)); // March 1, 2026 — still EST
    const storeBefore = new InMemoryJobStore(beforeDst);
    const jobBefore = storeBefore.add(baseInput({ cron: "30 9 * * 1-5", timeZone: "America/New_York" }));
    const scheduleBefore = parseCron(jobBefore.cron);
    const expectedBefore = nextFireTime(scheduleBefore, beforeDst.now(), jobBefore.timeZone);

    const snapBefore = buildSchedulePaneSnapshot(storeBefore, beforeDst);
    expect(snapBefore.jobs[0].nextFireAt).toBe(expectedBefore);

    const afterDst = new ManualClock(Date.UTC(2026, 3, 1)); // April 1, 2026 — now EDT
    const storeAfter = new InMemoryJobStore(afterDst);
    const jobAfter = storeAfter.add(baseInput({ cron: "30 9 * * 1-5", timeZone: "America/New_York" }));
    const scheduleAfter = parseCron(jobAfter.cron);
    const expectedAfter = nextFireTime(scheduleAfter, afterDst.now(), jobAfter.timeZone);

    const snapAfter = buildSchedulePaneSnapshot(storeAfter, afterDst);
    expect(snapAfter.jobs[0].nextFireAt).toBe(expectedAfter);

    // The DST transition really did shift the UTC instant by one hour
    // relative to the wall-clock cadence — proving this isn't coincidence.
    expect(expectedBefore).not.toBeNull();
    expect(expectedAfter).not.toBeNull();
    const beforeHourUtc = new Date(expectedBefore!).getUTCHours();
    const afterHourUtc = new Date(expectedAfter!).getUTCHours();
    expect(afterHourUtc).toBe((beforeHourUtc + 23) % 24); // one hour earlier in UTC (EDT is UTC-4 vs EST's UTC-5)
  });

  it("a disabled job always renders nextFireAt: null, even though its cron would otherwise match", () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput({ enabled: false }));

    const snap = buildSchedulePaneSnapshot(store, clock);
    const row = snap.jobs.find((j) => j.id === job.id);
    expect(row!.nextFireAt).toBeNull();
  });

  it("an unparseable cron on a job yields nextFireAt: null — never a guessed time", () => {
    // The real store validates cron on add()/update(), so this exercises
    // buildSchedulePaneSnapshot's defensive handling directly against a
    // minimal JobStore double holding a job whose cron could never have
    // passed the real store's own validation (e.g. legacy/corrupt data a
    // future store implementation might still surface via list()).
    const badJob: ScheduledJob = {
      id: "bad-cron-job",
      name: "corrupt",
      cron: "not a cron expression",
      timeZone: "UTC",
      task: { kind: "x", input: "y" },
      misfire: "skip",
      catchUpLimit: 5,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      runCount: 0,
      failCount: 0,
      abstainCount: 0,
      history: [],
      revision: 1,
    };
    const fakeStore: JobStore = {
      list: () => [badJob],
      get: () => badJob,
      add: () => {
        throw new Error("not implemented");
      },
      update: () => {
        throw new Error("not implemented");
      },
      remove: () => false,
      recordRun: () => badJob,
      loadReport: () => ({ recovered: false }),
    };
    const clock = new ManualClock(Date.UTC(2026, 0, 1));

    const snap = buildSchedulePaneSnapshot(fakeStore, clock);
    expect(snap.jobs[0].nextFireAt).toBeNull();
  });

  it("formats deliveryTarget as platform:user, platform:user:channel, or null with no delivery", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    const withChannel = store.add(
      baseInput({ name: "a", delivery: { platform: "discord", user: "U2", channel: "C9" } })
    );
    const withoutChannel = store.add(baseInput({ name: "b", delivery: { platform: "telegram", user: "U1" } }));
    const withoutDelivery = store.add(baseInput({ name: "c" }));

    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.jobs.find((j) => j.id === withChannel.id)!.deliveryTarget).toBe("discord:U2:C9");
    expect(snap.jobs.find((j) => j.id === withoutChannel.id)!.deliveryTarget).toBe("telegram:U1");
    expect(snap.jobs.find((j) => j.id === withoutDelivery.id)!.deliveryTarget).toBeNull();
  });

  it("lastOutcome is null with no history, then the most recent run's outcome once history exists", () => {
    const clock = new ManualClock(1_000);
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput());

    let snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.jobs[0].lastOutcome).toBeNull();

    store.recordRun(job.id, run({ firedAt: 1_000, outcome: "failed" }));
    store.recordRun(job.id, run({ firedAt: 2_000, outcome: "delivered" }));

    snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.jobs[0].lastOutcome).toBe("delivered");
  });

  it("runCount/failCount/abstainCount are cross-checked verbatim against the store's own ScheduledJob fields, never re-derived", () => {
    const clock = new ManualClock(1_000);
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput());
    store.recordRun(job.id, run({ firedAt: 1_000, outcome: "delivered" }));
    store.recordRun(job.id, run({ firedAt: 2_000, outcome: "failed" }));
    store.recordRun(job.id, run({ firedAt: 3_000, outcome: "abstained" }));

    const storeJob = store.get(job.id)!;
    const snap = buildSchedulePaneSnapshot(store, clock);
    const row = snap.jobs[0];

    expect(row.runCount).toBe(storeJob.runCount);
    expect(row.failCount).toBe(storeJob.failCount);
    expect(row.abstainCount).toBe(storeJob.abstainCount);
    expect(row.runCount).toBe(3);
    expect(row.failCount).toBe(1);
    expect(row.abstainCount).toBe(1);
  });

  it("taskKind is read straight from the job's task.kind", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput({ task: { kind: "custom-kind", input: "z" } }));
    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.jobs.find((j) => j.id === job.id)!.taskKind).toBe("custom-kind");
  });
});

// ===========================================================================
// Runs feed — merged ordering, runLimit boundary
// ===========================================================================

describe("buildSchedulePaneSnapshot: runs feed", () => {
  it("merges every job's history into one newest-first (firedAt descending) feed with jobName joined correctly", () => {
    const clock = new ManualClock(10_000);
    const store = new InMemoryJobStore(clock);
    const jobA = store.add(baseInput({ name: "job A" }));
    const jobB = store.add(baseInput({ name: "job B" }));

    // Interleave firedAt across the two jobs.
    store.recordRun(jobA.id, run({ firedAt: 100, outcome: "delivered" }));
    store.recordRun(jobB.id, run({ firedAt: 300, outcome: "failed" }));
    store.recordRun(jobA.id, run({ firedAt: 200, outcome: "abstained" }));
    store.recordRun(jobB.id, run({ firedAt: 400, outcome: "skipped" }));

    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.runs.map((r) => [r.jobName, r.firedAt])).toEqual([
      ["job B", 400],
      ["job B", 300],
      ["job A", 200],
      ["job A", 100],
    ]);
    for (const r of snap.runs) {
      const expectedJob = r.jobName === "job A" ? jobA : jobB;
      expect(r.jobId).toBe(expectedJob.id);
    }
  });

  it("respects a custom runLimit exactly at the boundary", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput());
    for (let i = 0; i < 10; i++) {
      store.recordRun(job.id, run({ firedAt: i, outcome: "delivered" }));
    }

    const snapAll = buildSchedulePaneSnapshot(store, clock, { runLimit: 10 });
    expect(snapAll.runs.length).toBe(10);

    const snapCapped = buildSchedulePaneSnapshot(store, clock, { runLimit: 4 });
    expect(snapCapped.runs.length).toBe(4);
    expect(snapCapped.runs.map((r) => r.firedAt)).toEqual([9, 8, 7, 6]);

    const snapOverLimit = buildSchedulePaneSnapshot(store, clock, { runLimit: 100 });
    expect(snapOverLimit.runs.length).toBe(10);
  });

  it("defaults runLimit to 200", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    // Spread runs across several jobs since the real store caps a single
    // job's history at 50 entries.
    const jobs = Array.from({ length: 6 }, (_, i) => store.add(baseInput({ name: `job-${i}` })));
    let firedAt = 0;
    for (const job of jobs) {
      for (let i = 0; i < 45; i++) {
        firedAt += 1;
        store.recordRun(job.id, run({ firedAt, outcome: "delivered" }));
      }
    }
    // 6 * 45 = 270 total runs recorded, well past the 200 default cap.
    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.runs.length).toBe(200);
    // Newest-first: the very last recorded run (highest firedAt) leads.
    expect(snap.runs[0].firedAt).toBe(firedAt);
  });
});

// ===========================================================================
// Tally — null-iff-no-history, cross-summed against the store's own records
// ===========================================================================

describe("buildSchedulePaneSnapshot: tally", () => {
  it("is null when no job in the store has ever recorded a run", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    store.add(baseInput({ name: "a" }));
    store.add(baseInput({ name: "b", enabled: false }));

    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.tally).toBeNull();
  });

  it("becomes a real, cross-summed tally the moment any job records a run — never a fabricated all-zero placeholder standing in for 'nothing yet'", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    const jobA = store.add(baseInput({ name: "a" }));
    const jobB = store.add(baseInput({ name: "b" }));

    store.recordRun(jobA.id, run({ firedAt: 1, outcome: "delivered" }));
    store.recordRun(jobA.id, run({ firedAt: 2, outcome: "delivered" }));
    store.recordRun(jobA.id, run({ firedAt: 3, outcome: "failed" }));
    store.recordRun(jobB.id, run({ firedAt: 1, outcome: "abstained" }));
    store.recordRun(jobB.id, run({ firedAt: 2, outcome: "withheld" }));
    store.recordRun(jobB.id, run({ firedAt: 3, outcome: "skipped" }));

    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.tally).not.toBeNull();

    // Cross-sum directly from the store's own JobRunRecords — never trust
    // the snapshot's arithmetic without an independent recomputation.
    const expected = { delivered: 0, abstained: 0, withheld: 0, failed: 0, skipped: 0 };
    for (const job of store.list()) {
      for (const r of job.history) {
        expected[r.outcome] += 1;
      }
    }
    expect(snap.tally).toEqual(expected);
    expect(snap.tally).toEqual({ delivered: 2, abstained: 1, withheld: 1, failed: 1, skipped: 1 });
  });

  it("counts runs from every job in the store, not just the first", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    const jobs = Array.from({ length: 4 }, (_, i) => store.add(baseInput({ name: `job-${i}` })));
    jobs.forEach((job, i) => {
      store.recordRun(job.id, run({ firedAt: i + 1, outcome: "delivered" }));
    });

    const snap = buildSchedulePaneSnapshot(store, clock);
    expect(snap.tally!.delivered).toBe(4);
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("buildSchedulePaneSnapshot: determinism", () => {
  it("produces a byte-identical (structurally) snapshot for the same store contents and the same clock reading", () => {
    const clock = new ManualClock(Date.UTC(2026, 5, 1));
    const store = new InMemoryJobStore(clock);
    const jobA = store.add(baseInput({ name: "a", cron: "0 * * * *" }));
    const jobB = store.add(baseInput({ name: "b", cron: "30 9 * * 1-5", timeZone: "America/New_York", enabled: false }));
    store.recordRun(jobA.id, run({ firedAt: 1, outcome: "delivered" }));
    store.recordRun(jobB.id, run({ firedAt: 2, outcome: "failed" }));

    const snap1 = buildSchedulePaneSnapshot(store, clock);
    const snap2 = buildSchedulePaneSnapshot(store, clock);

    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
    expect(snap1).toEqual(snap2);
  });

  it("changes only what the underlying store/clock actually changed, and nothing else", () => {
    const clock = new ManualClock(0);
    const store = new InMemoryJobStore(clock);
    const job = store.add(baseInput());

    const before = buildSchedulePaneSnapshot(store, clock);
    clock.advance(60_000);
    const after = buildSchedulePaneSnapshot(store, clock);

    // Same job, same (still no) history — but nextFireAt tracks the moved
    // clock and is recomputed from the real engine both times.
    const schedule = parseCron(job.cron);
    expect(before.jobs[0].nextFireAt).toBe(nextFireTime(schedule, 0, job.timeZone));
    expect(after.jobs[0].nextFireAt).toBe(nextFireTime(schedule, 60_000, job.timeZone));
    expect(before.tally).toBeNull();
    expect(after.tally).toBeNull();
  });
});
