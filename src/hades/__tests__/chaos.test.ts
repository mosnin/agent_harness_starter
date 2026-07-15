import { describe, it, expect, vi } from "vitest";
import { runChaosHierarchy, type ChaosOutcome } from "../hierarchy/chaos";
import { reduceRef } from "../hierarchy/fuzz";

/**
 * An injectable timer that resolves each scheduled callback on the next microtask
 * — deterministic, never touches real time, never hangs. Used for tests that want
 * delays exercised (out-of-order resolution) without a virtual clock to drive.
 */
const immediate = {
  setTimeoutFn: (cb: () => void): ReturnType<typeof setTimeout> => {
    Promise.resolve().then(cb);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  },
  clearTimeoutFn: (): void => {},
};

const data = [3, -1, 4, 1, 5, 9, 2, 6]; // 8 leaves
const expectedSum = reduceRef("sum", data) as number; // 29

describe("runChaosHierarchy", () => {
  it("zero chaos → ok:true, verified, result === full sum", async () => {
    const outcome = await runChaosHierarchy(1, data);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result).toBe(expectedSum);
    expect(outcome.reference).toBe(expectedSum);
    expect(outcome.verified).toBe(true);
    expect(outcome.audit.leaves).toBe(data.length);
    expect(outcome.audit.leafAttempts).toBe(data.length); // one attempt each
    expect(outcome.audit.drops).toBe(0);
    expect(outcome.audit.retries).toBe(0);
    expect(outcome.audit.killedNodes).toEqual([]);
  });

  it("dropProb=1, maxRetries=2 → clean ok:false with failedLeaves, no hang", async () => {
    const outcome = await runChaosHierarchy(2, data, { dropProb: 1, maxRetries: 2 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failedLeaves.length).toBeGreaterThan(0);
    // Every leaf is unrecoverable under dropProb=1 → all fail, none silently omitted.
    expect(outcome.failedLeaves).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(outcome.reason).toMatch(/retry budget/);
    // Bounded: (maxRetries + 1) attempts per leaf = 3 * 8.
    expect(outcome.audit.leafAttempts).toBe(3 * data.length);
    expect(outcome.audit.drops).toBeGreaterThan(0);
    // A failure result is not even present — cannot be a wrong sum.
    expect("result" in outcome).toBe(false);
  });

  it("killProb=1 → every node dead → ok:false promptly", async () => {
    const outcome = await runChaosHierarchy(3, data, { killProb: 1, maxRetries: 3 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failedLeaves).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(outcome.audit.killedNodes.length).toBe(data.length);
    // Kills are not drops.
    expect(outcome.audit.drops).toBe(0);
  });

  it("moderate dropProb with a generous retry budget → retries recover, result === full sum", async () => {
    const outcome = await runChaosHierarchy(
      42,
      data,
      { dropProb: 0.5, maxRetries: 30 },
      immediate
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result).toBe(expectedSum); // dropped leaves were recovered, sum intact
    expect(outcome.verified).toBe(true);
    // Retries actually happened and recovered the drops.
    expect(outcome.audit.drops).toBeGreaterThan(0);
    expect(outcome.audit.retries).toBeGreaterThan(0);
    expect(outcome.audit.leafAttempts).toBeGreaterThan(data.length);
  });

  it("determinism: same seed → identical outcome (including audit)", async () => {
    const cfg = { dropProb: 0.3, delayProb: 0.3, maxDelayMs: 5, killProb: 0.1, maxRetries: 4 };
    const a = await runChaosHierarchy(777, data, cfg, immediate);
    const b = await runChaosHierarchy(777, data, cfg, immediate);
    expect(a).toEqual(b);
    // And a different seed generally diverges in its audit fingerprint.
    const c = await runChaosHierarchy(778, data, cfg, immediate);
    expect(c).not.toEqual(a);
  });

  it("delays via fake timers don't hang and don't change the sum", async () => {
    vi.useFakeTimers();
    try {
      const p = runChaosHierarchy(
        9,
        data,
        { delayProb: 1, maxDelayMs: 50, maxRetries: 3 },
        {
          setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
          clearTimeoutFn: (t) => clearTimeout(t),
        }
      );
      await vi.runAllTimersAsync(); // drive the virtual clock; never real time
      const outcome = await p;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.result).toBe(expectedSum);
      expect(outcome.verified).toBe(true);
      // delayProb=1, dropProb=0 → exactly one delayed attempt per leaf.
      expect(outcome.audit.delaysInjected).toBe(data.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("audit counters: leafAttempts >= leaves, retries counted under drops", async () => {
    const outcome = await runChaosHierarchy(123, data, { dropProb: 0.4, maxRetries: 10 }, immediate);
    expect(outcome.audit.leafAttempts).toBeGreaterThanOrEqual(outcome.audit.leaves);
    // leafAttempts = leaves + retries by construction.
    expect(outcome.audit.leafAttempts).toBe(outcome.audit.leaves + outcome.audit.retries);
    if (outcome.audit.drops > 0) expect(outcome.audit.retries).toBeGreaterThan(0);
  });

  it("non-power-of-two leaf count: surplus slots contribute 0, sum stays exact", async () => {
    const odd = [10, 20, 30, 40, 50]; // 5 leaves → 8-slot tree, 3 surplus zeros
    const outcome: ChaosOutcome = await runChaosHierarchy(5, odd);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result).toBe(150);
    expect(outcome.verified).toBe(true);
    expect(outcome.audit.leaves).toBe(5);
    expect(outcome.audit.leafAttempts).toBe(5); // surplus slots not counted
  });

  it("empty workload settles to ok:true with result 0", async () => {
    const outcome = await runChaosHierarchy(0, [], { dropProb: 1, killProb: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result).toBe(0);
    expect(outcome.verified).toBe(true);
  });
});
