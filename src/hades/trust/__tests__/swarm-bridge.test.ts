/**
 * The bridge that carries STYX verification into the product path.
 *
 * The gap these tests close is the one the audit found after the T1-reference
 * verifier shipped: it worked, it was registered, and NOTHING outside
 * `bench/showdown.ts` consulted it. A user running a swarm goal or a gateway
 * request got the six grounding checks and no correctness check at all — so a
 * well-evidenced wrong answer came back "verified".
 *
 * Four properties are pinned here, and the last two matter as much as the
 * first: a bridge that failed everything would have a perfect silent-wrong
 * record and zero value, and a bridge that voted on subjects it cannot judge
 * would reject correct work.
 *
 *   1. a WRONG answer to a SPEC-carrying objective FAILS,
 *   2. a CORRECT answer to the same objective PASSES,
 *   3. an objective with no machine-checkable reference ABSTAINS,
 *   4. an INTERMEDIATE result ABSTAINS even when the request it was handed
 *      quotes a SPEC-carrying objective verbatim.
 *
 * (4) is a shipped regression, not a hypothetical. The `DeterministicPlanner`
 * copies the objective — `SPEC:` line included — into every fan-out subtask
 * ("Investigate the objective from the \"code\" angle: <objective>"), those
 * subtasks correctly return prose, and an earlier build graded that prose
 * against the recomputed reference. Because a refutation is a hard veto, a
 * model that answered everything correctly could not complete a single
 * SPEC-bearing goal.
 *
 * The last blocks run the bridge through the real `VerificationGate` and then
 * through a real `SwarmManager`, because "the verifier votes correctly" and
 * "the product returns the right answer" are different claims and only the
 * second one is the point.
 */
import { describe, it, expect } from "vitest";

import {
  createSwarmTrustBridge,
  procedureTrustRegistry,
  referenceRequest,
  swarmResultSubject,
  workerOutputText,
  NOT_GOAL_ANSWER_REASON,
} from "../swarm-bridge";
import { REFERENCE_VERIFIER_ID } from "../reference-verifier";
import { procedureRunVerifier } from "../emission-adapters";
import { computeSpec, type ReferenceSpec } from "../../styx/reference-spec";
import { VerificationGate } from "../../../swarm-runtime/verification/gate";
import type { ExternalVerifierInput } from "../../../swarm-runtime/verification/gate";
import { createInlineSwarm } from "../../../swarm-runtime/factory";
import type { TaskExecutor } from "../../../swarm-runtime/worker/executor";
import type { WorkerResult } from "../../../swarm-runtime/types";

/** (5 + 3) * 2 = 16 — recomputed by real code, never hard-coded below. */
const ARITH: ReferenceSpec = { family: "arithmetic", start: 5, ops: [["add", 3], ["mul", 2]] };
const RIGHT = computeSpec(ARITH);
const WRONG = "12";

const SPEC_PROMPT = [
  "Evaluate this arithmetic pipeline: start at 5, then add 3, then multiply by 2.",
  "",
  `SPEC:${JSON.stringify(ARITH)}`,
  "Respond with only the exact result and nothing else.",
].join("\n");

const PLAIN_PROMPT = "Summarize the meeting notes in one sentence.";

/** Read off the shipped factory rather than hard-coded — ids are calibration keys. */
const PROCEDURE_RUN_ID = procedureRunVerifier().id;

/** A worker result whose evidence genuinely traces to its tool log. */
function groundedResult(output: string): WorkerResult {
  return {
    taskId: "task-1",
    workerId: "worker-1",
    output,
    claims: [{ statement: `the calculator returned ${output}`, evidence: [`calc output: ${output}`], confidence: 0.9 }],
    toolTrace: [{ tool: "calc", args: { expr: "(5+3)*2" }, ok: true, output, at: 0 }],
    startedAt: 0,
    finishedAt: 1,
  };
}

/**
 * The bridge input for a result the caller IS offering as the goal's answer —
 * the only shape the bridge votes on. `isGoalAnswer` defaults to true here so
 * each test states its own deviation from that explicitly.
 */
function bridgeInput(
  taskDescription: string | undefined,
  output: string,
  extra: Partial<ExternalVerifierInput> = {},
): ExternalVerifierInput {
  const r = groundedResult(output);
  return {
    taskId: r.taskId,
    workerId: r.workerId,
    ...(taskDescription === undefined ? {} : { taskDescription }),
    isGoalAnswer: true,
    output: r.output,
    claims: r.claims,
    toolTrace: r.toolTrace,
    ...extra,
  };
}

describe("procedureTrustRegistry", () => {
  it("registers the same procedure-domain verifier set openTrustStack does", () => {
    const ids = procedureTrustRegistry()
      .list("procedure")
      .map((v) => v.id);
    expect(ids).toContain(REFERENCE_VERIFIER_ID);
    expect(ids).toContain(PROCEDURE_RUN_ID);
  });

  it("needs no signing key, data directory, or network to construct", () => {
    // Constructing twice is a pure in-memory operation — this is what lets a
    // per-result hook run inside the gate without side effects.
    expect(() => {
      procedureTrustRegistry();
      procedureTrustRegistry();
    }).not.toThrow();
  });
});

describe("referenceRequest", () => {
  it("prefers the GOAL's objective over the subtask description", () => {
    // A planner is free to paraphrase or drop the SPEC when writing a subtask;
    // the objective is where the reference canonically lives.
    const input = bridgeInput("Synthesize a single grounded answer to: <paraphrase>", RIGHT, {
      objective: SPEC_PROMPT,
    });
    expect(referenceRequest(input)).toBe(SPEC_PROMPT);
    expect(swarmResultSubject(input).input).toBe(SPEC_PROMPT);
  });

  it("falls back to the task description when no objective was supplied", () => {
    expect(referenceRequest(bridgeInput(SPEC_PROMPT, RIGHT))).toBe(SPEC_PROMPT);
  });

  it("is the empty string when the caller supplied neither", () => {
    expect(referenceRequest(bridgeInput(undefined, RIGHT))).toBe("");
  });
});

describe("swarmResultSubject", () => {
  it("agrees with showdown's referenceSubject on the fields a T1 vote reads", () => {
    const subject = swarmResultSubject(bridgeInput(SPEC_PROMPT, WRONG));
    expect(subject.domain).toBe("procedure");
    expect(subject.subjectId).toBe("task-1");
    expect(subject.taskId).toBe("task-1");
    expect(subject.input).toBe(SPEC_PROMPT);
    expect(subject.output).toBe(WRONG);
  });

  it("omits evidence.declaredSteps so the structural verifier abstains rather than judging a manifest nobody declared", async () => {
    const subject = swarmResultSubject(bridgeInput(SPEC_PROMPT, RIGHT));
    expect(subject.evidence).not.toHaveProperty("declaredSteps");

    const fused = await procedureTrustRegistry().verify(subject);
    const structural = fused.verdicts.find((v) => v.verifierId === PROCEDURE_RUN_ID);
    expect(structural?.abstained).toBe(true);
  });

  it("carries the tool trace through as audit context", () => {
    const subject = swarmResultSubject(bridgeInput(SPEC_PROMPT, RIGHT));
    expect(subject.trace).toEqual([{ seq: 1, kind: "calc", detail: RIGHT }]);
  });

  it("renders a non-string output as the exact text a verifier compares", () => {
    expect(workerOutputText("16")).toBe("16");
    expect(workerOutputText(16)).toBe("16"); // not "\"16\"" — a bare reference must still match
    expect(workerOutputText(undefined)).toBe("");
    expect(workerOutputText(null)).toBe("");
    expect(workerOutputText({ answer: 16 })).toBe('{"answer":16}');
  });
});

describe("createSwarmTrustBridge", () => {
  const bridge = createSwarmTrustBridge();

  it("FAILS a wrong answer to a SPEC-carrying task", async () => {
    const verdict = await bridge.verify(bridgeInput(SPEC_PROMPT, WRONG));
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.tier).toBe("T1-reference");
    expect(verdict.reasons[0]).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("reference-mismatch:arithmetic");
    // The recomputed truth is named, so the rejection is auditable.
    expect(verdict.reasons.join(" ")).toContain(RIGHT);
  });

  it("PASSES a correct answer to the same task", async () => {
    const verdict = await bridge.verify(bridgeInput(SPEC_PROMPT, RIGHT));
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.tier).toBe("T1-reference");
    expect(verdict.reasons.join(" ")).toContain("reference-match:arithmetic");
  });

  it("ABSTAINS on a task carrying no machine-checkable reference", async () => {
    const verdict = await bridge.verify(bridgeInput(PLAIN_PROMPT, "the team shipped the release"));
    expect(verdict.abstained).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toBe("abstain:no-verifier-could-judge");
  });

  it("ABSTAINS when the caller supplied no task description at all", async () => {
    const verdict = await bridge.verify(bridgeInput(undefined, RIGHT));
    expect(verdict.abstained).toBe(true);
  });

  it("judges the GOAL's objective, not the subtask's paraphrase of it", async () => {
    const verdict = await bridge.verify(
      bridgeInput("Synthesize a single grounded answer to the question above.", WRONG, {
        objective: SPEC_PROMPT,
      }),
    );
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(false);
  });

  it("reports the degraded single-verifier evidence rather than smoothing it over", async () => {
    const verdict = await bridge.verify(bridgeInput(SPEC_PROMPT, RIGHT));
    expect(verdict.reasons).toContain("degraded:single-verifier");
  });

  it("accepts an injected registry — no ambient stack, key, or network in tests", async () => {
    const injected = createSwarmTrustBridge({ registry: procedureTrustRegistry(), timeoutMs: 1000 });
    expect((await injected.verify(bridgeInput(SPEC_PROMPT, WRONG))).passed).toBe(false);
  });

  it("abstains rather than throwing when every verifier is unregistered", async () => {
    const { VerifierRegistry } = await import("../registry");
    const empty = createSwarmTrustBridge({ registry: new VerifierRegistry() });
    const verdict = await empty.verify(bridgeInput(SPEC_PROMPT, WRONG));
    expect(verdict.abstained).toBe(true);
    expect(verdict.reasons).toContain("no verifier claimed this subject");
  });
});

/**
 * The regression: the bridge must not grade INTERMEDIATE work product against
 * the goal's expected answer.
 *
 * A fan-out subtask's description quotes the whole objective, `SPEC:` line
 * included, so "the request carries a reference" is true for a subtask whose
 * correct output is prose. Grading it recomputes `16`, sees an essay, and
 * refutes — a hard veto that fails the goal. Every assertion below is about a
 * result that is RIGHT.
 */
describe("createSwarmTrustBridge — intermediate results are not the answer", () => {
  const bridge = createSwarmTrustBridge();

  /** Verbatim shape of `DeterministicPlanner`'s fan-out description. */
  const FANOUT_PROMPT = `Investigate the objective from the "research" angle: ${SPEC_PROMPT}`;
  const PROSE = "This objective is a deterministic computation; the synthesis step should recompute it.";

  it("ABSTAINS on a subtask whose description quotes the SPEC-carrying objective", async () => {
    const verdict = await bridge.verify(
      bridgeInput(FANOUT_PROMPT, PROSE, { objective: SPEC_PROMPT, isGoalAnswer: false }),
    );
    expect(verdict.abstained).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toBe(NOT_GOAL_ANSWER_REASON);
  });

  it("ABSTAINS rather than guessing when the caller never said what the result is", async () => {
    const { isGoalAnswer: _omitted, ...noFlag } = bridgeInput(FANOUT_PROMPT, PROSE, {
      objective: SPEC_PROMPT,
    });
    const verdict = await bridge.verify(noFlag);
    expect(verdict.abstained).toBe(true);
    expect(verdict.reasons[0]).toBe(NOT_GOAL_ANSWER_REASON);
  });

  it("does not even consult the registry for an intermediate result", async () => {
    // A T1 verdict about work product is not merely unhelpful, it is wrong —
    // the cheapest way never to emit one is never to compute it.
    let consulted = 0;
    const counting = procedureTrustRegistry();
    const realVerify = counting.verify.bind(counting);
    counting.verify = async (...args: Parameters<typeof realVerify>) => {
      consulted++;
      return realVerify(...args);
    };
    const counted = createSwarmTrustBridge({ registry: counting });

    await counted.verify(bridgeInput(FANOUT_PROMPT, PROSE, { objective: SPEC_PROMPT, isGoalAnswer: false }));
    expect(consulted).toBe(0);

    await counted.verify(bridgeInput(SPEC_PROMPT, RIGHT, { objective: SPEC_PROMPT }));
    expect(consulted).toBe(1);
  });

  it("through the gate, an intermediate result scores exactly as it did with no bridge at all", async () => {
    const withBridge = new VerificationGate({ externalVerifier: createSwarmTrustBridge() });
    const withoutBridge = new VerificationGate();
    const work = groundedResult(PROSE);
    const ctx = { taskDescription: FANOUT_PROMPT, objective: SPEC_PROMPT, isGoalAnswer: false };

    const before = await withoutBridge.verify(work, ctx);
    const after = await withBridge.verify(work, ctx);

    expect(before.verdict).toBe("accept");
    expect(after.verdict).toBe("accept");
    expect(after.score).toBe(before.score);
    expect(after.checks.filter((c) => c.name !== "external-verifier")).toEqual(before.checks);
  });
});

/**
 * End to end through the real gate. This is the claim that actually matters:
 * not "the verifier voted right" but "the product declines the answer".
 */
describe("bridge x VerificationGate — the product path", () => {
  const withBridge = new VerificationGate({ externalVerifier: createSwarmTrustBridge() });
  const withoutBridge = new VerificationGate();
  const ANSWER_CTX = { taskDescription: SPEC_PROMPT, isGoalAnswer: true };

  it("a well-grounded WRONG answer is accepted without the bridge and REJECTED with it", async () => {
    const wrong = groundedResult(WRONG);
    const before = await withoutBridge.verify(wrong, ANSWER_CTX);
    expect(before.verdict).toBe("accept"); // the regression, reproduced

    const after = await withBridge.verify(wrong, ANSWER_CTX);
    expect(after.verdict).toBe("reject");
    expect(after.feedback).toContain("independent verifier refuted");
  });

  it("a well-grounded CORRECT answer is still accepted with the bridge wired in", async () => {
    const right = groundedResult(RIGHT);
    const report = await withBridge.verify(right, ANSWER_CTX);
    expect(report.verdict).toBe("accept");
    expect(report.checks.find((c) => c.name === "external-verifier")?.passed).toBe(true);
  });

  it("an ordinary task with no reference scores exactly as it did before the bridge existed", async () => {
    const ordinary = groundedResult("the team shipped the release");
    const ctx = { taskDescription: PLAIN_PROMPT, isGoalAnswer: true };
    const before = await withoutBridge.verify(ordinary, ctx);
    const after = await withBridge.verify(ordinary, ctx);
    expect(after.verdict).toBe(before.verdict);
    expect(after.score).toBe(before.score);
  });
});

/**
 * The whole product path, through a real `SwarmManager` with the real
 * `DeterministicPlanner` — the configuration `engine-select.ts`, the MCP
 * session factory and the swarm CLI all build.
 *
 * The gate-level tests above hand-feed one result at a time and so cannot see
 * the failure that actually shipped: it only appears once a PLANNER
 * decomposes the objective and the manager decides which result is the answer.
 * `scriptedExecutor` behaves like a competent model — prose on the fan-out
 * subtasks, the requested answer on the synthesis task — so a failed goal here
 * means the verification declined correct work, not that the model was bad.
 */
describe("bridge x SwarmManager — a whole goal, planner included", () => {
  /**
   * A worker that answers the way a competent model does. Grounded either way:
   * every claim quotes the objective it was given, which the trace records.
   */
  function scriptedExecutor(finalAnswer: string): TaskExecutor {
    return {
      async execute(task) {
        const objective = String((task.input as { objective?: unknown }).objective ?? task.description);
        const synthesizing = (task.input as { mode?: unknown }).mode === "synthesize";
        const output = synthesizing
          ? finalAnswer
          : "From this angle the objective is a deterministic computation to be recomputed at synthesis time.";
        return {
          output,
          claims: [
            {
              statement: synthesizing ? `The answer is ${finalAnswer}.` : "The objective is a computation task.",
              evidence: [objective.slice(0, 80)],
              confidence: 0.9,
            },
          ],
          toolTrace: [
            { tool: "read_objective", args: { taskId: task.id }, ok: true, output: objective, at: 0 },
          ],
        };
      },
    };
  }

  async function runGoal(finalAnswer: string, opts: { bridge: boolean }) {
    const manager = await createInlineSwarm({
      capabilities: ["research", "analysis"],
      poolSize: 1,
      maxAttempts: 2,
      executor: scriptedExecutor(finalAnswer),
      gate: opts.bridge ? { externalVerifier: createSwarmTrustBridge() } : {},
    });
    try {
      return await manager.runGoal(SPEC_PROMPT, { timeoutMs: 30_000 });
    } finally {
      await manager.shutdown();
    }
  }

  it("COMPLETES with the right answer — the fan-out subtasks' prose is not graded as the answer", async () => {
    const goal = await runGoal(RIGHT, { bridge: true });
    expect(goal.status).toBe("completed");
    expect(goal.synthesis).toBe(RIGHT);
  }, 40_000);

  it("FAILS on a wrong answer that the identical run without the bridge completes", async () => {
    const unguarded = await runGoal(WRONG, { bridge: false });
    expect(unguarded.status).toBe("completed"); // the silent-wrong baseline
    expect(unguarded.synthesis).toBe(WRONG);

    const guarded = await runGoal(WRONG, { bridge: true });
    expect(guarded.status).toBe("failed");
    expect(guarded.synthesis).toBeUndefined();
  }, 40_000);

  it("leaves a goal with no machine-checkable reference exactly as it was", async () => {
    const manager = await createInlineSwarm({
      capabilities: ["research"],
      poolSize: 1,
      executor: scriptedExecutor("the team shipped the release"),
      gate: { externalVerifier: createSwarmTrustBridge() },
    });
    try {
      const goal = await manager.runGoal(PLAIN_PROMPT, { timeoutMs: 30_000 });
      expect(goal.status).toBe("completed");
      expect(goal.synthesis).toBe("the team shipped the release");
    } finally {
      await manager.shutdown();
    }
  }, 40_000);
});
