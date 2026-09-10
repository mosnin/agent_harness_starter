/**
 * Chaos SCENARIO SUITE for the Hades swarm hierarchy.
 *
 * This module runs the chaos harness ({@link runChaosHierarchy}) across MANY seeds
 * and MANY fault regimes and proves ONE invariant holds on every single run:
 *
 *   **"correct-verified XOR clean-audited, never silent-wrong, never hang."**
 *
 * Concretely, for every (scenario, seed) pair exactly one of two things is true:
 *   1. the run produced a VERIFIED-CORRECT aggregate — `ok:true`, `verified:true`,
 *      and the computed `result` equals the trusted `reference`; OR
 *   2. the run produced a CLEAN AUDITED FAILURE — `ok:false` carrying a human
 *      `reason` and the list of `failedLeaves`, plus a full {@link ChaosAudit}.
 *
 * There is NO third acceptable outcome. In particular a **silent-wrong** result
 * (`ok:true` but `result !== reference`) must NEVER occur — that would be the swarm
 * confidently returning a corrupted aggregate, which is the single worst failure a
 * fault-tolerant reducer can have. The suite counts silent-wrongs explicitly and the
 * per-scenario/overall `invariantHeld`/`allInvariantsHeld` flags go false the instant
 * one appears or any run falls outside the two acceptable buckets.
 *
 * Determinism & speed:
 *   - Seeds are fully deterministic (`seed = scenarioIndex * 1000 + i`); there is no
 *     `Math.random` and no clock read in this module's control flow, so a report is
 *     byte-for-byte reproducible from the same inputs.
 *   - All time is INSTANT. The suite hands {@link runChaosHierarchy} a fake timer
 *     ({@link makeInstantTimer}) whose `setTimeoutFn` never waits real milliseconds —
 *     it defers the callback onto the microtask queue (so no synchronous reentrancy or
 *     deep retry-recursion) and fires it immediately. Injected delays therefore change
 *     only ORDERING, never correctness, and the suite can never hang on a real timer.
 *     `clearTimeoutFn` cancels a pending callback, so any timeout-guard the harness
 *     installs and later clears behaves correctly.
 *
 * Both branches genuinely occur (the suite is not vacuously always-success): the
 * "calm" scenario (~0 chaos, generous retries) is expected to be ALL verified-correct,
 * while the "storm" scenario (drop probability ≈ 1) is expected to be ALL clean
 * failures — so a passing suite is positive evidence that BOTH sides of the XOR fire.
 */

import { runChaosHierarchy } from "../hierarchy/chaos";
import type { ChaosConfig, ChaosOutcome, ChaosTimerOpts } from "../hierarchy/chaos";

/** Per-scenario tally after classifying every run's {@link ChaosOutcome}. */
export interface ChaosScenarioResult {
  label: string;
  config: ChaosConfig;
  runs: number;
  /** `ok:true` && `verified` && `result === reference`. */
  verifiedCorrect: number;
  /** `ok:false` carrying a non-empty `reason` and a `failedLeaves` array. */
  cleanFailures: number;
  /** `ok:true` but `result !== reference` — a corrupted aggregate. MUST be 0. */
  silentWrong: number;
  /** `silentWrong === 0` && every run landed in exactly one acceptable bucket. */
  invariantHeld: boolean;
}

/** Whole-suite roll-up across every scenario. */
export interface ChaosSuiteReport {
  scenarios: ChaosScenarioResult[];
  totalRuns: number;
  /** Sum of every scenario's `silentWrong`. MUST be 0. */
  totalSilentWrong: number;
  /** True iff every scenario's `invariantHeld` is true. */
  allInvariantsHeld: boolean;
}

/**
 * A minimal-signature fake timer whose callbacks fire INSTANTLY (on the microtask
 * queue) instead of after a real delay. Returned as `{ setTimeoutFn, clearTimeoutFn }`
 * for {@link runChaosHierarchy}'s `opts`.
 *
 * Design notes:
 *  - Deferring via `Promise.resolve().then(...)` (rather than calling the callback
 *    synchronously) avoids reentrancy inside the harness's `new Promise` executors and
 *    prevents unbounded synchronous recursion when a retry schedules another timeout.
 *  - Each handle is a plain incrementing number; `clearTimeoutFn(id)` marks it cancelled
 *    so a pending microtask becomes a no-op — this faithfully supports a "install a
 *    timeout guard, clear it on success" pattern without spuriously firing the guard.
 *  - Zero real time elapses, so the suite is fast and can never hang on a wall clock.
 */
export function makeInstantTimer(): Required<ChaosTimerOpts> {
  type Handle = ReturnType<typeof setTimeout>;
  let nextId = 1;
  const cancelled = new Set<number>();
  const setTimeoutFn = (cb: () => void, _ms: number): Handle => {
    const id = nextId++;
    void Promise.resolve().then(() => {
      if (cancelled.has(id)) {
        cancelled.delete(id);
        return;
      }
      cb();
    });
    return id as unknown as Handle;
  };
  const clearTimeoutFn = (t: Handle): void => {
    cancelled.add(t as unknown as number);
  };
  return { setTimeoutFn, clearTimeoutFn };
}

/** A labelled fault regime the suite will sweep over many seeds. */
interface ChaosScenarioSpec {
  label: string;
  config: ChaosConfig;
}

/**
 * The default battery of fault regimes. Each probes a different branch of the harness:
 *  - **calm**    — no faults + generous retries → expected ALL verified-correct.
 *  - **lossy**   — moderate message drop with retry headroom → mostly recovers.
 *  - **slow**    — heavy delay injection (instant under the fake timer) → recovers;
 *                  proves delays change only ordering, not correctness.
 *  - **dead-nodes** — node kills → mix of recovery and clean audited failure.
 *  - **storm**   — drop probability ≈ 1 → expected ALL clean failures.
 *
 * `calm` and `storm` are the two anchors that force BOTH invariant branches to occur.
 */
export const DEFAULT_CHAOS_SCENARIOS: readonly ChaosScenarioSpec[] = [
  { label: "calm", config: { dropProb: 0, delayProb: 0, killProb: 0, maxRetries: 10 } },
  {
    label: "lossy",
    config: { dropProb: 0.35, delayProb: 0.2, maxDelayMs: 50, killProb: 0, maxRetries: 8 },
  },
  {
    label: "slow",
    config: { dropProb: 0, delayProb: 0.9, maxDelayMs: 500, killProb: 0, maxRetries: 8 },
  },
  {
    label: "dead-nodes",
    config: { dropProb: 0.1, delayProb: 0.1, maxDelayMs: 50, killProb: 0.25, maxRetries: 6 },
  },
  { label: "storm", config: { dropProb: 1, delayProb: 0.5, maxDelayMs: 100, killProb: 0, maxRetries: 2 } },
];

/**
 * Classify a single {@link ChaosOutcome} into exactly one of the three buckets and
 * fold it into the running tallies. Returns the updated tallies.
 *
 * Bucketing rules (mirrors the invariant precisely):
 *  - `ok:true`  & `result !== reference`  → **silentWrong** (forbidden).
 *  - `ok:true`  & `result === reference` & `verified` → **verifiedCorrect**.
 *  - `ok:false` & non-empty `reason` & `failedLeaves` array → **cleanFailure**.
 *  - anything else (e.g. `ok:true`, matching, but NOT `verified`; or a malformed
 *    failure) is deliberately counted in NO bucket, which drives `invariantHeld` false.
 */
function classify(
  outcome: ChaosOutcome,
  acc: { verifiedCorrect: number; cleanFailures: number; silentWrong: number }
): void {
  if (outcome.ok) {
    if (outcome.result !== outcome.reference) {
      acc.silentWrong++;
    } else if (outcome.verified) {
      acc.verifiedCorrect++;
    }
    // else: matched reference but harness did not mark it verified — not an
    // acceptable bucket; left uncounted so the invariant check flags it.
  } else {
    const hasReason = typeof outcome.reason === "string" && outcome.reason.length > 0;
    if (hasReason && Array.isArray(outcome.failedLeaves)) {
      acc.cleanFailures++;
    }
    // else: a failure without an audit trail is NOT a clean failure — uncounted.
  }
}

/** Run one scenario over `runs` deterministic seeds and tally the invariant. */
async function runScenario(
  spec: ChaosScenarioSpec,
  scenarioIndex: number,
  runs: number,
  leafValues: number[]
): Promise<ChaosScenarioResult> {
  const acc = { verifiedCorrect: 0, cleanFailures: 0, silentWrong: 0 };
  for (let i = 0; i < runs; i++) {
    const seed = scenarioIndex * 1000 + i;
    const timer = makeInstantTimer();
    const outcome = await runChaosHierarchy(seed, leafValues, spec.config, {
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });
    classify(outcome, acc);
  }
  const invariantHeld =
    acc.silentWrong === 0 && acc.verifiedCorrect + acc.cleanFailures === runs;
  return {
    label: spec.label,
    config: spec.config,
    runs,
    verifiedCorrect: acc.verifiedCorrect,
    cleanFailures: acc.cleanFailures,
    silentWrong: acc.silentWrong,
    invariantHeld,
  };
}

/**
 * Run every {@link DEFAULT_CHAOS_SCENARIOS} regime over `runsPerScenario` deterministic
 * seeds each, using INSTANT fake timers, classify every {@link ChaosOutcome}, and return
 * a {@link ChaosSuiteReport}. The report's `totalSilentWrong` must be 0 and
 * `allInvariantsHeld` must be true for a healthy swarm.
 *
 * @param opts.runsPerScenario  seeds per scenario (default 25).
 * @param opts.leafValues       the leaf workload every run aggregates (default a small
 *                              fixed integer array — the harness computes its own trusted
 *                              reference from it, so the exact values only need to be
 *                              deterministic).
 */
export async function runChaosSuite(opts?: {
  runsPerScenario?: number;
  leafValues?: number[];
}): Promise<ChaosSuiteReport> {
  const runsPerScenario = Math.max(1, opts?.runsPerScenario ?? 25);
  const leafValues = opts?.leafValues ?? [3, 1, 4, 1, 5, 9, 2, 6];

  const scenarios: ChaosScenarioResult[] = [];
  for (let s = 0; s < DEFAULT_CHAOS_SCENARIOS.length; s++) {
    scenarios.push(
      await runScenario(DEFAULT_CHAOS_SCENARIOS[s], s, runsPerScenario, leafValues)
    );
  }

  const totalRuns = scenarios.reduce((n, sc) => n + sc.runs, 0);
  const totalSilentWrong = scenarios.reduce((n, sc) => n + sc.silentWrong, 0);
  const allInvariantsHeld = scenarios.every((sc) => sc.invariantHeld);

  return { scenarios, totalRuns, totalSilentWrong, allInvariantsHeld };
}
