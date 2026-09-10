/* ------------------------------------------------------------------ *
 * route-bench.test.ts — drives runRouteBench through REAL EvalTasks and
 * the REAL runVtph/compareVtph harness (never re-implemented), with
 * deterministic-but-real router/baseline runners standing in for live
 * providers. Adversarial scenarios assert a DEFINED, non-crashing,
 * non-flattering result, per file.
 * ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { EVAL_TASKS } from "../../bench/eval-suite";
import type { AgentRunResult, EvalTask } from "../../bench/vtph";
import { RoutingLedger } from "../ledger";
import { mixedEvalBatch, runRouteBench } from "../route-bench";
import type { BenchProvenance, FixedBaseline, RouteBenchResult, RouterLike, RoutedRun } from "../route-bench";

// ===========================================================================
// Fixtures
// ===========================================================================

function taskById(id: string): EvalTask {
  const t = EVAL_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`fixture task "${id}" not found in EVAL_TASKS`);
  return t;
}

/** Correct answers for a small, hand-verified subset of the REAL EVAL_TASKS. */
const CORRECT: Record<string, string> = {
  "arith-01-sum-primes": "77",
  "arith-02-percent": "30",
  "classify-01-sentiment-pos": "positive",
  "extract-01-emails": "alice@example.com,bob@test.org",
  "reason-01-syllogism": "yes",
  "multi-01-word-length": "apple:5,kiwi:4,banana:6",
  "transform-04-swap": '{"x":"a","y":"b"}',
};

const FIXTURE_IDS = Object.keys(CORRECT);
const FIXTURE_TASKS = FIXTURE_IDS.map(taskById);

function makeClock(start = 0, step = 1): () => number {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

function correctOutputFor(task: EvalTask): string {
  const out = CORRECT[task.id];
  if (out === undefined) throw new Error(`no known-correct fixture answer for task "${task.id}"`);
  return out;
}

/** A FixedBaseline runner that answers correctly (per CORRECT) and claims verified. */
function perfectBaseline(usd: number): FixedBaseline["runner"] {
  return async (task: EvalTask): Promise<AgentRunResult> => ({
    output: correctOutputFor(task),
    claimedVerified: true,
    tokensIn: 50,
    tokensOut: 20,
    usd,
    provenance: ["baseline self-check"],
  });
}

/** A FixedBaseline runner that always claims verified but is always wrong. */
function alwaysWrongBaseline(usd: number): FixedBaseline["runner"] {
  return async (): Promise<AgentRunResult> => ({
    output: "definitely not the right answer",
    claimedVerified: true,
    tokensIn: 50,
    tokensOut: 20,
    usd,
    provenance: ["baseline self-check"],
  });
}

/** A RouterLike that always routes to one arm and answers correctly, cheaply. */
function perfectRouter(armId: string, usd: number): RouterLike {
  return {
    async route(task: EvalTask): Promise<RoutedRun> {
      return {
        output: correctOutputFor(task),
        claimedVerified: true,
        tokensIn: 30,
        tokensOut: 10,
        usd,
        provenance: [`routed to ${armId}: cheapest arm that verifies`],
        armId,
        fannedOut: [],
        escalations: 0,
        pCorrect: 0.97,
      };
    },
  };
}

function baseRoutedRun(overrides: Partial<RoutedRun> = {}): RoutedRun {
  return {
    output: "x",
    claimedVerified: false,
    tokensIn: 1,
    tokensOut: 1,
    usd: 0,
    provenance: [],
    armId: "some/arm",
    fannedOut: [],
    escalations: 0,
    pCorrect: 0,
    ...overrides,
  };
}

// ===========================================================================
// mixedEvalBatch
// ===========================================================================

describe("mixedEvalBatch", () => {
  it("draws only real EVAL_TASKS references -- never synthesizes a task", () => {
    const batch = mixedEvalBatch();
    expect(batch.length).toBeGreaterThan(0);
    for (const t of batch) {
      expect(EVAL_TASKS.includes(t)).toBe(true);
    }
  });

  it("spans multiple real categories by default, including both easy and hard (decomposable) tasks", () => {
    const batch = mixedEvalBatch();
    const categories = new Set(batch.map((t) => t.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);
    expect(batch.some((t) => t.decomposable)).toBe(true); // fan-out path
    expect(batch.some((t) => !t.decomposable)).toBe(true); // cheapest-that-verifies path
  });

  it("is deterministic across repeated calls", () => {
    const a = mixedEvalBatch();
    const b = mixedEvalBatch();
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it("respects an explicit categories filter", () => {
    const batch = mixedEvalBatch({ categories: ["arithmetic"] });
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((t) => t.category === "arithmetic")).toBe(true);
  });

  it("respects limit, including limit: 0", () => {
    expect(mixedEvalBatch({ limit: 0 })).toEqual([]);
    const limited = mixedEvalBatch({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it("includes the multi-part (decomposable) family, exercising the fan-out path", () => {
    const batch = mixedEvalBatch({ categories: ["multi-part"] });
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((t) => t.decomposable)).toBe(true);
  });
});

// ===========================================================================
// runRouteBench -- happy path, real measured behavior
// ===========================================================================

describe("runRouteBench: happy path", () => {
  it("a genuinely cheaper, genuinely correct router beats real fixed-provider baselines", async () => {
    const baselines: FixedBaseline[] = [
      { label: "gpt-baseline", armId: "openai/gpt-baseline", runner: perfectBaseline(0.02) },
      { label: "always-wrong-baseline", armId: "local/always-wrong", runner: alwaysWrongBaseline(0.001) },
    ];
    // The router happens to route through the same arm identity as one of
    // the fixed baselines -- a legitimate case, and it keeps this arm
    // within the known candidate set (see the dedicated
    // "never offered as a candidate" adversarial test for the mismatch case).
    const router = perfectRouter("openai/gpt-baseline", 0.0005);

    const result = await runRouteBench({
      router,
      baselines,
      tasks: FIXTURE_TASKS,
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.provenance).toBe("model");
    expect(result.routerReport.tasks).toBe(FIXTURE_TASKS.length);
    expect(result.routerReport.verifiedCorrect).toBe(FIXTURE_TASKS.length);
    expect(result.routerReport.silentWrong).toBe(0);

    expect(result.baselineReports).toHaveLength(2);
    expect(result.bestBaseline).not.toBeNull();
    expect(result.bestBaseline!.label).toBe("gpt-baseline"); // the always-wrong one scores 0

    expect(result.marginVsBestBaseline).toBeCloseTo(
      result.routerReport.vtphPerDollar - result.bestBaseline!.vtphPerDollar,
      10,
    );
    expect(result.beatsAllBaselines).toBe(true);

    expect(result.ledgerChain).toEqual({ ok: true, entries: FIXTURE_TASKS.length, brokenAt: null, code: "ok" });

    const chosenArmRow = result.armAttribution.find((a) => a.armId === "openai/gpt-baseline");
    expect(chosenArmRow).toBeDefined();
    expect(chosenArmRow!.tasks).toBe(FIXTURE_TASKS.length);
    expect(chosenArmRow!.verifiedCorrect).toBe(FIXTURE_TASKS.length);

    // The OTHER baseline arm id shows up in attribution too (as part of
    // the "candidates" universe) even though the router never routed to
    // it -- zero tasks, zero everything, no NaN.
    const neverRoutedArmRow = result.armAttribution.find((a) => a.armId === "local/always-wrong");
    expect(neverRoutedArmRow).toBeDefined();
    expect(neverRoutedArmRow!.tasks).toBe(0);
    expect(Number.isFinite(neverRoutedArmRow!.vtph)).toBe(true);
    expect(Number.isFinite(neverRoutedArmRow!.vtphPerDollar)).toBe(true);

    // The only anomaly is the real, honestly-flagged one: the
    // always-wrong baseline genuinely scored 0.
    expect(result.anomalies).toEqual([
      'baseline "always-wrong-baseline" scored 0 V-TPH$/$ (verifiedCorrect=0)',
    ]);
  });

  it("markdown states provenance verbatim on the first line, and every table number traces back to the result objects", async () => {
    const baselines: FixedBaseline[] = [
      { label: "gpt-baseline", armId: "openai/gpt-baseline", runner: perfectBaseline(0.02) },
    ];
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-baseline", 0.001),
      baselines,
      tasks: FIXTURE_TASKS,
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    const firstLine = result.markdown.split("\n")[0];
    expect(firstLine).toBe(
      "> provenance: model (deterministic simulated runners — not a live provider run)",
    );
    expect(result.markdown).toContain("# Route Bench Report");
    expect(result.markdown).toContain("## V-TPH$ comparison");
    expect(result.markdown).toContain("## Per-arm attribution");
    expect(result.markdown).toContain("## Ledger chain verification");
    expect(result.markdown).toContain("## Anomalies");
    expect(result.markdown).toContain("- none");

    // Verdict numbers trace to the result objects, not re-derived text.
    expect(result.markdown).toContain(result.routerReport.vtphPerDollar.toFixed(4));
    expect(result.markdown).toContain(result.marginVsBestBaseline.toFixed(4));

    // Every attribution row's formatted numbers appear verbatim.
    for (const a of result.armAttribution) {
      expect(result.markdown).toContain(
        `| ${a.armId} | ${a.tasks} | ${a.verifiedCorrect} | ${a.silentWrong} | ${a.declined} | ` +
          `${a.usd.toFixed(4)} | ${a.wallMs.toFixed(0)} | ${a.vtph.toFixed(2)} | ${a.vtphPerDollar.toFixed(2)} | ${a.escalatedInto} |`,
      );
    }

    // The comparison table is EXACTLY compareVtph's own table, present verbatim.
    expect(result.markdown).toContain("| Runner | Tasks | Verified✓ | Silent✗ | V-TPH | $ | **V-TPH$/$** |");
  });

  const provenances: BenchProvenance[] = ["measured-live", "measured-local", "model"];
  it.each(provenances)("provenance banner for %s is stated verbatim and distinct per label", async (p) => {
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [{ label: "b", armId: "b/arm", runner: perfectBaseline(0.01) }],
      tasks: [taskById("arith-01-sum-primes")],
      provenance: p,
      now: makeClock(),
      concurrency: 1,
    });
    expect(result.markdown.startsWith(`> provenance: ${p} (`)).toBe(true);
    expect(result.provenance).toBe(p);
  });

  it("determinism: an injected now + deterministic runners produce byte-identical markdown across two runs", async () => {
    const buildOpts = () => ({
      router: perfectRouter("openai/gpt-best", 0.0013),
      baselines: [
        { label: "gpt-baseline", armId: "openai/gpt-baseline", runner: perfectBaseline(0.02) } satisfies FixedBaseline,
        { label: "wrong-baseline", armId: "local/wrong", runner: alwaysWrongBaseline(0.004) } satisfies FixedBaseline,
      ],
      tasks: FIXTURE_TASKS,
      provenance: "model" as const,
      now: makeClock(0, 3),
      concurrency: 1,
    });

    const r1 = await runRouteBench(buildOpts());
    const r2 = await runRouteBench(buildOpts());

    expect(r1.markdown).toBe(r2.markdown);
    expect(r1).toEqual(r2);
  });

  it("running ledger: a caller-supplied ledger accumulates across bench invocations", async () => {
    const ledger = new RoutingLedger();
    ledger.append({
      taskId: "manual-pre-existing",
      category: "custom",
      armId: "manual/arm",
      reason: "seeded before the bench run",
      candidates: ["manual/arm"],
      fannedOut: [],
      escalations: 0,
      estimatedUsd: 0,
      actualUsd: 0,
      wallMs: 0,
      claimedVerified: false,
      graded: null,
      pCorrect: 0,
      certificateId: null,
      at: 0,
    });

    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [{ label: "b", armId: "b/arm", runner: perfectBaseline(0.01) }],
      tasks: [taskById("arith-01-sum-primes"), taskById("arith-02-percent")],
      provenance: "model",
      ledger,
      now: makeClock(),
      concurrency: 1,
    });

    expect(ledger.entries()).toHaveLength(3); // 1 seeded + 2 from this run
    expect(result.ledgerChain.entries).toBe(3);
    expect(result.armAttribution.find((a) => a.armId === "manual/arm")).toBeDefined();
  });
});

// ===========================================================================
// Adversarial robustness -- must never crash, never silently flatter
// ===========================================================================

describe("runRouteBench: adversarial robustness", () => {
  it("a router that throws for every task yields a defined declined result, not a crash", async () => {
    const throwingRouter: RouterLike = {
      async route(): Promise<RoutedRun> {
        throw new Error("router exploded");
      },
    };
    const tasks = [taskById("arith-01-sum-primes"), taskById("arith-02-percent")];

    const result = await runRouteBench({
      router: throwingRouter,
      baselines: [{ label: "b", armId: "b/arm", runner: perfectBaseline(0.01) }],
      tasks,
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.routerReport.declined).toBe(tasks.length);
    expect(result.routerReport.verifiedCorrect).toBe(0);
    expect(result.beatsAllBaselines).toBe(false);
    for (const t of tasks) {
      expect(result.anomalies.some((a) => a.includes(`router threw for task "${t.id}"`))).toBe(true);
    }
    expect(result.ledgerChain.ok).toBe(true);
    expect(result.ledgerChain.entries).toBe(tasks.length);
    const errRow = result.armAttribution.find((a) => a.armId === "<router-error>");
    expect(errRow).toBeDefined();
    expect(errRow!.declined).toBe(tasks.length);
    expect(typeof result.markdown).toBe("string");
    expect(result.markdown.length).toBeGreaterThan(0);
  });

  it("a router that returns an armId never offered as a candidate is flagged, not crashed or silently trusted", async () => {
    const router: RouterLike = {
      async route(task: EvalTask): Promise<RoutedRun> {
        return baseRoutedRun({
          output: correctOutputFor(task),
          claimedVerified: true,
          armId: "sneaky/unlisted-arm",
        });
      },
    };
    const tasks = [taskById("reason-01-syllogism")];

    const result = await runRouteBench({
      router,
      baselines: [{ label: "b", armId: "known/arm", runner: perfectBaseline(0.01) }],
      tasks,
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.anomalies.some((a) => a.includes('never offered as a candidate'))).toBe(true);
    expect(result.routerReport.verifiedCorrect).toBe(1); // correctness accounting is unaffected
    const row = result.armAttribution.find((a) => a.armId === "sneaky/unlisted-arm");
    expect(row).toBeDefined();
    expect(row!.tasks).toBe(1);
  });

  it("a router that claims verified on garbage output earns ZERO verifiedCorrect / vtph credit -- never a flattering number", async () => {
    const router: RouterLike = {
      async route(): Promise<RoutedRun> {
        return baseRoutedRun({ output: "totally wrong garbage", claimedVerified: true, armId: "liar/arm" });
      },
    };
    const tasks = [taskById("arith-01-sum-primes"), taskById("arith-02-percent")];

    const result = await runRouteBench({
      router,
      baselines: [
        { label: "gpt-baseline", armId: "openai/gpt-baseline", runner: perfectBaseline(0.02) },
      ],
      tasks,
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.routerReport.silentWrong).toBe(tasks.length);
    expect(result.routerReport.verifiedCorrect).toBe(0);
    expect(result.routerReport.vtph).toBe(0);
    expect(result.routerReport.vtphPerDollar).toBe(0);
    expect(result.beatsAllBaselines).toBe(false); // the honest baseline actually wins

    const row = result.armAttribution.find((a) => a.armId === "liar/arm");
    expect(row!.silentWrong).toBe(tasks.length);
    expect(row!.verifiedCorrect).toBe(0);
    expect(row!.vtph).toBe(0);
  });

  it("duplicate task ids are flagged, both instances still processed, no crash", async () => {
    const t = taskById("arith-01-sum-primes");
    const tasks = [t, t];

    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [{ label: "b", armId: "b/arm", runner: perfectBaseline(0.01) }],
      tasks,
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.anomalies.some((a) => a.includes("duplicate task id"))).toBe(true);
    expect(result.routerReport.tasks).toBe(2);
  });

  it("an empty task list yields a defined, NaN-free zero result, not a crash", async () => {
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [{ label: "b", armId: "b/arm", runner: perfectBaseline(0.01) }],
      tasks: [],
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.anomalies.some((a) => a.includes("empty task list"))).toBe(true);
    expect(result.routerReport.tasks).toBe(0);
    expect(Number.isFinite(result.routerReport.vtph)).toBe(true);
    expect(Number.isFinite(result.routerReport.vtphPerDollar)).toBe(true);
    expect(result.ledgerChain).toEqual({ ok: true, entries: 0, brokenAt: null, code: "empty" });
    expect(result.armAttribution).toEqual([]);
    expect(typeof result.markdown).toBe("string");
  });

  it("a single baseline works normally (no crash, no false 'no baselines' anomaly)", async () => {
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [{ label: "solo", armId: "solo/arm", runner: perfectBaseline(0.01) }],
      tasks: [taskById("arith-01-sum-primes")],
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });
    expect(result.bestBaseline).not.toBeNull();
    expect(result.bestBaseline!.label).toBe("solo");
    expect(result.anomalies.some((a) => a.includes("no baselines"))).toBe(false);
  });

  it("baselines that all score 0 are flagged per-baseline, comparison still well-defined", async () => {
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [
        { label: "wrong-1", armId: "wrong1/arm", runner: alwaysWrongBaseline(0.01) },
        { label: "wrong-2", armId: "wrong2/arm", runner: alwaysWrongBaseline(0.02) },
      ],
      tasks: [taskById("arith-01-sum-primes")],
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.anomalies.some((a) => a.includes('baseline "wrong-1" scored 0'))).toBe(true);
    expect(result.anomalies.some((a) => a.includes('baseline "wrong-2" scored 0'))).toBe(true);
    expect(result.bestBaseline).not.toBeNull();
    expect(result.bestBaseline!.vtphPerDollar).toBe(0);
    expect(result.beatsAllBaselines).toBe(true); // real router score (>0) beats real 0 baselines
  });

  it("no baselines supplied: bestBaseline is null, beatsAllBaselines is false (never a false victory claim)", async () => {
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [],
      tasks: [taskById("arith-01-sum-primes")],
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.anomalies.some((a) => a.includes("no baselines supplied"))).toBe(true);
    expect(result.bestBaseline).toBeNull();
    expect(result.beatsAllBaselines).toBe(false);
    expect(result.marginVsBestBaseline).toBe(0);
    expect(result.markdown).toContain("best baseline: none");
  });

  it("non-finite numerics from the router (NaN usd) are coerced and flagged, never crash or corrupt the aggregate", async () => {
    const router: RouterLike = {
      async route(task: EvalTask): Promise<RoutedRun> {
        return baseRoutedRun({
          output: correctOutputFor(task),
          claimedVerified: true,
          armId: "flaky/arm",
          usd: NaN,
          pCorrect: Infinity,
        });
      },
    };

    const result = await runRouteBench({
      router,
      baselines: [{ label: "b", armId: "b/arm", runner: perfectBaseline(0.01) }],
      tasks: [taskById("arith-01-sum-primes")],
      provenance: "model",
      now: makeClock(),
      concurrency: 1,
    });

    expect(result.anomalies.some((a) => a.includes("non-finite usd"))).toBe(true);
    expect(Number.isFinite(result.routerReport.totalUsd)).toBe(true);
    expect(Number.isFinite(result.routerReport.vtphPerDollar)).toBe(true);
    const row = result.armAttribution.find((a) => a.armId === "flaky/arm");
    expect(row).toBeDefined();
    expect(Number.isFinite(row!.usd)).toBe(true);
    expect(Number.isFinite(row!.vtphPerDollar)).toBe(true);
  });

  it("beatsAllBaselines uses strict inequality: an exact tie is NOT a win", async () => {
    // A constant clock forces every report's wallClockMs to 0, which
    // forces vtph (and therefore vtphPerDollar) to exactly 0 for every
    // runner via runVtph's own divide-by-zero guard -- a real,
    // reproducible tie, not a fabricated one.
    const zeroClock = () => 0;
    const result = await runRouteBench({
      router: perfectRouter("openai/gpt-best", 0.001),
      baselines: [{ label: "gpt-baseline", armId: "openai/gpt-baseline", runner: perfectBaseline(0.01) }],
      tasks: FIXTURE_TASKS,
      provenance: "model",
      now: zeroClock,
      concurrency: 1,
    });

    expect(result.routerReport.vtphPerDollar).toBe(0);
    expect(result.bestBaseline!.vtphPerDollar).toBe(0);
    expect(result.beatsAllBaselines).toBe(false);
  });

  it("rejects a router without a route() method", async () => {
    await expect(
      runRouteBench({
        router: {} as RouterLike,
        baselines: [],
        tasks: [],
        provenance: "model",
      }),
    ).rejects.toThrow(TypeError);
  });
});
