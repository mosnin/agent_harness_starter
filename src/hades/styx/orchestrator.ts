/**
 * Styx primitive #7 — the StyxOrchestrator (end-to-end pipeline assembly).
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * This module contains NO new trust machinery. It is the *assembler*: it wires
 * the six already-committed Styx primitives into one governed control loop and,
 * crucially, PRESERVES the S1 guarantee across the composition. Given a task it
 *
 *   1. SPECULATES divergent decomposition strategies (an injectable planner),
 *   2. RACES them under the budget-optimal bandit — each strategy is executed
 *      once by an injectable worker and scored by an injectable weak-verifier
 *      panel fused into a calibrated ensemble fitness,
 *   3. ROUTES the winner to its strongest applicable verifier tier,
 *   4. Applies the conformal abstention gate, the tier confidence floor, and
 *      (optionally) the S3 isomorphic-perturbation robustness check,
 *   5. EITHER emits a signed verification certificate OR abstains — never
 *      silently delivers an unverified answer.
 *
 * The load-bearing property is compositional: because every emitted answer must
 * clear the *conformal* gate (P(wrong|emit) ≤ ε on the calibration distribution)
 * AND the tier floor AND — when supplied — a robustness check, the EMITTED set's
 * true-wrong rate stays ≤ ε end to end. The orchestrator only ever *tightens*
 * the gate's bound with additional abstention conditions; it never loosens it.
 *
 * ===========================================================================
 * EVERYTHING IS INJECTABLE — TESTS USE SIMULATED COMPONENTS OF KNOWN QUALITY
 * ===========================================================================
 * `Speculator`, `Worker`, `VerifierPanel`, the `CertificateAuthority`, the
 * calibration set and `issuedAt` are all provided by the caller. There is NO
 * LLM, NO network, NO clock (`issuedAt` is caller-supplied), and NO
 * `Math.random` anywhere. Given deterministic injected components a `run` is a
 * pure function of `(task, cfg)` and is byte-for-byte reproducible. `run` never
 * throws: any internal failure is caught and converted into an abstention whose
 * `reason` starts with `"error:"`.
 *
 * ===========================================================================
 * HOW THE ENSEMBLE IS FIT — WITHIN THIS RUN, EACH BRANCH IS AN ITEM
 * ===========================================================================
 * We have no ground-truth labels at inference time, so the {@link
 * WeakVerifierEnsemble} estimates each panel verifier's reliability from
 * INTER-VERIFIER AGREEMENT (Dawid–Skene / Weaver style). The estimation set is
 * built WITHIN THIS RUN: we run the worker+panel once on every proposed root
 * strategy and treat each strategy's panel votes as one calibration item, then
 * `fitPredict` across those items to learn per-verifier reliabilities. The
 * bandit oracle then scores each branch it actually advances — roots AND any
 * children the controller speculatively expands — with `scoreItem` under those
 * learned reliabilities. This keeps reliabilities estimated from the same run
 * they are used on (no cross-run leakage) at the documented cost that, with very
 * few strategies, the reliability estimates are correspondingly coarse.
 *
 * @module hades/styx/orchestrator
 */

import { BranchTree } from "./branches";
import type { BranchNode } from "./branches";
import { BanditController } from "./controller";
import type { WorkerOracle } from "./controller";
import { routeTier, tierConfidenceFloor, WeakVerifierEnsemble } from "./tiers";
import type { TaskSignals, TierId, VerifierVote } from "./tiers";
import { ConformalGate } from "./gate";
import type { CalibrationPoint } from "./gate";
import { checkRobustness } from "./perturb";
import type { Perturbation } from "./perturb";
import { CertificateAuthority, sha256Hex } from "./certificate";
import type { VerificationCertificate } from "./certificate";

// ---------------------------------------------------------------------------
// Public shape (LOCKED — an adversary codes against this in parallel)
// ---------------------------------------------------------------------------

export interface StyxTask {
  id: string;
  input: string;
  signals: TaskSignals;
}

/** Propose K DIVERGENT decomposition strategy labels for a task (injectable; real = an LLM planner). */
export interface Speculator {
  propose(task: StyxTask): string[];
}

/** Execute one strategy on a task → an answer + its dollar cost (injectable; real = a worker LLM + tools). */
export interface Worker {
  run(task: StyxTask, strategy: string): { output: string; cost: number };
}

/** A panel of weak verifiers votes pass/fail on a candidate answer (injectable; real = tool checks + judge LLMs). */
export interface VerifierPanel {
  vote(task: StyxTask, output: string): VerifierVote[];
}

export interface StyxConfig {
  /** target silent-wrong bound P(wrong | emitted) */
  epsilon: number;
  /** $ budget per task for the bandit */
  budget: number;
  /** signs emitted certificates */
  ca: CertificateAuthority;
  /** (verifierScore, wasCorrect) history to fit the gate */
  calibration: CalibrationPoint[];
  /** cert timestamp (caller-provided; no Date.now here) */
  issuedAt: number;
  /** optional S3 robustness check on the winner */
  perturbations?: Array<Perturbation<StyxTask>>;
  explore?: number;
  pruneBelow?: number;
  pruneAfter?: number;
}

export interface StyxOutcome {
  taskId: string;
  emitted: boolean;
  /** present iff emitted */
  output?: string;
  /** calibrated P(correct) of the winning answer */
  pCorrect: number;
  tier: string;
  /** gate threshold used */
  threshold: number;
  /** tier floor used */
  confidenceFloor: number;
  /** $ the bandit spent (<= budget) */
  spent: number;
  branchesExplored: number;
  /** present iff emitted */
  certificate?: VerificationCertificate;
  provenance: string[];
  /** "emitted" | "below-gate" | "below-tier-floor" | "failed-robustness" | "error:..." */
  reason: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class StyxOrchestrator {
  private readonly spec: Speculator;
  private readonly worker: Worker;
  private readonly panel: VerifierPanel;
  private readonly cfg: StyxConfig;

  constructor(spec: Speculator, worker: Worker, panel: VerifierPanel, cfg: StyxConfig) {
    this.spec = spec;
    this.worker = worker;
    this.panel = panel;
    this.cfg = cfg;
  }

  async run(task: StyxTask): Promise<StyxOutcome> {
    // Tier routing and the tier confidence floor are pure and cannot throw, so
    // compute them up-front — an error abstention can still report them.
    const tier: TierId = routeTier(task.signals);
    const confidenceFloor = tierConfidenceFloor(tier, this.cfg.epsilon);

    try {
      // --- 1. SPECULATE: propose divergent strategies, seed the branch tree. ---
      const strategies = this.spec.propose(task);
      const tree = new BranchTree(strategies);

      // --- 2a. Fit the weak-verifier ensemble WITHIN this run: each proposed
      // strategy's panel votes is one item; reliabilities are estimated from
      // inter-verifier agreement across those items (see module doc). ---
      const ensemble = new WeakVerifierEnsemble();
      const rootVotes: VerifierVote[][] = strategies.map((strategy) => {
        const { output } = this.worker.run(task, strategy);
        return this.panel.vote(task, output);
      });
      ensemble.fitPredict(rootVotes);

      // --- 2b. Build the pure work+verify oracle. Each branch is executed once
      // (`done: true`): the bandit races strategies, not multi-step refinement.
      // The oracle stays a pure function of branch state (worker + panel are
      // deterministic; scoreItem uses fixed reliabilities), so the controller
      // may safely peek a step's cost before committing budget to it. ---
      const oracle: WorkerOracle = {
        step: (branch: BranchNode) => {
          const { output, cost } = this.worker.run(task, branch.strategy);
          const votes = this.panel.vote(task, output);
          const fitness = ensemble.scoreItem(votes);
          const provenance =
            `strategy=${branch.strategy};` +
            `votes=${votes.map((v) => `${v.verifierId}:${v.passed ? 1 : 0}`).join(",")}`;
          return { output, fitness, cost, done: true, provenance };
        },
      };

      // --- 3. RACE under the budget-optimal bandit; take the best branch. ---
      const controller = new BanditController(tree, oracle, {
        budget: this.cfg.budget,
        explore: this.cfg.explore,
        pruneBelow: this.cfg.pruneBelow,
        pruneAfter: this.cfg.pruneAfter,
      });
      const report = controller.run();
      const best = report.best;
      const bestFitness = best?.fitness ?? 0;
      const output = best?.output ?? "";
      const provenance = best?.provenance ? [...best.provenance] : [];

      // --- 5. Conformal abstention gate fitted on the caller's calibration. ---
      const gate = new ConformalGate({ epsilon: this.cfg.epsilon });
      gate.calibrate(this.cfg.calibration);
      const decision = gate.decide(bestFitness);
      // We report the gate's calibrated P(correct) at emission (the correct-rate
      // among calibration points above τ) rather than the raw ensemble score —
      // it is the number the ε-guarantee is actually about.
      const pCorrect = decision.pCorrectEstimate;

      // --- 6. Compose the abstention conditions. The gate bounds P(wrong|emit)
      // ≤ ε; the tier floor and (optional) robustness check can only ADD
      // abstention, never remove it — so the emitted set's wrong-rate stays ≤ ε.
      // Precedence of the recorded reason: gate → tier floor → robustness. ---
      let reason: string;
      let emitted = false;
      if (!best || !decision.emit) {
        reason = "below-gate";
      } else if (bestFitness < confidenceFloor) {
        reason = "below-tier-floor";
      } else if (this.cfg.perturbations && this.cfg.perturbations.length > 0) {
        // Re-run the WINNING strategy on each semantics-preserving rewrite of
        // the task; a genuinely correct winner is invariant, a gamed/brittle one
        // diverges. Solver output is normalized inside checkRobustness.
        const winningStrategy = best.strategy;
        const robustness = checkRobustness(
          (t: StyxTask) => this.worker.run(t, winningStrategy).output,
          task,
          this.cfg.perturbations,
        );
        if (!robustness.consistent) {
          reason = "failed-robustness";
        } else {
          emitted = true;
          reason = "emitted";
        }
      } else {
        emitted = true;
        reason = "emitted";
      }

      // --- 7. If emitting, mint a certificate binding the output to its
      // verification evidence. Otherwise abstain (no output, no cert). ---
      const base: StyxOutcome = {
        taskId: task.id,
        emitted,
        pCorrect,
        tier,
        threshold: decision.threshold,
        confidenceFloor,
        spent: report.spent,
        branchesExplored: report.branchesExplored,
        provenance,
        reason,
      };

      if (!emitted || !best) {
        return base;
      }

      const verifierVersions = uniqueInOrder(
        this.panel.vote(task, output).map((v) => v.verifierId),
      );
      const certificate = await this.cfg.ca.issue({
        outputSha256: sha256Hex(output),
        taskId: task.id,
        verifierTier: tier,
        ensembleScore: bestFitness,
        pCorrect,
        epsilon: this.cfg.epsilon,
        traceSha256: sha256Hex(JSON.stringify(provenance)),
        verifierVersions,
        issuedAt: this.cfg.issuedAt,
      });

      return { ...base, output, certificate };
    } catch (err) {
      // Never throw from run(): degrade to an abstention that records the fault.
      const message = err instanceof Error ? err.message : String(err);
      return {
        taskId: task?.id ?? "",
        emitted: false,
        pCorrect: 0,
        tier,
        threshold: 0,
        confidenceFloor,
        spent: 0,
        branchesExplored: 0,
        provenance: [],
        reason: `error:${message}`,
      };
    }
  }
}

/** Stable de-duplication preserving first-seen order (verifier id list). */
function uniqueInOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
