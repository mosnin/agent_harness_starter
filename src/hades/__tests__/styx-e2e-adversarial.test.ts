/**
 * ADVERSARIAL WHOLE-SYSTEM verification of the FULLY ASSEMBLED Styx pipeline
 * (`src/hades/styx/orchestrator.ts` — `StyxOrchestrator`).
 *
 * The S1 adversary already proved each trust primitive in isolation. THIS suite
 * attacks the COMPOSITION: does wiring speculator → bandit-race → ensemble
 * fitness → tier router → conformal gate → tier floor → certificate PRESERVE the
 * S1 silent-wrong guarantee END TO END?
 *
 * The headline claim under attack (docs/STYX_ARCHITECTURE.md, falsifiable #2):
 *   over many tasks, the EMITTED set's TRUE-wrong rate (per ground truth) ≤ ε,
 *   every emitted answer carries a valid output-bound certificate, and the
 *   per-task budget is never exceeded.
 *
 * METHODOLOGY (external validity, not theater):
 *  - A LARGE synthetic task population (≥300) with KNOWN ground truth: each
 *    task's answer is "OK:<id>" (correct) or "BAD:..." (wrong), so the true
 *    correctness of ANY emitted output is read directly from its text.
 *  - A Worker whose per-strategy correctness is tied to a hidden difficulty, and
 *    a VerifierPanel whose votes correlate with actual correctness (informative
 *    but imperfect — false positives AND false negatives).
 *  - The calibration set is drawn from the SAME process, and — crucially — its
 *    `score` is the SAME quantity the gate thresholds at deployment: the winning
 *    branch's ensemble fitness. We compute it with the SAME public primitives
 *    the orchestrator uses internally (BranchTree + WeakVerifierEnsemble +
 *    BanditController with identical params), and CROSS-CHECK that the replica's
 *    score equals the orchestrator's `certificate.ensembleScore` on every
 *    emitted test task — so the calibration is provably exchangeable with
 *    deployment, not hand-tuned.
 *  - Where a guarantee holds the attack fails (test passes); where it would
 *    break, the assertion encodes the CORRECT behaviour and is left to FAIL so a
 *    real regression is REPORTED, not hidden. No assertion is weakened to go
 *    green.
 *
 * Fully deterministic: all pseudo-randomness is a hash of an integer index
 * (splitmix/murmur finalizer). NO Math.random, NO Date.now/clock, NO network.
 * Certificate crypto is real ed25519 (async); everything else is synchronous.
 */
import { describe, it, expect } from "vitest";
import {
  StyxOrchestrator,
  type Speculator,
  type Worker,
  type VerifierPanel,
  type StyxTask,
  type StyxOutcome,
  type StyxConfig,
} from "../styx/orchestrator";
import { BranchTree } from "../styx/branches";
import type { BranchNode } from "../styx/branches";
import { BanditController } from "../styx/controller";
import type { WorkerOracle } from "../styx/controller";
import { WeakVerifierEnsemble, tierConfidenceFloor } from "../styx/tiers";
import type { VerifierVote } from "../styx/tiers";
import {
  CertificateAuthority,
  verifyCertificate,
  certifiesOutput,
  generatePrivateKeyHex,
} from "../styx/certificate";
import type { CalibrationPoint } from "../styx/gate";

// ===========================================================================
// Deterministic pseudo-randomness — hash of an integer, NO Math.random.
// ===========================================================================

function mix32(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
/** Deterministic uniform [0,1) keyed by an index and a salt. */
function rnd(i: number, salt: number): number {
  return mix32(((i * 2654435761) ^ (salt * 40503)) | 0) / 4294967296;
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
/** FNV-1a string hash → uint32; feeds deterministic vote/answer draws. */
function strHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ===========================================================================
// Deterministic ed25519 CA (injectable RNG — no ambient randomness).
// ===========================================================================
function detBytes(n: number, seed: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = mix32((seed * 7919 + i) | 0) & 0xff;
  return a;
}
const CA = new CertificateAuthority(generatePrivateKeyHex((n) => detBytes(n, 42)));
const ISSUED_AT = 1_700_000_000_000;

// ===========================================================================
// The simulated task population with KNOWN ground truth.
// ===========================================================================

const PANEL_V = 5; // weak verifiers on the panel
const HEADLINE_BUDGET = 12; // $ per task — enough to race all strategies + expand

function idxOf(task: StyxTask): number {
  return parseInt(task.id.slice(1), 10);
}
function makeTask(idx: number, signals: StyxTask["signals"]): StyxTask {
  return { id: `T${idx}`, input: `task-${idx}`, signals };
}

/** Speculator: 3 divergent decomposition strategies. */
const spec: Speculator = { propose: () => ["s0", "s1", "s2"] };

/**
 * Worker: for a task of hidden difficulty d, the answer produced by a strategy
 * is CORRECT with probability declining in d (and jittered per strategy so the
 * race is meaningful). Correctness is encoded in the output text so ground truth
 * of any emitted answer is recoverable directly.
 */
const worker: Worker = {
  run: (task, strategy) => {
    const i = idxOf(task);
    const d = rnd(i, 11); // hidden difficulty in [0,1)
    const pc = clamp01(0.92 - 0.8 * d); // harder task ⇒ lower per-answer accuracy
    const sh = strHash(strategy);
    const correct = rnd((Math.imul(i, 97) ^ sh) >>> 0, 21) < pc;
    return {
      output: correct ? `OK:${task.id}` : `BAD:${task.id}:${strategy}`,
      cost: 1,
    };
  },
};

/**
 * VerifierPanel: informative-but-imperfect. Each verifier passes a CORRECT
 * answer with prob ~acc (true-positive) and a WRONG answer with prob ~(1-acc)
 * (false-positive). Deterministic in the answer text + verifier index.
 */
const panel: VerifierPanel = {
  vote: (_task, output) => {
    const correct = output.startsWith("OK:");
    const oh = strHash(output);
    const votes: VerifierVote[] = [];
    for (let v = 0; v < PANEL_V; v++) {
      const acc = 0.68 + 0.03 * v; // 0.68..0.80 — imperfect verifiers
      const seed = (Math.imul(oh, 131) ^ Math.imul(v, 7919)) >>> 0;
      const r = rnd(seed, 31);
      const passed = correct ? r < acc : r < 1 - acc;
      votes.push({ verifierId: `pv${v}`, passed });
    }
    return votes;
  },
};

/**
 * REPLICA of the orchestrator's internal "winning branch fitness" computation,
 * built from the SAME public primitives with the SAME parameters (explore /
 * pruneBelow / pruneAfter left at controller defaults, exactly as the
 * orchestrator does when cfg omits them). This produces an exchangeable
 * calibration set whose `score` is the exact quantity the gate thresholds. Its
 * fidelity is asserted below against certificate.ensembleScore.
 */
function replicaScore(task: StyxTask, budget: number): { score: number; correct: boolean } {
  const strategies = spec.propose(task);
  const tree = new BranchTree(strategies);
  const ensemble = new WeakVerifierEnsemble();
  const rootVotes = strategies.map((s) => panel.vote(task, worker.run(task, s).output));
  ensemble.fitPredict(rootVotes);
  const oracle: WorkerOracle = {
    step: (branch: BranchNode) => {
      const { output, cost } = worker.run(task, branch.strategy);
      const votes = panel.vote(task, output);
      return { output, fitness: ensemble.scoreItem(votes), cost, done: true };
    },
  };
  const report = new BanditController(tree, oracle, { budget }).run();
  const output = report.best?.output ?? "";
  return { score: report.best?.fitness ?? 0, correct: output.startsWith("OK:") };
}

// ===========================================================================
// ATTACK 1 — END-TO-END SILENT-WRONG BOUND (the headline)
// ===========================================================================

describe("Attack 1 — assembled pipeline preserves P(true-wrong | emitted) ≤ ε", () => {
  const CAL_N = 350;
  const TEST_N = 350;
  // Disjoint index spaces ⇒ calibration and test are independent draws of the
  // SAME generative process (exchangeable), never the same tasks.
  const calTasks = Array.from({ length: CAL_N }, (_, k) =>
    makeTask(k, { executable: true }),
  );
  const testTasks = Array.from({ length: TEST_N }, (_, k) =>
    makeTask(1_000_000 + k, { executable: true }),
  );

  // Calibration = (winning-branch fitness, ground-truth correct) on the cal
  // split. Score is ε-independent, so compute ONCE and reuse for every ε.
  const calibration: CalibrationPoint[] = calTasks.map((t) => {
    const r = replicaScore(t, HEADLINE_BUDGET);
    return { score: r.score, correct: r.correct };
  });
  // Replica scores for the test split (for the fidelity cross-check).
  const testReplica = new Map<string, { score: number; correct: boolean }>();
  for (const t of testTasks) testReplica.set(t.id, replicaScore(t, HEADLINE_BUDGET));

  const epsilons = [0.05, 0.1, 0.2];
  const rows: Array<{
    eps: number;
    emitted: number;
    abstained: number;
    trueWrong: number;
    wrongRate: number;
    budget: number;
    emitRate: number;
  }> = [];

  for (const eps of epsilons) {
    it(`ε=${eps}: emitted true-wrong rate ≤ ε + finite-sample slack; some emit & some abstain`, async () => {
      const cfg: StyxConfig = {
        epsilon: eps,
        budget: HEADLINE_BUDGET,
        ca: CA,
        calibration,
        issuedAt: ISSUED_AT,
      };
      const orch = new StyxOrchestrator(spec, worker, panel, cfg);
      const outcomes = await Promise.all(testTasks.map((t) => orch.run(t)));

      let emitted = 0;
      let abstained = 0;
      let trueWrong = 0;
      for (const o of outcomes) {
        if (o.emitted) {
          emitted += 1;
          const out = o.output ?? "";
          if (!out.startsWith("OK:")) trueWrong += 1;
          // FIDELITY: the gate thresholded EXACTLY the replica score (so the
          // calibration set is genuinely exchangeable with deployment).
          const rep = testReplica.get(o.taskId)!;
          expect(o.certificate!.payload.ensembleScore).toBeCloseTo(rep.score, 12);
        } else {
          abstained += 1;
        }
      }

      const wrongRate = emitted > 0 ? trueWrong / emitted : 0;
      // Marginal split-conformal slack: single-split realized rate scatters
      // ~binomially around the (≤ε) tail risk; allow 3σ + a small estimation
      // floor. This is a genuinely tight bar — the tier floor only ADDS
      // abstention, so a correct composition lands comfortably under ε.
      const slack = 3 * Math.sqrt((eps * (1 - eps)) / Math.max(emitted, 1)) + 0.02;

      rows.push({
        eps,
        emitted,
        abstained,
        trueWrong,
        wrongRate,
        budget: eps + slack,
        emitRate: emitted / TEST_N,
      });

      // Useful: it emits SOMETHING. Discriminating: it abstains on SOMETHING.
      expect(emitted).toBeGreaterThan(0);
      expect(abstained).toBeGreaterThan(0);
      expect(emitted).toBeGreaterThan(20); // enough emitted to measure a rate

      // THE HEADLINE ASSERTION — the composition holds the S1 bound end to end.
      expect(wrongRate).toBeLessThanOrEqual(eps + slack);
    });
  }

  it("reports measured end-to-end silent-wrong rate vs ε (the critical number)", () => {
    expect(rows.length).toBe(epsilons.length);
    // eslint-disable-next-line no-console
    console.log(
      "[E2E Attack1] end-to-end emitted TRUE-wrong rate vs ε:",
      JSON.stringify(
        rows
          .slice()
          .sort((a, b) => a.eps - b.eps)
          .map((r) => ({
            eps: r.eps,
            emitted: r.emitted,
            abstained: r.abstained,
            emitRate: +r.emitRate.toFixed(3),
            trueWrong: r.trueWrong,
            wrongRate: +r.wrongRate.toFixed(4),
            budget_epsPlusSlack: +r.budget.toFixed(4),
            holds: r.wrongRate <= r.budget,
          })),
        null,
        2,
      ),
    );
    for (const r of rows) expect(r.wrongRate).toBeLessThanOrEqual(r.budget);
  });
});

// ===========================================================================
// ATTACK 2 — EVERY EMITTED ANSWER IS CERTIFIED & VALID; abstentions are bare
// ===========================================================================

describe("Attack 2 — emitted ⇒ valid output-bound certificate; abstained ⇒ nothing", () => {
  it("across the population every emit carries a verifying, output-bound cert", async () => {
    const tasks = Array.from({ length: 320 }, (_, k) =>
      makeTask(2_000_000 + k, { executable: true }),
    );
    const calibration: CalibrationPoint[] = Array.from({ length: 300 }, (_, k) => {
      const t = makeTask(2_500_000 + k, { executable: true });
      const r = replicaScore(t, HEADLINE_BUDGET);
      return { score: r.score, correct: r.correct };
    });
    const orch = new StyxOrchestrator(spec, worker, panel, {
      epsilon: 0.1,
      budget: HEADLINE_BUDGET,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });
    const outcomes = await Promise.all(tasks.map((t) => orch.run(t)));

    let emitted = 0;
    let abstained = 0;
    for (const o of outcomes) {
      if (o.emitted) {
        emitted += 1;
        // present
        expect(o.certificate).toBeDefined();
        expect(o.output).toBeDefined();
        // valid
        await expect(verifyCertificate(o.certificate!)).resolves.toBe(true);
        // output-bound
        await expect(certifiesOutput(o.certificate!, o.output!)).resolves.toBe(true);
        // the cert actually names THIS task and this ε
        expect(o.certificate!.payload.taskId).toBe(o.taskId);
        expect(o.certificate!.payload.epsilon).toBe(0.1);
        expect(o.reason).toBe("emitted");
      } else {
        abstained += 1;
        // an abstention has NO certificate and NO output
        expect(o.certificate).toBeUndefined();
        expect(o.output).toBeUndefined();
        expect(o.reason).not.toBe("emitted");
      }
    }
    expect(emitted).toBeGreaterThan(0);
    expect(abstained).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[E2E Attack2] emitted=${emitted} (all certified+valid+bound), abstained=${abstained} (all bare)`,
    );
  });
});

// ===========================================================================
// ATTACK 3 — TAMPER: the certificate actually binds THIS system's outputs
// ===========================================================================

describe("Attack 3 — mutating output or cert payload breaks verification", () => {
  it("output tamper ⇒ certifiesOutput false; payload tamper ⇒ verifyCertificate false", async () => {
    const calibration: CalibrationPoint[] = Array.from({ length: 300 }, (_, k) => {
      const t = makeTask(3_500_000 + k, { executable: true });
      const r = replicaScore(t, HEADLINE_BUDGET);
      return { score: r.score, correct: r.correct };
    });
    const orch = new StyxOrchestrator(spec, worker, panel, {
      epsilon: 0.2,
      budget: HEADLINE_BUDGET,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });

    // Find a task that actually emits.
    let emittedOutcome: StyxOutcome | undefined;
    for (let k = 0; k < 400 && !emittedOutcome; k++) {
      const o = await orch.run(makeTask(3_000_000 + k, { executable: true }));
      if (o.emitted) emittedOutcome = o;
    }
    expect(emittedOutcome).toBeDefined();
    const o = emittedOutcome!;
    const cert = o.certificate!;

    // Baseline: pristine cert verifies and binds its output.
    await expect(verifyCertificate(cert)).resolves.toBe(true);
    await expect(certifiesOutput(cert, o.output!)).resolves.toBe(true);

    // (a) Mutate the delivered OUTPUT text, keep the cert → binding fails.
    await expect(certifiesOutput(cert, o.output! + " (edited)")).resolves.toBe(false);
    await expect(
      certifiesOutput(cert, o.output!.replace("OK:", "HACKED:")),
    ).resolves.toBe(false);

    // (b) Mutate a cert PAYLOAD field → signature no longer verifies.
    const tamperedPayloads = [
      { ...cert.payload, pCorrect: cert.payload.pCorrect + 0.05 },
      { ...cert.payload, ensembleScore: cert.payload.ensembleScore + 0.05 },
      { ...cert.payload, epsilon: cert.payload.epsilon + 0.01 },
      { ...cert.payload, taskId: cert.payload.taskId + "!" },
      { ...cert.payload, verifierTier: "T0-execution-forged" },
    ];
    for (const payload of tamperedPayloads) {
      await expect(verifyCertificate({ ...cert, payload })).resolves.toBe(false);
    }
    // Sanity: the untouched cert still verifies (tamper was the only cause).
    await expect(verifyCertificate({ ...cert })).resolves.toBe(true);
  });
});

// ===========================================================================
// ATTACK 4 — BUDGET IS NEVER EXCEEDED (across varied budgets)
// ===========================================================================

describe("Attack 4 — spent ≤ budget on every task, for every budget", () => {
  it("holds across a range of budgets and both emit/abstain outcomes", async () => {
    const calibration: CalibrationPoint[] = Array.from({ length: 300 }, (_, k) => {
      const t = makeTask(4_500_000 + k, { executable: true });
      const r = replicaScore(t, HEADLINE_BUDGET);
      return { score: r.score, correct: r.correct };
    });
    const tasks = Array.from({ length: 120 }, (_, k) =>
      makeTask(4_000_000 + k, { executable: true }),
    );
    const budgets = [1, 2, 3, 5, 8, 13];
    let maxSpent = 0;
    for (const budget of budgets) {
      const orch = new StyxOrchestrator(spec, worker, panel, {
        epsilon: 0.1,
        budget,
        ca: CA,
        calibration,
        issuedAt: ISSUED_AT,
      });
      const outcomes = await Promise.all(tasks.map((t) => orch.run(t)));
      for (const o of outcomes) {
        // The hard invariant, end to end.
        expect(o.spent).toBeLessThanOrEqual(budget + 1e-9);
        maxSpent = Math.max(maxSpent, o.spent);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[E2E Attack4] budget invariant held; max observed spent=${maxSpent}`);
  });
});

// ===========================================================================
// ATTACK 5 — TIER IS LOAD-BEARING END TO END
// ===========================================================================
//
// SAME task input, SAME answer, SAME winning ensemble score — only the task
// SIGNALS differ (executable ⇒ T0 low floor vs no-signals ⇒ T4 near-1 floor).
// A correctly-composed pipeline EMITS at T0 and ABSTAINS at T4. If routing does
// not flip the emit decision, the tier router is decorative.

describe("Attack 5 — routing alone flips emit vs abstain at identical score", () => {
  // Dedicated components pinning the winning score into (floor_T0, floor_T4):
  // root "A" gets 9/10 verifiers passing, "B"/"C" all fail ⇒ score ≈ 0.931.
  const spec5: Speculator = { propose: () => ["A", "B", "C"] };
  const worker5: Worker = { run: (_t, strategy) => ({ output: `ans:${strategy}`, cost: 1 }) };
  const panel5: VerifierPanel = {
    vote: (_t, output) => {
      const isA = output === "ans:A";
      return Array.from({ length: 10 }, (_, v) => ({
        verifierId: `w${v}`,
        passed: isA ? v !== 9 : false,
      }));
    },
  };
  const EPS = 0.2;

  it("T0-executable EMITS while T4-consistency ABSTAINS on the same answer", async () => {
    // Calibration whose τ(0.2) sits below the winning score 0.931.
    const calibration: CalibrationPoint[] = [];
    for (let i = 0; i < 600; i++) {
      const s = rnd(i, 5501);
      calibration.push({ score: s, correct: rnd(i, 5502) < clamp01(s * 1.03) });
    }
    const cfg: StyxConfig = {
      epsilon: EPS,
      budget: 12,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    };
    const orch = new StyxOrchestrator(spec5, worker5, panel5, cfg);

    const t0 = await orch.run(makeTask(9001, { executable: true })); // ⇒ T0
    const t4 = await orch.run(makeTask(9002, {})); // no signals ⇒ T4

    const floorT0 = tierConfidenceFloor("T0-execution", EPS);
    const floorT4 = tierConfidenceFloor("T4-consistency", EPS);

    // Preconditions: routing is as intended and the score is genuinely between
    // the two floors and above the gate threshold (so ONLY the tier can differ).
    expect(t0.tier).toBe("T0-execution");
    expect(t4.tier).toBe("T4-consistency");
    expect(t0.confidenceFloor).toBeCloseTo(floorT0, 12);
    expect(t4.confidenceFloor).toBeCloseTo(floorT4, 12);
    const score = t0.certificate?.payload.ensembleScore ?? -1;
    expect(score).toBeGreaterThan(floorT0); // clears the strong-tier bar
    expect(score).toBeLessThan(floorT4); // but NOT the weak-tier bar
    expect(t0.threshold).toBeLessThanOrEqual(score); // gate would admit it too
    expect(Number.isFinite(t0.threshold)).toBe(true);

    // THE COMPOSITION CLAIM: tier — nothing else — flips the outcome.
    expect(t0.emitted).toBe(true);
    expect(t0.reason).toBe("emitted");
    expect(t4.emitted).toBe(false);
    expect(t4.reason).toBe("below-tier-floor");
    expect(t4.certificate).toBeUndefined();

    // eslint-disable-next-line no-console
    console.log(
      "[E2E Attack5] tier flip:",
      JSON.stringify({
        score: +score.toFixed(4),
        tau: +t0.threshold.toFixed(4),
        floorT0: +floorT0.toFixed(4),
        floorT4: +floorT4.toFixed(4),
        emitT0: t0.emitted,
        emitT4: t4.emitted,
      }),
    );
  });
});

// ===========================================================================
// ATTACK 6 — ABSTAIN-BY-DEFAULT UNDER GARBAGE, EMIT UNDER QUALITY
// ===========================================================================

describe("Attack 6 — the system tracks quality: garbage ⇒ ~0 emit, quality ⇒ high emit", () => {
  const EPS = 0.2;

  // GARBAGE: worker always wrong; honest panel fails wrong answers (mostly).
  const garbageWorker: Worker = {
    run: (task, strategy) => ({ output: `BAD:${task.id}:${strategy}`, cost: 1 }),
  };
  // QUALITY: worker always right; panel passes correct answers (mostly).
  const qualityWorker: Worker = {
    run: (task) => ({ output: `OK:${task.id}`, cost: 1 }),
  };

  it("a Worker that always returns wrong answers ⇒ emitted rate ≈ 0", async () => {
    const calibration: CalibrationPoint[] = Array.from({ length: 120 }, (_, k) => {
      const t = makeTask(6_500_000 + k, { executable: true });
      const r = replicaScoreWith(garbageWorker, t, HEADLINE_BUDGET);
      return { score: r.score, correct: r.correct };
    });
    const orch = new StyxOrchestrator(spec, garbageWorker, panel, {
      epsilon: EPS,
      budget: HEADLINE_BUDGET,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });
    const tasks = Array.from({ length: 120 }, (_, k) =>
      makeTask(6_000_000 + k, { executable: true }),
    );
    const outcomes = await Promise.all(tasks.map((t) => orch.run(t)));
    const emitted = outcomes.filter((o) => o.emitted).length;
    const emitRate = emitted / tasks.length;
    // eslint-disable-next-line no-console
    console.log(`[E2E Attack6] garbage worker emit rate=${emitRate.toFixed(4)} (${emitted}/${tasks.length})`);
    // The system abstains rather than emit garbage.
    expect(emitRate).toBeLessThanOrEqual(0.02);
    // And any emit (there should be ~none) is at least never a false OK.
    for (const o of outcomes) if (o.emitted) expect(o.output!.startsWith("OK:")).toBe(false);
  });

  it("a Worker that's always right + passing panel ⇒ high emit rate", async () => {
    const calibration: CalibrationPoint[] = Array.from({ length: 120 }, (_, k) => {
      const t = makeTask(6_700_000 + k, { executable: true });
      const r = replicaScoreWith(qualityWorker, t, HEADLINE_BUDGET);
      return { score: r.score, correct: r.correct };
    });
    const orch = new StyxOrchestrator(spec, qualityWorker, panel, {
      epsilon: EPS,
      budget: HEADLINE_BUDGET,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });
    const tasks = Array.from({ length: 120 }, (_, k) =>
      makeTask(6_900_000 + k, { executable: true }),
    );
    const outcomes = await Promise.all(tasks.map((t) => orch.run(t)));
    const emitted = outcomes.filter((o) => o.emitted).length;
    const emitRate = emitted / tasks.length;
    // eslint-disable-next-line no-console
    console.log(`[E2E Attack6] quality worker emit rate=${emitRate.toFixed(4)} (${emitted}/${tasks.length})`);
    expect(emitRate).toBeGreaterThanOrEqual(0.6);
    // Every emitted quality answer is in fact correct AND certified.
    for (const o of outcomes) {
      if (o.emitted) {
        expect(o.output!.startsWith("OK:")).toBe(true);
        await expect(certifiesOutput(o.certificate!, o.output!)).resolves.toBe(true);
      }
    }
  });
});

// Replica score using an arbitrary worker (for Attack 6 calibration).
function replicaScoreWith(
  w: Worker,
  task: StyxTask,
  budget: number,
): { score: number; correct: boolean } {
  const strategies = spec.propose(task);
  const tree = new BranchTree(strategies);
  const ensemble = new WeakVerifierEnsemble();
  const rootVotes = strategies.map((s) => panel.vote(task, w.run(task, s).output));
  ensemble.fitPredict(rootVotes);
  const oracle: WorkerOracle = {
    step: (branch: BranchNode) => {
      const { output, cost } = w.run(task, branch.strategy);
      const votes = panel.vote(task, output);
      return { output, fitness: ensemble.scoreItem(votes), cost, done: true };
    },
  };
  const report = new BanditController(tree, oracle, { budget }).run();
  const output = report.best?.output ?? "";
  return { score: report.best?.fitness ?? 0, correct: output.startsWith("OK:") };
}

// ===========================================================================
// ATTACK 7 — DETERMINISM + NEVER-THROWS
// ===========================================================================

describe("Attack 7 — identical inputs ⇒ identical outcome; throwing components ⇒ abstain, never reject", () => {
  const calibration: CalibrationPoint[] = Array.from({ length: 200 }, (_, k) => {
    const s = rnd(k, 7701);
    return { score: s, correct: rnd(k, 7702) < s };
  });

  it("same task + same components ⇒ byte-identical StyxOutcome (incl. certificate)", async () => {
    // Quality worker so the run actually emits and the cert is part of equality.
    const qWorker: Worker = { run: (task) => ({ output: `OK:${task.id}`, cost: 1 }) };
    const qCal: CalibrationPoint[] = Array.from({ length: 200 }, (_, k) => {
      const t = makeTask(7_500_000 + k, { executable: true });
      const r = replicaScoreWith(qWorker, t, HEADLINE_BUDGET);
      return { score: r.score, correct: r.correct };
    });
    const cfg: StyxConfig = {
      epsilon: 0.2,
      budget: HEADLINE_BUDGET,
      ca: CA,
      calibration: qCal,
      issuedAt: ISSUED_AT,
    };
    // Find a task that actually emits so the equality exercises a certificate.
    let task: StyxTask | undefined;
    for (let k = 0; k < 200 && !task; k++) {
      const cand = makeTask(7_000_000 + k, { executable: true });
      const probe = await new StyxOrchestrator(spec, qWorker, panel, cfg).run(cand);
      if (probe.emitted) task = cand;
    }
    expect(task).toBeDefined();
    const a = await new StyxOrchestrator(spec, qWorker, panel, cfg).run(task!);
    const b = await new StyxOrchestrator(spec, qWorker, panel, cfg).run(task!);
    expect(a.emitted).toBe(true); // the equality actually exercises a certificate
    expect(a).toEqual(b);
    // Signatures too — ed25519 is deterministic given key+message+issuedAt.
    expect(a.certificate!.signature).toBe(b.certificate!.signature);
  });

  it("a throwing Worker ⇒ resolves to an abstain with reason 'error:...' (never rejects)", async () => {
    const throwingWorker: Worker = {
      run: () => {
        throw new Error("worker boom");
      },
    };
    const orch = new StyxOrchestrator(spec, throwingWorker, panel, {
      epsilon: 0.1,
      budget: 5,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });
    const o = await orch.run(makeTask(7_100_001, { executable: true }));
    expect(o.emitted).toBe(false);
    expect(o.reason.startsWith("error:")).toBe(true);
    expect(o.certificate).toBeUndefined();
    expect(o.output).toBeUndefined();
    // The routing legs are still reported on the error path.
    expect(o.tier).toBe("T0-execution");
  });

  it("a throwing VerifierPanel ⇒ resolves to an abstain with reason 'error:...'", async () => {
    const throwingPanel: VerifierPanel = {
      vote: () => {
        throw new Error("panel boom");
      },
    };
    const orch = new StyxOrchestrator(spec, worker, throwingPanel, {
      epsilon: 0.1,
      budget: 5,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });
    const o = await orch.run(makeTask(7_200_001, { hasReference: true }));
    expect(o.emitted).toBe(false);
    expect(o.reason.startsWith("error:")).toBe(true);
    expect(o.certificate).toBeUndefined();
  });

  it("a throwing Speculator ⇒ resolves to an abstain with reason 'error:...'", async () => {
    const throwingSpec: Speculator = {
      propose: () => {
        throw new Error("spec boom");
      },
    };
    const orch = new StyxOrchestrator(throwingSpec, worker, panel, {
      epsilon: 0.1,
      budget: 5,
      ca: CA,
      calibration,
      issuedAt: ISSUED_AT,
    });
    // Must resolve, not reject.
    const o = await orch.run(makeTask(7_300_001, { executable: true }));
    expect(o.emitted).toBe(false);
    expect(o.reason.startsWith("error:")).toBe(true);
  });
});
