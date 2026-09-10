/**
 * Hades desktop app — ADVERSARIAL integration audit.
 *
 * The individual unit suites (ipc-contract.test.ts, sidecar.test.ts,
 * bridge.test.ts, app-store.test.ts, renderer.test.ts, ...) each prove one
 * module works in isolation. This file's job is different: attack the seams
 * between them and prove the desktop app is genuinely wired end to end, not
 * a collection of modules that merely typecheck next to each other.
 *
 * Every assertion here is written to FAIL loudly if the thing it's checking
 * is fake, stubbed, or silently dropped — per instruction, nothing here is
 * softened to make the suite green. If a real bug is found, the correct
 * assertion is written and left to fail, with the finding named in the
 * final report rather than the test.
 *
 * Deterministic by construction: every fake SwarmFactory / SwarmHandle
 * resolves and mutates synchronously, there is no real network and no
 * provider keys, and the only "waiting" is flushing already-scheduled
 * microtasks (`await Promise.resolve()`), never a real timer.
 */

import { describe, expect, it } from "vitest";

import {
  encodeCommand,
  decodeCommand,
  encodeEvent,
  decodeEvent,
  isCommand,
  isAppEvent,
  type Command,
  type AppEvent,
} from "../ipc/contract";
import { Sidecar, type SwarmFactory, type SwarmHandle } from "../core/sidecar";
import { devBridge } from "../ui/bridge";
import { createApp, type Bridge } from "../ui/renderer";
import { initialState, reduce, selectors, type AppState } from "../core/app-store";
import { createExecutor, detectInference } from "../core/inference";

// ---------------------------------------------------------------------------
// 1. Contract round-trips — the shared wire is real, not aspirational.
//
// Every Command kind and every AppEvent kind must survive encode -> decode
// unchanged, and the structural guards (isCommand/isAppEvent) must agree.
// This is the seam a fake sidecar (or a fake renderer) would be most tempted
// to skip — if it doesn't round-trip, nothing downstream can be trusted
// regardless of how convincing the UI looks.
// ---------------------------------------------------------------------------

describe("1. IPC contract — every Command/AppEvent kind round-trips over the real codec", () => {
  const commands: Command[] = [
    { kind: "runtime.start", mode: "inline", poolSize: 3 },
    { kind: "runtime.stop" },
    { kind: "goal.dispatch", objective: "ship the audit" },
    { kind: "goal.cancel", goalId: "goal-9" },
    { kind: "pool.scale", size: 5 },
    { kind: "worker.kill", workerId: "w-9" },
    { kind: "skills.list" },
    { kind: "skills.save", name: "grep-codebase", content: "# grep-codebase\n..." },
  ];

  it.each(commands.map((c) => [c.kind, c] as const))(
    "Command %s: encodeCommand -> decodeCommand is lossless and isCommand agrees",
    (_kind, cmd) => {
      expect(isCommand(cmd)).toBe(true);
      const wire = encodeCommand(cmd);
      expect(wire.endsWith("\n")).toBe(true);
      const decoded = decodeCommand(wire);
      expect(decoded).toEqual(cmd);
    }
  );

  it("covers every Command kind declared in the union (fails if a kind is added upstream and not audited here)", () => {
    const seen = new Set(commands.map((c) => c.kind));
    expect(Array.from(seen).sort()).toEqual(
      [
        "goal.cancel",
        "goal.dispatch",
        "pool.scale",
        "runtime.start",
        "runtime.stop",
        "skills.list",
        "skills.save",
        "worker.kill",
      ].sort()
    );
  });

  const events: AppEvent[] = [
    { kind: "runtime.status", running: true, mode: "inline", poolSize: 4 },
    {
      kind: "worker.upsert",
      worker: { id: "w-1", status: "busy", capabilities: ["code", "shell"], killReason: undefined },
    },
    {
      kind: "task.upsert",
      task: {
        id: "t-1",
        description: "audit the wiring",
        status: "dispatched",
        requiredCapabilities: ["code"],
        attempts: 1,
        maxAttempts: 3,
        dependsOn: ["t-0"],
      },
    },
    { kind: "run.upsert", run: { goalId: "g-1", objective: "ship the audit", status: "running" } },
    {
      kind: "verification",
      report: {
        taskId: "t-1",
        workerId: "w-1",
        verdict: "accept",
        score: 0.87,
        checks: [{ name: "grounded", passed: true, detail: "cited evidence" }],
      },
    },
    {
      kind: "certificate",
      cert: { taskId: "t-1", tier: "gold", pCorrect: 0.95, epsilon: 0.03, signature: "sig-abc123", issuedAt: 1_700_000_000_000 },
    },
    {
      kind: "metrics",
      metrics: { goalsCompleted: 2, goalsTotal: 3, groundingRate: 0.81, costUsd: 0.42, verifiedTasks: 5, rejectedTasks: 1 },
    },
    { kind: "skills.list", skills: [{ name: "grep", description: "search files" }] },
    { kind: "log", line: "worker w-1 started", at: 1_700_000_000_001 },
  ];

  it.each(events.map((e) => [e.kind, e] as const))(
    "AppEvent %s: encodeEvent -> decodeEvent is lossless and isAppEvent agrees",
    (_kind, ev) => {
      expect(isAppEvent(ev)).toBe(true);
      const wire = encodeEvent(ev);
      expect(wire.endsWith("\n")).toBe(true);
      const decoded = decodeEvent(wire);
      expect(decoded).toEqual(ev);
    }
  );

  it("covers every AppEvent kind declared in the union", () => {
    const seen = new Set(events.map((e) => e.kind));
    expect(Array.from(seen).sort()).toEqual(
      [
        "certificate",
        "log",
        "metrics",
        "run.upsert",
        "runtime.status",
        "skills.list",
        "task.upsert",
        "verification",
        "worker.upsert",
      ].sort()
    );
  });

  it("decodeCommand rejects a well-formed-JSON-but-wrong-shape payload rather than coercing it", () => {
    expect(() => decodeCommand(JSON.stringify({ kind: "goal.dispatch" /* missing objective */ }))).toThrow();
    expect(() => decodeCommand(JSON.stringify({ kind: "not.a.real.command" }))).toThrow();
    expect(() => decodeCommand("not json at all")).toThrow();
  });

  it("decodeEvent rejects a well-formed-JSON-but-wrong-shape payload rather than coercing it", () => {
    expect(() => decodeEvent(JSON.stringify({ kind: "metrics", metrics: { goalsCompleted: "not a number" } }))).toThrow();
    expect(() => decodeEvent(JSON.stringify({ kind: "not.a.real.event" }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. devBridge with a FAKE SwarmFactory — the renderer's data path is real,
// end to end, in-process. No Tauri, no child process, no network: the fake
// factory stands in for the engine, but Sidecar/devBridge themselves are the
// real production code.
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

/**
 * A scripted fake SwarmHandle. Deliberately includes engine-only fields
 * (handle, lastHeartbeat, load, weight, feedback, input, priority,
 * assignedTo, createdAt, result, contradictions, ...) mirroring the real
 * shapes in src/swarm-runtime/types.ts and manager.ts's WorkerRecord, so the
 * mapping layer (Sidecar's toXView helpers) has something real to strip.
 */
function makeFakeSwarmFactory(): { factory: SwarmFactory; closed: { value: boolean } } {
  const closed = { value: false };
  let snap = {
    workers: [
      {
        workerId: "w-1",
        status: "idle",
        capabilities: ["general"],
        handle: { containerId: "container-internal-only" }, // engine-only
        lastHeartbeat: 1_700_000_000_000, // engine-only
        load: 0.0, // engine-only
      },
    ],
    tasks: [] as unknown[],
    goals: [] as unknown[],
    verifications: [] as unknown[],
    metrics: emptyMetrics(),
  };

  const handle: SwarmHandle = {
    async dispatchGoal(objective: string) {
      const goalId = "goal-audit-1";
      snap = {
        ...snap,
        goals: [{ id: goalId, objective, status: "running", createdAt: 1, taskIds: ["t-audit-1"] }],
        tasks: [
          {
            id: "t-audit-1",
            goalId, // engine-only
            description: "dispatched by the audit",
            requiredCapabilities: ["general"],
            input: { some: "engine-internal-payload" }, // engine-only
            dependsOn: [],
            priority: 1, // engine-only
            status: "dispatched",
            assignedTo: "w-1", // engine-only
            attempts: 1,
            maxAttempts: 3,
            createdAt: 1, // engine-only
          },
        ],
      };
      return { goalId };
    },
    snapshot() {
      return snap;
    },
    on() {
      /* devBridge/Sidecar polls synchronously after each command in this fake */
    },
    async close() {
      closed.value = true;
    },
  };

  return { factory: async () => handle, closed };
}

describe("2. devBridge + fake SwarmFactory — the renderer's data path is real end to end", () => {
  it("runtime.start then goal.dispatch delivers a real AppEvent stream back through onEvent", async () => {
    const { factory } = makeFakeSwarmFactory();
    const bridge = devBridge({ factory });
    const events: AppEvent[] = [];
    bridge.onEvent((e) => events.push(e));

    await bridge.start();
    bridge.send({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await Promise.resolve();
    await Promise.resolve();

    bridge.send({ kind: "goal.dispatch", objective: "ship the audit" });
    await Promise.resolve();
    await Promise.resolve();

    const statusEvt = events.find((e) => e.kind === "runtime.status");
    expect(statusEvt).toEqual({ kind: "runtime.status", running: true, mode: "inline", poolSize: 1 });

    const runEvt = events.find((e): e is Extract<AppEvent, { kind: "run.upsert" }> => e.kind === "run.upsert");
    expect(runEvt?.run).toEqual({ goalId: "goal-audit-1", objective: "ship the audit", status: "running" });

    const taskEvt = events.find((e): e is Extract<AppEvent, { kind: "task.upsert" }> => e.kind === "task.upsert");
    expect(taskEvt?.task.id).toBe("t-audit-1");
    expect(taskEvt?.task.status).toBe("dispatched");
    // Every downstream event must itself satisfy the wire contract, not just
    // "look right" — re-run the exact guard the sidecar-entry process uses.
    expect(isAppEvent(taskEvt)).toBe(true);

    await bridge.stop();
  });

  it("send() before start() and unknown commands never throw and never fabricate a response", async () => {
    const { factory } = makeFakeSwarmFactory();
    const bridge = devBridge({ factory });
    const events: AppEvent[] = [];
    bridge.onEvent((e) => events.push(e));

    // No runtime.start yet — a real sidecar cannot dispatch a goal without a
    // running swarm handle; the bridge must report that honestly (a log
    // event), not silently invent a fake run.
    expect(() => bridge.send({ kind: "goal.dispatch", objective: "too early" })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("log");
    expect(events.some((e) => e.kind === "run.upsert")).toBe(false);

    await bridge.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. renderer (ui/renderer + app-store + views) — real state renders as real
// markup, not placeholder text. Attacks two things specifically: (a) does a
// dispatched task actually show up in html(), and (b) is the trust hero's
// number actually *driven* by the metrics event stream, or is it a
// hardcoded string that happens to look plausible.
// ---------------------------------------------------------------------------

describe("3. renderer — html() reflects real dispatched state, hero numbers are metrics-driven not hardcoded", () => {
  function makeFakeRendererBridge() {
    const sent: Command[] = [];
    let handler: ((e: AppEvent) => void) | null = null;
    const bridge: Bridge = {
      send(cmd) {
        sent.push(cmd);
      },
      onEvent(cb) {
        handler = cb;
        return () => {
          handler = null;
        };
      },
      async start() {},
      async stop() {
        handler = null;
      },
    };
    return { bridge, sent, push: (ev: AppEvent) => handler?.(ev) };
  }

  it("a dispatched task pushed through the bridge shows up verbatim in the Run view's html()", () => {
    const { bridge, push } = makeFakeRendererBridge();
    const app = createApp(bridge, { initialNav: "run" });

    const marker = "audit-marker-do-not-hardcode-this-string-elsewhere";
    push({
      kind: "task.upsert",
      task: {
        id: "t-audit",
        description: marker,
        status: "dispatched",
        requiredCapabilities: ["general"],
        attempts: 1,
        maxAttempts: 3,
      },
    });

    const html = app.html();
    expect(html).toContain(marker);
    expect(html).toContain('data-status="dispatched"');
    app.destroy();
  });

  it("the trust hero's Grounded% is driven by the metrics event, not a hardcoded string — two different metrics events render two different numbers", () => {
    const { bridge, push } = makeFakeRendererBridge();
    const app = createApp(bridge, { initialNav: "trust" });

    // Before any metrics event: groundingPct selector defaults to 0.
    const before = app.html();
    expect(before).toContain('<span class="trust-view__hero-number">0%</span>');

    push({
      kind: "metrics",
      metrics: { goalsCompleted: 1, goalsTotal: 2, groundingRate: 0.37, costUsd: 0, verifiedTasks: 1, rejectedTasks: 0 },
    });
    const afterFirst = app.html();
    expect(afterFirst).toContain('<span class="trust-view__hero-number">37%</span>');
    expect(afterFirst).not.toContain('<span class="trust-view__hero-number">0%</span>');

    // A second, different metrics event must move the rendered number again
    // — if the hero were a hardcoded placeholder this would still read 37%.
    push({
      kind: "metrics",
      metrics: { goalsCompleted: 2, goalsTotal: 2, groundingRate: 0.93, costUsd: 0.02, verifiedTasks: 2, rejectedTasks: 0 },
    });
    const afterSecond = app.html();
    expect(afterSecond).toContain('<span class="trust-view__hero-number">93%</span>');
    expect(afterSecond).not.toContain('<span class="trust-view__hero-number">37%</span>');

    // Sanity: the three renders must actually differ from each other overall
    // (proves onRender/html() aren't returning a cached/static string).
    expect(new Set([before, afterFirst, afterSecond]).size).toBe(3);

    app.destroy();
  });

  it("Settings/Workers/Skills nav content also reflects live state, not a static shell", () => {
    const { bridge, push } = makeFakeRendererBridge();
    const app = createApp(bridge, { initialNav: "settings" });

    push({ kind: "runtime.status", running: true, mode: "inline", poolSize: 7 });
    const html = app.html();
    expect(html).toContain("Pool size: <strong>7</strong>");
    expect(html).toContain("Mode: <strong>inline</strong>");
    app.destroy();
  });
});

// ---------------------------------------------------------------------------
// 4. app-store — reduce is a pure function, and every selector matches a
// hand-computed value over a realistic, non-trivial event sequence (not just
// the trivial single-event cases the unit suite already covers).
// ---------------------------------------------------------------------------

describe("4. app-store — reduce purity and selectors against hand-computed values", () => {
  function buildRealisticSequence(): { state: AppState; events: AppEvent[] } {
    const events: AppEvent[] = [
      { kind: "runtime.status", running: true, mode: "inline", poolSize: 3 },
      { kind: "worker.upsert", worker: { id: "w-2", status: "idle", capabilities: ["general"] } },
      { kind: "worker.upsert", worker: { id: "w-1", status: "busy", capabilities: ["code"] } },
      { kind: "worker.upsert", worker: { id: "w-3", status: "dead", capabilities: ["shell"], killReason: "OOM" } },
      { kind: "task.upsert", task: { id: "A", description: "root task", status: "verified", requiredCapabilities: [], attempts: 1, maxAttempts: 3 } },
      { kind: "task.upsert", task: { id: "B", description: "root task 2", status: "pending", requiredCapabilities: [], attempts: 0, maxAttempts: 3 } },
      { kind: "task.upsert", task: { id: "C", description: "depends on A", status: "verified", requiredCapabilities: [], attempts: 1, maxAttempts: 3, dependsOn: ["A"] } },
      { kind: "task.upsert", task: { id: "D", description: "depends on B and C", status: "rejected", requiredCapabilities: [], attempts: 2, maxAttempts: 3, dependsOn: ["B", "C"] } },
      // Re-upsert A with a changed status: proves upsert replaces in place, not append.
      { kind: "task.upsert", task: { id: "A", description: "root task", status: "verified", requiredCapabilities: [], attempts: 1, maxAttempts: 3 } },
      { kind: "verification", report: { taskId: "A", workerId: "w-1", verdict: "accept", score: 0.9, checks: [] } },
      { kind: "verification", report: { taskId: "C", workerId: "w-1", verdict: "accept", score: 0.85, checks: [] } },
      { kind: "verification", report: { taskId: "D", workerId: "w-2", verdict: "reject", score: 0.2, checks: [] } },
      { kind: "verification", report: { taskId: "D", workerId: "w-2", verdict: "revise", score: 0.4, checks: [] } },
      { kind: "run.upsert", run: { goalId: "g-1", objective: "first goal", status: "completed" } },
      { kind: "run.upsert", run: { goalId: "g-2", objective: "second goal", status: "running" } },
      { kind: "metrics", metrics: { goalsCompleted: 1, goalsTotal: 2, groundingRate: 0.876, costUsd: 0.55, verifiedTasks: 2, rejectedTasks: 1 } },
    ];

    let state = initialState();
    for (const e of events) state = reduce(state, e);
    return { state, events };
  }

  it("reduce never mutates its input state across the whole sequence (frozen-state replay)", () => {
    const { events } = buildRealisticSequence();
    let state = initialState();
    for (const e of events) {
      Object.freeze(state);
      Object.freeze(state.workers);
      Object.freeze(state.tasks);
      Object.freeze(state.runs);
      Object.freeze(state.verifications);
      Object.freeze(state.log);
      // If reduce ever mutated the frozen input in non-strict mode it would
      // silently no-op instead of throwing; the real proof is the *next*
      // line's assertion that state actually advanced.
      const before = state;
      state = reduce(state, e);
      expect(state).not.toBe(before);
    }
  });

  it("selectors match hand-computed values over the realistic sequence", () => {
    const { state } = buildRealisticSequence();

    // liveWorkerCount: w-2 idle, w-1 busy, w-3 dead -> 2 live.
    expect(selectors.liveWorkerCount(state)).toBe(2);

    // verifiedCount: tasks A and C are "verified" (B pending, D rejected) -> 2.
    expect(selectors.verifiedCount(state)).toBe(2);

    // rejectedCount: verifications are accept, accept, reject, revise -> 2 non-accept.
    expect(selectors.rejectedCount(state)).toBe(2);

    // groundingPct: round(0.876 * 100) = 88.
    expect(selectors.groundingPct(state)).toBe(88);

    // tasksByLevel: A,B level 0; C (deps A) level 1; D (deps B,C) level 2.
    const levels = selectors.tasksByLevel(state).map((lvl) => lvl.map((t) => t.id));
    expect(levels).toEqual([["A", "B"], ["C"], ["D"]]);

    // Workers stay sorted by id regardless of upsert order (w-2, w-1, w-3 sent).
    expect(state.workers.map((w) => w.id)).toEqual(["w-1", "w-2", "w-3"]);

    // Tasks keep insertion order, and the re-upsert of A replaced in place
    // rather than moving it or duplicating it.
    expect(state.tasks.map((t) => t.id)).toEqual(["A", "B", "C", "D"]);
    expect(state.tasks.filter((t) => t.id === "A")).toHaveLength(1);

    // Runs are newest-first by insertion, not by any other ordering.
    expect(state.runs.map((r) => r.goalId)).toEqual(["g-2", "g-1"]);
  });
});

// ---------------------------------------------------------------------------
// 5. sidecar engine -> contract mapping — a fake handle exposing engine-only
// fields (WorkerRecord.handle/lastHeartbeat/load, WorkerTask.goalId/input/
// priority/assignedTo/createdAt, VerificationCheck.weight) must never leak
// those fields onto the wire. This is the exact seam a lazy `as unknown as
// View` cast would fake past without anyone noticing.
// ---------------------------------------------------------------------------

describe("5. Sidecar — engine record -> IPC view mapping drops every engine-only field", () => {
  function collector() {
    const events: AppEvent[] = [];
    return { events, emit: (e: AppEvent) => events.push(e) };
  }

  it("worker.upsert carries only WorkerView's fields — handle/lastHeartbeat/load never reach the wire", async () => {
    const { events, emit } = collector();
    const handle: SwarmHandle = {
      dispatchGoal: async (objective: string) => ({ goalId: "unused-" + objective }),
      snapshot: () => ({
        workers: [
          {
            workerId: "w-leak-check",
            status: "busy",
            capabilities: ["general"],
            handle: { containerId: "should-never-leak", pid: 12345 },
            lastHeartbeat: 1_700_000_000_000,
            load: 0.87,
          },
        ],
        tasks: [],
      }),
    };
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });

    const workerEvt = events.find((e): e is Extract<AppEvent, { kind: "worker.upsert" }> => e.kind === "worker.upsert");
    expect(workerEvt).toBeDefined();
    expect(workerEvt!.worker).toEqual({
      id: "w-leak-check",
      status: "busy",
      capabilities: ["general"],
      killReason: undefined,
    });
    // Re-encode over the real wire codec and inspect the raw JSON text itself
    // — the strongest possible check that nothing engine-only survived,
    // independent of how the view object happens to structurally compare.
    const wire = encodeEvent(workerEvt!);
    expect(wire).not.toContain("should-never-leak");
    expect(wire).not.toContain("lastHeartbeat");
    expect(wire).not.toContain("load");
    expect(isAppEvent(JSON.parse(wire))).toBe(true);
  });

  it("task.upsert carries only TaskView's fields — goalId/input/priority/assignedTo/createdAt never reach the wire", async () => {
    const { events, emit } = collector();
    const handle: SwarmHandle = {
      dispatchGoal: async () => ({ goalId: "g-leak" }),
      snapshot: () => ({
        workers: [],
        tasks: [
          {
            id: "t-leak-check",
            goalId: "g-leak-internal",
            description: "should keep this field",
            requiredCapabilities: ["general"],
            input: { secretPayload: "should-never-leak" },
            dependsOn: [],
            priority: 5,
            status: "dispatched",
            assignedTo: "w-1-internal",
            attempts: 1,
            maxAttempts: 3,
            createdAt: 1_700_000_000_000,
          },
        ],
      }),
    };
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });

    const taskEvt = events.find((e): e is Extract<AppEvent, { kind: "task.upsert" }> => e.kind === "task.upsert");
    expect(taskEvt).toBeDefined();
    expect(taskEvt!.task).toEqual({
      id: "t-leak-check",
      description: "should keep this field",
      status: "dispatched",
      requiredCapabilities: ["general"],
      attempts: 1,
      maxAttempts: 3,
      dependsOn: [],
    });
    const wire = encodeEvent(taskEvt!);
    expect(wire).not.toContain("should-never-leak");
    expect(wire).not.toContain("assignedTo");
    expect(wire).not.toContain("priority");
    expect(wire).not.toContain("g-leak-internal");
  });

  it("verification carries only VerificationView's fields — each check's engine-only weight never reaches the wire", async () => {
    const { events, emit } = collector();
    const handle: SwarmHandle = {
      dispatchGoal: async () => ({ goalId: "g-verif" }),
      snapshot: () => ({
        workers: [],
        tasks: [],
        verifications: [
          {
            taskId: "t-verif",
            workerId: "w-1",
            verdict: "accept",
            score: 0.9,
            checks: [{ name: "grounded", passed: true, weight: 0.42, detail: "ok" }],
            feedback: "internal-only-feedback-text",
            at: 1_700_000_000_000,
          },
        ],
      }),
    };
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });

    const verifEvt = events.find((e): e is Extract<AppEvent, { kind: "verification" }> => e.kind === "verification");
    expect(verifEvt).toBeDefined();
    expect(verifEvt!.report.checks).toEqual([{ name: "grounded", passed: true, detail: "ok" }]);
    const wire = encodeEvent(verifEvt!);
    expect(wire).not.toContain("weight");
    expect(wire).not.toContain("internal-only-feedback-text");
  });

  it("a malformed snapshot entry (wrong types) is dropped, not coerced into a fake view", async () => {
    // Regression guard for a real gap this audit caught during development:
    // `toWorkerView` used to build `id` via `str(r.id ?? r.workerId)`, and
    // `str()` silently maps any non-string (e.g. a stray number) to `""` — an
    // empty string still satisfies `isString`, so a malformed record with a
    // wrong-typed id was NOT dropped as `sidecar.ts`'s own doc comment
    // claimed; it produced a phantom worker with `id: ""` on the wire. That
    // has since been fixed (see `idStr` in `../core/sidecar.ts`, which
    // returns `null` — and drops the record — for anything that isn't a
    // non-empty string). This test is kept as the guard against it
    // regressing.
    const { events, emit } = collector();
    const handle: SwarmHandle = {
      dispatchGoal: async () => ({ goalId: "g-bad" }),
      snapshot: () => ({
        workers: [{ workerId: "w-ok", status: "idle", capabilities: [] }, { workerId: 12345 /* wrong type */, status: "idle", capabilities: [] }],
        tasks: [],
      }),
    };
    const sidecar = new Sidecar({ factory: async () => handle, emit });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });

    const workerEvts = events.filter((e): e is Extract<AppEvent, { kind: "worker.upsert" }> => e.kind === "worker.upsert");
    expect(workerEvts.map((e) => e.worker.id)).toEqual(["w-ok"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Mock-masquerade check — the offline inference path must label itself
// honestly and must never report a fake positive cost/value number. This is
// the check that would catch a "demo mode" quietly pretending to be a real,
// paid model run.
// ---------------------------------------------------------------------------

describe("6. core/inference — the mock path is honestly labeled and reports zero, not fabricated, value", () => {
  it("with no provider keys in env, detectInference reports mock with a truthful detail string", () => {
    const mode = detectInference({});
    expect(mode.kind).toBe("mock");
    expect(mode.detail.toLowerCase()).toContain("mock");
  });

  it("createExecutor's mock path never calls a network and always returns usd 0 / zero token counts", async () => {
    const { mode, executor } = createExecutor({ env: {} });
    expect(mode.kind).toBe("mock");

    const result = await executor.run("what is the grounding rate of this swarm?");

    // Zero cost, zero tokens: a mock run must never look like a metered real
    // one. If this ever drifted to a nonzero placeholder "V-TPH$"-style
    // number, this is exactly where it would show up.
    expect(result.usd).toBe(0);
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);

    // The output itself must self-identify as a mock, so it can never be
    // mistaken for a real model's answer downstream (e.g. in a task result
    // shown in the Run view).
    expect(result.output.startsWith("[mock] ")).toBe(true);
    expect(result.output).toContain("NOT a real model output");
  });

  it("is fully deterministic — same prompt in, same mock answer out, twice", async () => {
    const { executor } = createExecutor({ env: {} });
    const a = await executor.run("identical prompt");
    const b = await executor.run("identical prompt");
    expect(a).toEqual(b);
  });

  it("an injected ANTHROPIC_API_KEY (present but not actually called here) flips detection to real, proving mock isn't hardcoded true", () => {
    const mode = detectInference({ ANTHROPIC_API_KEY: "sk-ant-fake-for-detection-only" });
    expect(mode.kind).toBe("real");
    expect(mode.detail).toContain("anthropic");
  });
});
