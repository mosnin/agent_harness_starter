import { describe, it, expect } from "vitest";
import {
  FlatOrchestrator,
  type FlatExec,
} from "../bench/flat-baseline";

/** A trivial numeric exec: split into N ones, each worker returns its index, sum on combine. */
function numericExec(): FlatExec<number, number> {
  return {
    split: (_task, n) => Array.from({ length: n }, () => 1),
    execute: async (_t, i) => i,
    combine: (results) => results.reduce((a, b) => a + b, 0),
  };
}

describe("FlatOrchestrator", () => {
  it("routeScans follows the exact N*(N+1)/2 formula", async () => {
    for (const n of [1, 4, 16]) {
      const orch = new FlatOrchestrator<number, number>(n, numericExec());
      const { stats } = await orch.run(0);
      expect(stats.routeScans).toBe((n * (n + 1)) / 2);
    }
  });

  it("peakConcurrency equals workerCount under a delayed execute", async () => {
    const n = 8;
    const exec: FlatExec<number, number> = {
      split: (_t, count) => Array.from({ length: count }, (_v, i) => i),
      execute: (_t, i) =>
        new Promise((resolve) => setTimeout(() => resolve(i), 5)),
      combine: (results) => results.length,
    };
    const orch = new FlatOrchestrator<number, number>(n, exec);
    const { stats } = await orch.run(0);
    expect(stats.peakConcurrency).toBe(n);
    expect(stats.peakConcurrency).toBe(orch.workerCount());
  });

  it("combine receives results in worker-index order even when later workers resolve first", async () => {
    const n = 5;
    const exec: FlatExec<number, string> = {
      split: (_t, count) => Array.from({ length: count }, (_v, i) => i),
      // Earlier indices resolve LATER (bigger delay), so completion order is reversed.
      execute: (_t, i) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(`w${i}`), (n - i) * 5),
        ),
      combine: (results) => results.join(","),
    };
    const orch = new FlatOrchestrator<number, string>(n, exec);
    const { result } = await orch.run(0);
    expect(result).toBe("w0,w1,w2,w3,w4");
  });

  it("workerRuns equals the number of sub-tasks executed", async () => {
    const orch = new FlatOrchestrator<number, number>(6, numericExec());
    const { stats } = await orch.run(0);
    expect(stats.workerRuns).toBe(6);
  });

  it("throws RangeError when workerCount < 1", () => {
    expect(() => new FlatOrchestrator<number, number>(0, numericExec())).toThrow(
      RangeError,
    );
    expect(() =>
      new FlatOrchestrator<number, number>(-3, numericExec()),
    ).toThrow(RangeError);
  });

  it("dispatches only present sub-tasks when split returns fewer than workerCount", async () => {
    const n = 5;
    const exec: FlatExec<number, number> = {
      // Only 2 sub-tasks despite 5 workers.
      split: () => [10, 20],
      execute: async (t) => t,
      combine: (results) => results.reduce((a, b) => a + b, 0),
    };
    const orch = new FlatOrchestrator<number, number>(n, exec);
    const { result, stats } = await orch.run(0);
    expect(stats.workerRuns).toBe(2);
    // Only workers w0 (1 scan) and w1 (2 scans) are routed -> 3 total.
    expect(stats.routeScans).toBe(3);
    expect(stats.peakConcurrency).toBe(2);
    expect(result).toBe(30);
  });

  it("ignores extra sub-tasks when split returns more than workerCount", async () => {
    const n = 3;
    const exec: FlatExec<number, number> = {
      split: () => [1, 1, 1, 1, 1], // 5 sub-tasks, only 3 workers
      execute: async () => 1,
      combine: (results) => results.reduce((a, b) => a + b, 0),
    };
    const orch = new FlatOrchestrator<number, number>(n, exec);
    const { result, stats } = await orch.run(0);
    expect(stats.workerRuns).toBe(3);
    expect(stats.routeScans).toBe((n * (n + 1)) / 2);
    expect(result).toBe(3);
  });
});
