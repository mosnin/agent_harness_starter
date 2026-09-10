import { describe, it, expect } from "vitest";
import { VerificationGate } from "../../../swarm-runtime/verification/gate";
import { buildProvenance } from "../../../swarm-runtime/verification/provenance";
import { verifiedSwarmEngine } from "../../gateway/verified-engine";
import { ConformalGate } from "../../styx/gate";
import { CertificateAuthority, generatePrivateKeyHex, certifiesOutput } from "../../styx/certificate";
import type { WorkerResult, Goal } from "../../../swarm-runtime/types";
import { LLMExecutor } from "../../../swarm-runtime/worker/llm-executor";
import { runVtph } from "../../bench/vtph";
import { assessReply } from "../../gateway/badge";
import { sha256Hex } from "../../styx/certificate";
import { styxRunner } from "../../styx/runner";

const fixture = (): WorkerResult => ({ taskId: "t", workerId: "w", output: "2 + 2 = 5", claims: [{ statement: "2 + 2 = 5", evidence: ["imaginary source"], confidence: 0.99 }], toolTrace: [], startedAt: 0, finishedAt: 1 });

describe("audit trust regressions", () => {
  it("does not promote a signed integrity receipt to a correctness badge", async () => {
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const certificate = await authority.issue({ scope: "integrity", outputSha256: sha256Hex("5"), taskId: "t", verifierTier: "receipt", ensembleScore: 1, pCorrect: 1, epsilon: 0.1, traceSha256: sha256Hex("trace"), verifierVersions: [], issuedAt: 0 });
    expect((await assessReply("5", { certificate, decision: { emit: true, score: 1, threshold: 0.8, pCorrectEstimate: 1 } })).badge).toBe("unverified");
  });
  it("abstains before model calls when STYX has no supplied calibration", async () => {
    let calls = 0;
    const runner = styxRunner({ async chat() { calls++; throw new Error("must not call"); } }, { workerModel: "test", verifierModels: ["test"], issuedAt: 0 });
    const result = await runner({ id: "t", prompt: "2+2", category: "math", decomposable: false, grade: () => true });
    expect(calls).toBe(0); expect(result.claimedVerified).toBe(false);
    expect(result.provenance[0]).toContain("uncalibrated");
  });
  it("refuses nonfinite scores and invalid recalibration without retaining old admission", () => {
    const gate = new ConformalGate({ epsilon: 0.1 });
    gate.calibrate(Array.from({ length: 30 }, () => ({ score: 1, correct: true })));
    expect(gate.decide(Infinity).emit).toBe(false);
    expect(() => gate.calibrate(Array.from({ length: 30 }, () => ({ score: NaN, correct: true })))).toThrow();
    expect(() => gate.decide(1)).toThrow("before calibrate");
  });
  it("rejects fabricated single-claim evidence with no trace, including provenance", async () => {
    const result = fixture(); const report = await new VerificationGate().verify(result);
    expect(report.verdict).toBe("reject");
    expect(buildProvenance(result, report).claims[0].grounded).toBe(false);
  });
  it("rejects a wrong output accompanied by unrelated true claims and observations", async () => {
    const result = fixture();
    result.claims = [{ statement: "2 + 2 = 4", evidence: ["2 + 2 = 4"], confidence: 0.99 }];
    result.toolTrace = [{ tool: "calc", args: {}, output: "2 + 2 = 4", ok: true, at: 0 }];
    expect((await new VerificationGate().verify(result)).verdict).toBe("reject");
  });
  it.each([true, false])("does not accept tool arguments as evidence (tool success=%s)", async (ok) => {
    const result = fixture();
    result.toolTrace = [{ tool: "read", args: { evidence: "imaginary source" }, output: "unrelated observation", ok, at: 0 }];
    expect((await new VerificationGate().verify(result)).verdict).toBe("reject");
  });
  it("accepts a bounded exact observation, but respects an independent judge's veto/outage", async () => {
    const result = fixture(); result.output = "4";
    result.claims = [{ statement: "4", evidence: ["4"], confidence: 0.5 }];
    result.toolTrace = [{ tool: "calc", args: { input: "2+2" }, output: "4", ok: true, at: 0 }];
    expect((await new VerificationGate().verify(result)).verdict).toBe("accept");
    for (const assess of [async () => ({ score: 0, rationale: "unrelated task" }), async () => { throw new Error("unavailable"); }]) {
      expect((await new VerificationGate({ judge: { assess } }).verify(result)).verdict).toBe("reject");
    }
  });
  it("never certifies completion counts without an independent checker, even with favorable calibration", async () => {
    const gate = new ConformalGate({ epsilon: 0.1 });
    gate.calibrate(Array.from({ length: 30 }, () => ({ score: 1, correct: true })));
    const goal: Goal = { id: "g", objective: "2+2", status: "completed", taskIds: ["t"], synthesis: "5", createdAt: 0 };
    const manager = { startGoal: async () => ({ goalId: "g", done: Promise.resolve(goal) }), getGoal: () => goal };
    const turn = { sessionId: "s", identityId: "i", platform: "telegram" as const, user: "u", text: "2+2", switchedChannel: false };
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    for (const checkOutcome of [undefined, async () => false, async () => { throw new Error("down"); }]) {
      const reply = await verifiedSwarmEngine(manager, { gate, authority, checkOutcome }).respond(turn);
      expect(reply.decision?.emit).toBe(false); expect(reply.certificate).toBeUndefined();
    }
    goal.synthesis = "4";
    const reply = await verifiedSwarmEngine(manager, { gate, authority, checkOutcome: async ({ objective, output }) => objective === "2+2" && output === "4" }).respond(turn);
    expect(reply.decision?.emit).toBe(true);
    expect(await certifiesOutput(reply.certificate!, "4")).toBe(true);
  });
  it("preserves a model response's cost and usage through the worker result", async () => {
    const executor = new LLMExecutor(async () => ({ text: '{"answer":"4","claims":[]}', usd: 0.123, tokensIn: 100, tokensOut: 20 }));
    const out = await executor.execute({ id: "t", description: "2+2", input: {} } as import("../../../swarm-runtime/types").WorkerTask, { workerId: "w", log: () => {} });
    expect(out.costUsd).toBe(0.123); expect(out.usage).toEqual({ tokensIn: 100, tokensOut: 20, costMeasured: true });
  });
  it("reports per-dollar throughput unavailable for zero or unknown spend", async () => {
    for (const usd of [0, 1]) {
      let time = 0;
      const r = await runVtph(async () => ({ output: "4", claimedVerified: true, tokensIn: 1, tokensOut: 1, usd, costMeasured: false, provenance: [] }), [{ id: "t", prompt: "2+2", category: "math", decomposable: false, grade: (x) => x === "4" }], { now: () => time += 1000 });
      expect(r.costMeasured).toBe(false); expect(r.vtphPerDollar).toBe(0);
    }
  });
});
