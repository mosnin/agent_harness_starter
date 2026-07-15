import { describe, it, expect } from "vitest";
import {
  simulateMakespan,
  buildFlatTopology,
  buildBalancedTopology,
  compareMakespan,
  type LatencyParams,
  type SimNode,
} from "../bench/latency-makespan";

/**
 * ADVERSARIAL VERIFICATION of the latency-model makespan claim.
 *
 * Every "expected" value below is hand-computed from the model description
 * INDEPENDENTLY of the implementation. If the implementation disagrees, the
 * assertion asserts the CORRECT (hand-computed) value and is allowed to fail —
 * that failure IS the bug report.
 */

const P: LatencyParams = { sendMs: 1, linkMs: 1, taskMs: 10, aggMs: 1 };

/**
 * Independent reference simulator, written from the doc comment WITHOUT looking
 * at the impl's control flow. Used to cross-check that the module's own
 * simulateMakespan matches an independent reading of the same rules.
 *
 *  - leaf: finishes at arrival + taskMs
 *  - coordinator with b children:
 *      child k dispatched at arrival + (k+1)*sendMs, reaches child +linkMs later
 *      child result returns +linkMs after the child finishes
 *      parent free at arrival + b*sendMs, folds arrived results one at a time
 *      (aggMs each) in ascending arrival order
 */
function refMakespan(node: SimNode, arrival: number, p: LatencyParams): number {
  if (node.children.length === 0) return arrival + p.taskMs;
  const b = node.children.length;
  const arrivals: number[] = [];
  for (let k = 0; k < b; k++) {
    const dispatchAt = arrival + (k + 1) * p.sendMs;
    const childArrival = dispatchAt + p.linkMs;
    const childFinish = refMakespan(node.children[k], childArrival, p);
    arrivals.push(childFinish + p.linkMs);
  }
  let free = arrival + b * p.sendMs;
  for (const a of [...arrivals].sort((x, y) => x - y)) {
    free = Math.max(free, a) + p.aggMs;
  }
  return free;
}

/** Count leaves in a topology (integrity check on the builders). */
function countLeaves(node: SimNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((s, c) => s + countLeaves(c), 0);
}

describe("1. EXACT hand-computed anti-rigging anchors", () => {
  it("single leaf finishes at arrival + taskMs", () => {
    expect(simulateMakespan({ children: [] }, 0, P)).toBe(10);
    expect(simulateMakespan({ children: [] }, 5, P)).toBe(15);
  });

  it("flat N=4 at arrival 0 equals hand-computed 17", () => {
    // results [13,14,15,16]; free starts at 4; folds -> 14,15,16,17
    expect(simulateMakespan(buildFlatTopology(4), 0, P)).toBe(17);
  });

  it("balanced N=4 B=2 at arrival 0 equals hand-computed 20", () => {
    // root -> two inner(2 leaves); inner@2=17, inner@3=18;
    // root results [18,19]; free 2; folds -> 19,20
    expect(simulateMakespan(buildBalancedTopology(4, 2), 0, P)).toBe(20);
  });

  it("module simulator matches an independent reference reading of the rules", () => {
    const cases: Array<[SimNode, number]> = [
      [{ children: [] }, 0],
      [buildFlatTopology(4), 0],
      [buildFlatTopology(7), 3],
      [buildBalancedTopology(4, 2), 0],
      [buildBalancedTopology(16, 4), 0],
      [buildBalancedTopology(27, 3), 2],
      [buildBalancedTopology(1000, 4), 0],
    ];
    for (const [node, arrival] of cases) {
      expect(simulateMakespan(node, arrival, P)).toBe(refMakespan(node, arrival, P));
    }
  });

  it("builders produce exactly N leaves (no hidden padding/cheating)", () => {
    for (const n of [1, 2, 4, 5, 7, 16, 27, 63, 100, 256, 1000, 1024]) {
      expect(countLeaves(buildFlatTopology(n))).toBe(n);
      expect(countLeaves(buildBalancedTopology(n, 4))).toBe(n);
      expect(countLeaves(buildBalancedTopology(n, 2))).toBe(n);
      expect(countLeaves(buildBalancedTopology(n, 3))).toBe(n);
    }
  });

  it("arrival-shift additivity holds (sanity on the event model)", () => {
    const node = buildBalancedTopology(64, 4);
    const base = simulateMakespan(node, 0, P);
    for (const a of [1, 5, 100]) {
      expect(simulateMakespan(node, a, P)).toBe(base + a);
    }
  });
});

describe("2. Both sides get IDENTICAL params & topology (no secret cheaper hops for the tree)", () => {
  it("compareMakespan feeds the same custom params to flat and tree", () => {
    const params: Partial<LatencyParams> = { sendMs: 2, linkMs: 3, taskMs: 7, aggMs: 2 };
    const full: LatencyParams = { sendMs: 2, linkMs: 3, taskMs: 7, aggMs: 2 };
    const branching = 3;
    const workerCounts = [9, 81];
    const report = compareMakespan({ workerCounts, branching, params });

    for (const n of workerCounts) {
      const row = report.rows.find((r) => r.workers === n)!;
      // Recompute independently with the SAME params on BOTH sides.
      const flat = simulateMakespan(buildFlatTopology(n), 0, full);
      const tree = simulateMakespan(buildBalancedTopology(n, branching), 0, full);
      expect(row.flatMakespanMs).toBe(flat);
      expect(row.treeMakespanMs).toBe(tree);
      // And confirm neither side was handed different params: swapping params
      // between builders must NOT reproduce the reported numbers unless equal.
      expect(row.flatMakespanMs).toBe(refMakespan(buildFlatTopology(n), 0, full));
      expect(row.treeMakespanMs).toBe(
        refMakespan(buildBalancedTopology(n, branching), 0, full)
      );
    }
    expect(report.params).toMatchObject({ ...full, branching });
  });

  it("with taskMs dominating, flat and tree share the same leaf compute floor", () => {
    // A single-leaf lower bound applies to both sides identically.
    const p: LatencyParams = { sendMs: 1, linkMs: 1, taskMs: 1000, aggMs: 1 };
    const flat = simulateMakespan(buildFlatTopology(8), 0, p);
    const tree = simulateMakespan(buildBalancedTopology(8, 2), 0, p);
    expect(flat).toBeGreaterThan(1000);
    expect(tree).toBeGreaterThan(1000);
  });
});

describe("3. Flat baseline is O(N) linear — NOT artificially crippled", () => {
  const flat = (n: number) => simulateMakespan(buildFlatTopology(n), 0, P);

  it("flat(N) == 2N for N>=13 (pure send+fold serialization, no invented penalty)", () => {
    // freeInit = N*sendMs = N >= r_0 = 13, so folds add exactly 1 each -> 2N.
    for (const n of [16, 32, 64, 128, 256, 512, 1024]) {
      expect(flat(n)).toBe(2 * n);
    }
  });

  it("flat grows linearly: fitted slope predicts a third point exactly", () => {
    const n1 = 64,
      n2 = 256,
      n3 = 1024;
    const y1 = flat(n1),
      y2 = flat(n2);
    const slope = (y2 - y1) / (n2 - n1);
    const intercept = y1 - slope * n1;
    const predicted = slope * n3 + intercept;
    expect(Math.abs(flat(n3) - predicted)).toBeLessThanOrEqual(1e-6);
  });

  it("flat is NOT super-linear: flat(2N) ~ 2*flat(N), not 4x (would betray quadratic rigging)", () => {
    for (const n of [64, 128, 256]) {
      const ratio = flat(2 * n) / flat(n);
      expect(ratio).toBeGreaterThan(1.9);
      expect(ratio).toBeLessThan(2.1);
    }
  });
});

describe("4. Tree grows sub-linearly (logarithmic in N)", () => {
  const tree = (n: number, b = 4) => simulateMakespan(buildBalancedTopology(n, b), 0, P);

  it("full 4-ary tree adds a constant per depth level (+7/level here)", () => {
    // f(4)=17, f(16)=24, f(64)=31, f(256)=38, f(1024)=45
    expect(tree(4)).toBe(17);
    expect(tree(16)).toBe(24);
    expect(tree(64)).toBe(31);
    expect(tree(256)).toBe(38);
    expect(tree(1024)).toBe(45);
  });

  it("tree(1024) < 3 * tree(16) — a linear model would be ~64x", () => {
    expect(tree(1024)).toBeLessThan(3 * tree(16));
  });

  it("tree depth effect: tree(N) grows far slower than flat(N)", () => {
    const flat = (n: number) => simulateMakespan(buildFlatTopology(n), 0, P);
    // 64x more workers: flat scales ~64x, tree well under 2x.
    const flatRatio = flat(1024) / flat(16);
    const treeRatio = tree(1024) / tree(16);
    expect(flatRatio).toBeGreaterThan(50);
    expect(treeRatio).toBeLessThan(2);
  });
});

describe("5. Crossover + growing win is REAL (not universally rigged for the tree)", () => {
  it("there EXISTS a small N where flat <= tree (tree not always better)", () => {
    // Hand case: flat(4)=17, balanced(4,B=2)=20 -> flat strictly cheaper.
    const flat4 = simulateMakespan(buildFlatTopology(4), 0, P);
    const tree4 = simulateMakespan(buildBalancedTopology(4, 2), 0, P);
    expect(flat4).toBeLessThanOrEqual(tree4);

    // And via the public API: at N=4, default branching 4 collapses to a flat
    // shape so the tree does NOT win.
    const report = compareMakespan({ workerCounts: [4], branching: 4 });
    expect(report.rows[0].treeWins).toBe(false);
  });

  it("for large N the tree wins and the speedup STRICTLY increases 256 -> 1024", () => {
    const report = compareMakespan({ workerCounts: [256, 1024], branching: 4 });
    const r256 = report.rows.find((r) => r.workers === 256)!;
    const r1024 = report.rows.find((r) => r.workers === 1024)!;

    expect(r256.treeWins).toBe(true);
    expect(r1024.treeWins).toBe(true);

    // Recompute speedup independently — do NOT trust the field.
    const s256 = r256.flatMakespanMs / r256.treeMakespanMs;
    const s1024 = r1024.flatMakespanMs / r1024.treeMakespanMs;
    expect(r256.makespanSpeedup).toBeCloseTo(s256, 9);
    expect(r1024.makespanSpeedup).toBeCloseTo(s1024, 9);

    expect(s1024).toBeGreaterThan(s256);
    // Concretely: flat 512/tree 38 ~= 13.5 ; flat 2048/tree 45 ~= 45.5
    expect(s256).toBeCloseTo(512 / 38, 9);
    expect(s1024).toBeCloseTo(2048 / 45, 9);
  });

  it("treeWins field is consistent with tree < flat for every row", () => {
    const report = compareMakespan({ workerCounts: [4, 16, 64, 256, 1024] });
    for (const r of report.rows) {
      expect(r.treeWins).toBe(r.treeMakespanMs < r.flatMakespanMs);
    }
  });
});

describe("6. Determinism (no Date.now / Math.random)", () => {
  it("compareMakespan with the same opts returns identical rows twice", () => {
    const opts = { workerCounts: [16, 64, 256, 1024], branching: 4 };
    const a = compareMakespan(opts);
    const b = compareMakespan(opts);
    expect(a.rows).toEqual(b.rows);
    expect(a.markdownTable).toBe(b.markdownTable);
  });

  it("simulateMakespan is a pure function of its inputs", () => {
    const node = buildBalancedTopology(256, 4);
    const first = simulateMakespan(node, 0, P);
    for (let i = 0; i < 5; i++) {
      expect(simulateMakespan(node, 0, P)).toBe(first);
    }
  });
});

describe("7. Table integrity", () => {
  const report = compareMakespan({ workerCounts: [16, 64, 256, 1024], branching: 4 });

  it("has one body row per worker count", () => {
    for (const n of [16, 64, 256, 1024]) {
      // row starts with "| <n> |"
      expect(report.markdownTable).toContain(`| ${n} |`);
    }
    const bodyRows = report.markdownTable
      .split("\n")
      .filter((l) => /^\|\s*\d/.test(l));
    expect(bodyRows).toHaveLength(4);
  });

  it("renders the actual flat/tree makespan numbers (toFixed(1))", () => {
    for (const r of report.rows) {
      expect(report.markdownTable).toContain(r.flatMakespanMs.toFixed(1));
      expect(report.markdownTable).toContain(r.treeMakespanMs.toFixed(1));
    }
  });
});
