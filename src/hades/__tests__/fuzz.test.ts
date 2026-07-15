import { describe, it, expect } from "vitest";
import {
  mulberry32,
  reduceRef,
  randomTreeSpec,
  runFuzzCase,
  fuzzMany,
} from "../hierarchy/fuzz";
import type { ReductionName } from "../hierarchy/fuzz";

describe("mulberry32", () => {
  it("is deterministic: same seed → same sequence", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("different seeds produce different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe("reduceRef", () => {
  it("computes each reduction exactly, in order", () => {
    expect(reduceRef("sum", [1, 2, 3])).toBe(6);
    expect(reduceRef("product", [2, 3, 4])).toBe(24);
    expect(reduceRef("max", [3, 9, -2, 5])).toBe(9);
    expect(reduceRef("min", [3, 9, -2, 5])).toBe(-2);
    expect(reduceRef("concat", [1, 2, 3])).toBe("1,2,3");
  });

  it("concat is order-sensitive", () => {
    expect(reduceRef("concat", [3, 1, 2])).toBe("3,1,2");
    expect(reduceRef("concat", [1, 2, 3])).not.toBe(reduceRef("concat", [3, 2, 1]));
  });

  it("returns the identity for empty input", () => {
    expect(reduceRef("sum", [])).toBe(0);
    expect(reduceRef("product", [])).toBe(1);
    expect(reduceRef("max", [])).toBe(-Infinity);
    expect(reduceRef("min", [])).toBe(Infinity);
    expect(reduceRef("concat", [])).toBe("");
  });
});

describe("randomTreeSpec", () => {
  it("always yields a full tree within bounds", () => {
    for (let seed = 0; seed < 50; seed++) {
      const spec = randomTreeSpec(mulberry32(seed));
      expect(spec.branching).toBeGreaterThanOrEqual(2);
      expect(spec.branching).toBeLessThanOrEqual(4);
      expect(spec.coordinatorLevels).toBeGreaterThanOrEqual(0);
      expect(spec.coordinatorLevels).toBeLessThanOrEqual(3);
      expect(spec.leafCount).toBe(spec.branching ** (spec.coordinatorLevels + 1));
    }
  });
});

describe("runFuzzCase", () => {
  it("matches the flat reference for many seeds, populating spec + reduction", async () => {
    const valid: ReductionName[] = ["sum", "product", "max", "min", "concat"];
    for (let seed = 0; seed < 25; seed++) {
      const c = await runFuzzCase(seed);
      expect(c.match).toBe(true);
      expect(c.hierResult).toEqual(c.referenceResult);
      expect(valid).toContain(c.reduction);
      expect(c.spec.leafCount).toBe(c.leafValues.length);
      expect(c.spec.leafCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("is reproducible: same seed → identical FuzzCase", async () => {
    const a = await runFuzzCase(777);
    const b = await runFuzzCase(777);
    expect(a).toEqual(b);
  });
});

describe("fuzzMany", () => {
  it("finds no failures across 100 seeds", async () => {
    const res = await fuzzMany(100);
    expect(res.checked).toBe(100);
    expect(res.failures).toHaveLength(0);
    expect(res.firstFailure).toBeNull();
  });
});

describe("concat order preservation", () => {
  it("a concat case reproduces the exact left-to-right leaf order via the tree", async () => {
    // Find a seed whose reduction is concat, then prove the tree fold equals the
    // ordered join of the leaves — a reordering bug would break this.
    let found = false;
    for (let seed = 0; seed < 200 && !found; seed++) {
      const c = await runFuzzCase(seed);
      if (c.reduction !== "concat") continue;
      found = true;
      expect(c.hierResult).toBe(c.leafValues.join(","));
      expect(c.match).toBe(true);
      // Guard the guard: the ordered join differs from a reversed join unless symmetric.
      const reversed = [...c.leafValues].reverse().join(",");
      if (c.leafValues.join(",") !== reversed) {
        expect(c.hierResult).not.toBe(reversed);
      }
    }
    expect(found).toBe(true);
  });
});
