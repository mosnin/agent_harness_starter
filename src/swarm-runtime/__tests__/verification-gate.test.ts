import { describe, it, expect } from "vitest";
import { VerificationGate } from "../verification/gate";
import type { WorkerResult } from "../types";

function baseResult(partial: Partial<WorkerResult> = {}): WorkerResult {
  return {
    taskId: "t1",
    workerId: "w1",
    output: "the answer",
    claims: [],
    toolTrace: [],
    startedAt: 0,
    finishedAt: 1,
    ...partial,
  };
}

describe("VerificationGate — anti-hallucination", () => {
  const gate = new VerificationGate();

  it("accepts a well-grounded result whose evidence traces to the tool log", async () => {
    const result = baseResult({
      output: "The file has 42 lines.",
      toolTrace: [
        { tool: "wc", args: { file: "a.txt" }, ok: true, output: "42 a.txt", at: 0 },
      ],
      claims: [
        { statement: "The file a.txt has 42 lines.", evidence: ["wc output: 42 a.txt"], confidence: 0.9 },
      ],
    });
    const report = await gate.verify(result);
    expect(report.verdict).toBe("accept");
    expect(report.score).toBeGreaterThanOrEqual(0.75);
  });

  it("rejects a result that fabricates evidence not present in the tool trace", async () => {
    const result = baseResult({
      output: "Revenue was $9.2M in Q3.",
      toolTrace: [
        { tool: "read_file", args: { file: "notes.txt" }, ok: true, output: "meeting notes about lunch", at: 0 },
      ],
      claims: [
        {
          statement: "Q3 revenue was $9.2M.",
          evidence: ["financial_report showed 9200000 for Q3 revenue"],
          confidence: 0.95,
        },
      ],
    });
    const report = await gate.verify(result);
    expect(report.verdict).toBe("reject");
  });

  it("rejects a result with no claims at all", async () => {
    const report = await gate.verify(baseResult({ output: "trust me", claims: [] }));
    expect(report.verdict).toBe("reject");
  });

  it("does not accept high confidence with zero evidence", async () => {
    const result = baseResult({
      claims: [{ statement: "The sky is green.", evidence: [], confidence: 0.99 }],
    });
    const report = await gate.verify(result);
    expect(report.verdict).not.toBe("accept");
  });

  it("rejects a worker that errored", async () => {
    const report = await gate.verify(baseResult({ error: "boom", claims: [] }));
    expect(report.verdict).toBe("reject");
    expect(report.checks[0].name).toBe("worker-error");
  });

  it("flags ungrounded hedging language", async () => {
    const result = baseResult({
      toolTrace: [{ tool: "noop", args: {}, ok: true, output: "", at: 0 }],
      claims: [{ statement: "I think it is probably fine.", evidence: [], confidence: 0.5 }],
    });
    const report = await gate.verify(result);
    const hedge = report.checks.find((c) => c.name === "no-ungrounded-hedging");
    expect(hedge?.passed).toBe(false);
  });

  it("uses an LLM judge when provided and folds it into the score", async () => {
    const strictGate = new VerificationGate({
      judge: { assess: async () => ({ score: 0.1, rationale: "unsupported" }) },
    });
    const result = baseResult({
      toolTrace: [{ tool: "t", args: {}, ok: true, output: "data", at: 0 }],
      claims: [{ statement: "grounded in data", evidence: ["data"], confidence: 0.8 }],
    });
    const report = await strictGate.verify(result);
    const judge = report.checks.find((c) => c.name === "llm-judge");
    expect(judge).toBeDefined();
    expect(judge?.passed).toBe(false);
  });
});
