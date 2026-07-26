import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  createSwarmTaskTool,
  SWARM_TASK_INPUT_SCHEMA,
  type SwarmSessionFactory,
  type SwarmSessionPort,
  type VerifiedSwarmResult,
} from "../swarm-task-tool";
import { McpServer, loopbackTransportPair } from "../server";
import { McpClient } from "../client";
import { createInlineSwarm } from "../../../swarm-runtime/factory";
import type { TaskExecutor, WorkerContext } from "../../../swarm-runtime/worker/executor";
import type { SwarmManager } from "../../../swarm-runtime/manager/manager";
import type { WorkerTask } from "../../../swarm-runtime/types";

// ---------------------------------------------------------------------------
// Real-engine adapter: SwarmManager -> SwarmSessionPort.
//
// This is the SAME adaptation `src/desktop/core/sidecar.ts`'s `realSwarmFactory`
// performs (`dispatchGoal` -> `manager.startGoal`) — the real `SwarmManager`
// has no method literally named `dispatchGoal`; the port wraps `startGoal`.
// ---------------------------------------------------------------------------

const openManagers: SwarmManager[] = [];

function adaptManager(manager: SwarmManager): SwarmSessionPort {
  const emitter = manager as unknown as EventEmitter;
  return {
    manager: {
      on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
      dispatchGoal: async (objective: string) => {
        const { goalId } = await manager.startGoal(objective);
        return { goalId };
      },
    },
    start: async () => {
      await manager.ensurePool();
    },
    stop: async () => {
      await manager.shutdown();
    },
  };
}

function realFactory(inlineOpts: {
  executor?: TaskExecutor;
  maxAttempts?: number;
} = {}): SwarmSessionFactory {
  return async ({ poolSize, capabilities, maxAttempts }) => {
    const manager = await createInlineSwarm({
      poolSize,
      capabilities,
      maxAttempts: inlineOpts.maxAttempts ?? maxAttempts,
      executor: inlineOpts.executor,
    });
    openManagers.push(manager);
    return adaptManager(manager);
  };
}

afterEach(async () => {
  await Promise.all(openManagers.splice(0).map((m) => m.shutdown().catch(() => undefined)));
  vi.useRealTimers();
});

// A worker whose single unbacked, hedging claim scores in the gate's "revise"
// band (0.4 <= score < 0.75) — never a critical evidence-traceability failure,
// so it never gets an outright "reject" verdict, only "revise".
const reviseOnlyExecutor: TaskExecutor = {
  async execute(_task: WorkerTask, _ctx: WorkerContext) {
    return {
      output: "definitely true",
      claims: [{ statement: "I assume this is correct.", evidence: [], confidence: 0.99 }],
      toolTrace: [],
    };
  },
};

// A worker with two unbacked claims and zero tool calls — trips the gate's
// critical evidence-traceability check, which forces an outright "reject"
// verdict regardless of score.
const outrightRejectExecutor: TaskExecutor = {
  async execute(_task: WorkerTask, _ctx: WorkerContext) {
    return {
      output: "two unbacked assertions",
      claims: [
        { statement: "Fact A holds.", evidence: [], confidence: 0.95 },
        { statement: "Fact B holds.", evidence: [], confidence: 0.95 },
      ],
      toolTrace: [],
    };
  },
};

function parse(text: string): VerifiedSwarmResult {
  return JSON.parse(text) as VerifiedSwarmResult;
}

// ===========================================================================
// Suite A — real end-to-end: real McpServer/McpClient over loopback, real
// inline swarm, real verification gate. No LLM, no network.
// ===========================================================================

describe("swarm_run_verified — real end-to-end", () => {
  it("tools/list advertises the tool with its full schema", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    server.register(createSwarmTaskTool(realFactory()));
    server.serve();
    const client = new McpClient(pair.client, { timeoutMs: 5000 });
    await client.initialize();

    const tools = await client.listTools();
    const tool = tools.find((t) => t.name === "swarm_run_verified");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/gate-verified/i);
    expect(tool!.inputSchema).toEqual(SWARM_TASK_INPUT_SCHEMA);
    client.close();
  });

  it("a real objective runs to a genuinely verified, certified result", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    server.register(createSwarmTaskTool(realFactory(), { defaultTimeoutMs: 20_000 }));
    server.serve();
    const client = new McpClient(pair.client, { timeoutMs: 20_000 });
    await client.initialize();

    const res = await client.callTool("swarm_run_verified", {
      objective: "Describe the module architecture",
      poolSize: 2,
      capabilities: ["research", "code"],
    });

    expect(res.isError).toBeUndefined();
    const result = parse(res.content[0].text!);
    expect(result.status).toBe("verified");
    expect(result.goalId).toMatch(/.+/);
    expect(result.objective).toBe("Describe the module architecture");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // research + code + synthesis = 3 tasks, all verified.
    expect(result.tasks.length).toBe(3);
    expect(result.tasks.every((t) => t.status === "verified")).toBe(true);

    // Every certificate is a real, verbatim VerificationReport the gate emitted.
    expect(result.verifications.length).toBe(3);
    expect(result.verifications.every((v) => v.verdict === "accept")).toBe(true);
    expect(result.certificates.length).toBe(3);
    for (const cert of result.certificates) {
      expect(cert.verdict).toBe("accept");
      expect(Array.isArray(cert.checks)).toBe(true);
      expect((cert.checks as unknown[]).length).toBeGreaterThan(0);
      // The certificate's taskId must correspond to one of the reported tasks —
      // proof the ledger wasn't fabricated independently of the engine state.
      expect(result.tasks.some((t) => t.id === cert.taskId)).toBe(true);
    }

    client.close();
  }, 20_000);

  it("a goal that never clears the gate (outright reject) is reported as 'rejected', not upgraded", async () => {
    const tool = createSwarmTaskTool(
      realFactory({ executor: outrightRejectExecutor, maxAttempts: 2 }),
      { defaultTimeoutMs: 20_000 },
    );
    const res = await tool.run({ objective: "Produce something ungrounded", poolSize: 1, capabilities: ["general"] });

    expect(res.isError).toBe(false); // an honest negative verdict is not a tool-level error
    const result = parse(res.text);
    expect(result.status).toBe("rejected");
    expect(result.verifications.length).toBeGreaterThan(0);
    expect(result.verifications.every((v) => v.verdict === "reject")).toBe(true);
    expect(result.certificates.every((c) => c.verdict === "reject")).toBe(true);
    expect(result.note).toMatch(/verification/i);
  }, 20_000);

  it("a goal that fails without ever being rejected by the gate is reported as 'failed'", async () => {
    // Score lands in the "revise" band every attempt (never an outright reject),
    // so after max attempts the goal fails without a single reject verdict.
    const tool = createSwarmTaskTool(
      realFactory({ executor: reviseOnlyExecutor, maxAttempts: 2 }),
      { defaultTimeoutMs: 20_000 },
    );
    const res = await tool.run({ objective: "Produce something borderline", poolSize: 1, capabilities: ["general"] });

    expect(res.isError).toBe(false);
    const result = parse(res.text);
    expect(result.status).toBe("failed");
    expect(result.verifications.every((v) => v.verdict === "revise")).toBe(true);
    expect(result.note).toBeTruthy();
  }, 20_000);

  it("round-trips an objective containing JSON-breaking and injection-looking text intact", async () => {
    const tricky =
      'He said "hi"\n\tand \\backslash\\ and \'quotes\' <script>alert(1)</script> {"nested":"json","a":[1,2]} 你好 🚀  ';
    const tool = createSwarmTaskTool(realFactory(), { defaultTimeoutMs: 20_000 });
    const res = await tool.run({ objective: tricky, poolSize: 1, capabilities: ["general"] });

    expect(res.isError).toBe(false);
    const result = parse(res.text);
    expect(result.status).toBe("verified");
    expect(result.objective).toBe(tricky);
    // The structure is unaffected by the payload — same shape as any other run.
    // (`note` is omitted by JSON.stringify when undefined, as on a clean "verified" run.)
    expect(Object.keys(result).sort()).toEqual(
      ["certificates", "elapsedMs", "goalId", "objective", "status", "tasks", "verifications"].sort(),
    );
  }, 20_000);

  it("two concurrent calls get independent sessions, goalIds, and task ledgers", async () => {
    const tool = createSwarmTaskTool(realFactory(), { defaultTimeoutMs: 20_000 });
    const [a, b] = await Promise.all([
      tool.run({ objective: "Concurrent objective A", poolSize: 1, capabilities: ["general"] }),
      tool.run({ objective: "Concurrent objective B", poolSize: 1, capabilities: ["general"] }),
    ]);

    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    const ra = parse(a.text);
    const rb = parse(b.text);
    expect(ra.objective).toBe("Concurrent objective A");
    expect(rb.objective).toBe("Concurrent objective B");
    expect(ra.goalId).not.toBe(rb.goalId);
    expect(ra.goalId.length).toBeGreaterThan(0);
    expect(rb.goalId.length).toBeGreaterThan(0);
    // No task id leaked across the two independent sessions.
    const aIds = new Set(ra.tasks.map((t) => t.id));
    const bIds = new Set(rb.tasks.map((t) => t.id));
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
  }, 20_000);
});

// ===========================================================================
// Suite B — validation matrix (hand-rolled schema enforcement).
// ===========================================================================

describe("swarm_run_verified — input validation", () => {
  function toolWithSpyFactory(maxObjectiveLength?: number) {
    const factory: SwarmSessionFactory = vi.fn(async () => {
      throw new Error("factory must not be called for invalid input");
    });
    const tool = createSwarmTaskTool(factory, { maxObjectiveLength });
    return { tool, factory };
  }

  it("rejects a missing objective", async () => {
    const { tool, factory } = toolWithSpyFactory();
    const res = await tool.run({});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/'objective' is required/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects every field with the wrong type in one call", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({
      objective: 123,
      poolSize: "three",
      capabilities: "not-an-array",
      maxAttempts: true,
      timeoutMs: {},
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/'objective' must be a string/);
    expect(res.text).toMatch(/'poolSize' must be a number/);
    expect(res.text).toMatch(/'capabilities' must be an array of strings/);
    expect(res.text).toMatch(/'maxAttempts' must be a number/);
    expect(res.text).toMatch(/'timeoutMs' must be a number/);
  });

  it("rejects poolSize 0", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({ objective: "x", poolSize: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/'poolSize' must be >= 1, got 0/);
  });

  it("rejects a negative, non-integer poolSize", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({ objective: "x", poolSize: -1.5 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/'poolSize' must be an integer, got -1.5/);
  });

  it("rejects timeoutMs 0", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({ objective: "x", timeoutMs: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/'timeoutMs' must be >= 1, got 0/);
  });

  it("rejects an objective over the configured length cap", async () => {
    const { tool } = toolWithSpyFactory(20);
    const res = await tool.run({ objective: "x".repeat(21) });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/exceeds the maximum length of 20 characters \(got 21\)/);
  });

  it("accepts an objective exactly at the length cap", async () => {
    const factory: SwarmSessionFactory = async () => {
      throw new Error("stop here — only validation is under test");
    };
    const tool = createSwarmTaskTool(factory, { maxObjectiveLength: 20 });
    const res = await tool.run({ objective: "x".repeat(20) });
    // Passes validation (factory IS invoked and throws), so this is an infra
    // failure, not a validation failure — proving the boundary is exactly 20.
    expect(res.isError).toBe(true);
    const result = parse(res.text);
    expect(result.note).toMatch(/factory failed/);
  });

  it("rejects an empty-string objective", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({ objective: "" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/minLength 1/);
  });

  it("rejects an unknown extra property (additionalProperties: false)", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({ objective: "x", foo: "bar" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/unexpected property 'foo' is not allowed/);
  });

  it("rejects a non-string element inside capabilities", async () => {
    const { tool } = toolWithSpyFactory();
    const res = await tool.run({ objective: "x", capabilities: ["ok", 5] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/non-string element/);
  });

  it("advertises the schema exactly as SWARM_TASK_INPUT_SCHEMA", () => {
    const tool = createSwarmTaskTool(realFactory());
    expect(tool.inputSchema).toBe(SWARM_TASK_INPUT_SCHEMA);
    expect(tool.name).toBe("swarm_run_verified");
  });
});

// ===========================================================================
// Suite C — scripted fake SwarmSessionPort: failure-path matrix + adversarial
// event-ordering properties. Deterministic, no real engine involved.
// ===========================================================================

interface FakePort {
  port: SwarmSessionPort;
  emitter: EventEmitter;
  dispatchGoal: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeFakePort(opts: {
  dispatchImpl?: (objective: string) => unknown | Promise<unknown>;
  stopImpl?: () => Promise<void>;
  startImpl?: () => Promise<void>;
} = {}): FakePort {
  const emitter = new EventEmitter();
  const dispatchGoal = vi.fn(
    opts.dispatchImpl ?? (async (_objective: string) => ({ goalId: "fake-goal-1" })),
  );
  const start = vi.fn(opts.startImpl ?? (async () => undefined));
  const stop = vi.fn(opts.stopImpl ?? (async () => undefined));
  const port: SwarmSessionPort = {
    manager: {
      on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
      dispatchGoal,
    },
    start,
    stop,
  };
  return { port, emitter, dispatchGoal, start, stop };
}

function report(taskId: string, verdict: "accept" | "revise" | "reject", score: number) {
  return { taskId, workerId: "w-1", verdict, score, checks: [{ name: "x", passed: verdict === "accept", weight: 1, detail: "d" }], feedback: "", at: Date.now() };
}
function task(id: string, status: string, attempts = 1) {
  return { id, goalId: "fake-goal-1", description: `task ${id}`, status, attempts, requiredCapabilities: [], input: {}, dependsOn: [], priority: 5, maxAttempts: 3, createdAt: Date.now() };
}

describe("swarm_run_verified — failure-path matrix (scripted fake port)", () => {
  it("factory rejection: isError true, status 'failed', empty goalId, note carries the reason", async () => {
    const factory: SwarmSessionFactory = async () => {
      throw new Error("no capacity");
    };
    const tool = createSwarmTaskTool(factory);
    const res = await tool.run({ objective: "x" });
    expect(res.isError).toBe(true);
    const result = parse(res.text);
    expect(result.status).toBe("failed");
    expect(result.goalId).toBe("");
    expect(result.note).toMatch(/factory failed: no capacity/);
  });

  it("dispatchGoal throwing: isError true, status 'failed', stop() still awaited exactly once", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        throw new Error("dispatch exploded");
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "x" });
    expect(res.isError).toBe(true);
    const result = parse(res.text);
    expect(result.status).toBe("failed");
    expect(result.note).toMatch(/dispatch exploded/);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("goal:failed (no reject verdict recorded): honest 'failed', isError false", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        fake.emitter.emit("goal:failed", { id: "fake-goal-1" }, "cross-claim contradiction detected");
        return { goalId: "fake-goal-1" };
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "x" });
    expect(res.isError).toBe(false);
    const result = parse(res.text);
    expect(result.status).toBe("failed");
    expect(result.goalId).toBe("fake-goal-1");
    expect(result.note).toBe("cross-claim contradiction detected");
  });

  it("goal:aborted: honest 'failed', isError false", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        fake.emitter.emit("goal:aborted", { id: "fake-goal-1" }, "budget exceeded: maxWorkerRuns");
        return { goalId: "fake-goal-1" };
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "x" });
    expect(res.isError).toBe(false);
    const result = parse(res.text);
    expect(result.status).toBe("failed");
    expect(result.note).toBe("budget exceeded: maxWorkerRuns");
  });

  it("timeout fires mid-run: status 'timeout', isError true, stop() awaited exactly once", async () => {
    vi.useFakeTimers();
    const fake = makeFakePort(); // dispatchGoal resolves but never emits a terminal event
    const tool = createSwarmTaskTool(async () => fake.port, { defaultTimeoutMs: 5000 });

    const runPromise = tool.run({ objective: "hangs forever" });
    await vi.advanceTimersByTimeAsync(5000);
    const res = await runPromise;

    expect(res.isError).toBe(true);
    const result = parse(res.text);
    expect(result.status).toBe("timeout");
    expect(result.note).toMatch(/deadline of 5000ms exceeded/);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stop() throwing: result is still returned intact, note records the cleanup failure", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        fake.emitter.emit("task:verified", task("t1", "verified"), report("t1", "accept", 0.9));
        fake.emitter.emit("goal:completed", { id: "fake-goal-1" });
        return { goalId: "fake-goal-1" };
      },
      stopImpl: async () => {
        throw new Error("teardown wedged");
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "x" });

    const result = parse(res.text);
    expect(result.status).toBe("verified"); // the underlying outcome is unaffected
    expect(result.goalId).toBe("fake-goal-1");
    expect(result.note).toMatch(/cleanup warning: stop\(\) failed: teardown wedged/);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() throwing after an infra failure still surfaces both reasons", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        throw new Error("dispatch broke");
      },
      stopImpl: async () => {
        throw new Error("teardown also broke");
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "x" });
    expect(res.isError).toBe(true);
    const result = parse(res.text);
    expect(result.note).toMatch(/dispatch broke/);
    expect(result.note).toMatch(/teardown also broke/);
  });
});

describe("swarm_run_verified — adversarial event-ordering properties", () => {
  const orderings: Array<{
    name: string;
    script: (emit: FakePort["emitter"]) => void;
  }> = [
    {
      name: "reject-before-accept, then completed",
      script: (e) => {
        e.emit("task:rejected", task("a", "reported"), report("a", "reject", 0.1));
        e.emit("task:verified", task("b", "verified"), report("b", "accept", 0.95));
        e.emit("goal:completed", { id: "fake-goal-1" });
      },
    },
    {
      name: "accept-before-reject, then completed (certificate-before-verification ordering)",
      script: (e) => {
        e.emit("task:verified", task("b", "verified"), report("b", "accept", 0.95));
        e.emit("task:rejected", task("a", "reported"), report("a", "reject", 0.1));
        e.emit("goal:completed", { id: "fake-goal-1" });
      },
    },
    {
      name: "revise-then-accept-then-reject, then completed",
      script: (e) => {
        e.emit("task:rejected", task("a", "reported"), report("a", "revise", 0.5));
        e.emit("task:verified", task("a", "verified"), report("a", "accept", 0.9));
        e.emit("task:rejected", task("c", "reported"), report("c", "reject", 0.05));
        e.emit("goal:completed", { id: "fake-goal-1" });
      },
    },
    {
      name: "reject then goal:failed",
      script: (e) => {
        e.emit("task:rejected", task("a", "reported"), report("a", "reject", 0.1));
        e.emit("goal:failed", { id: "fake-goal-1" }, "one or more tasks failed verification after max attempts");
      },
    },
  ];

  it.each(orderings)("never reports 'verified' when a reject verdict was recorded ($name)", async ({ script }) => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        script(fake.emitter);
        return { goalId: "fake-goal-1" };
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "adversarial ordering" });
    const result = parse(res.text);
    expect(result.status).not.toBe("verified");
    expect(result.verifications.some((v) => v.verdict === "reject")).toBe(true);
  });

  it("a clean all-accept run (no reject/revise anywhere) is the only path to 'verified'", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        fake.emitter.emit("task:verified", task("a", "verified"), report("a", "accept", 0.9));
        fake.emitter.emit("task:verified", task("b", "verified"), report("b", "accept", 0.95));
        fake.emitter.emit("goal:completed", { id: "fake-goal-1" });
        return { goalId: "fake-goal-1" };
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "clean run" });
    const result = parse(res.text);
    expect(result.status).toBe("verified");
    expect(res.isError).toBe(false);
  });

  it("a completed goal with a non-accept, non-reject (revise) verdict is 'partially-verified', not 'verified'", async () => {
    const fake = makeFakePort({
      dispatchImpl: () => {
        fake.emitter.emit("task:rejected", task("a", "reported"), report("a", "revise", 0.5));
        fake.emitter.emit("task:verified", task("a", "verified"), report("a", "accept", 0.9));
        fake.emitter.emit("goal:completed", { id: "fake-goal-1" });
        return { goalId: "fake-goal-1" };
      },
    });
    const tool = createSwarmTaskTool(async () => fake.port);
    const res = await tool.run({ objective: "bumpy road to done" });
    const result = parse(res.text);
    expect(result.status).toBe("partially-verified");
    expect(res.isError).toBe(false);
  });
});
