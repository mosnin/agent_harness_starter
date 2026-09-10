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
  it("computes vtph and vtphPerDollar on known time/tokens/usd", async () => {
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
    expect(r.provenanceCompleteRate).toBe(1);
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

    // best/worst with worst=0 is guarded to Infinity (still > 1).
    expect(cmp.vtphPerDollarSpeedup).toBe(Infinity);

    expect(cmp.markdownTable).toContain("honest");
    expect(cmp.markdownTable).toContain("liar");
    expect(cmp.markdownTable).toContain("V-TPH$/$");
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
