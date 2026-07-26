import { describe, it, expect } from "vitest";
import { runChaosHierarchy } from "../hierarchy/chaos";
import type { ChaosConfig, ChaosOutcome } from "../hierarchy/chaos";

/**
 * ADVERSARIAL contract tests for the chaos hierarchy pass (roadmap iter 15).
 *
 * The GUARANTEE under attack:
 *   Every `runChaosHierarchy(seed, leafValues, config, opts)` resolves to EITHER
 *     { ok:true,  result === arithmetic sum of ALL leafValues, verified:true, result===reference }
 *   OR
 *     { ok:false, reason, failedLeaves:[...non-empty...] }   (a clean, audited failure)
 *   and it must:
 *     - NEVER return ok:true with a wrong sum or a quietly omitted leaf (silent-wrong),
 *     - NEVER hang,
 *     - be DETERMINISTIC from `seed`,
 *     - use INJECTABLE timers for delays (so tests never wait real time).
 *
 * The oracle is recomputed INDEPENDENTLY here (`trueSum`) — we never trust the
 * implementation's own `reference`; we assert result === our own sum. That is the
 * anti-silent-wrong teeth: a run that reports ok:true but folded the wrong total
 * (or dropped a leaf) fails HERE with its seed surfaced.
 */

// ---------------------------------------------------------------------------
// Instant, cancelable fake timers: fire the callback on a microtask (so "delay"
// costs zero real time) but honor clearTimeoutFn so a cancelled timer never
// fires. Returns an opaque token like a real setTimeout.
// ---------------------------------------------------------------------------
function makeInstantTimers() {
  let counter = 0;
  const cleared = new Set<number>();
  const setTimeoutFn = (cb: () => void, _ms?: number) => {
    const id = ++counter;
    // microtask == instant but not synchronously re-entrant
    Promise.resolve().then(() => {
      if (!cleared.has(id)) cb();
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutFn = (t: unknown) => {
    cleared.add(t as number);
  };
  return { setTimeoutFn, clearTimeoutFn };
}

const INSTANT = () => {
  const { setTimeoutFn, clearTimeoutFn } = makeInstantTimers();
  return { setTimeoutFn, clearTimeoutFn };
};

// A no-hang guard using a REAL macrotask timer: if the chaos promise resolves
// promptly (it must, under instant fake timers) the race resolves immediately
// and we clear the guard; only a genuine hang lets the guard fire and FAIL.
function noHang<T>(p: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`HANG: ${label} did not resolve within ${ms}ms`)),
      ms
    );
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const trueSum = (vals: number[]) => vals.reduce((a, b) => a + b, 0);

// Fixed integer workload (exact arithmetic — no float grouping ambiguity).
const LEAVES = [3, -1, 4, 1, -5, 9, 2, -6]; // sum = 7
const LEAVES_SUM = trueSum(LEAVES); // 7

async function run(
  seed: number,
  leafValues: number[],
  config?: ChaosConfig
): Promise<ChaosOutcome> {
  return noHang(
    runChaosHierarchy(seed, leafValues, config, INSTANT()),
    `seed=${seed} config=${JSON.stringify(config)}`
  );
}

/** Assert the FULL ok:true contract against our own independent oracle. */
function assertOkTrueCorrect(
  outcome: ChaosOutcome,
  leafValues: number[],
  seed: number,
  config: ChaosConfig
): string | null {
  if (!outcome.ok) return null;
  const expected = trueSum(leafValues);
  const problems: string[] = [];
  if (outcome.result !== expected) {
    problems.push(`result ${outcome.result} !== trueSum ${expected}`);
  }
  if (outcome.verified !== true) {
    problems.push(`verified === ${outcome.verified} (expected true)`);
  }
  if (outcome.result !== outcome.reference) {
    problems.push(`result ${outcome.result} !== reference ${outcome.reference}`);
  }
  if (Number.isNaN(outcome.result)) problems.push(`result is NaN`);
  // ok:true must not carry a non-empty failedLeaves.
  const fl = (outcome as unknown as { failedLeaves?: number[] }).failedLeaves;
  if (fl !== undefined && fl.length > 0) {
    problems.push(`ok:true but failedLeaves=${JSON.stringify(fl)}`);
  }
  return problems.length
    ? `SILENT-WRONG @ seed=${seed} config=${JSON.stringify(config)}: ${problems.join("; ")}`
    : null;
}

// ===========================================================================
// 1. CORRECTNESS ON ok:true IS ABSOLUTE  (anti-silent-wrong, 100 seeds × configs)
// ===========================================================================
describe("chaos: ok:true correctness is absolute (anti-silent-wrong)", () => {
  const configs: Array<{ name: string; config: ChaosConfig }> = [
    { name: "calm", config: {} },
    { name: "moderate-drop+retries", config: { dropProb: 0.3, maxRetries: 5 } },
    { name: "delays", config: { delayProb: 0.6, maxDelayMs: 40, maxRetries: 3 } },
  ];

  it("every ok:true across 100 seeds × 3 configs sums to the TRUE total, verified, result===reference", async () => {
    const violations: string[] = [];
    let okTrue = 0;
    let okFalse = 0;
    for (const { config } of configs) {
      for (let seed = 0; seed < 100; seed++) {
        const outcome = await run(seed, LEAVES, config);
        if (outcome.ok) {
          okTrue++;
          const v = assertOkTrueCorrect(outcome, LEAVES, seed, config);
          if (v) violations.push(v);
        } else {
          okFalse++;
          // Even a clean failure must never be a silent drop with no evidence.
          expect(outcome.failedLeaves.length).toBeGreaterThan(0);
        }
      }
    }
    // The whole point: NOT ONE ok:true may carry a wrong or omitted sum.
    expect(violations).toEqual([]);
    // Sanity: we actually exercised the success path a meaningful number of times.
    expect(okTrue + okFalse).toBe(300);
    expect(okTrue).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2. NO HANG UNDER TOTAL FAILURE
// ===========================================================================
describe("chaos: no hang under total failure", () => {
  it("dropProb:1, maxRetries:3 resolves to a clean audited ok:false (never hangs/throws)", async () => {
    for (let seed = 0; seed < 10; seed++) {
      const outcome = await run(seed, LEAVES, { dropProb: 1, maxRetries: 3 });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failedLeaves.length).toBeGreaterThan(0);
        expect(typeof outcome.reason).toBe("string");
        expect(outcome.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("killProb:1 resolves to a clean audited ok:false (never hangs/throws)", async () => {
    for (let seed = 0; seed < 10; seed++) {
      const outcome = await run(seed, LEAVES, { killProb: 1, maxRetries: 3 });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failedLeaves.length).toBeGreaterThan(0);
      }
    }
  });
});

// ===========================================================================
// 3. BOTH BRANCHES OCCUR (non-vacuous): calm -> ok:true exists, storm -> ok:false exists
// ===========================================================================
describe("chaos: both outcome branches are reachable (non-vacuous)", () => {
  it("a calm config yields at least one ok:true and a storm yields at least one ok:false", async () => {
    let calmOkTrue = 0;
    let stormOkFalse = 0;
    for (let seed = 0; seed < 40; seed++) {
      const calm = await run(seed, LEAVES, {});
      if (calm.ok) calmOkTrue++;

      const storm = await run(seed, LEAVES, {
        dropProb: 0.95,
        killProb: 0.4,
        delayProb: 0.5,
        maxDelayMs: 20,
        maxRetries: 1,
      });
      if (!storm.ok) stormOkFalse++;
    }
    // Success path must actually work under calm...
    expect(calmOkTrue).toBeGreaterThan(0);
    // ...and the failure path must not be dead code under a storm.
    expect(stormOkFalse).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 4. RETRIES ACTUALLY RECOVER (recovered leaves rejoin the sum, not omitted)
// ===========================================================================
describe("chaos: retries genuinely recover dropped leaves into the correct sum", () => {
  it("dropProb:0.5 with maxRetries:10 produces many correct-sum ok:true runs with audit.retries>0 somewhere", async () => {
    let okTrue = 0;
    let sawRetry = false;
    const violations: string[] = [];
    for (let seed = 0; seed < 80; seed++) {
      const config: ChaosConfig = { dropProb: 0.5, maxRetries: 10 };
      const outcome = await run(seed, LEAVES, config);
      if (outcome.ok) {
        okTrue++;
        const v = assertOkTrueCorrect(outcome, LEAVES, seed, config);
        if (v) violations.push(v);
        if (outcome.audit.retries > 0) sawRetry = true;
      }
      // retries counter must never be negative / NaN regardless of branch
      expect(outcome.audit.retries).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(outcome.audit.retries)).toBe(false);
    }
    expect(violations).toEqual([]);
    // With 50% drop but 10 retries, recovery should be the common case.
    expect(okTrue).toBeGreaterThan(0);
    // Retry must not be a no-op: at least one run actually retried.
    expect(sawRetry).toBe(true);
  });
});

// ===========================================================================
// 5. DETERMINISM
// ===========================================================================
describe("chaos: deterministic from (seed, config)", () => {
  const outcomeSig = (o: ChaosOutcome) =>
    o.ok
      ? { ok: true, result: o.result, verified: o.verified, reference: o.reference }
      : { ok: false, reason: o.reason, failedLeaves: [...o.failedLeaves] };

  it("same (seed, config) yields an identical outcome across two independent calls", async () => {
    const configs: ChaosConfig[] = [
      {},
      { dropProb: 0.5, maxRetries: 4 },
      { dropProb: 0.8, killProb: 0.3, delayProb: 0.5, maxDelayMs: 15, maxRetries: 3 },
      { dropProb: 1, maxRetries: 2 },
    ];
    for (const config of configs) {
      for (let seed = 0; seed < 20; seed++) {
        const a = await run(seed, LEAVES, config);
        const b = await run(seed, LEAVES, config);
        expect(outcomeSig(b)).toEqual(outcomeSig(a));
      }
    }
  });

  it("different seeds do NOT all collapse to one identical outcome", async () => {
    const sigs = new Set<string>();
    const config: ChaosConfig = {
      dropProb: 0.6,
      killProb: 0.2,
      delayProb: 0.3,
      maxDelayMs: 10,
      maxRetries: 2,
    };
    for (let seed = 0; seed < 40; seed++) {
      const o = await run(seed, LEAVES, config);
      sigs.add(JSON.stringify(outcomeSig(o)));
    }
    // If every seed produced byte-identical outcomes, `seed` isn't wired in.
    expect(sigs.size).toBeGreaterThan(1);
  });
});

// ===========================================================================
// 6. AUDIT INTEGRITY
// ===========================================================================
describe("chaos: audit integrity", () => {
  it("failedLeaves are real leaf indices on ok:false; ok:true has none; leafAttempts>=leaves; killedNodes sorted; no NaN", async () => {
    const configs: ChaosConfig[] = [
      {},
      { dropProb: 0.5, maxRetries: 5 },
      { dropProb: 0.9, killProb: 0.4, delayProb: 0.4, maxDelayMs: 20, maxRetries: 1 },
      { dropProb: 1, maxRetries: 2 },
      { killProb: 1, maxRetries: 2 },
    ];
    for (const config of configs) {
      for (let seed = 0; seed < 30; seed++) {
        const o = await run(seed, LEAVES, config);
        const a = o.audit;

        // audit shape sanity
        expect(a.seed).toBe(seed);
        expect(a.leaves).toBe(LEAVES.length);
        expect(a.leafAttempts).toBeGreaterThanOrEqual(a.leaves);
        expect(Number.isNaN(a.leafAttempts)).toBe(false);
        expect(a.drops).toBeGreaterThanOrEqual(0);
        expect(a.retries).toBeGreaterThanOrEqual(0);
        expect(a.delaysInjected).toBeGreaterThanOrEqual(0);

        // killedNodes must be sorted (and unique-ish: sorted copy equals itself).
        expect(a.killedNodes).toEqual([...a.killedNodes].sort());

        if (o.ok) {
          expect(Number.isNaN(o.result)).toBe(false);
          const fl = (o as unknown as { failedLeaves?: number[] }).failedLeaves;
          expect(fl === undefined || fl.length === 0).toBe(true);
        } else {
          expect(o.failedLeaves.length).toBeGreaterThan(0);
          // every failed leaf is a real, in-range, integer index
          for (const idx of o.failedLeaves) {
            expect(Number.isInteger(idx)).toBe(true);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(LEAVES.length);
          }
          // no duplicate indices
          expect(new Set(o.failedLeaves).size).toBe(o.failedLeaves.length);
        }
      }
    }
  });
});

// ===========================================================================
// 7. LEAF COUNT EDGE CASES
// ===========================================================================
describe("chaos: leaf-count edge cases obey the guarantee", () => {
  it("single-leaf workload under no chaos is ok:true with result === that value", async () => {
    for (let seed = 0; seed < 20; seed++) {
      const leaves = [42];
      const o = await run(seed, leaves, {});
      expect(o.ok).toBe(true);
      if (o.ok) {
        expect(o.result).toBe(42);
        expect(o.verified).toBe(true);
        expect(o.result).toBe(o.reference);
      }
    }
  });

  it("non-power-of-branching leaf counts under no chaos sum exactly", async () => {
    const workloads = [
      [5], // 1
      [1, 2, 3], // 3 (odd)
      [2, -3, 7, 0, 5], // 5
      [4, 4, 4, 4, 4, 4, 4], // 7
      [9, -2, 6, 1, -8, 3, 3, 2, -1, 5, 5], // 11
    ];
    for (const leaves of workloads) {
      const expected = trueSum(leaves);
      for (let seed = 0; seed < 10; seed++) {
        const o = await run(seed, leaves, { dropProb: 0, delayProb: 0, killProb: 0 });
        expect(o.ok).toBe(true);
        if (o.ok) {
          expect(o.result).toBe(expected);
          expect(o.verified).toBe(true);
          expect(o.result).toBe(o.reference);
          expect(Number.isNaN(o.result)).toBe(false);
        }
      }
    }
  });

  it("a non-power-of-branching leaf count still recovers to the exact sum under moderate drop + retries", async () => {
    const leaves = [4, 4, 4, 4, 4, 4, 4]; // 7 leaves, sum 28
    const expected = 28;
    const violations: string[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const config: ChaosConfig = { dropProb: 0.4, maxRetries: 8 };
      const o = await run(seed, leaves, config);
      if (o.ok) {
        if (o.result !== expected || o.verified !== true || o.result !== o.reference) {
          violations.push(
            `seed=${seed}: result=${o.result} verified=${o.verified} reference=${o.reference}`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
