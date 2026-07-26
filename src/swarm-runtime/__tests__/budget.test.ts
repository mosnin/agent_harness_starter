import { describe, it, expect, afterEach } from "vitest";
import { budgetBreach } from "../manager/scheduler";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

describe("budgetBreach", () => {
  it("detects each kind of ceiling breach", () => {
    const usage = { workerRuns: 10, toolCalls: 5, costUsd: 2, wallClockMs: 100 };
    expect(budgetBreach(usage, { maxWorkerRuns: 5 })).toContain("worker runs");
    expect(budgetBreach(usage, { maxToolCalls: 3 })).toContain("tool calls");
    expect(budgetBreach(usage, { maxCostUsd: 1 })).toContain("cost");
    expect(budgetBreach(usage, { maxWallClockMs: 50 })).toContain("wall-clock");
    expect(budgetBreach(usage, { maxWorkerRuns: 100 })).toBeNull();
  });
});

describe("budget enforcement in the manager", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("aborts a goal that exceeds its worker-run ceiling", async () => {
    swarm = await createInlineSwarm({
      capabilities: ["a", "b", "c"],
      poolSize: 3,
      defaultBudget: { maxWorkerRuns: 1 }, // one run allowed → abort almost immediately
    });
    let abortReason = "";
    swarm.on("goal:aborted", (_g, reason) => (abortReason = reason));

    const goal = await swarm.runGoal("Big fan-out that blows the budget", { timeoutMs: 15_000 });
    expect(goal.status).toBe("aborted");
    expect(abortReason).toContain("budget exceeded");
  });

  it("completes within a generous budget and reports usage", async () => {
    swarm = await createInlineSwarm({
      capabilities: ["research"],
      poolSize: 2,
      defaultBudget: { maxWorkerRuns: 100, maxToolCalls: 1000 },
    });
    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    const usage = swarm.getUsage(goal.id);
    expect(usage.workerRuns).toBeGreaterThan(0);
    expect(usage.toolCalls).toBeGreaterThan(0);
  });
});
