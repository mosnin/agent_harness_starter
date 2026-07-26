import { describe, it, expect, afterEach } from "vitest";
import { createSwarmMcpTools } from "../mcp/swarm-tools";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

async function waitFor(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("swarm MCP tools", () => {
  it("runs a goal, polls status to completion, and reports provenance", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 2 });
    const tools = createSwarmMcpTools(swarm);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const started = (await byName.swarm_run_goal.execute(swarm, {
      objective: "Analyze the objective",
    })) as { goalId: string; status: string };
    expect(started.goalId).toBeTruthy();
    expect(started.status).toBe("running");

    await waitFor(() => {
      const s = swarm!.getGoal(started.goalId)?.status;
      return s === "completed" || s === "failed";
    });

    const status = (await byName.swarm_goal_status.execute(swarm, { goalId: started.goalId })) as {
      status: string;
      tasks: unknown[];
      usage: { workerRuns: number };
    };
    expect(status.status).toBe("completed");
    expect(status.tasks.length).toBe(3);
    expect(status.usage.workerRuns).toBeGreaterThan(0);

    const workers = (await byName.swarm_list_workers.execute(swarm, {})) as unknown[];
    expect(workers.length).toBeGreaterThan(0);

    const prov = (await byName.swarm_provenance.execute(swarm, { goalId: started.goalId })) as {
      records: unknown[];
    };
    expect(prov.records.length).toBe(3);
  });

  it("cancels a running goal via the tool", async () => {
    swarm = await createInlineSwarm({
      capabilities: ["a", "b"],
      poolSize: 2,
      executor: {
        async execute() {
          await new Promise((r) => setTimeout(r, 400));
          return { output: "x", claims: [{ statement: "x", evidence: ["o"], confidence: 0.8 }], toolTrace: [{ tool: "o", args: {}, ok: true, output: "o", at: 0 }] };
        },
      },
    });
    const tools = Object.fromEntries(createSwarmMcpTools(swarm).map((t) => [t.name, t]));
    const started = (await tools.swarm_run_goal.execute(swarm, { objective: "slow" })) as { goalId: string };
    await new Promise((r) => setTimeout(r, 100));
    const res = (await tools.swarm_cancel_goal.execute(swarm, { goalId: started.goalId })) as { cancelled: boolean };
    expect(res.cancelled).toBe(true);
    await waitFor(() => swarm!.getGoal(started.goalId)?.status === "aborted");
  });
});
