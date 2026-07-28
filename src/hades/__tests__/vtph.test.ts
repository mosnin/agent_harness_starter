import { describe, it, expect } from "vitest";
import {
  runVtph,
  compareVtph,
  type EvalTask,
  type AgentRunResult,
  type AgentRunner,
} from "../bench/vtph";

const MS_PER_HOUR = 3_600_000;

/**
 * V-TPH$ harness tests. Every "now" is injected and every runner is
 * deterministic, so all numbers below are hand-computed from the contract, not
 * read off the implementation.
 */

/** A task whose correct answer is exactly `"ok:" + id`. */
function task(id: string, overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id,
    prompt: `solve ${id}`,
    category: "unit",
    decomposable: false,
    grade: (output: string) => output === `ok:${id}`,
    ...overrides,
  };
}

function result(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    output: "",
    claimedVerified: false,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    provenance: [],
    ...overrides,
  };
}

/** now() that returns the given values in sequence (start, end, start, end, ...). */
function clock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("runVtph classification", () => {
  const tasks = [task("a"), task("b"), task("c"), task("d")];

  it("classifies correct+claimed as verifiedCorrect, correct+unclaimed as declined+correctButUnclaimed, wrong+claimed as silentWrong, wrong+unclaimed as declined", async () => {
    const runner: AgentRunner = async (t) => {
      switch (t.id) {
        case "a":
          return result({ output: "ok:a", claimedVerified: true, provenance: ["p"] });
        case "b":
          return result({ output: "ok:b", claimedVerified: false });
        case "c":
          return result({ output: "WRONG", claimedVerified: true, provenance: ["p"] });
        default:
          return result({ output: "WRONG", claimedVerified: false });
      }
    };

    const r = await runVtph(runner, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(r.tasks).toBe(4);
    expect(r.verifiedCorrect).toBe(1); // a
    expect(r.silentWrong).toBe(1); // c
    expect(r.declined).toBe(2); // b, d
    expect(r.correctButUnclaimed).toBe(1); // b (right but not claimed)
    // every task lands in exactly one primary bucket
    expect(r.verifiedCorrect + r.silentWrong + r.declined).toBe(r.tasks);
  });
});

describe("runVtph arithmetic", () => {
  it("computes vtph, vtphPerDollar, and verifiedYield on known time/tokens/usd", async () => {
    // 3 verifiedCorrect tasks, batch takes exactly half an hour, $2 total.
    const tasks = [task("a"), task("b"), task("c")];
    const runner: AgentRunner = async (t) =>
      result({
        output: `ok:${t.id}`,
        claimedVerified: true,
        provenance: ["src"],
        tokensIn: 10,
        tokensOut: 5,
        usd: 2 / 3,
      });

    const r = await runVtph(runner, tasks, { now: clock([1000, 1000 + MS_PER_HOUR / 2]) });
    expect(r.verifiedCorrect).toBe(3);
    expect(r.wallClockMs).toBe(MS_PER_HOUR / 2);
    // vtph = 3 / 0.5h = 6
    expect(r.vtph).toBeCloseTo(6, 9);
    expect(r.totalTokens).toBe(45); // 3 * (10+5)
    expect(r.totalUsd).toBeCloseTo(2, 9);
    // vtphPerDollar = 6 / 2 = 3
    expect(r.vtphPerDollar).toBeCloseTo(3, 9);
    // verifiedYield = (3 - 10*0) / $2 = 1.5 — wall-clock plays no part.
    expect(r.verifiedYield).toBeCloseTo(1.5, 9);
    expect(r.provenanceCompleteRate).toBe(1);
  });
});

describe("wall-clock floor (degenerate sub-millisecond measurements)", () => {
  const tasks = [task("a"), task("b")];
  const honest: AgentRunner = async (t) =>
    result({ output: `ok:${t.id}`, claimedVerified: true, provenance: ["p"], usd: 0.5 });

  it("a 0ms batch does NOT collapse vtph to 0 — the denominator floors at 1ms", async () => {
    const r = await runVtph(honest, tasks, { now: clock([5, 5]) });
    expect(r.wallClockMs).toBe(0); // the raw measurement is reported honestly
    // vtph = 2 / (max(0,1)ms in hours) = 2 * 3_600_000
    expect(r.vtph).toBeCloseTo(2 * MS_PER_HOUR, 6);
    expect(r.vtphPerDollar).toBeCloseTo((2 * MS_PER_HOUR) / 1, 6); // $1 total
    expect(r.vtph).toBeGreaterThan(0);
    expect(Number.isFinite(r.vtphPerDollar)).toBe(true);
  });

  it("clamps every sub-1ms elapsed to exactly the 1ms floor (0, 0.25ms, 1ms all agree)", async () => {
    const r0 = await runVtph(honest, tasks, { now: clock([0, 0]) });
    const rQuarter = await runVtph(honest, tasks, { now: clock([0, 0.25]) });
    const r1 = await runVtph(honest, tasks, { now: clock([0, 1]) });
    expect(r0.vtph).toBeCloseTo(r1.vtph, 9);
    expect(rQuarter.vtph).toBeCloseTo(r1.vtph, 9);
    // A backwards clock (end < start) floors too, instead of going negative.
    const rSkew = await runVtph(honest, tasks, { now: clock([10, 4]) });
    expect(rSkew.vtph).toBeCloseTo(r1.vtph, 9);
  });

  it("two lanes with IDENTICAL verified counts and spend can no longer read 0.00 vs millions off a 0ms-vs-1ms rounding artifact", async () => {
    // Same runner, same tasks, same spend — only the measured wall-clock
    // differs (0ms vs 1ms, i.e. pure clock-resolution noise). Before the
    // floor, the 0ms lane scored vtph 0 while the 1ms lane scored millions.
    const zeroMs = await runVtph(honest, tasks, { now: clock([0, 0]) });
    const oneMs = await runVtph(honest, tasks, { now: clock([0, 1]) });
    expect(zeroMs.verifiedCorrect).toBe(oneMs.verifiedCorrect);
    expect(zeroMs.totalUsd).toBeCloseTo(oneMs.totalUsd, 12);
    expect(zeroMs.vtph).toBeCloseTo(oneMs.vtph, 9);
    expect(zeroMs.vtphPerDollar).toBeCloseTo(oneMs.vtphPerDollar, 9);
  });

  it("above the floor, elapsed time still matters (2ms is half the vtph of 1ms)", async () => {
    const oneMs = await runVtph(honest, tasks, { now: clock([0, 1]) });
    const twoMs = await runVtph(honest, tasks, { now: clock([0, 2]) });
    expect(twoMs.vtph).toBeCloseTo(oneMs.vtph / 2, 6);
  });
});

describe("verifiedYield — the trust-adjusted headline", () => {
  const tasks = [task("a"), task("b"), task("c"), task("d")];

  it("goes NEGATIVE when silentWrong > 0: each lie is a 10x penalty on the numerator", async () => {
    // 2 verifiedCorrect + 2 silentWrong at $0.25/task = $1 total.
    const runner: AgentRunner = async (t) =>
      result({
        output: t.id === "a" || t.id === "b" ? `ok:${t.id}` : "WRONG",
        claimedVerified: true,
        provenance: ["p"],
        usd: 0.25,
      });
    const r = await runVtph(runner, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(r.verifiedCorrect).toBe(2);
    expect(r.silentWrong).toBe(2);
    // verifiedYield = (2 - 10*2) / $1 = -18
    expect(r.verifiedYield).toBeCloseTo(-18, 9);
    expect(r.verifiedYield).toBeLessThan(0);
  });

  it("a lane that lies scores STRICTLY worse than one that declines the same tasks", async () => {
    // Both get the same 2 tasks right; on the other 2, the liar claims a
    // wrong answer while the decliner honestly declines. Same spend.
    const liar: AgentRunner = async (t) =>
      result({
        output: t.id === "a" || t.id === "b" ? `ok:${t.id}` : "WRONG",
        claimedVerified: true,
        provenance: ["p"],
        usd: 0.25,
      });
    const decliner: AgentRunner = async (t) =>
      result({
        output: t.id === "a" || t.id === "b" ? `ok:${t.id}` : "WRONG",
        claimedVerified: t.id === "a" || t.id === "b",
        provenance: ["p"],
        usd: 0.25,
      });
    const rl = await runVtph(liar, tasks, { now: clock([0, MS_PER_HOUR]) });
    const rd = await runVtph(decliner, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(rl.verifiedCorrect).toBe(rd.verifiedCorrect); // same correct work surfaced
    expect(rd.verifiedYield).toBeCloseTo(2, 9); // (2 - 0) / $1
    expect(rl.verifiedYield).toBeCloseTo(-18, 9); // (2 - 20) / $1
    expect(rl.verifiedYield).toBeLessThan(rd.verifiedYield); // lying is strictly worse
  });

  it("wall-clock never appears in the verifiedYield denominator (deliberate: trust-per-dollar, not throughput)", async () => {
    const runner: AgentRunner = async (t) =>
      result({ output: `ok:${t.id}`, claimedVerified: true, provenance: ["p"], usd: 0.5 });
    const fast = await runVtph(runner, tasks, { now: clock([0, 1]) });
    const slow = await runVtph(runner, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(fast.vtph).not.toBeCloseTo(slow.vtph, 3); // throughput differs...
    expect(fast.verifiedYield).toBeCloseTo(slow.verifiedYield, 12); // ...trust-per-dollar does not
    expect(fast.verifiedYield).toBeCloseTo(4 / 2, 9); // (4 - 0) / $2
  });

  it("floors the dollar denominator at 1e-9, same as vtphPerDollar", async () => {
    const freeRunner: AgentRunner = async (t) =>
      result({ output: `ok:${t.id}`, claimedVerified: true, provenance: ["p"], usd: 0 });
    const r = await runVtph(freeRunner, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(r.totalUsd).toBe(0);
    expect(r.verifiedYield).toBeCloseTo(4 / 1e-9, 0);
    expect(Number.isFinite(r.verifiedYield)).toBe(true);
  });
});

describe("liar runner", () => {
  it("always claims verified but is always wrong → verifiedCorrect 0, silentWrong = tasks, vtph 0", async () => {
    const tasks = [task("a"), task("b"), task("c"), task("d"), task("e")];
    const liar: AgentRunner = async () =>
      result({ output: "lie", claimedVerified: true, provenance: ["fabricated"], usd: 1 });

    const r = await runVtph(liar, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(r.verifiedCorrect).toBe(0);
    expect(r.silentWrong).toBe(5); // every claim is a trust failure
    expect(r.declined).toBe(0);
    expect(r.vtph).toBe(0);
    expect(r.vtphPerDollar).toBe(0);
    // verifiedYield = (0 - 10*5) / $5 = -10: a liar scores NEGATIVE trust.
    expect(r.verifiedYield).toBeCloseTo(-10, 9);
  });
});

describe("bounded concurrency", () => {
  it("never exceeds the concurrency cap (independent counter)", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const runner: AgentRunner = async (t) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // yield to the event loop a couple of times so lanes actually overlap
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return result({ output: `ok:${t.id}`, claimedVerified: true, provenance: ["p"] });
    };

    const r = await runVtph(runner, tasks, { concurrency: 4, now: clock([0, MS_PER_HOUR]) });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // it really did run in parallel
    expect(r.verifiedCorrect).toBe(20);
  });
});

describe("throwing runner", () => {
  it("counts a throw as declined with zero cost and does not crash the batch", async () => {
    const tasks = [task("a"), task("b"), task("c")];
    const runner: AgentRunner = async (t) => {
      if (t.id === "b") throw new Error("boom");
      return result({
        output: `ok:${t.id}`,
        claimedVerified: true,
        provenance: ["p"],
        usd: 5,
        tokensIn: 100,
        tokensOut: 100,
      });
    };

    const r = await runVtph(runner, tasks, { now: clock([0, MS_PER_HOUR]) });
    expect(r.verifiedCorrect).toBe(2); // a, c
    expect(r.declined).toBe(1); // b threw
    expect(r.silentWrong).toBe(0);
    // the throwing task contributed no tokens/usd
    expect(r.totalUsd).toBe(10);
    expect(r.totalTokens).toBe(400);
  });
});

describe("provenanceCompleteRate", () => {
  it("is the fraction of claimedVerified results with non-empty provenance", async () => {
    const tasks = [task("a"), task("b"), task("c"), task("d")];
    const runner: AgentRunner = async (t) => {
      switch (t.id) {
        case "a":
          return result({ output: "ok:a", claimedVerified: true, provenance: ["x"] });
        case "b":
          return result({ output: "ok:b", claimedVerified: true, provenance: [] }); // claimed, no trail
        case "c":
          return result({ output: "ok:c", claimedVerified: false, provenance: ["y"] }); // not claimed → ignored
        default:
          return result({ output: "ok:d", claimedVerified: true, provenance: ["z"] });
      }
    };

    const r = await runVtph(runner, tasks, { now: clock([0, MS_PER_HOUR]) });
    // 3 claimedVerified (a, b, d); 2 of them have provenance → 2/3
    expect(r.provenanceCompleteRate).toBeCloseTo(2 / 3, 9);
  });
});

describe("compareVtph", () => {
  const tasks = [task("a"), task("b"), task("c"), task("d")];

  // Honest verifier: claims verified only when actually correct, cheap.
  const honest: AgentRunner = async (t) =>
    result({ output: `ok:${t.id}`, claimedVerified: true, provenance: ["proof"], usd: 0.25 });

  // Liar: always claims, always wrong, and expensive.
  const liar: AgentRunner = async (t) => {
    void t;
    return result({ output: "lie", claimedVerified: true, provenance: ["fake"], usd: 1 });
  };

  it("renders a table and computes vtphPerDollarSpeedup best/worst", async () => {
    // Each report consumes 2 now() reads; give both an exact 1-hour batch.
    const cmp = await compareVtph(
      [
        { label: "honest", runner: honest },
        { label: "liar", runner: liar },
      ],
      tasks,
      { now: clock([0, MS_PER_HOUR, 0, MS_PER_HOUR]) }
    );

    expect(cmp.reports).toHaveLength(2);
    const honestReport = cmp.reports.find((r) => r.label === "honest")!;
    const liarReport = cmp.reports.find((r) => r.label === "liar")!;
    expect(honestReport.verifiedCorrect).toBe(4);
    expect(honestReport.silentWrong).toBe(0);
    expect(liarReport.verifiedCorrect).toBe(0);
    expect(liarReport.silentWrong).toBe(4);

    // honest: vtph = 4/1h = 4, usd = 1 → vtphPerDollar 4. liar: 0.
    expect(honestReport.vtphPerDollar).toBeCloseTo(4, 9);
    expect(liarReport.vtphPerDollar).toBe(0);

    // Trust-adjusted: honest (4-0)/$1 = 4; liar (0-40)/$4 = -10.
    expect(honestReport.verifiedYield).toBeCloseTo(4, 9);
    expect(liarReport.verifiedYield).toBeCloseTo(-10, 9);

    // best/worst with worst=0 is an UNDEFINED ratio, reported as null rather
    // than Infinity: these comparisons get persisted into published run
    // artifacts, and JSON.stringify turns Infinity into null — so a manifest
    // written with Infinity could never be re-verified against a fresh
    // recomputation. null round-trips, and "a lane verified nothing" is the
    // more honest reading than "infinitely better".
    expect(cmp.vtphPerDollarSpeedup).toBeNull();

    expect(cmp.markdownTable).toContain("honest");
    expect(cmp.markdownTable).toContain("liar");
    expect(cmp.markdownTable).toContain("V-TPH$/$");
    // The trust-adjusted column is rendered, including the negative figure.
    expect(cmp.markdownTable).toContain("Yield$");
    expect(cmp.markdownTable).toContain("-10.00");
  });

  it("computes a finite speedup between two honest runners of different cost", async () => {
    const cheap = honest; // $0.25/task
    const pricey: AgentRunner = async (t) =>
      result({ output: `ok:${t.id}`, claimedVerified: true, provenance: ["proof"], usd: 0.5 });

    const cmp = await compareVtph(
      [
        { label: "cheap", runner: cheap },
        { label: "pricey", runner: pricey },
      ],
      tasks,
      { now: clock([0, MS_PER_HOUR, 0, MS_PER_HOUR]) }
    );
    // cheap usd=1 → vtphPerDollar 4; pricey usd=2 → vtphPerDollar 2; speedup 2.
    expect(cmp.vtphPerDollarSpeedup).toBeCloseTo(2, 9);
  });
});
