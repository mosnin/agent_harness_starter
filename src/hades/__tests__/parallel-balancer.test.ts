import { describe, it, expect } from "vitest";
import { LoadBalancer } from "../parallel/balancer";

describe("LoadBalancer", () => {
  it("completes all items across healthy agents", async () => {
    const lb = new LoadBalancer(["a", "b"], async (_agent, item: number) => item + 1);
    const res = await lb.run([1, 2, 3, 4]);
    expect(res.results.sort((x, y) => x - y)).toEqual([2, 3, 4, 5]);
    expect(res.failures).toEqual([]);
  });

  it("steals a failed item to a different agent and succeeds", async () => {
    // Agent "bad" fails everything; "good" succeeds. Every item should recover.
    const lb = new LoadBalancer(
      ["bad", "good"],
      async (agent, item: number) => {
        if (agent === "bad") throw new Error("bad agent");
        return item;
      },
      { maxRetries: 3, quarantineAfter: 10 }
    );
    const res = await lb.run([1, 2, 3, 4]);
    expect(res.results.sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
    expect(res.attempts).toBeGreaterThan(4); // retries happened
  });

  it("quarantines an always-failing agent", async () => {
    const lb = new LoadBalancer(
      ["flaky", "solid"],
      async (agent, item: number) => {
        if (agent === "flaky") throw new Error("nope");
        return item;
      },
      { maxRetries: 5, quarantineAfter: 2 }
    );
    const res = await lb.run([1, 2, 3, 4, 5, 6]);
    expect(res.quarantined).toContain("flaky");
    // All work still completed via the solid agent.
    expect(res.results.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports items that exhaust retries as failures", async () => {
    const lb = new LoadBalancer(["a"], async () => {
      throw new Error("always fails");
    }, { maxRetries: 1, quarantineAfter: 100 });
    const res = await lb.run([1, 2]);
    expect(res.results).toEqual([]);
    expect(res.failures.map((f) => f.index).sort()).toEqual([0, 1]);
  });

  it("gives up remaining items when every agent is quarantined", async () => {
    const lb = new LoadBalancer(["a", "b"], async () => {
      throw new Error("dead");
    }, { maxRetries: 10, quarantineAfter: 1 });
    const res = await lb.run([1, 2, 3, 4, 5]);
    expect(res.quarantined.sort()).toEqual(["a", "b"]);
    expect(res.failures.length).toBe(5);
  });

  it("throws with an empty roster", async () => {
    await expect(new LoadBalancer([], async () => 0).run([1])).rejects.toThrow(/at least one agent/);
  });
});
