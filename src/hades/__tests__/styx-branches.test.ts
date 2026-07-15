import { describe, it, expect } from "vitest";
import { BranchTree, type BranchNode } from "../styx/branches";

/**
 * A fixed sequence of operations used by determinism / replay tests. Applying it
 * to a fresh tree must always yield a byte-identical structure.
 */
function buildFixture(): BranchTree {
  const t = new BranchTree(["divide-and-conquer", "top-down", "retrieval-first"]);
  t.expand("b0", ["split-A", "split-B"]);
  t.advance("b0.0", { costDelta: 0.5, steps: 2, output: "partial", provenance: ["worker:haiku"] });
  t.markVerified("b0.0", 0.82);
  t.advance("b0.1", { costDelta: 0.3, steps: 1 });
  t.prune("b1", "dominated by b0.0");
  t.markVerified("b2", 0.4);
  return t;
}

describe("BranchTree construction", () => {
  it("seeds K divergent roots, all pending with deterministic ids", () => {
    const t = new BranchTree(["s0", "s1", "s2"]);
    const roots = t.root();
    expect(roots.map((r) => r.id)).toEqual(["b0", "b1", "b2"]);
    expect(roots.every((r) => r.state === "pending")).toBe(true);
    expect(roots.every((r) => r.fitness === 0 && r.costSpent === 0 && r.depth === 0)).toBe(true);
    expect(roots.map((r) => r.strategy)).toEqual(["s0", "s1", "s2"]);
    // all roots are actionable frontier
    expect(t.frontier().map((n) => n.id)).toEqual(["b0", "b1", "b2"]);
  });
});

describe("expand", () => {
  it("creates deterministic child ids, sets parent active, continues numbering", () => {
    const t = new BranchTree(["root"]);
    const first = t.expand("b0", ["a", "b"]);
    expect(first.map((n) => n.id)).toEqual(["b0.0", "b0.1"]);
    expect(first.every((n) => n.depth === 1 && n.state === "pending")).toBe(true);
    expect(t.get("b0")!.state).toBe("active");
    // second expand continues from existing child count
    const second = t.expand("b0", ["c"]);
    expect(second.map((n) => n.id)).toEqual(["b0.2"]);
    expect(t.children("b0").map((n) => n.id)).toEqual(["b0.0", "b0.1", "b0.2"]);
    // grandchildren nest under their parent id
    const gc = t.expand("b0.0", ["x", "y"]);
    expect(gc.map((n) => n.id)).toEqual(["b0.0.0", "b0.0.1"]);
    expect(gc[0].depth).toBe(2);
  });
});

describe("advance", () => {
  it("accumulates cost across two advances and sums steps", () => {
    const t = new BranchTree(["root"]);
    t.advance("b0", { costDelta: 0.4, steps: 3 });
    t.advance("b0", { costDelta: 0.25, steps: 2, output: "o", fitness: 0.6, provenance: ["v1"] });
    const n = t.get("b0")!;
    expect(n.costSpent).toBeCloseTo(0.65, 10);
    expect(n.steps).toBe(5);
    expect(n.output).toBe("o");
    expect(n.fitness).toBe(0.6);
    expect(n.provenance).toEqual(["v1"]);
    expect(n.state).toBe("active");
  });

  it("throws RangeError on negative costDelta and clamps fitness to [0,1]", () => {
    const t = new BranchTree(["root"]);
    expect(() => t.advance("b0", { costDelta: -0.01 })).toThrow(RangeError);
    t.advance("b0", { costDelta: 0, fitness: 1.7 });
    expect(t.get("b0")!.fitness).toBe(1);
    t.advance("b0", { costDelta: 0, fitness: -3 });
    expect(t.get("b0")!.fitness).toBe(0);
    expect(() => t.advance("b0", { costDelta: 0, fitness: NaN })).toThrow(RangeError);
  });
});

describe("markVerified + best", () => {
  it("best() picks the max-fitness verified branch and ignores pruned", () => {
    const t = new BranchTree(["a", "b", "c"]);
    t.markVerified("b0", 0.7);
    t.markVerified("b1", 0.9);
    t.markVerified("b2", 0.5);
    expect(t.best()!.id).toBe("b1");
    expect(t.stats().bestFitness).toBeCloseTo(0.9, 10);
    // pruning the winner drops it from best()
    t.prune("b1", "reject");
    expect(t.best()!.id).toBe("b0");
    // pending/unverified branches are never best()
    const t2 = new BranchTree(["x"]);
    expect(t2.best()).toBeUndefined();
  });
});

describe("prune", () => {
  it("cascades to the whole subtree, removes them from frontier, and is idempotent", () => {
    const t = new BranchTree(["root"]);
    t.expand("b0", ["a", "b"]);
    t.expand("b0.0", ["a1", "a2"]);
    t.prune("b0.0", "dead line");
    const affected = ["b0.0", "b0.0.0", "b0.0.1"];
    for (const id of affected) expect(t.get(id)!.state).toBe("pruned");
    // subtree provenance carries the reason exactly once
    expect(t.get("b0.0")!.provenance).toEqual(["dead line"]);
    expect(t.get("b0.0.0")!.provenance).toEqual(["dead line"]);
    // frontier excludes the pruned subtree; parent b0 and sibling b0.1 remain
    expect(t.frontier().map((n) => n.id)).toEqual(["b0", "b0.1"]);
    // idempotent: re-pruning is a no-op, reason not duplicated
    t.prune("b0.0", "dead line");
    expect(t.get("b0.0.0")!.provenance).toEqual(["dead line"]);
    expect(t.stats().pruned).toBe(3);
  });

  it("frontier excludes nodes under a pruned ancestor even if they were active", () => {
    const t = new BranchTree(["root"]);
    t.expand("b0", ["a"]);
    t.expand("b0.0", ["a1"]);
    t.advance("b0.0.0", { costDelta: 0.1 }); // now active
    expect(t.frontier().some((n) => n.id === "b0.0.0")).toBe(true);
    t.prune("b0", "kill root branch");
    expect(t.frontier()).toEqual([]);
  });
});

describe("totalCost accounting", () => {
  it("includes cost spent on pruned branches (honest V-TPH$ accounting)", () => {
    const t = new BranchTree(["a", "b"]);
    t.advance("b0", { costDelta: 1.0 });
    t.advance("b1", { costDelta: 2.0 });
    t.prune("b1", "loser"); // pruned, but its $2 was really spent
    expect(t.stats().totalCost).toBeCloseTo(3.0, 10);
    expect(t.get("b1")!.costSpent).toBeCloseTo(2.0, 10);
  });
});

describe("guards", () => {
  it("throws on missing ids and on operating on pruned/done nodes", () => {
    const t = new BranchTree(["root"]);
    expect(() => t.advance("nope", { costDelta: 0 })).toThrow();
    expect(() => t.expand("nope", ["x"])).toThrow();
    expect(() => t.prune("nope", "r")).toThrow();
    expect(() => t.complete("nope")).toThrow();

    t.prune("b0", "dead");
    expect(() => t.expand("b0", ["x"])).toThrow();
    expect(() => t.advance("b0", { costDelta: 0 })).toThrow();
    expect(() => t.complete("b0")).toThrow();

    const t2 = new BranchTree(["root"]);
    t2.complete("b0");
    expect(() => t2.expand("b0", ["x"])).toThrow();
    expect(() => t2.advance("b0", { costDelta: 0 })).toThrow();
  });
});

describe("stats", () => {
  it("counts branches by state", () => {
    const t = buildFixture();
    const s = t.stats();
    // b0(active via expand->advance children? b0 became active on expand), b0.0 verified,
    // b0.1 active, b1 pruned, b2 verified
    expect(s.total).toBe(5);
    expect(s.pruned).toBe(1);
    expect(s.verified).toBe(2);
    // sum of all counts equals total
    expect(s.pending + s.active + s.verified + s.pruned + s.done).toBe(s.total);
    expect(s.bestFitness).toBeCloseTo(0.82, 10);
  });
});

describe("determinism", () => {
  it("replaying identical operations yields an identical tree", () => {
    const snap = (t: BranchTree): BranchNode[] => t.all().map((n) => ({ ...n, provenance: [...n.provenance] }));
    const a = snap(buildFixture());
    const b = snap(buildFixture());
    expect(a).toEqual(b);
    // ids are in stable numeric-segment order, not lexicographic
    const t = new BranchTree(Array.from({ length: 11 }, (_, i) => `s${i}`));
    expect(t.all().map((n) => n.id)).toEqual([
      "b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10",
    ]);
  });
});
