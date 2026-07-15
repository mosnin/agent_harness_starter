import { describe, it, expect, afterEach } from "vitest";
import { isStale } from "../manager/scheduler";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { WorkerTask } from "../types";

describe("isStale", () => {
  it("is true only past the timeout", () => {
    expect(isStale(0, 100, 50)).toBe(true);
    expect(isStale(0, 40, 50)).toBe(false);
  });
});

describe("task requeue on a hung worker", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("recovers by requeueing a task whose worker never reports, then completes", async () => {
    let hungOnce = false;
    const executor: TaskExecutor = {
      async execute(task: WorkerTask, _c: WorkerContext) {
        // The first worker to take a real task hangs forever (simulates a dead
        // or wedged container). Every later run succeeds.
        if (!hungOnce) {
          hungOnce = true;
          await new Promise(() => {}); // never resolves
        }
        const angle = String((task.input as { angle?: string }).angle ?? "x");
        return {
          output: `analysis ${angle}`,
          claims: [{ statement: `angle ${angle} analyzed`, evidence: [`obs ${angle}`], confidence: 0.85 }],
          toolTrace: [{ tool: "obs", args: {}, ok: true, output: `obs ${angle}`, at: 0 }],
        };
      },
    };

    swarm = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 2,
      executor,
      taskTimeoutMs: 400,
      monitorIntervalMs: 150,
      maxRequeues: 5,
    });

    const requeued: string[] = [];
    swarm.on("task:requeued", (t) => requeued.push(t.id));

    const goal = await swarm.runGoal("Recover from a hung worker", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
    expect(requeued.length).toBeGreaterThanOrEqual(1);
  });
});
