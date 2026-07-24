/**
 * Central-integration tests for `../swarm-session.ts`: the PRODUCT wiring of
 * `swarm_run_verified` to the real inline engine. No scripted engine fakes —
 * `realSwarmSessionFactory` builds a genuine `SwarmManager` via
 * `createInlineSwarm` (default deterministic planner + demo executor, no LLM,
 * no network), and the tool is exercised end-to-end over a real
 * `McpServer`/`McpClient` loopback pair.
 */
import { describe, expect, it } from "vitest";
import { McpServer, loopbackTransportPair } from "../server";
import { McpClient } from "../client";
import {
  realSwarmSessionFactory,
  registerSwarmTaskTool,
  adaptSwarmManager,
} from "../swarm-session";
import type { VerifiedSwarmResult } from "../swarm-task-tool";
import { createInlineSwarm } from "../../../swarm-runtime/factory";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((c) => c.type === "text");
  if (!item?.text) throw new Error("tool returned no text content");
  return item.text;
}

describe("registerSwarmTaskTool + realSwarmSessionFactory (real engine)", () => {
  it("advertises swarm_run_verified over tools/list and runs a genuinely verified goal", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    const registered = registerSwarmTaskTool(server, realSwarmSessionFactory(), {
      defaultTimeoutMs: 30_000,
    });
    expect(registered.name).toBe("swarm_run_verified");
    server.serve();

    const client = new McpClient(pair.client);
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("swarm_run_verified");

    const result = await client.callTool("swarm_run_verified", {
      objective: "summarize the release notes",
      poolSize: 2,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(firstText(result)) as VerifiedSwarmResult;
    expect(parsed.status).toBe("verified");
    expect(parsed.goalId).not.toBe("");
    expect(parsed.tasks.length).toBeGreaterThan(0);
    expect(parsed.certificates.length).toBeGreaterThan(0);
    // Every certificate is the gate's own verbatim report: accept verdicts only
    // on a clean verified run, and each maps back to a real task id.
    const taskIds = new Set(parsed.tasks.map((t) => t.id));
    for (const v of parsed.verifications) {
      expect(v.verdict).toBe("accept");
      expect(taskIds.has(v.taskId)).toBe(true);
    }
  }, 30_000);

  it("input validation rejects before the engine is ever built", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    registerSwarmTaskTool(server); // default real factory
    server.serve();

    const client = new McpClient(pair.client);
    await client.initialize();
    const result = await client.callTool("swarm_run_verified", { objective: "", poolSize: 0 });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("invalid input");
  });

  it("adaptSwarmManager drives a live manager through the port surface", async () => {
    const manager = await createInlineSwarm({ poolSize: 1 });
    const port = adaptSwarmManager(manager);
    try {
      await port.start();
      const completed = new Promise<void>((resolve) => {
        port.manager.on("goal:completed", () => resolve());
      });
      const dispatched = (await port.manager.dispatchGoal("check the port adaptation")) as {
        goalId: string;
      };
      expect(typeof dispatched.goalId).toBe("string");
      expect(dispatched.goalId.length).toBeGreaterThan(0);
      await completed;
    } finally {
      await port.stop();
    }
  }, 30_000);
});
