import { describe, it, expect } from "vitest";
import { initialState, reduce, selectors, type AppState } from "../core/app-store";
import type {
  AppEvent,
  WorkerView,
  TaskView,
  RunView,
  VerificationView,
  CertificateView,
  MetricsView,
} from "../ipc/contract";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function worker(id: string, status: WorkerView["status"] = "idle"): WorkerView {
  return { id, status, capabilities: ["code"] };
}

function task(
  id: string,
  status: TaskView["status"] = "pending",
  dependsOn?: string[],
): TaskView {
  return {
    id,
    description: `task ${id}`,
    status,
    requiredCapabilities: [],
    attempts: 0,
    maxAttempts: 3,
    ...(dependsOn ? { dependsOn } : {}),
  };
}

function run(goalId: string, status: RunView["status"] = "running"): RunView {
  return { goalId, objective: `objective ${goalId}`, status };
}

function verification(
  taskId: string,
  verdict: VerificationView["verdict"],
): VerificationView {
  return { taskId, workerId: "w-1", verdict, score: 0.5, checks: [] };
}

function certificate(taskId: string, issuedAt: number): CertificateView {
  return {
    taskId,
    tier: "gold",
    pCorrect: 0.9,
    epsilon: 0.05,
    signature: `sig-${taskId}`,
    issuedAt,
  };
}

function metrics(overrides: Partial<MetricsView> = {}): MetricsView {
  return {
    goalsCompleted: 1,
    goalsTotal: 2,
    groundingRate: 0.876,
    costUsd: 1.23,
    verifiedTasks: 1,
    rejectedTasks: 0,
    ...overrides,
  };
}

function ev(e: AppEvent): AppEvent {
  return e;
}

// ---------------------------------------------------------------------------
// initialState
// ---------------------------------------------------------------------------

describe("initialState", () => {
  it("returns the expected empty shape", () => {
    const s = initialState();
    expect(s).toEqual({
      running: false,
      mode: "",
      poolSize: 0,
      workers: [],
      tasks: [],
      runs: [],
      verifications: [],
      certificates: [],
      metrics: null,
      skills: [],
      log: [],
    });
  });
});

// ---------------------------------------------------------------------------
// worker.upsert
// ---------------------------------------------------------------------------

describe("worker.upsert", () => {
  it("appends a new worker and keeps the list sorted by id", () => {
    let s = initialState();
    s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-2") }));
    s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-1") }));
    expect(s.workers.map((w) => w.id)).toEqual(["w-1", "w-2"]);
  });

  it("replaces an existing worker by id instead of duplicating it", () => {
    let s = initialState();
    s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-1", "idle") }));
    s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-1", "busy") }));
    expect(s.workers).toHaveLength(1);
    expect(s.workers[0].status).toBe("busy");
  });
});

// ---------------------------------------------------------------------------
// task.upsert / run.upsert / verification / certificate ordering
// ---------------------------------------------------------------------------

describe("task.upsert", () => {
  it("keeps insertion order and replaces by id in place", () => {
    let s = initialState();
    s = reduce(s, ev({ kind: "task.upsert", task: task("t-a") }));
    s = reduce(s, ev({ kind: "task.upsert", task: task("t-b") }));
    s = reduce(s, ev({ kind: "task.upsert", task: task("t-a", "verified") }));
    expect(s.tasks.map((t) => t.id)).toEqual(["t-a", "t-b"]);
    expect(s.tasks[0].status).toBe("verified");
  });
});

describe("run.upsert", () => {
  it("puts new runs at the front (newest first) and updates in place", () => {
    let s = initialState();
    s = reduce(s, ev({ kind: "run.upsert", run: run("g-1") }));
    s = reduce(s, ev({ kind: "run.upsert", run: run("g-2") }));
    expect(s.runs.map((r) => r.goalId)).toEqual(["g-2", "g-1"]);

    s = reduce(s, ev({ kind: "run.upsert", run: run("g-1", "completed") }));
    // g-1 keeps its existing slot rather than jumping back to front.
    expect(s.runs.map((r) => r.goalId)).toEqual(["g-2", "g-1"]);
    expect(s.runs.find((r) => r.goalId === "g-1")?.status).toBe("completed");
  });
});

describe("verification and certificate events", () => {
  it("appends verifications (newest last) and certificates", () => {
    let s = initialState();
    s = reduce(s, ev({ kind: "verification", report: verification("t-1", "accept") }));
    s = reduce(s, ev({ kind: "verification", report: verification("t-2", "reject") }));
    expect(s.verifications.map((v) => v.taskId)).toEqual(["t-1", "t-2"]);

    s = reduce(s, ev({ kind: "certificate", cert: certificate("t-1", 100) }));
    s = reduce(s, ev({ kind: "certificate", cert: certificate("t-2", 200) }));
    expect(s.certificates.map((c) => c.taskId)).toEqual(["t-1", "t-2"]);
  });
});

// ---------------------------------------------------------------------------
// log cap
// ---------------------------------------------------------------------------

describe("log", () => {
  it("caps the log at 200 entries, dropping the oldest first", () => {
    let s = initialState();
    for (let i = 0; i < 205; i++) {
      s = reduce(s, ev({ kind: "log", line: `line-${i}`, at: i }));
    }
    expect(s.log).toHaveLength(200);
    expect(s.log[0].line).toBe("line-5");
    expect(s.log[s.log.length - 1].line).toBe("line-204");
  });
});

// ---------------------------------------------------------------------------
// runtime.status / skills.list
// ---------------------------------------------------------------------------

describe("runtime.status and skills.list", () => {
  it("sets running/mode/poolSize and replaces skills wholesale", () => {
    let s = initialState();
    s = reduce(
      s,
      ev({ kind: "runtime.status", running: true, mode: "inline", poolSize: 4 }),
    );
    expect(s.running).toBe(true);
    expect(s.mode).toBe("inline");
    expect(s.poolSize).toBe(4);

    s = reduce(
      s,
      ev({
        kind: "skills.list",
        skills: [{ name: "grep", description: "search files" }],
      }),
    );
    expect(s.skills).toEqual([{ name: "grep", description: "search files" }]);
  });
});

// ---------------------------------------------------------------------------
// Built-up state for selector checks
// ---------------------------------------------------------------------------

function buildDagState(): AppState {
  let s = initialState();
  // Dependency graph:
  //   A (no deps)      -> level 0
  //   B (no deps)      -> level 0
  //   C depends on A   -> level 1
  //   D depends on B,C -> level 2
  //   E depends on D   -> level 3
  s = reduce(s, ev({ kind: "task.upsert", task: task("A", "verified") }));
  s = reduce(s, ev({ kind: "task.upsert", task: task("B", "pending") }));
  s = reduce(s, ev({ kind: "task.upsert", task: task("C", "verified", ["A"]) }));
  s = reduce(s, ev({ kind: "task.upsert", task: task("D", "rejected", ["B", "C"]) }));
  s = reduce(s, ev({ kind: "task.upsert", task: task("E", "pending", ["D"]) }));

  s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-1", "busy") }));
  s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-2", "killed") }));
  s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-3", "dead") }));
  s = reduce(s, ev({ kind: "worker.upsert", worker: worker("w-4", "idle") }));

  s = reduce(s, ev({ kind: "verification", report: verification("A", "accept") }));
  s = reduce(s, ev({ kind: "verification", report: verification("C", "accept") }));
  s = reduce(s, ev({ kind: "verification", report: verification("D", "reject") }));
  s = reduce(s, ev({ kind: "verification", report: verification("D", "revise") }));

  s = reduce(s, ev({ kind: "certificate", cert: certificate("A", 100) }));
  s = reduce(s, ev({ kind: "certificate", cert: certificate("C", 200) }));

  s = reduce(s, ev({ kind: "metrics", metrics: metrics({ groundingRate: 0.876 }) }));

  return s;
}

describe("selectors", () => {
  it("liveWorkerCount excludes killed/dead workers", () => {
    const s = buildDagState();
    // w-1 busy, w-2 killed, w-3 dead, w-4 idle -> 2 live
    expect(selectors.liveWorkerCount(s)).toBe(2);
  });

  it("verifiedCount counts tasks with status === 'verified'", () => {
    const s = buildDagState();
    // A and C are verified
    expect(selectors.verifiedCount(s)).toBe(2);
  });

  it("rejectedCount counts verifications with verdict !== 'accept'", () => {
    const s = buildDagState();
    // accept, accept, reject, revise -> 2 non-accept
    expect(selectors.rejectedCount(s)).toBe(2);
  });

  it("groundingPct rounds metrics.groundingRate*100, and is 0 when metrics is null", () => {
    const s = buildDagState();
    expect(selectors.groundingPct(s)).toBe(88); // round(87.6) = 88
    expect(selectors.groundingPct(initialState())).toBe(0);
  });

  it("tasksByLevel computes topological levels from dependsOn", () => {
    const s = buildDagState();
    const levels = selectors.tasksByLevel(s);
    expect(levels.map((lvl) => lvl.map((t) => t.id))).toEqual([
      ["A", "B"],
      ["C"],
      ["D"],
      ["E"],
    ]);
  });

  it("latestCertificate returns the most recently appended certificate", () => {
    const s = buildDagState();
    expect(selectors.latestCertificate(s)?.taskId).toBe("C");
    expect(selectors.latestCertificate(initialState())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Purity / immutability
// ---------------------------------------------------------------------------

describe("purity", () => {
  it("never mutates the input state and returns a new object", () => {
    const s0 = initialState();
    Object.freeze(s0);
    Object.freeze(s0.workers);
    Object.freeze(s0.tasks);
    Object.freeze(s0.log);

    const s1 = reduce(s0, ev({ kind: "worker.upsert", worker: worker("w-1") }));

    expect(s1).not.toBe(s0);
    expect(s0.workers).toEqual([]); // unmutated
    expect(s1.workers).toEqual([worker("w-1")]);

    // Untouched slices keep their original reference (no needless copying).
    expect(s1.tasks).toBe(s0.tasks);
    expect(s1.log).toBe(s0.log);
  });

  it("does not mutate arrays across a chain of events", () => {
    const s0 = initialState();
    const s1 = reduce(s0, ev({ kind: "task.upsert", task: task("t-1") }));
    const tasksRefAfterS1 = s1.tasks;
    const s2 = reduce(s1, ev({ kind: "worker.upsert", worker: worker("w-1") }));

    // task.upsert in s1 should not have been retroactively changed by s2.
    expect(s1.tasks).toBe(tasksRefAfterS1);
    expect(s2.tasks).toBe(s1.tasks);
    expect(s1.tasks.map((t) => t.id)).toEqual(["t-1"]);
  });
});
