import { describe, expect, it } from "vitest";

import {
  runRiskEval,
  formatRiskEvalReport,
  scriptedSolvers,
  type AdmitFn,
  type RiskEvalAdmission,
  type RiskEvalReport,
  type RiskEvalSubject,
  type ScriptedSolver,
} from "../risk-eval";
import { UnifiedTrustGate } from "../unified-gate";
import { VerifierRegistry, type TrustSubject, type UniversalVerifier } from "../registry";
import {
  CertificateAuthority,
  certifiesOutput,
  generatePrivateKeyHex,
  sha256Hex,
  verifyCertificate,
  type CertificatePayload,
} from "../../styx/certificate";
import type { CalibrationPoint } from "../../styx/gate";
import { EVAL_TASKS, EVAL_CATEGORIES } from "../../bench/eval-suite";
import type { EvalTask } from "../../bench/vtph";

// ===========================================================================
// Shared fixtures
// ===========================================================================

const NOW_MS = 1_800_000_000_000;
const FIXED_NOW = (): number => NOW_MS;

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

function stubTask(id: string, correctOutput: string, category = "arithmetic"): EvalTask {
  return {
    id,
    category,
    decomposable: false,
    prompt: `stub prompt for ${id}`,
    grade: (output: string) => output === correctOutput,
  };
}

function fixedOutputSolver(output: string, id = "solver-fixed"): ScriptedSolver {
  return {
    id,
    label: "faithful",
    answer: () => ({
      output,
      evidence: {},
      trace: [{ seq: 1, kind: "fixed", detail: "fixed output" }],
    }),
  };
}

function perTaskOutputSolver(map: Record<string, string>, id = "solver-per-task"): ScriptedSolver {
  return {
    id,
    label: "faithful",
    answer: (task: EvalTask) => ({
      output: map[task.id] ?? "",
      evidence: {},
      trace: [{ seq: 1, kind: "fixed", detail: "fixed per-task output" }],
    }),
  };
}

/**
 * A REAL calibrated pipeline: two independent verifiers, each an honest
 * T0-execution oracle that runs the task's OWN real grader (simulating two
 * independent executions of a deterministic check), fused by the REAL
 * `WeakVerifierEnsemble` and thresholded by the REAL `ConformalGate`.
 * Because both verifiers vote unanimously on `task.grade(output)`, the
 * fused score is exactly 1.0 for a correct output and exactly 0.0 for a
 * wrong one; calibrating the threshold at the score-1 cluster makes
 * `admitted <=> grade(output) === true`, by construction, over this
 * verifier pair. This is the REAL UnifiedTrustGate.admit — not a simplified
 * stand-in — wired with a plausible (execution-oracle-style) verifier pair.
 */
function buildCalibratedGate(
  tasksForVerifier: readonly EvalTask[],
  epsilon = 0.1,
): { gate: UnifiedTrustGate; admit: AdmitFn } {
  const tasksById = new Map(tasksForVerifier.map((t) => [t.id, t]));

  function makeGradeVerifier(id: string): UniversalVerifier {
    return {
      id,
      version: "1.0.0",
      domain: "procedure",
      tier: "T0-execution",
      prior: 0.999,
      appliesTo: (s: TrustSubject) => s.domain === "procedure" && tasksById.has(s.taskId),
      verify: (s: TrustSubject) => {
        const task = tasksById.get(s.taskId);
        const passed = task ? task.grade(s.output) : false;
        return {
          verifierId: id,
          version: "1.0.0",
          tier: "T0-execution" as const,
          passed,
          confidence: 0.99,
          reasons: [],
          abstained: false,
        };
      },
    };
  }

  const registry = new VerifierRegistry();
  registry.register(makeGradeVerifier("grader-oracle-a"));
  registry.register(makeGradeVerifier("grader-oracle-b"));

  const issuer = new CertificateAuthority(generatePrivateKeyHex(fixedRng(11)));
  const gate = new UnifiedTrustGate({ epsilon, issuer, registry, now: FIXED_NOW });

  const calibrationPoints: CalibrationPoint[] = [
    ...Array.from({ length: 40 }, () => ({ score: 1, correct: true })),
    ...Array.from({ length: 4 }, () => ({ score: 0, correct: false })),
  ];
  gate.calibrate("procedure", calibrationPoints);

  const admit: AdmitFn = (subject: RiskEvalSubject) => gate.admit(subject as unknown as TrustSubject);
  return { gate, admit };
}

/** SIMPLIFIED admit (not the real gate): accepts every subject with a REAL,
 *  correctly-bound ed25519 certificate. Used only to drive falsifiability
 *  and certificate-audit edge cases named as such in each test title. */
function makeAcceptEverythingAdmit(epsilon: number, seed = 3): { admit: AdmitFn; ca: CertificateAuthority } {
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(seed)));
  const admit: AdmitFn = async (subject: RiskEvalSubject): Promise<RiskEvalAdmission> => {
    const payload: CertificatePayload = {
      outputSha256: sha256Hex(subject.output),
      taskId: subject.taskId,
      verifierTier: "T4-consistency",
      ensembleScore: 1,
      pCorrect: 1 - epsilon / 2,
      epsilon,
      traceSha256: sha256Hex(JSON.stringify(subject.trace)),
      verifierVersions: ["accept-everything-test-stub@1.0.0"],
      issuedAt: NOW_MS,
    };
    const certificate = await ca.issue(payload);
    return {
      accepted: true,
      domain: subject.domain,
      taskId: subject.taskId,
      score: 1,
      threshold: 0,
      pCorrect: payload.pCorrect,
      epsilon,
      tier: "T4-consistency",
      certificate,
    };
  };
  return { admit, ca };
}

function assertAccounting(r: RiskEvalReport): void {
  expect(r.accepted + r.abstained).toBe(r.attempts);
  expect(r.silentWrong).toBeLessThanOrEqual(r.accepted);

  let catAttempts = 0;
  let catAccepted = 0;
  let catSilentWrong = 0;
  for (const cat of Object.keys(r.perCategory)) {
    const b = r.perCategory[cat];
    catAttempts += b.attempts;
    catAccepted += b.accepted;
    catSilentWrong += b.silentWrong;
    expect(b.silentWrong).toBeLessThanOrEqual(b.accepted);
  }
  expect(catAttempts).toBe(r.attempts);
  expect(catAccepted).toBe(r.accepted);
  expect(catSilentWrong).toBe(r.silentWrong);

  let solverAttempts = 0;
  let solverAccepted = 0;
  let solverSilentWrong = 0;
  for (const id of Object.keys(r.perSolver)) {
    const b = r.perSolver[id];
    solverAttempts += b.attempts;
    solverAccepted += b.accepted;
    solverSilentWrong += b.silentWrong;
  }
  expect(solverAttempts).toBe(r.attempts);
  expect(solverAccepted).toBe(r.accepted);
  expect(solverSilentWrong).toBe(r.silentWrong);
}

// ===========================================================================
// scriptedSolvers() — the derivation logic itself
// ===========================================================================

describe("scriptedSolvers", () => {
  it("returns exactly the four locked solver labels, each deterministic (non-model)", () => {
    const solvers = scriptedSolvers();
    expect(solvers.map((s) => s.label).sort()).toEqual(["fabricating", "faithful", "lossy", "refusing"]);
    // determinism: calling answer() twice on the same task yields identical output
    for (const s of solvers) {
      const a = s.answer(EVAL_TASKS[0]);
      const b = s.answer(EVAL_TASKS[0]);
      expect(a.output).toBe(b.output);
    }
  });

  it("faithful solver's derived answer passes the REAL grader for every task in the REAL corpus", () => {
    const [faithful] = scriptedSolvers();
    expect(faithful.label).toBe("faithful");
    const failures: string[] = [];
    for (const task of EVAL_TASKS) {
      const { output } = faithful.answer(task);
      if (!task.grade(output)) failures.push(`${task.id} -> ${JSON.stringify(output)}`);
    }
    expect(failures).toEqual([]);
  });

  it("lossy solver's truncated answer fails the REAL grader for every task (real degrading transform)", () => {
    const solvers = scriptedSolvers();
    const lossy = solvers.find((s) => s.label === "lossy")!;
    for (const task of EVAL_TASKS) {
      const { output } = lossy.answer(task);
      expect(task.grade(output)).toBe(false);
    }
  });

  it("fabricating solver's answer is structurally plausible (same shape as the real answer) but fails the REAL grader for every task", () => {
    const solvers = scriptedSolvers();
    const faithful = solvers.find((s) => s.label === "faithful")!;
    const fabricating = solvers.find((s) => s.label === "fabricating")!;
    for (const task of EVAL_TASKS) {
      const real = faithful.answer(task).output;
      const fab = fabricating.answer(task).output;
      expect(task.grade(fab)).toBe(false);
      // "plausible": non-empty and not wildly different in shape/length from
      // the real answer (a shallow structural check would not flag it).
      expect(fab.length).toBeGreaterThan(0);
      expect(Math.abs(fab.length - real.length)).toBeLessThan(real.length + 25);
    }
  });

  it('refusing solver always emits "" (grade("") is false for every real task per the grader contract)', () => {
    const solvers = scriptedSolvers();
    const refusing = solvers.find((s) => s.label === "refusing")!;
    for (const task of EVAL_TASKS) {
      const { output } = refusing.answer(task);
      expect(output).toBe("");
      expect(task.grade(output)).toBe(false);
    }
  });
});

// ===========================================================================
// runRiskEval — falsifiability (both directions)
// ===========================================================================

describe("runRiskEval falsifiability", () => {
  it("SIMPLIFIED admit-everything AdmitFn (not the real gate) drives withinBound to false with a nonzero measured silentWrongRate", async () => {
    const { admit } = makeAcceptEverythingAdmit(0.01);
    const report = await runRiskEval({ epsilon: 0.01, admit, now: FIXED_NOW });

    assertAccounting(report);
    expect(report.accepted).toBe(report.attempts); // accepts everything
    expect(report.abstained).toBe(0);
    expect(report.silentWrong).toBeGreaterThan(0);
    expect(report.silentWrongRate).toBeGreaterThan(report.epsilon);
    expect(report.withinBound).toBe(false);
    expect(report.certificateFailures).toEqual([]); // every cert genuinely verifies
  });

  it("a REAL UnifiedTrustGate calibrated so admission tracks the real grader produces withinBound:true over the full real corpus", async () => {
    const { admit } = buildCalibratedGate(EVAL_TASKS, 0.1);
    const report = await runRiskEval({ epsilon: 0.1, admit, now: FIXED_NOW });

    assertAccounting(report);
    expect(report.taskCount).toBe(EVAL_TASKS.length);
    expect(report.attempts).toBe(EVAL_TASKS.length * scriptedSolvers().length);
    expect(report.silentWrong).toBe(0);
    expect(report.withinBound).toBe(true);
    expect(report.certificateFailures).toEqual([]);
    expect(report.certificatesIssued).toBe(report.accepted);
    expect(report.certificatesVerified).toBe(report.accepted);

    // The thesis test: the faithful solver is admitted on every task; the
    // fabricating adversary — structurally plausible, ground-truth wrong —
    // is abstained on, never silently accepted, under a calibrated gate.
    expect(report.perSolver["solver-faithful"].accepted).toBe(EVAL_TASKS.length);
    expect(report.perSolver["solver-faithful"].silentWrong).toBe(0);
    expect(report.perSolver["solver-fabricating"].accepted).toBe(0);
    expect(report.perSolver["solver-lossy"].accepted).toBe(0);
  });
});

// ===========================================================================
// Certificate audit — independent of whatever gate issued the certificate
// ===========================================================================

describe("runRiskEval certificate audit", () => {
  it("an accepted output with NO certificate is recorded as a certificateFailure (missing-certificate) and fails the checkpoint", async () => {
    const task = stubTask("no-cert-task", "42");
    const solver = fixedOutputSolver("42");
    const admit: AdmitFn = async (subject) => ({
      accepted: true,
      domain: subject.domain,
      taskId: subject.taskId,
      score: 1,
      threshold: 0,
      pCorrect: 0.99,
      epsilon: 0.1,
      tier: "T0-execution",
      // no certificate
    });

    const report = await runRiskEval({ tasks: [task], solvers: [solver], epsilon: 0.1, admit, now: FIXED_NOW });
    assertAccounting(report);
    expect(report.accepted).toBe(1);
    expect(report.certificatesIssued).toBe(0);
    expect(report.certificatesVerified).toBe(0);
    expect(report.certificateFailures).toEqual([{ taskId: "no-cert-task", reason: "missing-certificate" }]);
    expect(report.withinBound).toBe(false);
  });

  it("a certificate with a tampered payload field fails independent re-verification as signature-invalid", async () => {
    const task = stubTask("tamper-task", "42");
    const solver = fixedOutputSolver("42");
    const { admit } = makeAcceptEverythingAdmit(0.1, 21);

    const tamperingAdmit: AdmitFn = async (subject) => {
      const clean = await admit(subject);
      if (clean.certificate === undefined) return clean;
      const tampered = {
        ...clean.certificate,
        payload: { ...clean.certificate.payload, pCorrect: clean.certificate.payload.pCorrect + 0.001 },
      };
      // Sanity: the tamper really does break the real signature check.
      expect(await verifyCertificate(tampered)).toBe(false);
      return { ...clean, certificate: tampered };
    };

    const report = await runRiskEval({
      tasks: [task],
      solvers: [solver],
      epsilon: 0.1,
      admit: tamperingAdmit,
      now: FIXED_NOW,
    });
    assertAccounting(report);
    expect(report.certificateFailures).toEqual([{ taskId: "tamper-task", reason: "signature-invalid" }]);
    expect(report.withinBound).toBe(false);
  });

  it("a valid certificate signature truncated to malformed hex fails re-verification as signature-malformed (distinct from a tampered payload)", async () => {
    const task = stubTask("truncate-task", "42");
    const solver = fixedOutputSolver("42");
    const { admit } = makeAcceptEverythingAdmit(0.1, 22);

    const truncatingAdmit: AdmitFn = async (subject) => {
      const clean = await admit(subject);
      if (clean.certificate === undefined) return clean;
      const truncated = { ...clean.certificate, signature: clean.certificate.signature.slice(0, 10) };
      return { ...clean, certificate: truncated };
    };

    const report = await runRiskEval({
      tasks: [task],
      solvers: [solver],
      epsilon: 0.1,
      admit: truncatingAdmit,
      now: FIXED_NOW,
    });
    assertAccounting(report);
    expect(report.certificateFailures).toEqual([{ taskId: "truncate-task", reason: "signature-malformed" }]);
    expect(report.withinBound).toBe(false);
  });

  it("a genuinely valid certificate swapped onto a DIFFERENT task's output fails re-verification as output-mismatch (distinct from the other two failure reasons)", async () => {
    const tasks = [stubTask("swap-a", "AAA"), stubTask("swap-b", "BBB")];
    const solver = perTaskOutputSolver({ "swap-a": "AAA", "swap-b": "BBB" });
    const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(31)));

    // Issue ONE real, valid certificate bound to swap-a's output only.
    const payloadA: CertificatePayload = {
      outputSha256: sha256Hex("AAA"),
      taskId: "swap-a",
      verifierTier: "T0-execution",
      ensembleScore: 1,
      pCorrect: 0.99,
      epsilon: 0.1,
      traceSha256: sha256Hex("[]"),
      verifierVersions: ["swap-test@1.0.0"],
      issuedAt: NOW_MS,
    };
    const certA = await ca.issue(payloadA);
    // Sanity: certA really does bind swap-a's output and not swap-b's.
    expect(await certifiesOutput(certA, "AAA")).toBe(true);
    expect(await certifiesOutput(certA, "BBB")).toBe(false);

    const swappingAdmit: AdmitFn = async (subject) => ({
      accepted: true,
      domain: subject.domain,
      taskId: subject.taskId,
      score: 1,
      threshold: 0,
      pCorrect: 0.99,
      epsilon: 0.1,
      tier: "T0-execution",
      certificate: certA, // ALWAYS certA, regardless of which subject this is
    });

    const report = await runRiskEval({
      tasks,
      solvers: [solver],
      epsilon: 0.1,
      admit: swappingAdmit,
      now: FIXED_NOW,
    });
    assertAccounting(report);
    expect(report.accepted).toBe(2);
    // swap-a: genuinely correctly bound -> no failure. swap-b: certA does not
    // bind swap-b's output -> exactly one failure, reason output-mismatch.
    expect(report.certificateFailures).toEqual([{ taskId: "swap-b", reason: "output-mismatch" }]);
    expect(report.withinBound).toBe(false);
  });
});

// ===========================================================================
// Honest abstention accounting
// ===========================================================================

describe("runRiskEval abstention accounting", () => {
  it("abstainedButCorrect reports the honest cost of abstention, and a degenerate abstain-all run is flagged, never presented as a pass", async () => {
    const abstainAllAdmit: AdmitFn = async (subject) => ({
      accepted: false,
      domain: subject.domain,
      taskId: subject.taskId,
      score: 0,
      threshold: Number.POSITIVE_INFINITY,
      pCorrect: 0,
      epsilon: 0.1,
      tier: "T4-consistency",
      abstention: { code: "below-threshold", message: "SIMPLIFIED abstain-everything admit (test fixture)" },
    });

    const [faithful] = scriptedSolvers();
    const report = await runRiskEval({
      solvers: [faithful],
      epsilon: 0.1,
      admit: abstainAllAdmit,
      now: FIXED_NOW,
    });

    assertAccounting(report);
    expect(report.accepted).toBe(0);
    expect(report.abstained).toBe(report.attempts);
    expect(report.coverage).toBe(0);
    // the faithful solver is correct on essentially the whole corpus, so
    // abstaining on all of it must show up as a large honest cost.
    expect(report.abstainedButCorrect).toBe(EVAL_TASKS.length);
    expect(report.abstentionsByCode["below-threshold"]).toBe(EVAL_TASKS.length);

    const formatted = formatRiskEvalReport(report);
    expect(formatted).toMatch(/DEGENERATE/);
    expect(formatted).not.toMatch(/RESULT: PASS/);
  });
});

// ===========================================================================
// Robustness: throwing admit / throwing grader / throwing solver
// ===========================================================================

describe("runRiskEval robustness", () => {
  it("an admit() that throws for one subject is recorded as an abstention with a reason code and does not abort the run", async () => {
    const { admit: baseAdmit } = makeAcceptEverythingAdmit(0.1, 41);
    const throwingAdmit: AdmitFn = async (subject) => {
      if (subject.taskId === "boom-task") throw new Error("SIMPLIFIED admit blew up (test fixture)");
      return baseAdmit(subject);
    };
    const tasks = [stubTask("boom-task", "x"), stubTask("ok-task", "y")];
    const solver = perTaskOutputSolver({ "boom-task": "x", "ok-task": "y" });

    const report = await runRiskEval({ tasks, solvers: [solver], epsilon: 0.1, admit: throwingAdmit, now: FIXED_NOW });
    assertAccounting(report);
    expect(report.attempts).toBe(2);
    expect(report.abstained).toBe(1);
    expect(report.accepted).toBe(1);
    expect(report.abstentionsByCode["harness-admit-error"]).toBe(1);
  });

  it("a task whose grader throws is reported as a harness error and NEVER silently graded as correct", async () => {
    const throwingTask: EvalTask = {
      id: "throwing-grader",
      category: "arithmetic",
      decomposable: false,
      prompt: "stub prompt",
      grade: () => {
        throw new Error("grader exploded");
      },
    };
    const solver = fixedOutputSolver("anything");
    const { admit } = makeAcceptEverythingAdmit(0.5, 42); // accepts unconditionally, valid cert

    const report = await runRiskEval({
      tasks: [throwingTask],
      solvers: [solver],
      epsilon: 0.5,
      admit,
      now: FIXED_NOW,
    });
    assertAccounting(report);
    expect(report.accepted).toBe(1);
    // never silently correct: forced wrong, so an accepted-but-ungraded
    // output must land in silentWrong, not in verifiedCorrect-equivalent.
    expect(report.silentWrong).toBe(1);
    expect(report.certificateFailures).toEqual([]);
    const grErrorKeys = Object.keys(report.abstentionsByCode).filter((k) => k.startsWith("harness-grader-error:"));
    expect(grErrorKeys.length).toBe(1);
    expect(report.abstentionsByCode[grErrorKeys[0]]).toBe(1);
  });

  it("a scripted solver whose answer() throws for one task is recorded as abstained and does not abort the run", async () => {
    const throwingSolver: ScriptedSolver = {
      id: "solver-throws",
      label: "faithful",
      answer: (task) => {
        if (task.id === "t1") throw new Error("solver exploded");
        return { output: "y", evidence: {}, trace: [{ seq: 1, kind: "fixed", detail: "ok" }] };
      },
    };
    const tasks = [stubTask("t1", "x"), stubTask("t2", "y")];
    const { admit } = makeAcceptEverythingAdmit(0.5, 43);

    const report = await runRiskEval({ tasks, solvers: [throwingSolver], epsilon: 0.5, admit, now: FIXED_NOW });
    assertAccounting(report);
    expect(report.attempts).toBe(2);
    expect(report.abstained).toBe(1);
    expect(report.accepted).toBe(1);
    const solverErrorKeys = Object.keys(report.abstentionsByCode).filter((k) =>
      k.startsWith("harness-solver-error:"),
    );
    expect(solverErrorKeys.length).toBe(1);
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("runRiskEval determinism", () => {
  it("two runs with identical inputs and an injected clock produce byte-identical reports", async () => {
    const subset = EVAL_TASKS.slice(0, 12); // spans multiple real categories
    const run = async (): Promise<RiskEvalReport> => {
      const { admit } = buildCalibratedGate(subset, 0.1);
      return runRiskEval({ tasks: subset, epsilon: 0.1, admit, now: FIXED_NOW });
    };
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1).toEqual(r2);
  });
});

// ===========================================================================
// Options / validation
// ===========================================================================

describe("runRiskEval options", () => {
  it("defaults `tasks` to the REAL EVAL_TASKS across every EVAL_CATEGORIES entry", async () => {
    const report = await runRiskEval({
      solvers: [],
      epsilon: 0.1,
      admit: async () => {
        throw new Error("admit must never be called when solvers=[]");
      },
    });
    expect(report.taskCount).toBe(EVAL_TASKS.length);
    expect(report.attempts).toBe(0);
    for (const cat of EVAL_CATEGORIES) {
      expect(report.perCategory[cat]).toBeDefined();
    }
  });

  it("rejects an epsilon outside (0,1)", async () => {
    const { admit } = makeAcceptEverythingAdmit(0.1, 5);
    await expect(runRiskEval({ epsilon: 0, admit })).rejects.toThrow(RangeError);
    await expect(runRiskEval({ epsilon: 1, admit })).rejects.toThrow(RangeError);
    await expect(runRiskEval({ epsilon: -0.5, admit })).rejects.toThrow(RangeError);
  });
});

// ===========================================================================
// formatRiskEvalReport — terminal output, not HTML
// ===========================================================================

describe("formatRiskEvalReport", () => {
  it("renders aligned ASCII text with epsilon, the measured rate, PASS/FAIL, and a provenance block naming solvers as scripted (not model calls) -- no HTML", async () => {
    const { admit } = buildCalibratedGate(EVAL_TASKS, 0.1);
    const report = await runRiskEval({ epsilon: 0.1, admit, now: FIXED_NOW });
    const text = formatRiskEvalReport(report);

    expect(text).not.toMatch(/<[a-zA-Z][^>]*>/); // no HTML tags
    expect(text).toMatch(/epsilon/i);
    expect(text).toMatch(/0\.1000/);
    expect(text).toMatch(/RESULT: PASS/);
    expect(text).toMatch(/NOT model calls/);
    expect(text).toMatch(/PROVENANCE/);
    expect(text).toMatch(/PER-CATEGORY/);
    expect(text).toMatch(/PER-SOLVER/);
  });

  it("FAIL report names the reason(s): exceeded epsilon and/or certificate failures", async () => {
    const { admit } = makeAcceptEverythingAdmit(0.01, 6);
    const report = await runRiskEval({ epsilon: 0.01, admit, now: FIXED_NOW });
    const text = formatRiskEvalReport(report);
    expect(text).toMatch(/RESULT: FAIL/);
    expect(text).toMatch(/exceeds epsilon/);
  });
});
