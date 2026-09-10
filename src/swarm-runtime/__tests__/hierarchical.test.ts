import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../factory";
import { SubSwarmExecutor } from "../worker/sub-swarm-executor";
import { DemoExecutor } from "../worker/executor";
import type { SwarmManager } from "../manager/manager";
import type { Planner, PlannedTask } from "../manager/planner";

let parent: SwarmManager | undefined;
afterEach(async () => {
  await parent?.shutdown();
  parent = undefined;
});

// Planner that emits a single task flagged for sub-swarm delegation.
const delegatingPlanner: Planner = {
  async plan(objective): Promise<PlannedTask[]> {
    return [
      {
        description: `Delegate: ${objective}`,
        requiredCapabilities: ["general"],
        input: { objective, subSwarm: true },
        priority: 5,
      },
    ];
  },
};

describe("hierarchical swarms", () => {
  it("delegates a task to a child sub-swarm and verifies its synthesized result", async () => {
    let childrenSpawned = 0;

    const executor = new SubSwarmExecutor({
      base: new DemoExecutor(),
      childTimeoutMs: 15_000,
      makeChild: async () => {
        childrenSpawned += 1;
        // The child uses the plain demo executor (no further delegation) to
        // avoid unbounded recursion.
        return createInlineSwarm({ capabilities: ["research", "analysis"], poolSize: 2 });
      },
    });

    parent = await createInlineSwarm({
      capabilities: ["general"],
      poolSize: 1,
      planner: delegatingPlanner,
      executor,
    });

    const goal = await parent.runGoal("Produce a deep multi-part analysis", { timeoutMs: 20_000 });
    expect(goal.status).toBe("completed");
    expect(childrenSpawned).toBe(1);

    // The parent accepted the delegated result, grounded in the sub-swarm trace.
    const prov = parent.listProvenance(goal.id);
    expect(prov.length).toBe(1);
    expect(prov[0].verdict).toBe("accept");
  });

  it("falls back to the base executor for non-delegated tasks", async () => {
    const executor = new SubSwarmExecutor({
      base: new DemoExecutor(),
      makeChild: async () => {
        throw new Error("should not be called");
      },
    });
    parent = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor });
    const goal = await parent.runGoal("Simple analysis", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
  });
});
