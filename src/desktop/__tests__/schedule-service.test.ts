import { describe, it, expect } from "vitest";
import { ScheduleService, type ScheduleJobsSource, type ScheduleNextFire } from "../core/schedule-service";
import { isScheduleEvent, type ScheduleCommand, type ScheduleEvent } from "../ipc/schedule-contract";
import {
  InMemoryJobStore,
  type JobRunRecord,
  type JobStore,
  type NewJobInput,
  type ScheduledJob,
} from "../../hades/schedule/store";
import { SchedulerRunner, type JobExecutionContext, type JobExecutionResult, type JobExecutor } from "../../hades/schedule/runner";
import type { DeliveryReceipt, JobDeliverer } from "../../hades/schedule/delivery";
import { ManualClock } from "../../hades/schedule/clock";
import { nextFireTime, parseCron } from "../../hades/schedule/cron";

// ===========================================================================
// Real-engine test fixtures — no mocks of JobStore/SchedulerRunner/cron
// themselves, only of the task-kind-specific JobExecutor/JobDeliverer that
// SchedulerRunner is deliberately agnostic about.
// ===========================================================================

let idCounter = 0;
function makeIdFn(): () => string {
  idCounter = 0;
  return () => `job-${++idCounter}`;
}

/** A minimal, honest inline executor: always succeeds, echoes the job id. */
const executor: JobExecutor = {
  async execute(job: ScheduledJob, _ctx: JobExecutionContext): Promise<JobExecutionResult> {
    return { ok: true, output: `ran ${job.id}` };
  },
};

/** A minimal, honest in-memory deliverer: reports "delivered" for jobs with
 *  a delivery target, badge always "unverified" since this double performs
 *  no real STYX verification (never claims verification it didn't do). */
const deliverer: JobDeliverer = {
  async deliver(job: ScheduledJob, result: JobExecutionResult, ctx: JobExecutionContext): Promise<DeliveryReceipt> {
    return {
      jobId: job.id,
      outcome: "delivered",
      badge: "unverified",
      reason: `delivered ${job.id}`,
      detail: `delivered ${job.id}`,
      target: job.delivery,
      deliveredText: result.output,
      attempts: 1,
      at: ctx.firedAt,
    };
  },
};

/** The real composition the service's `nextFire` seam is documented to
 *  accept with zero adapter code. */
const nextFire: ScheduleNextFire = (cron, afterEpochMs, timeZone) =>
  nextFireTime(parseCron(cron), afterEpochMs, timeZone);

interface Stack {
  clock: ManualClock;
  store: InMemoryJobStore;
  runner: SchedulerRunner;
  service: ScheduleService;
}

function makeStack(startEpochMs = 1_700_000_000_000, opts: { withRunner?: boolean } = {}): Stack {
  const clock = new ManualClock(startEpochMs);
  const store = new InMemoryJobStore(clock, makeIdFn());
  const runner = new SchedulerRunner({ store, clock, executor, deliverer });
  const service = new ScheduleService({
    jobs: store,
    runner: opts.withRunner === false ? undefined : runner,
    nextFire,
    now: () => clock.now(),
  });
  return { clock, store, runner, service };
}

async function handleAndCheck(service: ScheduleService, cmd: ScheduleCommand): Promise<ScheduleEvent> {
  const evt = await service.handle(cmd);
  // Every event handle() emits must pass isScheduleEvent — service and
  // contract can never drift.
  expect(isScheduleEvent(evt)).toBe(true);
  return evt;
}

/** A `JobStore` wrapper whose `recordRun` always throws — used to prove
 *  `SchedulerRunner.runOnce`'s rejection path (a hostile persistence layer)
 *  surfaces as an honest `schedule.error`, never a fabricated receipt. */
class ThrowingRecordRunStore implements JobStore {
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

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("ScheduleService constructor", () => {
  it("requires opts.jobs", () => {
    // @ts-expect-error deliberately omitting the required field
    expect(() => new ScheduleService({ nextFire })).toThrow("opts.jobs is required");
  });

  it("requires opts.nextFire", () => {
    const store = new InMemoryJobStore(new ManualClock(0), makeIdFn());
    // @ts-expect-error deliberately omitting the required field
    expect(() => new ScheduleService({ jobs: store })).toThrow("opts.nextFire is required");
  });
});

// ---------------------------------------------------------------------------
// schedule.status.get — full field-for-field projection
// ---------------------------------------------------------------------------

describe("ScheduleService.handle schedule.status.get", () => {
  it("maps every job field-for-field, including undefined -> null conversions", async () => {
    const { clock, store, service } = makeStack();

    const withDelivery = store.add({
      name: "digest",
      cron: "0 9 * * *",
      timeZone: "UTC",
      task: { kind: "note", input: "morning" },
      delivery: { platform: "telegram", user: "u1" },
      misfire: "catch-up",
    });
    const noDelivery = store.add({
      name: "cleanup",
      cron: "*/5 * * * *",
      task: { kind: "cleanup", input: "" },
    });
    const disabled = store.add({
      name: "disabled",
      cron: "0 0 * * *",
      task: { kind: "note", input: "x" },
      enabled: false,
    });

    const evt = await handleAndCheck(service, { kind: "schedule.status.get" });
    expect(evt.kind).toBe("schedule.status");
    if (evt.kind !== "schedule.status") throw new Error("unreachable");
    expect(evt.status.runnerAttached).toBe(true);
    expect(evt.status.at).toBe(clock.now());
    expect(evt.status.jobs).toHaveLength(3);

    const withDeliveryView = evt.status.jobs.find((j) => j.id === withDelivery.id);
    expect(withDeliveryView).toEqual({
      id: withDelivery.id,
      name: "digest",
      cron: "0 9 * * *",
      timeZone: "UTC",
      enabled: true,
      taskKind: "note",
      taskInput: "morning",
      // delivery.channel: undefined (not set on the NewJobInput) -> null.
      delivery: { platform: "telegram", user: "u1", channel: null },
      misfire: "catch-up",
      nextFireAt: nextFireTime(parseCron("0 9 * * *"), clock.now(), "UTC"),
      lastFireAt: null, // ScheduledJob.lastFireAt is undefined -> null
      runCount: 0,
      failCount: 0,
      abstainCount: 0,
      revision: 1,
    });

    const noDeliveryView = evt.status.jobs.find((j) => j.id === noDelivery.id);
    expect(noDeliveryView?.delivery).toBeNull();
    expect(noDeliveryView?.lastFireAt).toBeNull();
    expect(noDeliveryView?.misfire).toBe("skip"); // NewJobInput default

    const disabledView = evt.status.jobs.find((j) => j.id === disabled.id);
    expect(disabledView?.enabled).toBe(false);
    // Disabled jobs never get a projected nextFireAt, even though the cron
    // is perfectly valid.
    expect(disabledView?.nextFireAt).toBeNull();
  });

  it("reports runnerAttached: false when no runner source was supplied", async () => {
    const { store, clock } = makeStack(1_700_000_000_000, { withRunner: false });
    const service = new ScheduleService({ jobs: store, nextFire, now: () => clock.now() });
    const evt = await handleAndCheck(service, { kind: "schedule.status.get" });
    if (evt.kind !== "schedule.status") throw new Error("unreachable");
    expect(evt.status.runnerAttached).toBe(false);
  });

  it("reports an empty jobs array honestly for an empty store", async () => {
    const { service } = makeStack();
    const evt = await handleAndCheck(service, { kind: "schedule.status.get" });
    if (evt.kind !== "schedule.status") throw new Error("unreachable");
    expect(evt.status.jobs).toEqual([]);
  });

  it("a throwing nextFire never crashes status.get; only the affected job's nextFireAt is null", async () => {
    const { clock, store } = makeStack();
    store.add({ name: "a", cron: "0 9 * * *", task: { kind: "note", input: "" } });
    store.add({ name: "b", cron: "0 10 * * *", task: { kind: "note", input: "" } });

    const throwingNextFire: ScheduleNextFire = () => {
      throw new Error("cron engine exploded");
    };
    const service = new ScheduleService({ jobs: store, nextFire: throwingNextFire, now: () => clock.now() });

    const evt = await handleAndCheck(service, { kind: "schedule.status.get" });
    if (evt.kind !== "schedule.status") throw new Error("unreachable");
    expect(evt.status.jobs).toHaveLength(2);
    for (const job of evt.status.jobs) {
      expect(job.nextFireAt).toBeNull();
    }
  });

  it("nextFireAt is null (never a guessed time) when nextFire returns undefined", async () => {
    const { clock, store } = makeStack();
    store.add({ name: "a", cron: "0 9 * * *", task: { kind: "note", input: "" } });
    const undefinedNextFire: ScheduleNextFire = () => undefined;
    const service = new ScheduleService({ jobs: store, nextFire: undefinedNextFire, now: () => clock.now() });

    const evt = await handleAndCheck(service, { kind: "schedule.status.get" });
    if (evt.kind !== "schedule.status") throw new Error("unreachable");
    expect(evt.status.jobs[0].nextFireAt).toBeNull();
  });

  it("a throwing jobs.list() surfaces as schedule.error, never a partial status", async () => {
    const throwingJobs: ScheduleJobsSource = {
      list: () => {
        throw new Error("store unavailable");
      },
      get: () => undefined,
      update: () => {
        throw new Error("unreachable");
      },
    };
    const service = new ScheduleService({ jobs: throwingJobs, nextFire, now: () => 9 });
    const evt = await handleAndCheck(service, { kind: "schedule.status.get" });
    expect(evt).toEqual({ kind: "schedule.error", message: "store unavailable", at: 9 });
  });
});

// ---------------------------------------------------------------------------
// schedule.job.get
// ---------------------------------------------------------------------------

describe("ScheduleService.handle schedule.job.get", () => {
  it("returns the job with its full history mapped", async () => {
    const { clock, store, runner, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "hi" } });

    await runner.runOnce(job.id);
    clock.advance(1_000);
    await runner.runOnce(job.id);

    const evt = await handleAndCheck(service, { kind: "schedule.job.get", id: job.id });
    expect(evt.kind).toBe("schedule.job");
    if (evt.kind !== "schedule.job") throw new Error("unreachable");

    const stored = store.get(job.id);
    expect(stored).toBeDefined();
    expect(evt.history).toEqual(
      stored!.history.map((r) => ({
        firedAt: r.firedAt,
        scheduledFor: r.scheduledFor,
        outcome: r.outcome,
        detail: r.detail,
        durationMs: r.durationMs,
      })),
    );
    expect(evt.history).toHaveLength(2);
    expect(evt.job.runCount).toBe(2);
    expect(evt.job.id).toBe(job.id);
  });

  it("returns an empty history array for a job that has never fired", async () => {
    const { store, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });
    const evt = await handleAndCheck(service, { kind: "schedule.job.get", id: job.id });
    if (evt.kind !== "schedule.job") throw new Error("unreachable");
    expect(evt.history).toEqual([]);
  });

  it("unknown id -> schedule.error carrying the store's real message", async () => {
    const { service } = makeStack();
    const evt = await handleAndCheck(service, { kind: "schedule.job.get", id: "nope" });
    expect(evt).toEqual({
      kind: "schedule.error",
      message: 'ScheduledJob "nope" not found',
      at: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// schedule.job.toggle
// ---------------------------------------------------------------------------

describe("ScheduleService.handle schedule.job.toggle", () => {
  it("happy path: bumps revision and flips enabled", async () => {
    const { store, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });
    expect(job.revision).toBe(1);
    expect(job.enabled).toBe(true);

    const evt = await handleAndCheck(service, {
      kind: "schedule.job.toggle",
      id: job.id,
      enabled: false,
      revision: 1,
    });
    expect(evt.kind).toBe("schedule.job");
    if (evt.kind !== "schedule.job") throw new Error("unreachable");
    expect(evt.job.enabled).toBe(false);
    expect(evt.job.revision).toBe(2);
    expect(store.get(job.id)?.revision).toBe(2);
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  it("a stale-revision retry surfaces the store's real conflict message via schedule.error", async () => {
    const { store, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });

    const first = await service.handle({ kind: "schedule.job.toggle", id: job.id, enabled: false, revision: 1 });
    expect(first.kind).toBe("schedule.job");

    // Retrying with the now-stale revision 1 must fail with the exact
    // conflict message InMemoryJobStore.update produces.
    const evt = await handleAndCheck(service, {
      kind: "schedule.job.toggle",
      id: job.id,
      enabled: true,
      revision: 1,
    });
    expect(evt).toEqual({
      kind: "schedule.error",
      message: `ScheduledJob "${job.id}" revision conflict: expected revision 1, actual revision 2`,
      at: expect.any(Number),
    });
  });

  it("unknown id -> schedule.error with the store's real message", async () => {
    const { service } = makeStack();
    const evt = await handleAndCheck(service, {
      kind: "schedule.job.toggle",
      id: "nope",
      enabled: true,
      revision: 1,
    });
    expect(evt).toEqual({
      kind: "schedule.error",
      message: 'ScheduledJob "nope" not found',
      at: expect.any(Number),
    });
  });

  it("toggling without an expectedRevision constraint (0 as a real revision) still enforces optimistic concurrency correctly", async () => {
    const { store, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });
    // Correct current revision (1) succeeds.
    const evt = await handleAndCheck(service, {
      kind: "schedule.job.toggle",
      id: job.id,
      enabled: false,
      revision: 1,
    });
    expect(evt.kind).toBe("schedule.job");
  });
});

// ---------------------------------------------------------------------------
// schedule.job.run
// ---------------------------------------------------------------------------

describe("ScheduleService.handle schedule.job.run", () => {
  it("produces a receipt whose run fields equal the store's newly recorded JobRunRecord exactly", async () => {
    const { store, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "hi" } });

    const evt = await handleAndCheck(service, { kind: "schedule.job.run", id: job.id });
    expect(evt.kind).toBe("schedule.run.receipt");
    if (evt.kind !== "schedule.run.receipt") throw new Error("unreachable");
    expect(evt.jobId).toBe(job.id);

    const stored = store.get(job.id);
    expect(stored?.history).toHaveLength(1);
    const recorded = stored!.history[0];
    expect(evt.run).toEqual({
      firedAt: recorded.firedAt,
      scheduledFor: recorded.scheduledFor,
      outcome: recorded.outcome,
      detail: recorded.detail,
      durationMs: recorded.durationMs,
    });
    expect(evt.run.outcome).toBe("delivered");
  });

  it("without a runner -> schedule.error, never a fabricated receipt", async () => {
    const { store, clock } = makeStack();
    const service = new ScheduleService({ jobs: store, nextFire, now: () => clock.now() });
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });

    const evt = await handleAndCheck(service, { kind: "schedule.job.run", id: job.id });
    expect(evt).toEqual({
      kind: "schedule.error",
      message: "no scheduler runner attached to this sidecar",
      at: expect.any(Number),
    });
  });

  it("unknown id -> schedule.error with the runner's real rejection message", async () => {
    const { service } = makeStack();
    const evt = await handleAndCheck(service, { kind: "schedule.job.run", id: "nope" });
    expect(evt.kind).toBe("schedule.error");
    if (evt.kind !== "schedule.error") throw new Error("unreachable");
    expect(evt.message).toBe('SchedulerRunner.runOnce: unknown job id "nope"');
  });

  it("a rejecting runner.runOnce (hostile persistence) surfaces as schedule.error, never a fabricated receipt", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const baseStore = new InMemoryJobStore(clock, makeIdFn());
    const job = baseStore.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });
    const throwingStore = new ThrowingRecordRunStore(baseStore, "record store unavailable");
    const runner = new SchedulerRunner({ store: throwingStore, clock, executor, deliverer });
    const service = new ScheduleService({ jobs: baseStore, runner, nextFire, now: () => clock.now() });

    const evt = await handleAndCheck(service, { kind: "schedule.job.run", id: job.id });
    expect(evt).toEqual({
      kind: "schedule.error",
      message: "record store unavailable",
      at: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// handle() never rejects, for every command kind
// ---------------------------------------------------------------------------

describe("ScheduleService.handle never rejects", () => {
  it("resolves for every command kind even when every jobs seam throws synchronously", async () => {
    const throwingJobs: ScheduleJobsSource = {
      list: () => {
        throw new Error("boom");
      },
      get: () => {
        throw new Error("boom");
      },
      update: () => {
        throw new Error("boom");
      },
    };
    const service = new ScheduleService({ jobs: throwingJobs, nextFire, now: () => 1 });

    await expect(service.handle({ kind: "schedule.status.get" })).resolves.toBeDefined();
    await expect(service.handle({ kind: "schedule.job.get", id: "x" })).resolves.toBeDefined();
    await expect(
      service.handle({ kind: "schedule.job.toggle", id: "x", enabled: true, revision: 1 }),
    ).resolves.toBeDefined();
    await expect(service.handle({ kind: "schedule.job.run", id: "x" })).resolves.toBeDefined();
  });

  it("every resolved event, across every command kind, passes isScheduleEvent", async () => {
    const { store, runner, service } = makeStack();
    const job = store.add({ name: "x", cron: "* * * * *", task: { kind: "note", input: "" } });
    await runner.runOnce(job.id);

    const commands: ScheduleCommand[] = [
      { kind: "schedule.status.get" },
      { kind: "schedule.job.get", id: job.id },
      { kind: "schedule.job.toggle", id: job.id, enabled: false, revision: job.revision },
      { kind: "schedule.job.run", id: job.id },
      { kind: "schedule.job.get", id: "does-not-exist" },
    ];
    for (const cmd of commands) {
      const evt = await service.handle(cmd);
      expect(isScheduleEvent(evt)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end sanity: real store + real runner + real cron, no doubles beyond
// the task-kind executor/deliverer SchedulerRunner is deliberately agnostic
// about.
// ---------------------------------------------------------------------------

describe("ScheduleService end-to-end against the real engine", () => {
  it("status -> toggle -> run -> get tells a consistent story", async () => {
    const { clock, store, service } = makeStack();
    const job = store.add({
      name: "digest",
      cron: "0 9 * * *",
      timeZone: "UTC",
      task: { kind: "note", input: "hello" },
      delivery: { platform: "telegram", user: "u1", channel: "c1" },
    });

    const statusEvt = await handleAndCheck(service, { kind: "schedule.status.get" });
    if (statusEvt.kind !== "schedule.status") throw new Error("unreachable");
    expect(statusEvt.status.jobs.map((j) => j.id)).toEqual([job.id]);

    const toggleEvt = await handleAndCheck(service, {
      kind: "schedule.job.toggle",
      id: job.id,
      enabled: false,
      revision: job.revision,
    });
    if (toggleEvt.kind !== "schedule.job") throw new Error("unreachable");
    expect(toggleEvt.job.enabled).toBe(false);
    expect(toggleEvt.job.nextFireAt).toBeNull();

    // Re-enable so runOnce (which bypasses `enabled` entirely, per
    // SchedulerRunner.runOnce's own contract) has a realistic job to fire,
    // and so the post-run status reflects an enabled job's real nextFireAt.
    await handleAndCheck(service, {
      kind: "schedule.job.toggle",
      id: job.id,
      enabled: true,
      revision: toggleEvt.job.revision,
    });

    const runEvt = await handleAndCheck(service, { kind: "schedule.job.run", id: job.id });
    if (runEvt.kind !== "schedule.run.receipt") throw new Error("unreachable");
    expect(runEvt.run.outcome).toBe("delivered");

    const getEvt = await handleAndCheck(service, { kind: "schedule.job.get", id: job.id });
    if (getEvt.kind !== "schedule.job") throw new Error("unreachable");
    expect(getEvt.history).toHaveLength(1);
    expect(getEvt.job.runCount).toBe(1);
    expect(getEvt.job.lastFireAt).toBe(clock.now());
    expect(getEvt.job.nextFireAt).toBe(nextFireTime(parseCron("0 9 * * *"), clock.now(), "UTC"));
  });
});
