/**
 * Seeded **CHAOS** harness for the swarm hierarchy — the destructive sibling of
 * the property fuzzer. Where `fuzz.ts` asks "does the tree fold equal the flat
 * fold on a clean run?", this module asks the far harder question: **can the
 * swarm still be trusted when the network is on fire?** It runs a hierarchy SUM
 * under a storm of injected faults — dropped results, delayed results, results
 * that resolve wildly out of order, and whole nodes that die for the entire run —
 * and pins down a single, non-negotiable guarantee.
 *
 * ## The guarantee: correct-verified-aggregate XOR clean-audited-failure
 *
 * Every call to {@link runChaosHierarchy} settles into exactly one of two states,
 * never a third:
 *
 *  - **`{ ok: true }`** — every leaf was ultimately delivered (possibly after
 *    retries). `result` is the arithmetic sum of *all* `leafValues`, `reference`
 *    is the independent oracle {@link reduceRef}`("sum", leafValues)`, and
 *    `verified === (result === reference)`. On a correct implementation `verified`
 *    is *always* `true` on an `ok:true` outcome; the field exists so that a latent
 *    bug surfaces as `verified:false` instead of a silently-wrong number escaping
 *    into the world.
 *  - **`{ ok: false }`** — at least one leaf exhausted its retry budget (a
 *    persistent drop, or a dead node). The run reports `failedLeaves` (the leaf
 *    indices that could not be delivered) and a human `reason`. It does **NOT**
 *    quietly omit those leaves and hand back a smaller sum.
 *
 * The two things this harness forbids, by construction:
 *  - **NEVER a silent wrong answer.** A leaf that cannot be delivered fails the
 *    whole run (`ok:false`); it is never dropped from the sum. `result` on
 *    `ok:true` therefore always accounts for 100% of the input.
 *  - **NEVER a hang.** Every fault path is bounded: retries are capped at
 *    `maxRetries`, delays are scheduled through *injectable* timers (so tests
 *    drive a virtual clock and never wait on wall-time), and the pathological
 *    configs — `killProb:1`, `dropProb:1` — settle *promptly* to `ok:false`.
 *
 * ## How each fault is injected — deterministically, from `seed` alone
 *
 * Determinism is the whole point: a failing chaos run must be reproducible from
 * its seed. The trap is async interleaving — under `Promise.all` fan-out with
 * injected delays, leaves resolve in an order the scheduler chooses, so a single
 * shared RNG would produce seed-dependent-*and*-timing-dependent results. This
 * harness sidesteps that entirely: **each leaf owns an isolated RNG stream** keyed
 * by `(seed, leafIndex)`, and the kill decision draws from a second, independent
 * per-leaf stream. No chaos decision depends on the order in which promises
 * happen to settle, so the outcome and every audit counter are pure functions of
 * `seed` and `config`.
 *
 *  - **Drop** — per leaf *attempt*, the leaf's chaos stream draws `< dropProb`;
 *    the result is "lost" and the attempt counts as a failure to be retried.
 *  - **Delay** — per attempt, the stream draws `< delayProb`; a virtual delay of
 *    up to `maxDelayMs` is scheduled via the injectable `setTimeoutFn`, then the
 *    attempt proceeds. Delays never change the answer, only the arrival order.
 *  - **Reorder** — not injected directly; it *emerges* from delays and retries
 *    making leaves resolve out of order. Because SUM is commutative the aggregate
 *    is invariant to arrival order — demonstrating the reorder-safety of the fold.
 *  - **Kill** — decided **once per node id at run start** from the independent
 *    per-leaf kill stream (`< killProb`). A dead node's leaf fails on *every*
 *    attempt, so unless retries can rescue it (they cannot — the node stays dead)
 *    the run ends in a clean `ok:false` with that leaf in `failedLeaves`.
 *
 * A dropped/failed leaf is retried up to `maxRetries` times. A leaf rescued on a
 * retry contributes its true value to the sum; a leaf that exhausts its budget
 * sinks the run to `ok:false`. That asymmetry is what makes the guarantee hold.
 */

import { buildBalancedHierarchy, walk } from "./tree";
import type { HierarchyNode } from "./tree";
import { HierarchyOrchestrator } from "./orchestrator";
import type { HierarchyExec } from "./orchestrator";
import { reduceRef, mulberry32 } from "./fuzz";

/** Knobs controlling how much chaos is injected. All probabilities are in `[0,1]`. */
export interface ChaosConfig {
  /** Per-leaf-attempt probability the result is "lost" (a drop). Default 0. */
  dropProb?: number;
  /** Per-leaf-attempt probability of an injected delay. Default 0. */
  delayProb?: number;
  /** Max injected delay in ms (virtual, via injectable timers). Default 0. */
  maxDelayMs?: number;
  /** Probability a given node id is "dead" for the whole run (its leaf always fails). Default 0. */
  killProb?: number;
  /** Per-leaf retry budget for drops/failures (retries beyond the first attempt). Default 3. */
  maxRetries?: number;
}

/** Post-mortem accounting for a chaos run — every counter is deterministic from the seed. */
export interface ChaosAudit {
  seed: number;
  /** Number of real leaves (surplus tree slots are not counted). */
  leaves: number;
  /** Total execute attempts across all real leaves, including retries. */
  leafAttempts: number;
  /** Attempts lost to a drop. */
  drops: number;
  /** Retry attempts beyond the first, summed over all real leaves. */
  retries: number;
  /** Node ids marked dead this run (sorted). */
  killedNodes: string[];
  /** Number of delays injected across all attempts. */
  delaysInjected: number;
}

/** The two — and only two — shapes a chaos run can settle into. */
export type ChaosOutcome =
  | { ok: true; result: number; reference: number; verified: boolean; audit: ChaosAudit }
  | { ok: false; reason: string; failedLeaves: number[]; audit: ChaosAudit };

/** Injectable timers so tests drive a virtual clock instead of waiting on wall-time. */
export interface ChaosTimerOpts {
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
}

/** Smallest balanced binary tree (branching 2) whose leaf count can hold `n` values. */
function sizeTree(n: number): { branching: number; coordinatorLevels: number } {
  let levels = 0;
  while (2 ** (levels + 1) < Math.max(1, n)) levels++;
  return { branching: 2, coordinatorLevels: levels };
}

/**
 * Derive an isolated `mulberry32` stream for `(seed, leafIndex, salt)`. The salt
 * separates the two per-leaf concerns (chaos vs. kill) into independent streams,
 * and mixing `leafIndex` in means each leaf's decisions are independent of the
 * order in which its promise happens to resolve — the key to determinism under
 * async fan-out.
 */
function streamFor(seed: number, leafIndex: number, salt: number): () => number {
  const mixed = ((seed ^ Math.imul(leafIndex + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0) >>> 0;
  return mulberry32(mixed);
}

/**
 * Run a hierarchy SUM over `leafValues` under seeded chaos with bounded retries.
 *
 * Returns **exactly one** of:
 *  - `{ ok:true, result, reference, verified, audit }` when every leaf is
 *    ultimately delivered within `maxRetries`. `result` is the sum of *all*
 *    `leafValues`, `reference` is {@link reduceRef}`("sum", leafValues)`, and
 *    `verified === (result === reference)`.
 *  - `{ ok:false, reason, failedLeaves, audit }` when any leaf exhausts its retry
 *    budget (persistent drop / dead node) — a **clean audited failure**, never a
 *    wrong sum.
 *
 * Deterministic from `seed` alone (each leaf owns an isolated RNG stream, so the
 * result is independent of async scheduling). Delays are scheduled via the
 * injectable `setTimeoutFn`, and every fault path is bounded, so the function
 * **always settles** — no seed or config can make it hang.
 */
export function runChaosHierarchy(
  seed: number,
  leafValues: number[],
  config: ChaosConfig = {},
  opts: ChaosTimerOpts = {}
): Promise<ChaosOutcome> {
  const dropProb = clampProb(config.dropProb);
  const delayProb = clampProb(config.delayProb);
  const killProb = clampProb(config.killProb);
  const maxDelayMs = Math.max(0, config.maxDelayMs ?? 0);
  const maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 3));

  const setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));

  const n = leafValues.length;
  const reference = reduceRef("sum", leafValues) as number;

  const audit: ChaosAudit = {
    seed,
    leaves: n,
    leafAttempts: 0,
    drops: 0,
    retries: 0,
    killedNodes: [],
    delaysInjected: 0,
  };

  // Empty workload: nothing to fault, sum is the identity 0.
  if (n === 0) {
    return Promise.resolve({ ok: true, result: 0, reference, verified: 0 === reference, audit });
  }

  const { branching, coordinatorLevels } = sizeTree(n);
  const root = buildBalancedHierarchy(branching, coordinatorLevels);

  // Enumerate workers in left-to-right (pre-order) leaf order; this exactly
  // matches the contiguous slices `decompose` hands down, so worker i owns leaf i.
  const workers: HierarchyNode[] = [];
  walk(root, (node) => {
    if (node.info.kind === "worker" || node.children.length === 0) workers.push(node);
  });

  // Kill decisions: once per node id, at run start, from an independent stream.
  // Only real leaves (index < n) can be killed — surplus slots trivially yield 0.
  const dead = new Set<string>();
  for (let i = 0; i < n && i < workers.length; i++) {
    if (streamFor(seed, i, /*salt*/ 7)() < killProb) dead.add(workers[i].info.id);
  }
  audit.killedNodes = [...dead].sort();

  const failedLeaves = new Set<number>();

  // A virtual delay guarded so it always settles: a non-positive delay resolves
  // synchronously; otherwise it is scheduled through the injectable timer.
  const delay = (ms: number): Promise<void> =>
    ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeoutFn(() => resolve(), ms));

  const exec: HierarchyExec<number[], number> = {
    // Split the ordered leaf-index array into contiguous, equal chunks per child.
    decompose: (task, node) => {
      const childCount = node.childIds.length;
      const size = task.length / childCount; // exact: power-of-two balanced tree
      const chunks: number[][] = [];
      for (let i = 0; i < childCount; i++) chunks.push(task.slice(i * size, (i + 1) * size));
      return chunks;
    },
    // Run one leaf under chaos, with a bounded retry loop.
    execute: async (task, node) => {
      const leafIndex = task[0];
      // Surplus slot: contributes 0, exempt from chaos.
      if (leafIndex >= n) return 0;

      const value = leafValues[leafIndex];
      const isDead = dead.has(node.id);
      const rng = streamFor(seed, leafIndex, /*salt*/ 1);

      // attempt 0 is the first try; attempts 1..maxRetries are the retry budget.
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        audit.leafAttempts++;
        if (attempt > 0) audit.retries++;

        // Delay decision (proceed after the virtual delay; never changes the value).
        if (rng() < delayProb) {
          audit.delaysInjected++;
          const ms = maxDelayMs > 0 ? Math.floor(rng() * (maxDelayMs + 1)) : 0;
          await delay(ms);
        }

        // Drop decision.
        const dropped = rng() < dropProb;
        if (!isDead && dropped) audit.drops++;

        if (isDead || dropped) continue; // failed attempt → retry (if budget remains)
        return value; // delivered
      }

      // Retry budget exhausted: record the leaf and fail the run (never omit it).
      failedLeaves.add(leafIndex);
      return 0;
    },
    aggregate: (childResults) => childResults.reduce((a, b) => a + b, 0),
  };

  const rootTask = Array.from({ length: 2 ** (coordinatorLevels + 1) }, (_, i) => i);
  const orch = new HierarchyOrchestrator(root, exec);

  return orch.run(rootTask).then(({ result }): ChaosOutcome => {
    if (failedLeaves.size > 0) {
      const failed = [...failedLeaves].sort((a, b) => a - b);
      return {
        ok: false,
        reason:
          `${failed.length} of ${n} leaf/leaves exhausted the retry budget ` +
          `(maxRetries=${maxRetries}) under persistent drops or dead nodes`,
        failedLeaves: failed,
        audit,
      };
    }
    return { ok: true, result, reference, verified: result === reference, audit };
  });
}

/** Clamp a probability into `[0,1]`, treating `undefined`/`NaN` as 0. */
function clampProb(p: number | undefined): number {
  if (p === undefined || Number.isNaN(p)) return 0;
  return Math.min(1, Math.max(0, p));
}
