import { describe, it, expect } from "vitest";
import { VerificationGate, type ExternalVerification, type ExternalVerifier } from "../verification/gate";
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

/**
 * The `externalVerifier` seam — the hook a CORRECTNESS oracle plugs into.
 *
 * Every check in the gate proper asks whether an answer is properly
 * evidenced; none asks whether it is right. That ceiling is why a
 * confidently-formatted wrong answer used to clear the gate. These tests pin
 * the four properties the seam has to have for that to change without
 * anything else changing:
 *
 *   (a) no hook  -> byte-identical behaviour (this is a pure addition);
 *   (b) abstain  -> the score does not move at all (the weight-0 precedent);
 *   (c) fail     -> REJECT even with a perfect grounding score (hard veto);
 *   (d) pass     -> contributes, but never rescues an ungrounded result.
 *
 * (c) and (d) are the asymmetry that makes the seam worth having: a proof of
 * wrongness outranks good formatting, and a proof of correctness does not
 * excuse a worker that cited nothing.
 */
describe("VerificationGate — external verifier seam", () => {
  /** Well-grounded AND (per the fixtures below) correct: the gate accepts. */
  const grounded = (): WorkerResult =>
    baseResult({
      output: "The file has 42 lines.",
      toolTrace: [{ tool: "wc", args: { file: "a.txt" }, ok: true, output: "42 a.txt", at: 0 }],
      claims: [
        { statement: "The file a.txt has 42 lines.", evidence: ["wc output: 42 a.txt"], confidence: 0.9 },
      ],
    });

  /** Asserts nothing about evidence: no claims at all, so nothing is grounded. */
  const ungrounded = (): WorkerResult => baseResult({ output: "just trust me", claims: [] });

  const hook = (outcome: ExternalVerification): ExternalVerifier => ({
    verify: async () => outcome,
  });

  const PASS: ExternalVerification = {
    passed: true,
    abstained: false,
    tier: "T1-reference",
    reasons: ["reference-match:arithmetic"],
  };
  const FAIL: ExternalVerification = {
    passed: false,
    abstained: false,
    tier: "T1-reference",
    reasons: ["reference-mismatch:arithmetic", 'recomputed "16" but the answer was "12"'],
  };
  const ABSTAIN: ExternalVerification = {
    passed: false,
    abstained: true,
    tier: "T4-consistency",
    reasons: ["abstain:no-reference-spec"],
  };

  it("(a) with no hook configured, behaves exactly as before — no extra check, same verdict/score", async () => {
    const bare = new VerificationGate();
    for (const result of [grounded(), ungrounded()]) {
      const withoutContext = await bare.verify(result);
      // Passing a context is also inert when no verifier is configured.
      const withContext = await bare.verify(result, { taskDescription: "SPEC:{...} do the thing" });
      expect(withoutContext.checks.map((c) => c.name)).toEqual([
        "has-claims",
        "evidence-present",
        "evidence-traceable",
        "no-ungrounded-hedging",
        "confidence-calibrated",
        "output-supported",
      ]);
      expect(withContext.verdict).toBe(withoutContext.verdict);
      expect(withContext.score).toBe(withoutContext.score);
      expect(withContext.checks).toEqual(withoutContext.checks);
    }
  });

  it("(b) an abstaining hook does not move the score, the verdict, or anything else scored", async () => {
    const bare = new VerificationGate();
    const hooked = new VerificationGate({ externalVerifier: hook(ABSTAIN) });

    for (const result of [grounded(), ungrounded()]) {
      const before = await bare.verify(result);
      const after = await hooked.verify(result, { taskDescription: "no reference here" });

      expect(after.score).toBe(before.score);
      expect(after.verdict).toBe(before.verdict);

      const external = after.checks.find((c) => c.name === "external-verifier");
      expect(external?.weight).toBe(0); // mirrors the judge-outage precedent
      expect(external?.detail).toContain("abstained");
      // Everything else in the report is untouched.
      expect(after.checks.filter((c) => c.name !== "external-verifier")).toEqual(before.checks);
    }
  });

  it("(c) a failing hook REJECTS even when every grounding check passes", async () => {
    const bare = new VerificationGate();
    const baseline = await bare.verify(grounded());
    expect(baseline.verdict).toBe("accept");
    expect(baseline.checks.every((c) => c.passed)).toBe(true);

    const hooked = new VerificationGate({ externalVerifier: hook(FAIL) });
    const report = await hooked.verify(grounded(), { taskDescription: "SPEC:{...}" });

    expect(report.verdict).toBe("reject");
    // The veto is not arithmetic: the grounding score is still high.
    expect(report.score).toBeGreaterThan(0.75);
    expect(report.feedback).toContain("independent verifier refuted");
    expect(report.checks.find((c) => c.name === "external-verifier")?.detail).toContain("REFUTED");
  });

  it("(c') the veto survives a gate configured to accept anything", async () => {
    // Thresholds cannot buy past a refutation: even acceptThreshold 0 rejects.
    const permissive = new VerificationGate({
      acceptThreshold: 0,
      rejectThreshold: 0,
      externalVerifier: hook(FAIL),
    });
    expect((await permissive.verify(grounded())).verdict).toBe("reject");
    // ...and the same gate accepts once the oracle stops objecting.
    const permissiveOk = new VerificationGate({
      acceptThreshold: 0,
      rejectThreshold: 0,
      externalVerifier: hook(PASS),
    });
    expect((await permissiveOk.verify(grounded())).verdict).toBe("accept");
  });

  it("(d) a passing hook does not rescue an ungrounded result", async () => {
    const hooked = new VerificationGate({ externalVerifier: hook(PASS) });
    const report = await hooked.verify(ungrounded(), { taskDescription: "SPEC:{...}" });

    expect(report.verdict).toBe("reject");
    expect(report.score).toBeLessThan(0.75);
    expect(report.checks.find((c) => c.name === "external-verifier")?.passed).toBe(true);
  });

  it("(d') a passing hook does not rescue fabricated evidence either", async () => {
    const fabricated = baseResult({
      output: "Revenue was $9.2M in Q3.",
      toolTrace: [
        { tool: "read_file", args: { file: "notes.txt" }, ok: true, output: "meeting notes about lunch", at: 0 },
      ],
      claims: [
        { statement: "Q3 revenue was $9.2M.", evidence: ["financial_report showed 9200000"], confidence: 0.95 },
      ],
    });
    const hooked = new VerificationGate({ externalVerifier: hook(PASS) });
    expect((await hooked.verify(fabricated)).verdict).toBe("reject");
  });

  it("a passing hook DOES raise the score of an already-grounded result", async () => {
    const bare = new VerificationGate();
    const hooked = new VerificationGate({ externalVerifier: hook(PASS) });
    const partiallyGrounded = baseResult({
      output: "answer",
      toolTrace: [{ tool: "t", args: {}, ok: true, output: "data", at: 0 }],
      claims: [
        { statement: "backed by data", evidence: ["data"], confidence: 0.5 },
        { statement: "I think this is probably fine", evidence: [], confidence: 0.2 },
      ],
    });
    const before = await bare.verify(partiallyGrounded);
    const after = await hooked.verify(partiallyGrounded);
    expect(after.score).toBeGreaterThan(before.score);
  });

  it("a hook that throws is an outage, never a veto — grounding is not punished", async () => {
    const exploding: ExternalVerifier = {
      verify: async () => {
        throw new Error("registry unreachable");
      },
    };
    const bare = new VerificationGate();
    const hooked = new VerificationGate({ externalVerifier: exploding });

    const before = await bare.verify(grounded());
    const after = await hooked.verify(grounded());

    expect(after.verdict).toBe("accept");
    expect(after.score).toBe(before.score);
    const external = after.checks.find((c) => c.name === "external-verifier");
    expect(external?.weight).toBe(0);
    expect(external?.detail).toContain("unavailable");
    expect(external?.detail).toContain("registry unreachable");
  });

  it("a hook returning a malformed verdict is an outage, never a veto", async () => {
    const broken = { verify: async () => ({ nonsense: true }) } as unknown as ExternalVerifier;
    const hooked = new VerificationGate({ externalVerifier: broken });
    const report = await hooked.verify(grounded());

    expect(report.verdict).toBe("accept");
    const external = report.checks.find((c) => c.name === "external-verifier");
    expect(external?.weight).toBe(0);
    expect(external?.detail).toContain("malformed");
  });

  it("passes the whole request context through so an oracle can recompute the request", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const recording: ExternalVerifier = {
      verify: async (input) => {
        seen.push({ ...input });
        return ABSTAIN;
      },
    };
    const gate = new VerificationGate({ externalVerifier: recording });
    const result = grounded();
    await gate.verify(result, {
      taskDescription: 'Investigate the objective from the "code" angle: compute 5 + 3\nSPEC:{...}',
      objective: "compute 5 + 3\nSPEC:{...}",
      isGoalAnswer: false,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].taskDescription).toBe(
      'Investigate the objective from the "code" angle: compute 5 + 3\nSPEC:{...}',
    );
    // The goal's objective travels SEPARATELY from the subtask's quote of it,
    // and so does the fact that this result is not the goal's answer — without
    // both, an oracle refutes correct intermediate work. See VerifyContext.
    expect(seen[0].objective).toBe("compute 5 + 3\nSPEC:{...}");
    expect(seen[0].isGoalAnswer).toBe(false);
    expect(seen[0].taskId).toBe(result.taskId);
    expect(seen[0].workerId).toBe(result.workerId);
    expect(seen[0].output).toBe(result.output);
    expect(seen[0].claims).toEqual(result.claims);
    expect(seen[0].toolTrace).toEqual(result.toolTrace);
  });

  it("omits the context fields the caller never supplied rather than inventing them", async () => {
    // `undefined` and "absent" are different to an oracle deciding whether it
    // is allowed to judge: absent means nobody claimed anything.
    const seen: Array<Record<string, unknown>> = [];
    const recording: ExternalVerifier = {
      verify: async (input) => {
        seen.push({ ...input });
        return ABSTAIN;
      },
    };
    const gate = new VerificationGate({ externalVerifier: recording });
    await gate.verify(grounded());

    expect(seen[0]).not.toHaveProperty("taskDescription");
    expect(seen[0]).not.toHaveProperty("objective");
    expect(seen[0]).not.toHaveProperty("isGoalAnswer");
  });

  it("never consults the hook for a worker that errored — that is already a reject", async () => {
    let calls = 0;
    const counting: ExternalVerifier = {
      verify: async () => {
        calls++;
        return PASS;
      },
    };
    const gate = new VerificationGate({ externalVerifier: counting });
    const report = await gate.verify(baseResult({ error: "boom", claims: [] }));
    expect(report.verdict).toBe("reject");
    expect(calls).toBe(0);
  });
});
