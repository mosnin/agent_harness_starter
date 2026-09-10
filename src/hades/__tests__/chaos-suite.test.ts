import { describe, it, expect } from "vitest";
import {
  runChaosSuite,
  makeInstantTimer,
  DEFAULT_CHAOS_SCENARIOS,
} from "../bench/chaos-suite";

describe("chaos-suite", () => {
  it("holds the invariant with zero silent-wrong results", async () => {
    const report = await runChaosSuite({ runsPerScenario: 12 });
    expect(report.totalSilentWrong).toBe(0);
    expect(report.allInvariantsHeld).toBe(true);
    // every scenario individually accounts for all its runs in the two buckets
    for (const sc of report.scenarios) {
      expect(sc.silentWrong).toBe(0);
      expect(sc.verifiedCorrect + sc.cleanFailures).toBe(sc.runs);
      expect(sc.invariantHeld).toBe(true);
    }
    expect(report.totalRuns).toBe(DEFAULT_CHAOS_SCENARIOS.length * 12);
  });

  it("calm scenario is ALL verified-correct (verified branch fires)", async () => {
    const report = await runChaosSuite({ runsPerScenario: 15 });
    const calm = report.scenarios.find((s) => s.label === "calm");
    expect(calm).toBeDefined();
    expect(calm!.verifiedCorrect).toBe(calm!.runs);
    expect(calm!.cleanFailures).toBe(0);
    expect(calm!.silentWrong).toBe(0);
  });

  it("storm scenario is ALL clean failures (failure branch fires)", async () => {
    const report = await runChaosSuite({ runsPerScenario: 15 });
    const storm = report.scenarios.find((s) => s.label === "storm");
    expect(storm).toBeDefined();
    expect(storm!.cleanFailures).toBe(storm!.runs);
    expect(storm!.verifiedCorrect).toBe(0);
    expect(storm!.silentWrong).toBe(0);
  });

  it("is deterministic — two runs produce identical reports", async () => {
    const a = await runChaosSuite({ runsPerScenario: 10 });
    const b = await runChaosSuite({ runsPerScenario: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("both invariant branches genuinely occur across the suite", async () => {
    const report = await runChaosSuite({ runsPerScenario: 12 });
    const totalVerified = report.scenarios.reduce((n, s) => n + s.verifiedCorrect, 0);
    const totalClean = report.scenarios.reduce((n, s) => n + s.cleanFailures, 0);
    expect(totalVerified).toBeGreaterThan(0);
    expect(totalClean).toBeGreaterThan(0);
  });

  it("makeInstantTimer fires callbacks immediately and honors cancellation", async () => {
    const { setTimeoutFn, clearTimeoutFn } = makeInstantTimer();
    let fired = 0;
    let cancelledFired = 0;
    setTimeoutFn(() => {
      fired++;
    }, 10_000);
    const id = setTimeoutFn(() => {
      cancelledFired++;
    }, 10_000);
    clearTimeoutFn(id);
    // drain the microtask queue
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toBe(1);
    expect(cancelledFired).toBe(0);
  });
});
