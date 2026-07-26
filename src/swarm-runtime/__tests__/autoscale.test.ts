import { describe, it, expect, afterEach } from "vitest";
import { desiredWorkers, computeDemand } from "../manager/scheduler";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { WorkerTask } from "../types";

function t(id: string, status: WorkerTask["status"], replicas?: number): WorkerTask {
  return {
    id, goalId: "g", description: id, requiredCapabilities: [], input: {},
    dependsOn: [], priority: 5, status, attempts: 0, maxAttempts: 3, createdAt: 0,
    ...(replicas ? { consensus: { replicas, quorum: 0.5 } } : {}),
  };
}

describe("autoscale math", () => {
  it("clamps demand to [min,max]", () => {
    expect(desiredWorkers(10, 1, 5)).toBe(5);
    expect(desiredWorkers(0, 2, 5)).toBe(2);
    expect(desiredWorkers(3, 1, 5)).toBe(3);
  });

  it("counts consensus replicas as extra demand", () => {
    const isVerified = () => false;
    const demand = computeDemand([t("a", "pending"), t("b", "pending", 3)], isVerified);
    expect(demand).toBe(1 + 3);
  });
});

describe("autoscaling in the manager", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("grows the pool beyond min to meet parallel demand and completes", async () => {
    swarm = await createInlineSwarm({
      capabilities: ["a", "b", "c", "d", "e"],
      autoscale: { min: 1, max: 6 },
    });
    const spawned = new Set<string>();
    swarm.on("worker:spawned", (r) => spawned.add(r.workerId));

    const goal = await swarm.runGoal("Fan out across five angles", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
    // Started at min=1 but demand (5 independent tasks) grew the pool.
    expect(spawned.size).toBeGreaterThan(1);
    expect(spawned.size).toBeLessThanOrEqual(6);
  });
});
