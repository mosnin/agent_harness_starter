import { describe, it, expect } from "vitest";
import {
  fuzzMany,
  runFuzzCase,
  reduceRef,
  type ReductionName,
} from "../hierarchy/fuzz";

const ALL_REDUCTIONS: ReductionName[] = [
  "sum",
  "product",
  "max",
  "min",
  "concat",
];

describe("hierarchy property: hierarchy fold === flat reference", () => {
  it("matches the flat reference on 300 random shapes/reductions/workloads", async () => {
    const r = await fuzzMany(300);
    expect(r.checked).toBe(300);
    // Headline oracle: every seed's tree fold equals the flat left-to-right fold.
    // If it ever fails, surface the reproducible failing case (seed + everything).
    expect(r.firstFailure, JSON.stringify(r.firstFailure)).toBeNull();
    expect(r.failures.length).toBe(0);
  });

  it("exercises ALL FIVE reductions across a sample of seeds", async () => {
    const seen = new Set<ReductionName>();
    for (let seed = 0; seed < 200; seed++) {
      const c = await runFuzzCase(seed);
      seen.add(c.reduction);
      if (seen.size === ALL_REDUCTIONS.length) break;
    }
    for (const name of ALL_REDUCTIONS) {
      // A missing reduction here is a generator gap, not a hierarchy bug.
      expect(
        seen.has(name),
        `reduction "${name}" never appeared in 200 seeds; seen=${JSON.stringify([...seen])}`,
      ).toBe(true);
    }
  });

  it("produces structurally real, independently-verifiable cases", async () => {
    for (const seed of [0, 1, 2, 7, 13, 99, 256, 1000]) {
      const c = await runFuzzCase(seed);

      // Full balanced tree: leafCount = branching^(coordinatorLevels+1),
      // and the leaf values array is exactly that long.
      expect(c.spec.leafCount).toBe(
        c.spec.branching ** (c.spec.coordinatorLevels + 1),
      );
      expect(c.leafValues.length).toBe(c.spec.leafCount);

      // The case claims to match...
      expect(c.match).toBe(true);
      expect(c.hierResult).toBe(c.referenceResult);

      // ...but don't trust its own fields: recompute the reference independently.
      const independentRef = reduceRef(c.reduction, c.leafValues);
      expect(c.hierResult).toBe(independentRef);
      expect(c.referenceResult).toBe(independentRef);
    }
  });

  it("explores diverse tree shapes (varied branching AND depth)", async () => {
    const branchings = new Set<number>();
    const levels = new Set<number>();
    for (let seed = 0; seed < 200; seed++) {
      const c = await runFuzzCase(seed);
      branchings.add(c.spec.branching);
      levels.add(c.spec.coordinatorLevels);
    }
    expect(
      branchings.size,
      `only branching(s) ${JSON.stringify([...branchings])} seen`,
    ).toBeGreaterThan(1);
    expect(
      levels.size,
      `only coordinatorLevels ${JSON.stringify([...levels])} seen`,
    ).toBeGreaterThan(1);
  });

  it("is deterministic: same seed yields the same case", async () => {
    const a = await runFuzzCase(42);
    const b = await runFuzzCase(42);
    expect(b.reduction).toBe(a.reduction);
    expect(b.spec).toEqual(a.spec);
    expect(b.hierResult).toBe(a.hierResult);
    expect(b.referenceResult).toBe(a.referenceResult);
    expect(b.leafValues).toEqual(a.leafValues);
  });
});
