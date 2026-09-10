import { describe, it, expect } from "vitest";
import { FanOutCoordinator } from "../parallel/fanout";

describe("FanOutCoordinator", () => {
  it("maps items across agents, results in input order", async () => {
    const fan = new FanOutCoordinator(["a", "b", "c"], async (_agent, item: number) => item * 10);
    const { results, byAgent } = await fan.map([1, 2, 3, 4, 5, 6]);
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    // Every item processed; work spread across the three agents.
    expect(Object.values(byAgent).reduce((a, b) => a + b, 0)).toBe(6);
    expect(Object.keys(byAgent).length).toBeGreaterThan(1);
  });

  it("runs with parallelism equal to the roster size", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fan = new FanOutCoordinator(["a", "b", "c", "d"], async (_agent, item: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return item;
    });
    await fan.map([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4); // never exceeds roster
  });

  it("faster agents naturally pull more work (implicit balancing)", async () => {
    const fan = new FanOutCoordinator(["fast", "slow"], async (agent, item: number) => {
      if (agent === "slow") await new Promise((r) => setTimeout(r, 5));
      return item;
    });
    const { byAgent } = await fan.map([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(byAgent.fast).toBeGreaterThan(byAgent.slow ?? 0);
  });

  it("first error rejects by default", async () => {
    const fan = new FanOutCoordinator(["a"], async (_agent, item: number) => {
      if (item === 3) throw new Error("bad item");
      return item;
    });
    await expect(fan.map([1, 2, 3, 4])).rejects.toThrow(/item 2 on a failed: bad item/);
  });

  it("continueOnError collects failures and keeps successes", async () => {
    const fan = new FanOutCoordinator(["a", "b"], async (_agent, item: number) => {
      if (item % 2 === 0) throw new Error(`even ${item}`);
      return item;
    });
    const { results, failures } = await fan.map([1, 2, 3, 4, 5], { continueOnError: true });
    expect(results.sort((x, y) => x - y)).toEqual([1, 3, 5]);
    expect(failures.map((f) => f.index).sort()).toEqual([1, 3]);
  });

  it("throws with an empty roster", async () => {
    const fan = new FanOutCoordinator([], async () => 0);
    await expect(fan.map([1])).rejects.toThrow(/at least one agent/);
  });
});
