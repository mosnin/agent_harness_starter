/**
 * The swarm lane must DECLINE rather than certify a wrong answer.
 *
 * This is the end-to-end pin for the audit's headline failure. On a live run
 * against a provider that returned a fixed, well-formed, wrong answer, the
 * swarm lane reported:
 *
 *     swarm | verified 0 | silent-wrong 4 | declined 0
 *
 * — identical silent-wrong to the self-trusting baseline it exists to beat,
 * because the gate was a T4-consistency ensemble that could only see shape.
 * With the T1-reference verifier in the lane the same run must report
 * `silent-wrong 0, declined 4`.
 *
 * Both directions are asserted from ONE parameterised executor, so the tests
 * differ only in whether the model is right. A gate that declined everything
 * would pass the first test and fail the second.
 */
import { describe, it, expect } from "vitest";
import { runShowdown } from "../showdown";
import { extractReferenceSpec, computeSpec } from "../../styx/reference-spec";
import type { TaskExecutor } from "../../../swarm-runtime/worker/executor";

/**
 * A worker that answers every task the same way a model would — with a
 * claim and evidence attached, i.e. structurally impeccable. `solve`
 * decides whether the ANSWER is right; nothing else differs.
 */
function stubExecutor(solve: (prompt: string) => string): TaskExecutor {
  return {
    async execute(task: { description?: string }) {
      const answer = solve(task.description ?? "");
      return {
        output: answer,
        claims: [{ statement: `computed ${answer}`, evidence: [answer], confidence: 0.95 }],
        toolTrace: [],
      };
    },
  } as unknown as TaskExecutor;
}

/** Right every time: parse the embedded reference and recompute it. */
const honest = stubExecutor((prompt) => {
  const spec = extractReferenceSpec(prompt);
  return spec ? computeSpec(spec) : "";
});

/** Wrong every time, but confidently formatted — the audit's failure case. */
const confidentlyWrong = stubExecutor(() => "42");

const OPTS = { mode: "modeled", seed: 5, taskCount: 4 } as const;

describe("showdown swarm lane — T1-reference gate", () => {
  it("declines a confidently-wrong answer instead of certifying it", async () => {
    const result = await runShowdown({ ...OPTS, swarm: { executor: confidentlyWrong } });
    const swarm = result.comparison.reports.find((r) => r.label === "swarm")!;

    // The property the whole product rests on.
    expect(swarm.silentWrong).toBe(0);
    expect(swarm.declined).toBeGreaterThan(0);
    expect(swarm.verifiedCorrect).toBe(0);

    // And the ledger records the refusal rather than a quiet pass.
    const swarmVerdicts = result.audit.filter((a) => a.lane === "swarm").map((a) => a.verdict);
    expect(swarmVerdicts.every((v) => v !== "verified")).toBe(true);
  });

  it("still certifies correct answers — it is a gate, not a wall", async () => {
    const result = await runShowdown({ ...OPTS, swarm: { executor: honest } });
    const swarm = result.comparison.reports.find((r) => r.label === "swarm")!;

    expect(swarm.verifiedCorrect).toBe(OPTS.taskCount);
    expect(swarm.silentWrong).toBe(0);
    expect(swarm.declined).toBe(0);
  });

  it("separates the lanes on trust-adjusted yield, not just raw throughput", async () => {
    // A wider suite than the 4-task cases above: the scripted baseline's
    // dishonest tasks are seed-derived, and at taskCount 4 this seed happens
    // to flag none — so the lie-vs-decline contrast needs a suite big enough
    // for at least one dishonest task to fire.
    const result = await runShowdown({ mode: "modeled", seed: 7, taskCount: 24, swarm: { executor: honest } });
    const swarm = result.comparison.reports.find((r) => r.label === "swarm")!;
    const baseline = result.comparison.reports.find((r) => r.label === "baseline")!;

    // The self-trusting baseline asserts verification it did not earn…
    expect(baseline.silentWrong).toBeGreaterThan(0);
    // …while the gated lane never does.
    expect(swarm.silentWrong).toBe(0);
    // The 10x silent-wrong penalty is what turns that honesty into a score.
    expect(swarm.verifiedYield).toBeGreaterThan(baseline.verifiedYield);
  });
});
