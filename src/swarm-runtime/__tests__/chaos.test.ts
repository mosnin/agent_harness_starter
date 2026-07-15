import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { WorkerTask } from "../types";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

function grounded(angle: string) {
  return {
    output: `analysis ${angle}`,
    claims: [{ statement: `angle ${angle} analyzed`, evidence: [`obs ${angle}`], confidence: 0.85 }],
    toolTrace: [{ tool: "obs", args: {}, ok: true, output: `obs ${angle}`, at: 0 }],
  };
}

describe("chaos — resilience under failure", () => {
  it("recovers when a worker is killed mid-goal", async () => {
    const slow: TaskExecutor = {
      async execute(task: WorkerTask, _c: WorkerContext) {
        await new Promise((r) => setTimeout(r, 250));
        return grounded(String((task.input as { angle?: string }).angle ?? "x"));
      },
    };
    swarm = await createInlineSwarm({
      capabilities: ["a"],
      poolSize: 2,
      executor: slow,
      taskTimeoutMs: 300,
      monitorIntervalMs: 80,
      maxRequeues: 6,
    });

    let killedOne = false;
    swarm.on("worker:spawned", (r) => {
      // Kill the very first worker shortly after it comes up (likely mid-task).
      if (!killedOne) {
        killedOne = true;
        setTimeout(() => void swarm!.killWorker(r.workerId, "chaos"), 120);
      }
    });

    const goal = await swarm.runGoal("Survive a worker kill", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
  });

  it("recovers from a flaky executor that throws on early attempts", async () => {
    const attempts = new Map<string, number>();
    const flaky: TaskExecutor = {
      async execute(task: WorkerTask, _c: WorkerContext) {
        const n = (attempts.get(task.id) ?? 0) + 1;
        attempts.set(task.id, n);
        if (n < 2) throw new Error("transient failure");
        return grounded(String((task.input as { angle?: string }).angle ?? "x"));
      },
    };
    swarm = await createInlineSwarm({ capabilities: ["a", "b"], poolSize: 3, executor: flaky, maxAttempts: 5 });
    const goal = await swarm.runGoal("Survive transient failures", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
  });

  it("completes despite jittery, slow responses", async () => {
    const jittery: TaskExecutor = {
      async execute(task: WorkerTask, _c: WorkerContext) {
        // Deterministic-ish jitter derived from the task id (no Math.random needed).
        const delay = 50 + (task.id.charCodeAt(0) % 5) * 40;
        await new Promise((r) => setTimeout(r, delay));
        return grounded(String((task.input as { angle?: string }).angle ?? "x"));
      },
    };
    swarm = await createInlineSwarm({ capabilities: ["a", "b", "c"], poolSize: 3, executor: jittery });
    const goal = await swarm.runGoal("Survive latency", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
  });

  it("fails cleanly (does not hang) when every attempt is ungrounded", async () => {
    const useless: TaskExecutor = {
      async execute() {
        return { output: "nope", claims: [], toolTrace: [] };
      },
    };
    swarm = await createInlineSwarm({ capabilities: ["a"], poolSize: 2, executor: useless, maxAttempts: 2 });
    const goal = await swarm.runGoal("Impossible", { timeoutMs: 20_000 });
    expect(goal.status).toBe("failed"); // terminates, not hangs
  });
});
