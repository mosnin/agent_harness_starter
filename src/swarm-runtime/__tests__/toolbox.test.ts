import { describe, it, expect, afterEach } from "vitest";
import {
  ToolBox,
  ToolRunner,
  ToolAccessError,
  createToolExecutor,
  webSearchTool,
  defineTool,
} from "../worker/toolbox";
import { VerificationGate } from "../verification/gate";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { WorkerTask } from "../types";

const ctx = { workerId: "w1", log: () => {} };

function task(caps: string[] = []): WorkerTask {
  return {
    id: "t1", goalId: "g1", description: "Find the capital of France", requiredCapabilities: caps,
    input: { objective: "capital of France" }, dependsOn: [], priority: 5, status: "dispatched",
    attempts: 0, maxAttempts: 3, createdAt: 0,
  };
}

const searchBox = new ToolBox([
  webSearchTool(async (q) => [
    { title: "France", url: "https://ex/france", snippet: `${q}: Paris is the capital of France.` },
  ]),
]);

describe("ToolRunner", () => {
  it("records every call and enforces the allowlist", async () => {
    const runner = new ToolRunner(searchBox, new Set(["web_search"]));
    await runner.call("web_search", { query: "capital of France" });
    expect(runner.records.length).toBe(1);
    expect(runner.records[0].ok).toBe(true);

    await expect(runner.call("delete_everything", {})).rejects.toBeInstanceOf(ToolAccessError);
    expect(runner.records[1].ok).toBe(false); // blocked call is recorded
  });
});

describe("createToolExecutor", () => {
  it("auto-grounds a worker's claims in its tool calls and passes the gate", async () => {
    const executor = createToolExecutor({
      toolbox: searchBox,
      scopeToCapabilities: false,
      async reason(t, tools) {
        const results = (await tools.call("web_search", { query: "capital of France" })) as Array<{ snippet: string }>;
        return { output: `The capital of France is Paris. (${results[0].snippet})` };
      },
    });
    const out = await executor.execute(task(), ctx);
    expect(out.toolTrace.length).toBe(1);
    expect(out.claims.length).toBeGreaterThan(0);

    const gate = new VerificationGate();
    const report = await gate.verify({
      taskId: "t1", workerId: "w1", output: out.output, claims: out.claims,
      toolTrace: out.toolTrace, startedAt: 0, finishedAt: 1,
    });
    expect(report.verdict).toBe("accept");
  });

  it("blocks a tool outside the task's capabilities and the guardrail sees it", async () => {
    const box = new ToolBox([defineTool("dangerous_delete", "x", async () => "done")]);
    const executor = createToolExecutor({
      toolbox: box,
      async reason(_t, tools) {
        try {
          await tools.call("dangerous_delete", {});
        } catch {
          /* blocked */
        }
        return { output: "attempted", claims: [] };
      },
    });
    const out = await executor.execute(task(["web_search"]), ctx); // only web_search allowed
    const blocked = out.toolTrace.find((r) => r.tool === "dangerous_delete");
    expect(blocked?.ok).toBe(false);
  });
});

describe("tool executor in a full swarm", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("runs a swarm whose workers use tools", async () => {
    const executor = createToolExecutor({
      toolbox: searchBox,
      scopeToCapabilities: false,
      async reason(t, tools) {
        const r = (await tools.call("web_search", { query: String((t.input as { objective?: string }).objective ?? "x") })) as Array<{ snippet: string }>;
        return { output: r[0].snippet };
      },
    });
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2, executor });
    const goal = await swarm.runGoal("Research a topic", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
  });
});
