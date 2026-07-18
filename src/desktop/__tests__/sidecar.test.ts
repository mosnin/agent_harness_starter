import { describe, expect, it } from "vitest";
import { Sidecar, type SwarmFactory, type SwarmHandle } from "../core/sidecar";
import type { AppEvent } from "../ipc/contract";

// ---------------------------------------------------------------------------
// A scripted fake SwarmHandle standing in for the real engine. No LLM, no
// real timers — `dispatchGoal` synchronously mutates the handle's snapshot to
// simulate a goal that plans, dispatches, and verifies instantly, so a single
// poll (which `Sidecar` always performs right after dispatch) sees the full
// end state deterministically.
// ---------------------------------------------------------------------------

function emptyMetrics() {
  return {
    goals: { total: 0, completed: 0, failed: 0, aborted: 0, running: 0 },
    tasks: { total: 0, verified: 0, failed: 0, pending: 0, dispatched: 0 },
    workers: { total: 0, idle: 0, busy: 0, killed: 0, dead: 0 },
    verification: { total: 0, accepted: 0, rejected: 0, avgScore: 0, groundingRate: 0 },
    usage: { toolCalls: 0, costUsd: 0 },
  };
}

interface FakeSnapshot {
  workers: unknown[];
  tasks: unknown[];
  goals: unknown[];
  verifications: unknown[];
  metrics: ReturnType<typeof emptyMetrics>;
}

function makeFake(initial?: Partial<FakeSnapshot>) {
  let snap: FakeSnapshot = {
    workers: initial?.workers ?? [{ workerId: "w1", status: "idle", capabilities: ["general"] }],
    tasks: initial?.tasks ?? [],
    goals: initial?.goals ?? [],
    verifications: initial?.verifications ?? [],
    metrics: initial?.metrics ?? emptyMetrics(),
  };

  const calls = {
    dispatchGoal: [] as string[],
    cancelGoal: [] as string[],
    scalePool: [] as number[],
    killWorker: [] as string[],
  };
  const closed = { value: false };
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  const handle: SwarmHandle = {
    async dispatchGoal(objective: string) {
      calls.dispatchGoal.push(objective);
      const goalId = "goal-1";
      snap = {
        ...snap,
        goals: [{ id: goalId, objective, status: "completed" }],
        tasks: [
          {
            id: "t1",
            description: "do the thing",
            status: "verified",
            requiredCapabilities: ["general"],
            attempts: 1,
            maxAttempts: 3,
            dependsOn: [],
          },
        ],
        verifications: [
          {
            taskId: "t1",
            workerId: "w1",
            verdict: "accept",
            score: 0.92,
            checks: [{ name: "grounded", passed: true, weight: 1, detail: "cited evidence" }],
            feedback: "",
            at: 1,
          },
        ],
        metrics: {
          goals: { total: 1, completed: 1, failed: 0, aborted: 0, running: 0 },
          tasks: { total: 1, verified: 1, failed: 0, pending: 0, dispatched: 0 },
          workers: { total: 1, idle: 1, busy: 0, killed: 0, dead: 0 },
          verification: { total: 1, accepted: 1, rejected: 0, avgScore: 0.92, groundingRate: 1 },
          usage: { toolCalls: 2, costUsd: 0.01 },
        },
      };
      return { goalId };
    },
    async cancelGoal(goalId: string) {
      calls.cancelGoal.push(goalId);
      snap = { ...snap, goals: snap.goals.map((g) => ({ ...(g as object), status: "aborted" })) };
    },
    async scalePool(size: number) {
      calls.scalePool.push(size);
      snap = { ...snap, workers: [...snap.workers, { workerId: "w2", status: "starting", capabilities: ["general"] }] };
    },
    async killWorker(id: string) {
      calls.killWorker.push(id);
      snap = {
        ...snap,
        workers: snap.workers.map((w) =>
          (w as { workerId: string }).workerId === id ? { ...(w as object), status: "killed" } : w
        ),
      };
    },
    snapshot() {
      return snap;
    },
    on(event: string, cb: (payload: unknown) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    async close() {
      closed.value = true;
    },
  };

  return {
    handle,
    calls,
    closed,
    setSnapshot: (s: FakeSnapshot) => {
      snap = s;
    },
    fire: (event: string, payload?: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

function collector() {
  const events: AppEvent[] = [];
  return { events, emit: (e: AppEvent) => events.push(e) };
}

describe("Sidecar", () => {
  it("runtime.start builds the swarm, emits runtime.status, and an initial snapshot", async () => {
    const { handle } = makeFake();
    const { events, emit } = collector();
    const factory: SwarmFactory = async () => handle;
    const sidecar = new Sidecar({ factory, emit, now: () => 100 });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });

    expect(events[0]).toEqual({ kind: "runtime.status", running: true, mode: "inline", poolSize: 1 });
    const workerEvt = events.find((e) => e.kind === "worker.upsert");
    expect(workerEvt).toEqual({
      kind: "worker.upsert",
      worker: { id: "w1", status: "idle", capabilities: ["general"], killReason: undefined },
    });
    const metricsEvt = events.find((e) => e.kind === "metrics");
    expect(metricsEvt).toBeTruthy();
  });

  it("goal.dispatch emits run.upsert then streams mapped task/verification/metrics events", async () => {
    const { handle, calls } = makeFake();
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit, now: () => 1 });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    events.length = 0; // isolate dispatch's own events

    await sidecar.handle({ kind: "goal.dispatch", objective: "ship the thing" });

    expect(calls.dispatchGoal).toEqual(["ship the thing"]);

    const runStatuses = events
      .filter((e): e is Extract<AppEvent, { kind: "run.upsert" }> => e.kind === "run.upsert")
      .map((e) => e.run.status);
    // First the optimistic "running" upsert, then the polled state once the
    // (instantly-completing) fake goal actually finishes.
    expect(runStatuses).toEqual(["running", "completed"]);

    const taskEvt = events.find((e): e is Extract<AppEvent, { kind: "task.upsert" }> => e.kind === "task.upsert");
    expect(taskEvt?.task).toEqual({
      id: "t1",
      description: "do the thing",
      status: "verified",
      requiredCapabilities: ["general"],
      attempts: 1,
      maxAttempts: 3,
      dependsOn: [],
    });

    const metricsEvt = events.find((e): e is Extract<AppEvent, { kind: "metrics" }> => e.kind === "metrics");
    expect(metricsEvt?.metrics).toEqual({
      goalsCompleted: 1,
      goalsTotal: 1,
      groundingRate: 1,
      costUsd: 0.01,
      verifiedTasks: 1,
      rejectedTasks: 0,
    });
  });

  it("maps a verification report's verdict/score/checks and drops the engine-only weight field", async () => {
    const { handle } = makeFake();
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await sidecar.handle({ kind: "goal.dispatch", objective: "ship the thing" });

    const verifEvt = events.find(
      (e): e is Extract<AppEvent, { kind: "verification" }> => e.kind === "verification"
    );
    expect(verifEvt).toBeDefined();
    expect(verifEvt?.report).toEqual({
      taskId: "t1",
      workerId: "w1",
      verdict: "accept",
      score: 0.92,
      checks: [{ name: "grounded", passed: true, detail: "cited evidence" }],
    });
    // The engine's check carried a `weight` used only for gate scoring; make
    // sure it didn't leak into the wire view.
    expect((verifEvt?.report.checks[0] as unknown as { weight?: number }).weight).toBeUndefined();
  });

  it("pool.scale forwards the requested size and emits the resulting snapshot", async () => {
    const { handle, calls } = makeFake();
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    events.length = 0;

    await sidecar.handle({ kind: "pool.scale", size: 5 });

    expect(calls.scalePool).toEqual([5]);
    const workerEvt = events.find(
      (e): e is Extract<AppEvent, { kind: "worker.upsert" }> => e.kind === "worker.upsert" && e.worker.id === "w2"
    );
    expect(workerEvt?.worker.status).toBe("starting");
  });

  it("worker.kill forwards the worker id and emits its updated status", async () => {
    const { handle, calls } = makeFake();
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    events.length = 0;

    await sidecar.handle({ kind: "worker.kill", workerId: "w1" });

    expect(calls.killWorker).toEqual(["w1"]);
    const workerEvt = events.find(
      (e): e is Extract<AppEvent, { kind: "worker.upsert" }> => e.kind === "worker.upsert" && e.worker.id === "w1"
    );
    expect(workerEvt?.worker.status).toBe("killed");
  });

  it("goal.cancel forwards the goalId and maps the engine's aborted status to cancelled", async () => {
    const { handle, calls } = makeFake({
      goals: [{ id: "goal-1", objective: "ship the thing", status: "running" }],
    });
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    events.length = 0;

    await sidecar.handle({ kind: "goal.cancel", goalId: "goal-1" });

    expect(calls.cancelGoal).toEqual(["goal-1"]);
    const runEvt = events.find((e): e is Extract<AppEvent, { kind: "run.upsert" }> => e.kind === "run.upsert");
    expect(runEvt?.run.status).toBe("cancelled");
  });

  it("runtime.stop closes the handle and emits running:false", async () => {
    const { handle, closed } = makeFake();
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 3 });
    await sidecar.handle({ kind: "runtime.stop" });

    expect(closed.value).toBe(true);
    expect(events[events.length - 1]).toEqual({
      kind: "runtime.status",
      running: false,
      mode: "inline",
      poolSize: 3,
    });
  });

  it("a throwing factory/handle never escapes handle() — it becomes a log event", async () => {
    const { events, emit } = collector();
    const failingFactory: SwarmFactory = async () => {
      throw new Error("boom: cannot build swarm");
    };
    const sidecar = new Sidecar({ factory: failingFactory, emit });

    await expect(sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 })).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("log");
    expect((events[0] as Extract<AppEvent, { kind: "log" }>).line).toContain("boom");
  });

  it("a command sent before runtime.start emits a log instead of throwing", async () => {
    const { events, emit } = collector();
    const sidecar = new Sidecar({
      factory: async () => {
        throw new Error("should never be called");
      },
      emit,
    });

    await sidecar.handle({ kind: "goal.dispatch", objective: "too early" });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("log");
  });

  it("re-polls reactively when the handle's `on` fires a progress event", async () => {
    const { handle, fire, setSnapshot } = makeFake();
    const { events, emit } = collector();
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    events.length = 0;

    // Simulate the real engine mutating state and firing one of the manager
    // events Sidecar subscribes to, without going through a Command at all.
    setSnapshot({
      workers: [{ workerId: "w1", status: "busy", capabilities: ["general"] }],
      tasks: [],
      goals: [],
      verifications: [],
      metrics: emptyMetrics(),
    });
    fire("task:dispatched");

    const workerEvt = events.find((e): e is Extract<AppEvent, { kind: "worker.upsert" }> => e.kind === "worker.upsert");
    expect(workerEvt?.worker.status).toBe("busy");
  });

  it("is deterministic: the same factory/now/command sequence yields identical events", async () => {
    async function run(): Promise<AppEvent[]> {
      const { handle } = makeFake();
      const { events, emit } = collector();
      const sidecar = new Sidecar({ factory: async () => handle, emit, now: () => 42 });
      await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 2 });
      await sidecar.handle({ kind: "goal.dispatch", objective: "same objective" });
      await sidecar.handle({ kind: "runtime.stop" });
      return events;
    }

    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });
});
