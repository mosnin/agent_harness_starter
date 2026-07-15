import { describe, it, expect, afterEach } from "vitest";
import { formatPrometheus } from "../observability/prometheus";
import { attachStructuredLogging, type StructuredLogRecord } from "../observability/structured-log";
import { buildSwarm } from "../server/build-swarm";
import { SwarmServer } from "../server/swarm-server";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { SwarmMetrics } from "../types";

const sampleMetrics: SwarmMetrics = {
  goals: { total: 2, completed: 1, failed: 0, aborted: 1, running: 0 },
  tasks: { total: 5, verified: 4, failed: 1, pending: 0, dispatched: 0 },
  workers: { total: 3, idle: 3, busy: 0, killed: 0, dead: 0 },
  verification: { total: 6, accepted: 5, rejected: 1, avgScore: 0.83, groundingRate: 0.9 },
  usage: { toolCalls: 18, costUsd: 0.0234 },
};

describe("formatPrometheus", () => {
  it("emits valid exposition format with labelled + scalar gauges", () => {
    const text = formatPrometheus(sampleMetrics);
    expect(text).toContain("# TYPE swarm_goals gauge");
    expect(text).toContain('swarm_goals{status="completed"} 1');
    expect(text).toContain('swarm_tasks{status="verified"} 4');
    expect(text).toContain('swarm_workers{status="idle"} 3');
    expect(text).toContain("swarm_verifications_accepted 5");
    expect(text).toContain("swarm_grounding_rate 0.9");
    expect(text).toContain("swarm_cost_usd_total 0.0234");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("structured logging", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("emits JSON records for lifecycle events", async () => {
    const records: StructuredLogRecord[] = [];
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
    const detach = attachStructuredLogging(swarm, (r) => records.push(r));

    await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    detach();

    expect(records.some((r) => r.event === "worker.spawned")).toBe(true);
    expect(records.some((r) => r.event === "task.verified")).toBe(true);
    expect(records.some((r) => r.event === "goal.completed")).toBe(true);
    expect(records.every((r) => typeof r.ts === "number" && r.fields)).toBe(true);
  });
});

describe("/metrics endpoint", () => {
  it("serves Prometheus text", async () => {
    const built = await buildSwarm({ mode: "inline", capabilities: ["research"], poolSize: 1 });
    const port = 39290;
    const server = new SwarmServer(built, { port });
    try {
      await server.listen();
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const text = await res.text();
      expect(text).toContain("swarm_goals_total");
    } finally {
      await server.close();
    }
  });
});
