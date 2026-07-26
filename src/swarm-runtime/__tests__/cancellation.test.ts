import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { WorkerTask } from "../types";

// Executor that takes a while, so a goal is in-flight long enough to cancel.
const slow: TaskExecutor = {
  async execute(task: WorkerTask, _c: WorkerContext) {
    await new Promise((r) => setTimeout(r, 400));
    const angle = String((task.input as { angle?: string }).angle ?? "x");
    return {
      output: `done ${angle}`,
      claims: [{ statement: `angle ${angle}`, evidence: [`obs ${angle}`], confidence: 0.85 }],
      toolTrace: [{ tool: "obs", args: {}, ok: true, output: `obs ${angle}`, at: 0 }],
    };
  },
};

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

describe("goal cancellation", () => {
  it("cancelGoal aborts a running goal mid-flight", async () => {
    swarm = await createInlineSwarm({ capabilities: ["a", "b"], poolSize: 2, executor: slow });
    let goalId = "";
    swarm.on("goal:planned", (g) => (goalId = g.id));

    const p = swarm.runGoal("Long fan-out", { timeoutMs: 15_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(goalId).toBeTruthy();
    expect(swarm.cancelGoal(goalId, "user cancelled")).toBe(true);

    const goal = await p;
    expect(goal.status).toBe("aborted");
    // Cancelling an already-terminal goal returns false.
    expect(swarm.cancelGoal(goalId)).toBe(false);
  });

  it("aborts via an AbortSignal", async () => {
    swarm = await createInlineSwarm({ capabilities: ["a", "b"], poolSize: 2, executor: slow });
    const ac = new AbortController();
    const p = swarm.runGoal("Long fan-out", { timeoutMs: 15_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    const goal = await p;
    expect(goal.status).toBe("aborted");
  });
});
