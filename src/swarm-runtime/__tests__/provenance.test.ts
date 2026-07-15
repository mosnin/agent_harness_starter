import { describe, it, expect, afterEach } from "vitest";
import { buildProvenance, ProvenanceStore } from "../verification/provenance";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";
import type { VerificationReport, WorkerResult } from "../types";

describe("buildProvenance", () => {
  it("marks evidence grounded when it traces to the tool log", () => {
    const result: WorkerResult = {
      taskId: "t1",
      workerId: "w1",
      output: "42 lines",
      claims: [{ statement: "file has 42 lines", evidence: ["wc: 42 a.txt"], confidence: 0.9 }],
      toolTrace: [{ tool: "wc", args: {}, ok: true, output: "42 a.txt", at: 0 }],
      startedAt: 0,
      finishedAt: 1,
    };
    const report: VerificationReport = {
      taskId: "t1", workerId: "w1", verdict: "accept", score: 0.9, checks: [], feedback: "", at: 5,
    };
    const rec = buildProvenance(result, report, "g1");
    expect(rec.goalId).toBe("g1");
    expect(rec.claims[0].grounded).toBe(true);
    expect(rec.claims[0].tracedEvidence.length).toBe(1);
  });
});

describe("ProvenanceStore", () => {
  it("keeps the latest record per task and computes grounding rate", () => {
    const store = new ProvenanceStore();
    store.record({ taskId: "a", workerId: "w", at: 1, verdict: "accept", score: 1, toolCount: 1,
      claims: [{ statement: "x", confidence: 1, evidence: ["e"], tracedEvidence: ["e"], grounded: true }] });
    store.record({ taskId: "b", workerId: "w", at: 2, verdict: "accept", score: 1, toolCount: 0,
      claims: [{ statement: "y", confidence: 1, evidence: [], tracedEvidence: [], grounded: false }] });
    expect(store.list().length).toBe(2);
    expect(store.groundingRate()).toBe(0.5);
  });
});

describe("provenance in the manager", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("records an audit trail for every verified task", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 3 });
    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");

    const prov = swarm.listProvenance(goal.id);
    expect(prov.length).toBe(3); // research + code + synthesis
    expect(prov.every((p) => p.verdict === "accept")).toBe(true);
    expect(prov.every((p) => p.claims.length > 0)).toBe(true);
    expect(swarm.groundingRate()).toBeGreaterThan(0);
  });
});
