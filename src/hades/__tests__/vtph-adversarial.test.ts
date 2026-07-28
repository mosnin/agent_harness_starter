/**
 * ADVERSARIAL VERIFICATION of the V-TPH$ (Verified-Tasks-per-Hour-per-Dollar)
 * scoreboard and its supporting eval-suite + model-client modules.
 *
 * These tests do NOT try to make the scoreboard look good. They try to BREAK it:
 * to prove it can be gamed, that its graders are tautologies, that its cost
 * accounting is fictional, or that its concurrency ceilings are decorative. Where
 * the harness is honest, the attack fails and the test passes; where it is
 * gameable/wrong, the assertion encodes the CORRECT behaviour and is left to FAIL
 * so the bug is reported rather than hidden.
 *
 * External-validity focus (a prior audit caught an internally-correct but
 * externally-meaningless benchmark): the metric must measure verified-correct
 * work per dollar with a real trust signal — nothing else.
 *
 * Fully deterministic: injected clocks, injected fetch, no real network, no
 * Math.random, no wall-clock Date.now in any assertion path.
 */
import { describe, it, expect } from "vitest";
import {
  runVtph,
  compareVtph,
  type AgentRunner,
  type AgentRunResult,
  type EvalTask,
} from "../bench/vtph";
import {
  EVAL_TASKS,
  EVAL_CATEGORIES,
  tasksByCategory,
  decomposableTasks,
} from "../bench/eval-suite";
import {
  computeCost,
  DEFAULT_PRICES,
  HttpModelClient,
  MultiProviderClient,
  type ModelClient,
  type ChatResponse,
  type PriceEntry,
} from "../models/client";

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;

/**
 * A paired clock: runVtph samples now() exactly twice (start, end). This returns
 * 0 on every start sample and MS_PER_HOUR on every end sample, so each runVtph
 * measures exactly one wall-clock HOUR — non-zero (so vtph is meaningful) and
 * identical across every runner in a compareVtph batch.
 */
function hourClock(): () => number {
  let n = 0;
  return () => (n++ % 2 === 0 ? 0 : MS_PER_HOUR);
}

/** Yield the microtask queue n times. */
async function microtasks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function byId(id: string): EvalTask {
  const t = EVAL_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`test setup: unknown task id ${id}`);
  return t;
}

/** A canned, obviously-wrong answer no honest grader may accept. */
const WRONG = "WRONG_ANSWER_XYZ";

/** Known-correct answers for a fixed slice of real EVAL_TASKS. */
const KNOWN: Record<string, string> = {
  "arith-02-percent": "30",
  "arith-05-sum-1-to-10": "55",
  "reason-01-syllogism": "yes",
  "classify-01-sentiment-pos": "positive",
  "arith-07-power": "1024",
  "multi-03-double": "3:6, 8:16, 10:20",
};
const SLICE_IDS = Object.keys(KNOWN);
const SLICE: EvalTask[] = SLICE_IDS.map(byId);

function result(partial: Partial<AgentRunResult> & { output: string }): AgentRunResult {
  return {
    claimedVerified: false,
    tokensIn: 100,
    tokensOut: 50,
    usd: 0.001,
    provenance: [],
    ...partial,
  };
}

/** A minimal `Response`-like for an injected fetch. */
function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  } as unknown as Response;
}

/** Injected fetch for an OpenAI-dialect endpoint with fixed usage. */
function openAiFetch(promptTokens: number, completionTokens: number, content = "ok"): typeof fetch {
  return (async () =>
    jsonResponse({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    })) as unknown as typeof fetch;
}

/** Injected fetch for an Anthropic-native endpoint; answers keyed by the user prompt. */
function anthropicFetch(
  answerForPrompt: (prompt: string) => string,
  inputTokens = 10,
  outputTokens = 5,
): typeof fetch {
  return (async (_url: unknown, init: { body?: string } = {}) => {
    const body = JSON.parse(init.body ?? "{}") as {
      messages?: Array<{ role: string; content: string }>;
    };
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const answer = answerForPrompt(lastUser?.content ?? "");
    return jsonResponse({
      content: [{ type: "text", text: answer }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  }) as unknown as typeof fetch;
}

// ===========================================================================
// 1. THE METRIC CANNOT BE GAMED BY CLAIMING "VERIFIED"
// ===========================================================================

describe("1. a liar who always claims verified scores ZERO", () => {
  it("wrong output + claimedVerified:true on EVERY real task => vtph 0, all silentWrong", async () => {
    // The liar asserts trust on every answer but every answer is wrong.
    const liar: AgentRunner = async () =>
      result({ output: WRONG, claimedVerified: true, provenance: [] });

    const report = await runVtph(liar, EVAL_TASKS, { now: hourClock() });

    // A full HOUR of wall-clock elapsed and money was spent — yet nothing scores.
    expect(report.wallClockMs).toBe(MS_PER_HOUR);
    expect(report.totalUsd).toBeGreaterThan(0);

    // North Star: zero. Claiming "verified" on garbage must NOT earn throughput.
    expect(report.verifiedCorrect).toBe(0);
    expect(report.vtph).toBe(0);
    expect(report.vtphPerDollar).toBe(0);

    // Trust-adjusted headline: NEGATIVE. Every lie costs 10x on the numerator,
    // so a liar scores strictly below an agent that simply declined everything.
    expect(report.verifiedYield).toBeLessThan(0);
    expect(report.verifiedYield).toBeCloseTo((0 - 10 * EVAL_TASKS.length) / report.totalUsd, 6);

    // Trust-failure counter: MAX. Every claimed-verified answer was wrong.
    expect(report.silentWrong).toBe(EVAL_TASKS.length);
    expect(report.silentWrong).toBe(report.tasks);
    expect(report.declined).toBe(0);

    // No provenance backing the claims => provenance-complete rate is 0.
    expect(report.provenanceCompleteRate).toBe(0);
  });
});

// ===========================================================================
// 2. HONEST-CHEAP BEATS HONEST-EXPENSIVE ON $ WHEN BOTH ARE CORRECT
// ===========================================================================

describe("2. cost-efficiency only counts when the work is actually correct", () => {
  function honestRunner(usdPerTask: number): AgentRunner {
    return async (task) =>
      result({
        output: KNOWN[task.id],
        claimedVerified: true,
        usd: usdPerTask,
        provenance: ["verifier:pass"],
      });
  }

  it("equal vtph, ~50x vtphPerDollar for the cheap runner, reflected in compareVtph", async () => {
    const cheap = honestRunner(0.001);
    const pricey = honestRunner(0.05);

    const cmp = await compareVtph(
      [
        { label: "cheap", runner: cheap },
        { label: "pricey", runner: pricey },
      ],
      SLICE,
      { now: hourClock() },
    );
    const [ra, rb] = cmp.reports;

    // Both do the SAME verified-correct work in the SAME wall-clock hour.
    expect(ra.verifiedCorrect).toBe(SLICE.length);
    expect(rb.verifiedCorrect).toBe(SLICE.length);
    expect(ra.silentWrong).toBe(0);
    expect(rb.silentWrong).toBe(0);
    expect(ra.vtph).toBeCloseTo(rb.vtph, 9);
    expect(ra.vtph).toBeCloseTo(SLICE.length, 9); // verifiedCorrect per hour

    // Only the money differs: cheap spends 50x less, so earns 50x more per dollar.
    expect(ra.vtphPerDollar).toBeCloseTo(50 * rb.vtphPerDollar, 6);
    expect(cmp.vtphPerDollarSpeedup).toBeCloseTo(50, 6);

    // Same 50x split on the trust-adjusted yield (no silent-wrong on either side).
    expect(ra.verifiedYield).toBeCloseTo(50 * rb.verifiedYield, 6);
    expect(ra.verifiedYield).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. SILENT-WRONG IS THE TRUST DISCRIMINATOR
// ===========================================================================

describe("3. silentWrong separates the truthful runner from the confidently-wrong one", () => {
  // idx 0,2,4 answered correctly; idx 1,3,5 answered wrong.
  const isRightSlot = (i: number) => i % 2 === 0;

  it("C claims verified on all (half wrong); D declines the ones it got wrong", async () => {
    // C: cheap, claims verified on EVERY task, but half its answers are wrong.
    const C: AgentRunner = async (task) => {
      const i = SLICE_IDS.indexOf(task.id);
      const output = isRightSlot(i) ? KNOWN[task.id] : WRONG;
      return result({ output, claimedVerified: true, usd: 0.001, provenance: ["c"] });
    };
    // D: same cheap outputs, but only CLAIMS verified when it is actually right.
    const D: AgentRunner = async (task) => {
      const i = SLICE_IDS.indexOf(task.id);
      const right = isRightSlot(i);
      return result({
        output: right ? KNOWN[task.id] : WRONG,
        claimedVerified: right,
        usd: 0.001,
        provenance: ["d"],
      });
    };

    const rc = await runVtph(C, SLICE, { label: "C", now: hourClock() });
    const rd = await runVtph(D, SLICE, { label: "D", now: hourClock() });

    const rightCount = SLICE.filter((_, i) => isRightSlot(i)).length; // 3

    // Both surface the same number of correct answers...
    expect(rc.verifiedCorrect).toBe(rightCount);
    expect(rd.verifiedCorrect).toBe(rightCount);
    // ...and produce the same raw number of outputs (superficially similar).
    expect(rc.tasks).toBe(rd.tasks);

    // But the trust signal cleanly separates them:
    expect(rc.silentWrong).toBeGreaterThan(0);
    expect(rc.silentWrong).toBe(SLICE.length - rightCount); // 3 lies wearing a badge
    expect(rd.silentWrong).toBe(0); // D never hands over a wrong "verified" answer
    expect(rd.declined).toBe(SLICE.length - rightCount);

    // vtph counts ONLY verifiedCorrect for both — the lying does not add throughput.
    expect(rc.vtph).toBeCloseTo(rightCount, 9);
    expect(rd.vtph).toBeCloseTo(rightCount, 9);
    expect(rc.vtph).toBeCloseTo(rd.vtph, 9);

    // The trust-adjusted yield is where the lying finally COSTS: C's three
    // badge-wearing lies each carry a 10x penalty, dragging C negative, while
    // D (same spend, same correct answers, honest declines) stays positive.
    expect(rc.verifiedYield).toBeLessThan(0);
    expect(rd.verifiedYield).toBeGreaterThan(0);
    expect(rc.verifiedYield).toBeLessThan(rd.verifiedYield);
  });
});

// ===========================================================================
// 4. EVAL GRADERS HAVE TEETH & THE SUITE IS NOT SECRETLY TRIVIAL
// ===========================================================================

describe("4. graders reject garbage and the suite is real", () => {
  it("every grader REJECTS the empty string and an obviously-wrong constant", () => {
    for (const task of EVAL_TASKS) {
      expect(task.grade(""), `${task.id} must reject ""`).toBe(false);
      expect(task.grade(WRONG), `${task.id} must reject "${WRONG}"`).toBe(false);
      // A whitespace-only / punctuation-only answer is also not a correct answer.
      expect(task.grade("   "), `${task.id} must reject whitespace`).toBe(false);
    }
  });

  it("suite has a realistic, non-trivial shape", () => {
    expect(EVAL_TASKS.length).toBeGreaterThanOrEqual(30);
    expect(EVAL_TASKS.length).toBeLessThanOrEqual(50);

    // Every declared category is populated, and no task escapes the taxonomy.
    for (const cat of EVAL_CATEGORIES) {
      expect(tasksByCategory(cat).length, `category ${cat} must be represented`).toBeGreaterThan(0);
    }
    for (const task of EVAL_TASKS) {
      expect(EVAL_CATEGORIES).toContain(task.category);
    }

    // Enough decomposable tasks for the swarm-vs-single comparison to have a workload.
    expect(decomposableTasks().length).toBeGreaterThanOrEqual(12);
    for (const t of decomposableTasks()) expect(t.decomposable).toBe(true);

    // Ids are unique — a duplicate id would let a runner be scored twice.
    const ids = EVAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("graders ACCEPT a genuinely-correct answer (not vacuously always-false)", () => {
    // If a grader rejected everything it would be a tautology too; prove teeth cut both ways.
    for (const id of SLICE_IDS) {
      expect(byId(id).grade(KNOWN[id]), `${id} must accept its correct answer`).toBe(true);
    }
  });
});

// ===========================================================================
// 5. COST ACCOUNTING IS REAL
// ===========================================================================

describe("5. cost accounting is arithmetic, not decoration", () => {
  it("computeCost matches hand-computed cases exactly", () => {
    const prices: PriceEntry[] = [{ model: "X", inPerMTok: 3, outPerMTok: 15 }];
    // 1000 in * $3/MTok + 500 out * $15/MTok = 0.003 + 0.0075 = 0.0105
    expect(computeCost("X", 1000, 500, prices)).toBeCloseTo(0.0105, 12);
    // Zero tokens => zero cost.
    expect(computeCost("X", 0, 0, prices)).toBe(0);
    // Unknown model => documented 0 (never throws mid-run).
    expect(computeCost("nope", 1000, 500, prices)).toBe(0);
    // A second hand case on real defaults: sonnet 2000/1000 = 0.006 + 0.015 = 0.021
    expect(computeCost("claude-sonnet-5", 2000, 1000, DEFAULT_PRICES)).toBeCloseTo(0.021, 12);
  });

  it("DEFAULT_PRICES are all positive and finite", () => {
    expect(DEFAULT_PRICES.length).toBeGreaterThan(0);
    for (const p of DEFAULT_PRICES) {
      expect(Number.isFinite(p.inPerMTok)).toBe(true);
      expect(Number.isFinite(p.outPerMTok)).toBe(true);
      expect(p.inPerMTok).toBeGreaterThan(0);
      expect(p.outPerMTok).toBeGreaterThan(0);
    }
    // Ids are unique so a lookup is unambiguous.
    const models = DEFAULT_PRICES.map((p) => p.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it("HttpModelClient.usd equals computeCost on the returned usage (fake fetch)", async () => {
    const client = new HttpModelClient(
      { name: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o"] },
      { fetchImpl: openAiFetch(1000, 500), prices: DEFAULT_PRICES },
    );
    const res = await client.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.tokensIn).toBe(1000);
    expect(res.tokensOut).toBe(500);
    expect(res.usd).toBeCloseTo(computeCost("gpt-4o", 1000, 500, DEFAULT_PRICES), 12);
    // And that is a genuinely non-zero, hand-checkable number:
    // 1000 in * $2.50/MTok + 500 out * $10/MTok = 0.0025 + 0.005 = 0.0075
    expect(res.usd).toBeCloseTo(0.0075, 12);
  });

  it("MultiProviderClient.stats().totalUsd equals the sum of per-call costs", async () => {
    const p1 = new HttpModelClient(
      { name: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o"] },
      { fetchImpl: openAiFetch(100, 50), prices: DEFAULT_PRICES },
    );
    const p2 = new HttpModelClient(
      { name: "openai-b", kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini"] },
      { fetchImpl: openAiFetch(100, 50), prices: DEFAULT_PRICES },
    );
    const mpc = new MultiProviderClient([
      { client: p1, models: ["gpt-4o"] },
      { client: p2, models: ["gpt-4o-mini"] },
    ]);

    const calls = [
      { model: "gpt-4o" },
      { model: "gpt-4o-mini" },
      { model: "gpt-4o" },
      { model: "gpt-4o-mini" },
    ];
    let expectedUsd = 0;
    for (const c of calls) {
      const res = await mpc.chat({ model: c.model, messages: [{ role: "user", content: "x" }] });
      // Every model in this fixture is priced; a null here would mean the
      // price table lost an entry, which is worth failing on explicitly
      // rather than coercing to 0.
      expect(res.usd).not.toBeNull();
      expectedUsd += res.usd ?? 0;
    }

    const stats = mpc.stats();
    expect(stats.calls).toBe(calls.length);
    expect(stats.totalUsd).toBeCloseTo(expectedUsd, 12);
    // Independent recompute from the price sheet (not just echoing res.usd).
    const independent =
      2 * computeCost("gpt-4o", 100, 50, DEFAULT_PRICES) +
      2 * computeCost("gpt-4o-mini", 100, 50, DEFAULT_PRICES);
    expect(stats.totalUsd).toBeCloseTo(independent, 12);
    expect(stats.byModel["gpt-4o"]).toBe(2);
    expect(stats.byModel["gpt-4o-mini"]).toBe(2);
  });
});

// ===========================================================================
// 6. CONCURRENCY CEILINGS ARE REAL
// ===========================================================================

describe("6. concurrency ceilings are enforced, not advisory", () => {
  it("runVtph never runs more than `concurrency` runners at once", async () => {
    const tasks: EvalTask[] = Array.from({ length: 12 }, (_, i) => ({
      id: `conc-${i}`,
      prompt: "",
      category: "arithmetic",
      decomposable: false,
      grade: () => true,
    }));

    let live = 0;
    let peak = 0;
    const runner: AgentRunner = async () => {
      live++;
      if (live > peak) peak = live;
      await microtasks(3); // park long enough for the pool to fill
      live--;
      return result({ output: "ok", claimedVerified: true });
    };

    const report = await runVtph(runner, tasks, { concurrency: 4, now: hourClock() });

    expect(peak).toBeLessThanOrEqual(4); // ceiling never breached
    expect(peak).toBe(4); // and the ceiling is actually reached (pool is real)
    expect(report.verifiedCorrect).toBe(tasks.length); // all work still completed
  });

  it("MultiProviderClient never exceeds maxConcurrency under a burst", async () => {
    let live = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Inner client parks on the gate so calls pile up against the semaphore.
    const inner: ModelClient = {
      async chat(req): Promise<ChatResponse> {
        live++;
        if (live > peak) peak = live;
        await gate;
        live--;
        return {
          text: "",
          tokensIn: 1,
          tokensOut: 1,
          usd: 0,
          model: req.model,
          provider: "p",
        };
      },
    };
    const mpc = new MultiProviderClient([{ client: inner, models: ["m"] }], { maxConcurrency: 3 });

    const burst = Array.from({ length: 9 }, () =>
      mpc.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    );
    await microtasks(20); // let everything that CAN start, start

    expect(peak).toBeLessThanOrEqual(3); // semaphore holds the line
    expect(peak).toBe(3); // and it does admit up to the cap

    release();
    await Promise.all(burst);
    const stats = mpc.stats();
    expect(stats.maxObservedConcurrency).toBeLessThanOrEqual(3);
    expect(stats.maxObservedConcurrency).toBe(3);
    expect(stats.calls).toBe(9);
  });
});

// ===========================================================================
// 7. END-TO-END: THE THREE MODULES COMPOSE INTO A COHERENT MEASUREMENT
// ===========================================================================

describe("7. end-to-end composition is coherent and non-vacuous", () => {
  it("MultiProviderClient -> model runner -> runVtph agree on cost and verified count", async () => {
    // A small slice of REAL tasks with staged model answers of known correctness.
    const plan = [
      { id: "arith-02-percent", answer: "30", claim: true }, // correct + claimed -> verifiedCorrect
      { id: "arith-05-sum-1-to-10", answer: "55", claim: true }, // correct + claimed -> verifiedCorrect
      { id: "reason-01-syllogism", answer: "no", claim: true }, // WRONG + claimed  -> silentWrong
      { id: "classify-01-sentiment-pos", answer: "positive", claim: false }, // right but declined
    ];
    const tasks = plan.map((p) => byId(p.id));
    const answerByPrompt = new Map(tasks.map((t, i) => [t.prompt, plan[i].answer]));
    const claimByPrompt = new Map(tasks.map((t, i) => [t.prompt, plan[i].claim]));

    const model = "claude-haiku-4-5-20251001";
    const http = new HttpModelClient(
      { name: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", models: [model] },
      {
        fetchImpl: anthropicFetch((prompt) => answerByPrompt.get(prompt) ?? WRONG),
        prices: DEFAULT_PRICES,
      },
    );
    const mpc = new MultiProviderClient([{ client: http, models: [model] }]);

    // The runner genuinely asks the model, then reports the model's text as output.
    const runner: AgentRunner = async (task) => {
      const res = await mpc.chat({ model, messages: [{ role: "user", content: task.prompt }] });
      return {
        output: res.text,
        // AgentRunResult.usd is non-nullable: an unpriced call contributes no
        // measured spend to the benchmark. The assertion above pins that this
        // fixture's model is priced, so this coalesce is never load-bearing.
        claimedVerified: claimByPrompt.get(task.prompt) ?? false,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        usd: res.usd ?? 0,
        provenance: [`model:${res.model}`, `provider:${res.provider}`],
      };
    };

    const report = await runVtph(runner, tasks, { now: hourClock() });

    // Independent recount straight from the plan + the real graders.
    const expectedVerified = plan.filter((p) => p.claim && byId(p.id).grade(p.answer)).length;
    expect(expectedVerified).toBe(2); // sanity: the fixture is non-vacuous
    expect(report.verifiedCorrect).toBe(expectedVerified);
    expect(report.silentWrong).toBe(1); // the claimed-but-wrong syllogism
    expect(report.declined).toBe(1); // the correct-but-unclaimed sentiment
    expect(report.correctButUnclaimed).toBe(1);

    // Cost accounting composes: the harness total equals the client's own ledger.
    const stats = mpc.stats();
    expect(stats.calls).toBe(tasks.length);
    expect(report.totalUsd).toBeCloseTo(stats.totalUsd, 12);
    expect(report.totalUsd).toBeGreaterThan(0);
    expect(report.totalTokens).toBe(stats.totalTokensIn + stats.totalTokensOut);

    // Every claim carried provenance.
    expect(report.provenanceCompleteRate).toBe(1);
  });
});
