import { describe, expect, it } from "vitest";

import { ManualClock } from "../clock";
import {
  InMemoryJobStore,
  type JobRunRecord,
  type JobStore,
  type MisfirePolicy,
  type NewJobInput,
  type ScheduledJob,
} from "../store";
import {
  SchedulerRunner,
  type JobExecutionContext,
  type JobExecutionResult,
  type JobExecutor,
  type SchedulerEvent,
} from "../runner";
import type { DeliveryReceipt } from "../delivery";

// ===========================================================================
// Test doubles — honest recording fakes, never a stand-in for the real
// engine. `overrides` is mutable so a test can register a job-specific
// behavior (including for a job created *after* the runner was constructed
// and a tick is already mid-flight — see the overlap and event-order tests).
// ===========================================================================

interface ExecutorCall {
  jobId: string;
  ctx: JobExecutionContext;
}

function makeExecutor(
  initial: Record<string, (ctx: JobExecutionContext) => Promise<JobExecutionResult>> = {},
): JobExecutor & { calls: ExecutorCall[]; overrides: Record<string, (ctx: JobExecutionContext) => Promise<JobExecutionResult>> } {
  const calls: ExecutorCall[] = [];
  const overrides = { ...initial };
  return {
    calls,
    overrides,
    async execute(job: ScheduledJob, ctx: JobExecutionContext): Promise<JobExecutionResult> {
      calls.push({ jobId: job.id, ctx });
      const fn = overrides[job.id];
      if (fn) return fn(ctx);
      return { ok: true, output: `ran ${job.id}` };
    },
  };
}

/** The subset a test override cares about; `makeDeliverer` normalizes it
 *  into a full, contract-shaped {@link DeliveryReceipt} so the double is
 *  assignable to the real `JobDeliverer` (runner.ts only ever reads
 *  `outcome` and `detail`, but the type contract is the full receipt). */
interface DeliveryReceiptLike {
  outcome: DeliveryReceipt["outcome"];
  detail?: string;
}

interface DeliveryCall {
  jobId: string;
}

function makeDeliverer(
  initial: Record<string, (result: JobExecutionResult, ctx: JobExecutionContext) => Promise<DeliveryReceiptLike>> = {},
) {
  const calls: DeliveryCall[] = [];
  const overrides = { ...initial };
  const toReceipt = (job: ScheduledJob, ctx: JobExecutionContext, like: DeliveryReceiptLike): DeliveryReceipt => {
    const reason = like.detail ?? "";
    return {
      jobId: job.id,
      outcome: like.outcome,
      // The double never claims verification it didn't do: only the real
      // VerifiedDeliveryRouter (backed by assessReply) may say "verified".
      badge: "unverified",
      reason,
      detail: reason,
      attempts: 1,
      at: ctx.firedAt,
    };
  };
  return {
    calls,
    overrides,
    async deliver(job: ScheduledJob, result: JobExecutionResult, ctx: JobExecutionContext): Promise<DeliveryReceipt> {
      calls.push({ jobId: job.id });
      const fn = overrides[job.id];
      const like = fn ? await fn(result, ctx) : { outcome: "delivered" as const, detail: `delivered ${job.id}` };
      return toReceipt(job, ctx, like);
    },
  };
}

/** A `JobStore` wrapper whose `recordRun` can be made to throw on demand —
 *  simulates a hostile / failing persistence layer without touching the
 *  real store's own (already-tested) internals. */
class RecordRunThrowingStore implements JobStore {
  constructor(
    private readonly inner: JobStore,
    private readonly message: string,
  ) {}
  list(): ScheduledJob[] {
    return this.inner.list();
  }
  get(id: string): ScheduledJob | undefined {
    return this.inner.get(id);
  }
  add(input: NewJobInput): ScheduledJob {
    return this.inner.add(input);
  }
  update(id: string, patch: Parameters<JobStore["update"]>[1], expectedRevision?: number): ScheduledJob {
    return this.inner.update(id, patch, expectedRevision);
  }
  remove(id: string): boolean {
    return this.inner.remove(id);
  }
  recordRun(_id: string, _run: JobRunRecord): ScheduledJob {
    throw new Error(this.message);
  }
  loadReport(): ReturnType<JobStore["loadReport"]> {
    return this.inner.loadReport();
  }
}

// ===========================================================================
// Fixtures
// ===========================================================================

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `job-${idCounter}`;
}

function makeStore(clock: ManualClock): InMemoryJobStore {
  return new InMemoryJobStore(clock, nextId);
}

/** 2024-01-01T00:00:00Z — a UTC instant already aligned to a 5-minute
 *  boundary, so the "every 5 minutes" cron arithmetic below is exact and
 *  hand-checkable. */
const EPOCH = Date.UTC(2024, 0, 1, 0, 0, 0);
const MIN = 60_000;

function baseJobInput(overrides: Partial<NewJobInput> = {}): NewJobInput {
  return {
    name: "test job",
    cron: "*/5 * * * *",
    timeZone: "UTC",
    task: { kind: "noop", input: "x" },
    misfire: "skip",
    ...overrides,
  };
}

function setupBacklog(misfire: MisfirePolicy, catchUpLimit = 5) {
  const clock = new ManualClock(EPOCH);
  const store = makeStore(clock);
  const job = store.add(baseJobInput({ misfire, catchUpLimit }));
  clock.advance(25 * MIN); // due: :05 :10 :15 :20 :25 — 5 missed instants
  return { clock, store, job };
}

// ===========================================================================
// Boundary determinism / idempotence
// ===========================================================================

describe("SchedulerRunner.tick — boundary firing", () => {
  it("fires nothing before the boundary, exactly once at the boundary (scheduledFor on the boundary), and is idempotent on repeat", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput());
    const executor = makeExecutor();
    const deliverer = makeDeliverer();
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    clock.advance(4 * MIN + 59_000); // 4m59s
    let report = await runner.tick();
    expect(report.fired).toHaveLength(0);
    expect(report.evaluated).toBe(1);
    expect(executor.calls).toHaveLength(0);

    clock.advance(1_000); // now exactly :05:00
    report = await runner.tick();
    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 5 * MIN, outcome: "delivered" }]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].ctx).toEqual({ scheduledFor: EPOCH + 5 * MIN, firedAt: EPOCH + 5 * MIN, manual: false });

    const updated = store.get(job.id)!;
    expect(updated.lastFireAt).toBe(EPOCH + 5 * MIN);
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0]).toMatchObject({
      firedAt: EPOCH + 5 * MIN,
      scheduledFor: EPOCH + 5 * MIN,
      outcome: "delivered",
      detail: "no delivery target — result stored only",
    });
    expect(updated.runCount).toBe(1);

    // Idempotent: ticking again at the exact same `now` fires nothing.
    report = await runner.tick();
    expect(report.fired).toHaveLength(0);
    expect(executor.calls).toHaveLength(1);
    expect(store.get(job.id)!.revision).toBe(updated.revision);
  });

  it("a job with nothing due is left completely untouched — no store write happens at all", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput());
    const before = store.get(job.id)!;
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    clock.advance(MIN); // 1 minute — not yet due for */5
    const report = await runner.tick();
    expect(report.fired).toHaveLength(0);
    expect(report.evaluated).toBe(1);

    const after = store.get(job.id)!;
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.history).toEqual([]);
  });
});

// ===========================================================================
// Misfire / catch-up policy
// ===========================================================================

describe("SchedulerRunner.tick — misfire policy on a 5-instant backlog (25 minutes of downtime)", () => {
  it('"catch-up" (limit 3) fires exactly the 3 oldest instants and reports the 2 remaining as missed', async () => {
    const { clock, store, job } = setupBacklog("catch-up", 3);
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    const report = await runner.tick();

    expect(report.fired.map((f) => f.scheduledFor)).toEqual([EPOCH + 5 * MIN, EPOCH + 10 * MIN, EPOCH + 15 * MIN]);
    expect(report.fired.every((f) => f.outcome === "delivered")).toBe(true);
    expect(report.misfiresSkipped).toEqual([{ jobId: job.id, missed: 2 }]);

    const updated = store.get(job.id)!;
    expect(updated.lastFireAt).toBe(EPOCH + 15 * MIN);
    expect(updated.history).toHaveLength(3);
    expect(updated.history.map((h) => h.scheduledFor)).toEqual([EPOCH + 5 * MIN, EPOCH + 10 * MIN, EPOCH + 15 * MIN]);

    // The next tick (still at the same `now`) picks up the remaining 2.
    const report2 = await runner.tick();
    expect(report2.fired.map((f) => f.scheduledFor)).toEqual([EPOCH + 20 * MIN, EPOCH + 25 * MIN]);
    expect(report2.misfiresSkipped).toEqual([]);
    expect(store.get(job.id)!.lastFireAt).toBe(EPOCH + 25 * MIN);

    // Fully caught up now: a third tick fires nothing further.
    const report3 = await runner.tick();
    expect(report3.fired).toHaveLength(0);
  });

  it('"fire-once" fires exactly one execution, for the latest missed instant, coalescing all 5 into it', async () => {
    const { clock, store, job } = setupBacklog("fire-once");
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    const report = await runner.tick();

    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 25 * MIN, outcome: "delivered" }]);
    expect(report.misfiresSkipped).toEqual([{ jobId: job.id, missed: 4 }]);

    const updated = store.get(job.id)!;
    expect(updated.lastFireAt).toBe(EPOCH + 25 * MIN);
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0].detail).toContain("coalesced 5 missed fires");

    // No re-fire on a subsequent tick at the same `now`.
    expect((await runner.tick()).fired).toHaveLength(0);
  });

  it('"skip" fires only the newest missed instant and drops the rest — never retried', async () => {
    const { clock, store, job } = setupBacklog("skip");
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    const report = await runner.tick();

    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 25 * MIN, outcome: "delivered" }]);
    expect(report.misfiresSkipped).toEqual([{ jobId: job.id, missed: 4 }]);
    expect(store.get(job.id)!.lastFireAt).toBe(EPOCH + 25 * MIN);
    expect(store.get(job.id)!.history).toHaveLength(1);

    expect((await runner.tick()).fired).toHaveLength(0);
  });
});

// ===========================================================================
// Downtime recovery across a simulated process restart
// ===========================================================================

describe("SchedulerRunner.tick — downtime recovery on a fresh runner (simulated restart)", () => {
  it("applies misfire policy correctly with no phantom fires before lastFireAt and nothing missed after", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ misfire: "skip" }));

    // Simulate the previous process instance having last fired at :01, then
    // the whole process being down for 2 hours before this fresh runner
    // (a brand-new SchedulerRunner instance — no shared in-memory state
    // with whatever ran before) ticks for the first time.
    store.update(job.id, { lastFireAt: EPOCH + MIN });
    clock.set(EPOCH + MIN + 2 * 60 * MIN); // now = lastFireAt + 2h = 02:01:00

    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });
    const report = await runner.tick();

    // Due instants after 00:01 up to 02:01 are every 5-min boundary from
    // 00:05 through 02:00 inclusive: 24 instants. "skip" fires only 02:00.
    const latestDue = EPOCH + 120 * MIN; // 02:00:00
    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: latestDue, outcome: "delivered" }]);
    expect(report.misfiresSkipped).toEqual([{ jobId: job.id, missed: 23 }]);
    expect(latestDue).toBeGreaterThan(EPOCH + MIN); // no phantom fire before the old lastFireAt

    const updated = store.get(job.id)!;
    expect(updated.lastFireAt).toBe(latestDue);

    // Nothing missed after: a further tick at the same `now` fires nothing.
    const report2 = await runner.tick();
    expect(report2.fired).toHaveLength(0);
    expect(report2.misfiresSkipped).toHaveLength(0);
  });
});

// ===========================================================================
// Overlap protection
// ===========================================================================

describe("SchedulerRunner.tick — overlap protection", () => {
  it("a job whose previous firing hasn't resolved is not re-fired; the skip is reported and reconciled once it resolves", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ misfire: "skip" }));

    let resolveExec!: (r: JobExecutionResult) => void;
    const pending = new Promise<JobExecutionResult>((resolve) => {
      resolveExec = resolve;
    });
    const executor = makeExecutor({ [job.id]: () => pending });
    const deliverer = makeDeliverer();
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    clock.advance(5 * MIN); // due at :05

    // Kick off a tick whose executor call never resolves — the runner
    // synchronously marks the job in-flight before suspending on it.
    const tick1 = runner.tick();

    const report2 = await runner.tick(); // a second, concurrent due tick
    expect(report2.overlapsSkipped).toEqual([job.id]);
    expect(report2.fired).toHaveLength(0);

    const mid = store.get(job.id)!;
    expect(mid.lastFireAt).toBeUndefined(); // nothing actually fired — baseline unmoved
    expect(mid.history).toHaveLength(1);
    expect(mid.history[0]).toMatchObject({ outcome: "skipped", detail: "overlap", scheduledFor: EPOCH + 5 * MIN });

    resolveExec({ ok: true, output: "done" });
    const report1 = await tick1;
    expect(report1.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 5 * MIN, outcome: "delivered" }]);
    expect(store.get(job.id)!.lastFireAt).toBe(EPOCH + 5 * MIN);

    // After resolution, the next boundary fires completely normally.
    clock.advance(5 * MIN);
    const report3 = await runner.tick();
    expect(report3.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 10 * MIN, outcome: "delivered" }]);
  });
});

// ===========================================================================
// Failure containment: executor throw, deliverer throw, hostile store
// ===========================================================================

describe("SchedulerRunner.tick — failure containment", () => {
  it("an executor throw is caught, recorded as a failed run, surfaced in errors, and never re-fired forever", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput());
    const executor = makeExecutor({
      [job.id]: async () => {
        throw new Error("boom-exec");
      },
    });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer: makeDeliverer() });

    clock.advance(5 * MIN);
    const report = await runner.tick();

    expect(report.errors).toEqual([{ jobId: job.id, message: "boom-exec" }]);
    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 5 * MIN, outcome: "failed" }]);

    const updated = store.get(job.id)!;
    expect(updated.lastFireAt).toBe(EPOCH + 5 * MIN); // advances even on throw
    expect(updated.failCount).toBe(1);
    expect(updated.history[0]).toMatchObject({ outcome: "failed", detail: "boom-exec" });

    const report2 = await runner.tick();
    expect(report2.fired).toHaveLength(0); // proven: not re-fired forever
  });

  it("a deliverer throw is caught, recorded as a failed run distinct from an executor failure, and surfaced in errors", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ delivery: { platform: "slack", user: "U1" } }));
    const executor = makeExecutor();
    const deliverer = makeDeliverer({
      [job.id]: async () => {
        throw new Error("boom-deliver");
      },
    });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer });

    clock.advance(5 * MIN);
    const report = await runner.tick();

    expect(report.errors).toEqual([{ jobId: job.id, message: "boom-deliver" }]);
    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 5 * MIN, outcome: "failed" }]);
    expect(executor.calls).toHaveLength(1); // the executor itself did run
    expect(deliverer.calls).toHaveLength(1);

    const updated = store.get(job.id)!;
    expect(updated.history[0].detail).toBe("delivery failed: boom-deliver");
    expect(updated.lastFireAt).toBe(EPOCH + 5 * MIN);
  });

  it("a store.recordRun throw (a hostile store) is caught, surfaced in errors, and does not crash the tick", async () => {
    const clock = new ManualClock(EPOCH);
    const inner = makeStore(clock);
    const job = inner.add(baseJobInput());
    const store = new RecordRunThrowingStore(inner, "store is on fire");
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    clock.advance(5 * MIN);
    const report = await runner.tick();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({ jobId: job.id, message: "store.recordRun failed: store is on fire" });
    // The execution itself still happened and is reported, even though
    // persisting its outcome failed.
    expect(report.fired).toEqual([{ jobId: job.id, scheduledFor: EPOCH + 5 * MIN, outcome: "delivered" }]);
  });
});

// ===========================================================================
// Tampered / degenerate store data never crashes the tick
// ===========================================================================

describe("SchedulerRunner.tick — resilience to disabled jobs and tampered records", () => {
  it("a disabled job is left completely untouched: no fire, no error, no executor call", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput());
    store.update(job.id, { enabled: false });
    const executor = makeExecutor();
    const runner = new SchedulerRunner({ store, clock, executor, deliverer: makeDeliverer() });

    clock.advance(60 * MIN);
    const report = await runner.tick();

    expect(report.fired).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
    expect(report.evaluated).toBe(0);
    expect(executor.calls).toHaveLength(0);
  });

  it("a job whose cron is unparseable (simulating on-disk tampering) is reported as an error, never crashes the tick, and sibling jobs still run", async () => {
    const clock = new ManualClock(EPOCH);
    const inner = makeStore(clock);
    const goodJob = inner.add(baseJobInput());
    const badJob = inner.add(baseJobInput());

    // The real store's own add()/update() validate `cron` and would refuse
    // this — a corrupted-on-disk record only enters the picture through the
    // store's *reading* surface, so this wrapper simulates that by handing
    // back a tampered copy from list() only.
    const store: JobStore = {
      list: () => inner.list().map((j) => (j.id === badJob.id ? { ...j, cron: "not a cron expression" } : j)),
      get: (id) => inner.get(id),
      add: (input) => inner.add(input),
      update: (id, patch, rev) => inner.update(id, patch, rev),
      remove: (id) => inner.remove(id),
      recordRun: (id, run) => inner.recordRun(id, run),
      loadReport: () => inner.loadReport(),
    };
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    clock.advance(5 * MIN);
    const report = await runner.tick();

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].jobId).toBe(badJob.id);
    expect(report.errors[0].message).toMatch(/unparseable cron/i);
    expect(report.fired).toEqual([{ jobId: goodJob.id, scheduledFor: EPOCH + 5 * MIN, outcome: "delivered" }]);
  });
});

// ===========================================================================
// DST-aware time-zone firing, asserted on exact epochs
// ===========================================================================

describe("SchedulerRunner.tick — DST-aware time-zone firing", () => {
  it("fires at 13:00 UTC for a 0 9 * * * America/New_York job during EDT (summer)", async () => {
    const clock = new ManualClock(Date.UTC(2024, 6, 10, 0, 0, 0)); // 2024-07-10T00:00:00Z
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ cron: "0 9 * * *", timeZone: "America/New_York" }));
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    clock.set(Date.UTC(2024, 6, 10, 13, 0, 0));
    const report = await runner.tick();

    expect(report.fired).toEqual([
      { jobId: job.id, scheduledFor: Date.UTC(2024, 6, 10, 13, 0, 0), outcome: "delivered" },
    ]);
  });

  it("fires at 14:00 UTC for the same 0 9 * * * America/New_York job during EST (winter)", async () => {
    const clock = new ManualClock(Date.UTC(2024, 0, 10, 0, 0, 0)); // 2024-01-10T00:00:00Z
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ cron: "0 9 * * *", timeZone: "America/New_York" }));
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    clock.set(Date.UTC(2024, 0, 10, 14, 0, 0));
    const report = await runner.tick();

    expect(report.fired).toEqual([
      { jobId: job.id, scheduledFor: Date.UTC(2024, 0, 10, 14, 0, 0), outcome: "delivered" },
    ]);
  });
});

// ===========================================================================
// Event stream ordering across a single mixed tick
// ===========================================================================

describe("SchedulerRunner — event stream ordering", () => {
  it("emits overlap, fired+delivery, misfire, and executor-error events in the exact order they occur", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);

    // jobC is created first and will still be in-flight from a prior tick
    // by the time the "mixed" tick runs.
    const jobC = store.add(baseJobInput({ name: "c" }));

    let resolveExec!: (r: JobExecutionResult) => void;
    const pending = new Promise<JobExecutionResult>((resolve) => {
      resolveExec = resolve;
    });
    const executor = makeExecutor({ [jobC.id]: () => pending });
    const deliverer = makeDeliverer();
    const events: SchedulerEvent[] = [];
    const runner = new SchedulerRunner({ store, clock, executor, deliverer, onEvent: (e) => events.push(e) });

    clock.advance(5 * MIN); // :05 — jobC now due

    const tick1 = runner.tick(); // fires jobC, hangs on the pending executor promise

    // Register the rest of the jobs while jobC's firing is still in flight.
    const jobA = store.add(baseJobInput({ name: "a", delivery: { platform: "slack", user: "U1" } }));
    store.update(jobA.id, { lastFireAt: EPOCH }); // exactly one instant (:05) due

    const jobB = store.add(baseJobInput({ name: "b", misfire: "skip" }));
    store.update(jobB.id, { lastFireAt: EPOCH - 15 * MIN }); // 4 instants due: -10,-5,0,+5

    const jobD = store.add(baseJobInput({ name: "d" }));
    store.update(jobD.id, { lastFireAt: EPOCH }); // exactly one instant (:05) due
    executor.overrides[jobD.id] = async () => {
      throw new Error("boom-d");
    };

    const report2 = await runner.tick();

    expect(report2.overlapsSkipped).toEqual([jobC.id]);
    expect(report2.misfiresSkipped).toEqual([{ jobId: jobB.id, missed: 3 }]);
    expect(report2.errors).toEqual([{ jobId: jobD.id, message: "boom-d" }]);
    expect(report2.fired.map((f) => f.jobId)).toEqual([jobA.id, jobB.id, jobD.id]);

    expect(events.map((e) => `${e.kind}:${e.jobId}`)).toEqual([
      `overlap-skipped:${jobC.id}`,
      `fired:${jobA.id}`,
      `delivery:${jobA.id}`,
      `misfire-skipped:${jobB.id}`,
      `fired:${jobB.id}`,
      `executor-error:${jobD.id}`,
    ]);

    resolveExec({ ok: true, output: "done-c" });
    const report1 = await tick1;
    expect(report1.fired).toEqual([{ jobId: jobC.id, scheduledFor: EPOCH + 5 * MIN, outcome: "delivered" }]);

    // jobC's own "fired" event lands only once its execution resolves.
    expect(events.map((e) => `${e.kind}:${e.jobId}`)).toEqual([
      `overlap-skipped:${jobC.id}`,
      `fired:${jobA.id}`,
      `delivery:${jobA.id}`,
      `misfire-skipped:${jobB.id}`,
      `fired:${jobB.id}`,
      `executor-error:${jobD.id}`,
      `fired:${jobC.id}`,
    ]);
  });
});

// ===========================================================================
// runOnce
// ===========================================================================

describe("SchedulerRunner.runOnce", () => {
  it("fires immediately regardless of schedule and enabled state, with manual:true and scheduledFor === firedAt === now", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ enabled: false, cron: "0 0 1 1 *" })); // fires once a year, and disabled
    const executor = makeExecutor();
    const runner = new SchedulerRunner({ store, clock, executor, deliverer: makeDeliverer() });

    const record = await runner.runOnce(job.id);

    expect(record).toMatchObject({ scheduledFor: EPOCH, firedAt: EPOCH, outcome: "delivered" });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].ctx).toEqual({ scheduledFor: EPOCH, firedAt: EPOCH, manual: true });

    const updated = store.get(job.id)!;
    expect(updated.history).toHaveLength(1);
    expect(updated.runCount).toBe(1);
    expect(updated.enabled).toBe(false); // runOnce does not touch enabled/schedule state
  });

  it("throws for an unknown job id", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    await expect(runner.runOnce("does-not-exist")).rejects.toThrow(/unknown job id/i);
  });

  it("records a failed run (never throws) when the executor throws during a manual run", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput());
    const executor = makeExecutor({
      [job.id]: async () => {
        throw new Error("manual-boom");
      },
    });
    const runner = new SchedulerRunner({ store, clock, executor, deliverer: makeDeliverer() });

    const record = await runner.runOnce(job.id);
    expect(record.outcome).toBe("failed");
    expect(record.detail).toBe("manual-boom");
  });

  it("respects a job's delivery target exactly like a scheduled fire does", async () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const job = store.add(baseJobInput({ delivery: { platform: "slack", user: "U1" } }));
    const deliverer = makeDeliverer({
      [job.id]: async () => ({ outcome: "abstained" as const, detail: "held back by the gate" }),
    });
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer });

    const record = await runner.runOnce(job.id);
    expect(record.outcome).toBe("abstained");
    expect(record.detail).toBe("held back by the gate");
  });
});

// ===========================================================================
// start()/stop()/running() — production convenience, not used to drive
// firing logic anywhere else in this suite.
// ===========================================================================

describe("SchedulerRunner.start/stop/running", () => {
  it("toggles running() and is safe to stop before its poll timer ever fires", () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    expect(runner.running()).toBe(false);
    runner.start(60_000);
    expect(runner.running()).toBe(true);
    runner.stop();
    expect(runner.running()).toBe(false);
    runner.stop(); // idempotent
    expect(runner.running()).toBe(false);
  });

  it("start() is a no-op when already running", () => {
    const clock = new ManualClock(EPOCH);
    const store = makeStore(clock);
    const runner = new SchedulerRunner({ store, clock, executor: makeExecutor(), deliverer: makeDeliverer() });

    runner.start(60_000);
    expect(runner.running()).toBe(true);
    runner.start(60_000); // no-op, does not throw or double-arm
    expect(runner.running()).toBe(true);
    runner.stop();
  });
});
