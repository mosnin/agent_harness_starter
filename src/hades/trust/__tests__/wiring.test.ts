/**
 * Central-wiring tests for the unified trust gate.
 *
 * Everything here runs the REAL stack against REAL temp directories: real
 * ed25519 key files, the real hash-chained budget ledger, the real
 * `ConformalGate`, the real verifier registry over every shipped verifier,
 * and the real `EVAL_TASKS` corpus with its own ground-truth graders. The
 * only injected thing is the clock.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openTrustStack,
  resolveTrustSigningKey,
  TrustCalibrationStore,
  collectEvalCalibration,
  summarizeDiscrimination,
  trustDomainStatuses,
  domainCertifiability,
  trustRoot,
  evalCalibrationSubject,
  TRUST_DOMAINS,
  TRUST_KEY_FILE,
  TRUST_BUDGET_FILE,
  TRUST_CALIBRATION_FILE,
} from "../wiring";
import { scriptedSolvers } from "../risk-eval";
import { EVAL_TASKS } from "../../bench/eval-suite";
import { verifyCertificate, certifiesOutput } from "../../styx/certificate";
import type { TrustSubject } from "../registry";
import type { CalibrationPoint } from "../../styx/gate";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hades-trust-wiring-"));
}

/** A deliberately EMPTY environment: these tests must never pick up a real
 *  `HADES_STYX_KEY` or `HADES_DATA_DIR` from the machine running them. */
const noEnv = {} as NodeJS.ProcessEnv;

/**
 * A real `memory` subject carrying the evidence BOTH shipped memory
 * verifiers claim: `existingRecords` (for the real `verifyMemoryWrite`) and
 * a `model` with `.all()` (for the real `auditUserModel`). This is the only
 * domain in this build where two real verifiers co-vote on one subject —
 * see the "single-verifier" test below for why that matters.
 */
function memorySubject(id: string, output: string): TrustSubject {
  return {
    domain: "memory",
    subjectId: id,
    taskId: id,
    input: "remember this",
    output,
    evidence: { existingRecords: [], model: { all: (): unknown[] => [] } },
    trace: [{ seq: 1, kind: "write", detail: output }],
  };
}

/** A subject that the real `procedureRunVerifier` structurally accepts. */
function procedureSubject(id: string, output: string): TrustSubject {
  return {
    domain: "procedure",
    subjectId: id,
    taskId: id,
    input: "do the thing",
    output,
    evidence: { declaredSteps: ["answer"], toolStepNames: [], stepProvenance: [] },
    trace: [{ seq: 1, kind: "answer", detail: output }],
  };
}

describe("resolveTrustSigningKey", () => {
  it("mints and PERSISTS a key at 0600 so later processes can re-verify certificates", () => {
    const root = join(tempDir(), "trust");
    const first = resolveTrustSigningKey({ root, env: noEnv });
    expect(first.source).toBe("generated");
    expect(first.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);

    const keyPath = join(root, TRUST_KEY_FILE);
    expect(existsSync(keyPath)).toBe(true);
    // 0600: the seed is signing material, not a config value.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // A SECOND resolution over the same root must return the SAME identity —
    // this is the whole reason the key is persisted.
    const second = resolveTrustSigningKey({ root, env: noEnv });
    expect(second.source).toBe("persisted");
    expect(second.privateKeyHex).toBe(first.privateKeyHex);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
  });

  it("honors HADES_STYX_KEY over a persisted key, and never falls back on a malformed one", () => {
    const root = join(tempDir(), "trust");
    const minted = resolveTrustSigningKey({ root, env: noEnv });
    const explicit = "ab".repeat(32);

    const fromEnv = resolveTrustSigningKey({ root, env: { HADES_STYX_KEY: explicit } as unknown as NodeJS.ProcessEnv });
    expect(fromEnv.source).toBe("env");
    expect(fromEnv.privateKeyHex).toBe(explicit);
    expect(fromEnv.privateKeyHex).not.toBe(minted.privateKeyHex);

    // A malformed env key is a hard error: silently signing under a DIFFERENT
    // identity than the operator asked for is worse than refusing.
    expect(() => resolveTrustSigningKey({ root, env: { HADES_STYX_KEY: "nope" } as unknown as NodeJS.ProcessEnv })).toThrow(RangeError);
  });

  it("refuses to silently rotate a corrupt persisted key", () => {
    const root = join(tempDir(), "trust");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, TRUST_KEY_FILE), "not-a-key\n", "utf8");
    expect(() => resolveTrustSigningKey({ root, env: noEnv })).toThrow(/unreadable or not a 64-char hex seed/);
  });

  it("reports an in-memory stack's key as ephemeral rather than pretending it is durable", () => {
    const res = resolveTrustSigningKey({ env: noEnv });
    expect(res.source).toBe("ephemeral");
    expect(res.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("TrustCalibrationStore", () => {
  it("round-trips real points and provenance through a real file", () => {
    const path = join(tempDir(), "trust", TRUST_CALIBRATION_FILE);
    const store = new TrustCalibrationStore(path);
    expect(store.calibratedDomains()).toEqual([]);

    const points: CalibrationPoint[] = [
      { score: 0.9, correct: true },
      { score: 0.1, correct: false },
    ];
    store.record("memory", points, "unit-test observations");

    const reopened = new TrustCalibrationStore(path);
    expect(reopened.points("memory")).toEqual(points);
    expect(reopened.provenance("memory")).toBe("unit-test observations");
    expect(reopened.calibratedDomains()).toEqual(["memory"]);
    expect(reopened.loadError).toBeNull();
  });

  it("append accumulates; record REPLACES (a fit is a snapshot, not a log)", () => {
    const path = join(tempDir(), "trust", TRUST_CALIBRATION_FILE);
    const store = new TrustCalibrationStore(path);
    store.append("tool", [{ score: 0.5, correct: true }], "a");
    store.append("tool", [{ score: 0.6, correct: false }], "b");
    expect(store.points("tool")).toHaveLength(2);
    store.record("tool", [{ score: 0.7, correct: true }], "c");
    expect(store.points("tool")).toEqual([{ score: 0.7, correct: true }]);
  });

  it("treats an unreadable file as EMPTY (never defaulted) and says why", () => {
    const dir = tempDir();
    const path = join(dir, "calibration.json");
    writeFileSync(path, "{ not json", "utf8");
    const store = new TrustCalibrationStore(path);
    expect(store.loadError).toMatch(/unreadable calibration file/);
    for (const d of TRUST_DOMAINS) expect(store.points(d)).toEqual([]);
  });

  it("rejects an unrecognized envelope rather than reading points out of it", () => {
    const dir = tempDir();
    const path = join(dir, "calibration.json");
    writeFileSync(path, JSON.stringify({ version: 99, domains: { tool: [{ score: 1, correct: true }] } }), "utf8");
    const store = new TrustCalibrationStore(path);
    expect(store.loadError).toMatch(/unrecognized envelope/);
    expect(store.points("tool")).toEqual([]);
  });

  it("drops malformed points instead of admitting a NaN/non-boolean into a conformal fit", () => {
    const dir = tempDir();
    const path = join(dir, "calibration.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        domains: {
          tool: [
            { score: 0.5, correct: true },
            { score: Number.NaN, correct: true },
            { score: 0.4, correct: "yes" },
            { score: 0.3, correct: false },
          ],
        },
        provenance: {},
      }),
      "utf8",
    );
    const store = new TrustCalibrationStore(path);
    // NaN JSON-serializes to null, so both bad rows are dropped by the guard.
    expect(store.points("tool")).toEqual([
      { score: 0.5, correct: true },
      { score: 0.3, correct: false },
    ]);
  });
});

describe("summarizeDiscrimination", () => {
  it("computes exact rank AUC, counting ties at 0.5", () => {
    // Perfect separation.
    expect(
      summarizeDiscrimination([
        { score: 1, correct: true },
        { score: 0, correct: false },
      ]).auc,
    ).toBe(1);
    // Perfectly inverted.
    expect(
      summarizeDiscrimination([
        { score: 0, correct: true },
        { score: 1, correct: false },
      ]).auc,
    ).toBe(0);
    // All ties -> exactly chance, and flagged as NO discrimination.
    const tied = summarizeDiscrimination([
      { score: 0.7, correct: true },
      { score: 0.7, correct: false },
      { score: 0.7, correct: false },
    ]);
    expect(tied.auc).toBe(0.5);
    expect(tied.verdict).toMatch(/NO discrimination/);
    // One class empty -> undefined, never silently 0.5.
    expect(summarizeDiscrimination([{ score: 0.9, correct: true }]).auc).toBeNull();
  });

  it("reports means from the real sample, not a smoothed estimate", () => {
    const s = summarizeDiscrimination([
      { score: 1, correct: true },
      { score: 0.5, correct: true },
      { score: 0.2, correct: false },
    ]);
    expect(s.meanScoreCorrect).toBeCloseTo(0.75, 12);
    expect(s.meanScoreWrong).toBeCloseTo(0.2, 12);
    expect(s.points).toBe(3);
    expect(s.correct).toBe(2);
    expect(s.wrong).toBe(1);
  });
});

describe("openTrustStack", () => {
  it("registers every shipped verifier across all four domains", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const ids = stack.registry.list().map((v) => v.id);
    // The real adapters, not a hand-written list: every tool verifier plus
    // the exec-provenance check plus the four emission verifiers.
    expect(ids).toContain("verify.shell");
    expect(ids).toContain("verify.browser");
    expect(ids).toContain("verify.exec-provenance");
    expect(ids).toContain("verify.memory-write");
    expect(ids).toContain("verify.user-model");
    expect(ids).toContain("verify.outbound-message");
    expect(ids).toContain("verify.procedure-run");
    for (const domain of TRUST_DOMAINS) {
      expect(stack.registry.list(domain).length).toBeGreaterThan(0);
    }
  });

  it("starts with EVERY domain uncalibrated — no seeded threshold anywhere", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    expect(stack.calibratedDomains).toEqual([]);
    for (const s of trustDomainStatuses(stack)) {
      expect(s.calibrated).toBe(false);
      expect(s.stats).toBeNull();
    }
    // And an admit before calibration abstains rather than throwing OR admitting.
    const admission = await stack.gate.admit(procedureSubject("p1", "hello"));
    expect(admission.accepted).toBe(false);
    expect(admission.abstention?.code).toBe("uncalibrated");
    expect(admission.certificate).toBeUndefined();
  });

  it("puts every artifact under <dataDir>/trust and reuses it across opens", () => {
    const dataDir = tempDir();
    const first = openTrustStack({ dataDir, env: noEnv, now: () => 0 });
    expect(first.root).toBe(trustRoot(dataDir));
    expect(existsSync(join(trustRoot(dataDir), TRUST_KEY_FILE))).toBe(true);

    first.calibration.record("memory", [{ score: 0.9, correct: true }], "test");
    expect(existsSync(join(trustRoot(dataDir), TRUST_CALIBRATION_FILE))).toBe(true);

    const second = openTrustStack({ dataDir, env: noEnv, now: () => 0 });
    expect(second.key.publicKeyHex).toBe(first.key.publicKeyHex);
    expect(second.calibration.points("memory")).toEqual([{ score: 0.9, correct: true }]);
  });

  it("keeps a stored calibration set the real ConformalGate refuses OUT of the gate, with the reason", () => {
    const dataDir = tempDir();
    const seed = openTrustStack({ dataDir, env: noEnv, now: () => 0 });
    // 3 points is far under ConformalGate's minimum of 20.
    seed.calibration.record(
      "memory",
      [
        { score: 0.9, correct: true },
        { score: 0.5, correct: false },
        { score: 0.2, correct: false },
      ],
      "too small on purpose",
    );

    const reopened = openTrustStack({ dataDir, env: noEnv, now: () => 0 });
    expect(reopened.calibratedDomains).not.toContain("memory");
    expect(reopened.calibrationErrors.memory).toMatch(/at least 20 calibration points/);
    // Uncalibrated in the GATE, even though points exist on disk.
    const status = trustDomainStatuses(reopened).find((s) => s.domain === "memory");
    expect(status?.calibrated).toBe(false);
    expect(status?.points).toBe(3);
  });

  it("trustDomainStatuses reads calibration from the GATE, not a stale open-time snapshot", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    expect(trustDomainStatuses(stack).find((s) => s.domain === "memory")?.calibrated).toBe(false);

    const points: CalibrationPoint[] = Array.from({ length: 40 }, (_, i) => ({
      score: i / 40,
      correct: i >= 20,
    }));
    stack.gate.calibrate("memory", points);

    const after = trustDomainStatuses(stack).find((s) => s.domain === "memory");
    expect(after?.calibrated).toBe(true);
    // The open-time snapshot is still false — proving the two are distinct
    // and that `calibrated` follows the live gate.
    expect(after?.calibratedAtOpen).toBe(false);
    expect(stack.calibratedDomains).not.toContain("memory");
  });

  it("shares ONE budget chain across two stacks over the same dataDir", () => {
    const dataDir = tempDir();
    const a = openTrustStack({ dataDir, env: noEnv, now: () => 1_000 });
    const b = openTrustStack({ dataDir, env: noEnv, now: () => 1_000 });

    const spend = a.budget!.spend({
      domain: "memory",
      taskId: "t-1",
      risk: 0.02,
      subjectSha256: "a".repeat(64),
      issuedAt: 1_000,
    });
    expect(spend.accepted).toBe(true);

    // The SECOND instance sees it, because every read reloads from disk.
    expect(b.budget!.report().entries).toBe(1);
    expect(b.budget!.report().spentRisk).toBeCloseTo(0.02, 12);
    expect(b.budget!.verifyChain().ok).toBe(true);
    expect(existsSync(join(trustRoot(dataDir), TRUST_BUDGET_FILE))).toBe(true);
  });

  it("noBudget builds a gate with no ledger at all", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0, noBudget: true });
    expect(stack.budget).toBeNull();
  });
});

describe("collectEvalCalibration — REAL labeled points from the REAL corpus", () => {
  it("labels every point with the task's OWN grader and reports honest separation", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const result = await collectEvalCalibration({ registry: stack.registry });

    const solvers = scriptedSolvers();
    expect(result.domain).toBe("procedure");
    // One observation per (solver, task) minus any the solver could not answer.
    expect(result.points.length + result.solverErrors.length).toBe(EVAL_TASKS.length * solvers.length);
    expect(result.points.length).toBeGreaterThan(0);

    // The labels are the REAL graders' verdicts: the faithful solver is
    // correct on the whole corpus, the refusing solver on none of it, so a
    // real mix of both labels must be present.
    expect(result.discrimination.correct).toBeGreaterThan(0);
    expect(result.discrimination.wrong).toBeGreaterThan(0);

    // Provenance must state, verbatim, that the solvers are not model calls.
    expect(result.provenance).toContain("NOT model calls");
    expect(result.provenance).toContain("ground-truth grade()");
  });

  it("independently reproduces the labels — the harness is not grading itself", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const solvers = scriptedSolvers();
    const faithful = solvers.find((s) => s.label === "faithful")!;
    const refusing = solvers.find((s) => s.label === "refusing")!;

    const result = await collectEvalCalibration({
      registry: stack.registry,
      tasks: EVAL_TASKS,
      solvers: [faithful, refusing],
    });

    // Re-derive the expected labels here, straight from the real graders.
    const expected: boolean[] = [];
    for (const solver of [faithful, refusing]) {
      for (const task of EVAL_TASKS) {
        expected.push(task.grade(solver.answer(task).output));
      }
    }
    expect(result.points.map((p) => p.correct)).toEqual(expected);
    // Sanity on the shape of that truth: faithful is right everywhere,
    // refusing is wrong everywhere.
    expect(expected.slice(0, EVAL_TASKS.length).every((c) => c)).toBe(true);
    expect(expected.slice(EVAL_TASKS.length).every((c) => !c)).toBe(true);
  });

  it("reports NO discrimination honestly when only structural verifiers are registered", async () => {
    // This build ships exactly one `procedure` verifier, and it is a
    // STRUCTURAL check (trace-vs-declared-steps + provenance hashes). It
    // cannot see whether an answer is right, so correct and wrong outputs
    // must score identically — and the summary must say so rather than
    // dressing it up.
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const result = await collectEvalCalibration({ registry: stack.registry });
    expect(result.discrimination.auc).toBe(0.5);
    expect(result.discrimination.verdict).toMatch(/NO discrimination/);

    // And the honest consequence: the conformal fit admits nothing.
    const stats = stack.gate.calibrate("procedure", result.points);
    expect(Number.isFinite(stats.threshold)).toBe(false);
    const admission = await stack.gate.admit(procedureSubject("p", "anything"));
    expect(admission.accepted).toBe(false);
    expect(admission.certificate).toBeUndefined();
    // `procedure` ships exactly ONE verifier, so the lone-voter rule fires
    // before the threshold ever gets a say. Both bars independently refuse
    // this subject; the gate reports the first one it hits.
    expect(admission.abstention?.code).toBe("degraded-evidence");
  });

  it("drops an unanswerable task as an error rather than labelling it correct", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const exploding = {
      id: "solver-explodes",
      label: "faithful" as const,
      answer(): never {
        throw new Error("cannot answer");
      },
    };
    const result = await collectEvalCalibration({
      registry: stack.registry,
      tasks: EVAL_TASKS.slice(0, 3),
      solvers: [exploding],
    });
    expect(result.points).toEqual([]);
    expect(result.solverErrors).toHaveLength(3);
    expect(result.solverErrors[0].message).toBe("cannot answer");
  });

  it("evalCalibrationSubject builds a subject the REAL procedure verifier accepts", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
    const task = EVAL_TASKS[0];
    const subject = evalCalibrationSubject(task, solver, solver.answer(task));

    expect(subject.domain).toBe("procedure");
    // The contract the procedure verifier documents: output IS the last
    // step's detail, and declaredSteps mirrors the trace's kinds in order.
    expect(subject.output).toBe(subject.trace[subject.trace.length - 1].detail);
    expect(subject.evidence.declaredSteps).toEqual(subject.trace.map((s) => s.kind));

    const fused = await stack.registry.verify(subject);
    const verdict = fused.verdicts.find((v) => v.verifierId === "verify.procedure-run");
    expect(verdict).toBeDefined();
    expect(verdict!.abstained).toBe(false);
    expect(verdict!.passed).toBe(true);
  });
});

describe("structural certifiability of what this build actually ships", () => {
  it("flags the domains that ship ONE verifier and therefore can never certify", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const byDomain = new Map(domainCertifiability(stack).map((c) => [c.domain, c]));

    // This is a real property of the shipped verifier set, asserted so a
    // future change that fixes it (or breaks it further) is caught here.
    expect(byDomain.get("procedure")!.registered).toBe(1);
    expect(byDomain.get("procedure")!.canEverCertify).toBe(false);
    expect(byDomain.get("message")!.registered).toBe(1);
    expect(byDomain.get("message")!.canEverCertify).toBe(false);
    expect(byDomain.get("memory")!.canEverCertify).toBe(true);
    // `tool` registers eleven, but each adapter claims only its own tool
    // name — the detail text must say so rather than implying eleven voters.
    expect(byDomain.get("tool")!.canEverCertify).toBe(true);
    expect(byDomain.get("tool")!.detail).toMatch(/only its own tool name/);
  });

  it("proves the consequence: a lone voter abstains no matter how it is calibrated", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0, epsilon: 0.2 });
    // A calibration that admits essentially everything.
    const points: CalibrationPoint[] = [];
    for (let i = 0; i < 40; i++) points.push({ score: 0.99, correct: true });
    stack.gate.calibrate("procedure", points);

    const fused = await stack.registry.verify(procedureSubject("p", "x"));
    expect(fused.verdicts.filter((v) => !v.abstained)).toHaveLength(1);
    expect(fused.degradedReason).toBe("single-verifier");

    const admission = await stack.gate.admit(procedureSubject("p", "x"));
    expect(admission.accepted).toBe(false);
    expect(admission.abstention?.code).toBe("degraded-evidence");
    expect(admission.certificate).toBeUndefined();
  });

  it("memory really does draw TWO co-voting real verifiers", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const subject = memorySubject("m", "the sky is blue");
    expect(stack.registry.select(subject).map((v) => v.id).sort()).toEqual([
      "verify.memory-write",
      "verify.user-model",
    ]);
    const fused = await stack.registry.verify(subject);
    expect(fused.verdicts.filter((v) => !v.abstained)).toHaveLength(2);
    expect(fused.degraded).toBe(false);
  });
});

describe("end-to-end: a calibrated domain issues a REAL, re-verifiable certificate", () => {
  it("admits, signs, charges the budget, and the certificate verifies independently", async () => {
    const dataDir = tempDir();
    const stack = openTrustStack({ dataDir, env: noEnv, now: () => 4_242, epsilon: 0.2 });

    // Real labeled points with genuine separation. These are synthetic
    // OBSERVATIONS supplied by this test (as an operator would supply real
    // graded ones via `--from`), not a fabricated threshold: the fit itself
    // is done by the real ConformalGate over them.
    const points: CalibrationPoint[] = [];
    for (let i = 0; i < 30; i++) points.push({ score: 0.9, correct: true });
    for (let i = 0; i < 30; i++) points.push({ score: 0.1, correct: false });
    const stats = stack.gate.calibrate("memory", points);
    expect(Number.isFinite(stats.threshold)).toBe(true);

    const subject = memorySubject("m-accept", "the answer");
    const admission = await stack.gate.admit(subject);

    expect(admission.accepted).toBe(true);
    // The central invariant.
    expect(admission.certificate !== undefined).toBe(admission.accepted);

    const cert = admission.certificate!;
    // Independently re-verified here, never trusted because the gate said so.
    expect(await verifyCertificate(cert)).toBe(true);
    expect(await certifiesOutput(cert, subject.output)).toBe(true);
    expect(await certifiesOutput(cert, `${subject.output} tampered`)).toBe(false);

    // The budget was really charged, and the chain really verifies.
    const report = stack.budget!.report();
    expect(report.entries).toBe(1);
    expect(report.spentRisk).toBeCloseTo(admission.spentRisk, 12);
    expect(stack.budget!.verifyChain().ok).toBe(true);

    // A SECOND process over the same dataDir re-verifies the same
    // certificate — the point of persisting the signing key.
    const reopened = openTrustStack({ dataDir, env: noEnv, now: () => 4_242 });
    expect(reopened.key.publicKeyHex).toBe(cert.publicKey);
    expect(await verifyCertificate(cert)).toBe(true);
    expect(reopened.budget!.report().entries).toBe(1);
  });

  it("REGRESSION: a perfectly-calibrated admission charges a real, non-zero risk", async () => {
    // The bug this pins: `pCorrectEstimate` is the UNCORRECTED observed rate,
    // so a calibration sample with no wrong points at/above the threshold
    // made the gate compute `risk = 1 - 1 = 0`, which TrustBudgetLedger
    // rejects outright ("must be a finite number > 0"). The best-calibrated
    // admission in the system was therefore refused as budget-exhausted, and
    // no amount of admitting could ever move the budget.
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 7, epsilon: 0.2 });
    const points: CalibrationPoint[] = [];
    for (let i = 0; i < 30; i++) points.push({ score: 0.9, correct: true });
    for (let i = 0; i < 30; i++) points.push({ score: 0.1, correct: false });
    const stats = stack.gate.calibrate("memory", points);

    const admission = await stack.gate.admit(memorySubject("m-zero", "flawless"));
    expect(admission.accepted).toBe(true);
    // Uncorrected estimate really is a perfect 1 ...
    expect(admission.pCorrect).toBe(1);
    // ... but the charge is the CONSERVATIVE (wrong+1)/(selected+1) rate the
    // conformal fit itself was accepted under: 30 selected points -> 1/31.
    const selected = Math.round(stats.calibrationSize * stats.coverageAtThreshold);
    expect(selected).toBe(30);
    expect(admission.spentRisk).toBeCloseTo(1 / 31, 12);
    expect(admission.spentRisk).toBeGreaterThan(0);
    // And it never exceeds the epsilon the conformal guarantee promises.
    expect(admission.spentRisk).toBeLessThanOrEqual(stats.epsilon);

    // The budget really moved — the whole point of charging anything.
    const report = stack.budget!.report();
    expect(report.entries).toBe(1);
    expect(report.spentRisk).toBeCloseTo(1 / 31, 12);
  });

  it("keeps charging until the budget genuinely binds, then abstains", async () => {
    // A tiny total budget so exhaustion is reached in a bounded number of
    // real admissions rather than asserted from a formula.
    const stack = openTrustStack({
      dataDir: tempDir(),
      env: noEnv,
      now: () => 11,
      epsilon: 0.2,
      totalRisk: 0.1,
    });
    const points: CalibrationPoint[] = [];
    for (let i = 0; i < 30; i++) points.push({ score: 0.9, correct: true });
    for (let i = 0; i < 30; i++) points.push({ score: 0.1, correct: false });
    stack.gate.calibrate("memory", points);

    let accepted = 0;
    let exhausted = false;
    for (let i = 0; i < 10; i++) {
      const a = await stack.gate.admit(memorySubject(`m-${i}`, `output ${i}`));
      if (a.accepted) {
        accepted += 1;
        expect(a.certificate).toBeDefined();
      } else {
        expect(a.abstention?.code).toBe("budget-exhausted");
        expect(a.certificate).toBeUndefined();
        exhausted = true;
        break;
      }
    }
    // 0.1 / (1/31) = 3.1 -> exactly three admissions fit.
    expect(accepted).toBe(3);
    expect(exhausted).toBe(true);
    expect(stack.budget!.report().entries).toBe(3);
    expect(stack.budget!.verifyChain().ok).toBe(true);
  });

  it("a tampered budget file makes the whole stack refuse to spend, never reset", async () => {
    const dataDir = tempDir();
    const stack = openTrustStack({ dataDir, env: noEnv, now: () => 1, epsilon: 0.2 });
    const points: CalibrationPoint[] = [];
    for (let i = 0; i < 30; i++) points.push({ score: 0.9, correct: true });
    for (let i = 0; i < 30; i++) points.push({ score: 0.1, correct: false });
    stack.gate.calibrate("memory", points);

    const first = await stack.gate.admit(memorySubject("m-1", "one"));
    expect(first.accepted).toBe(true);

    // Hand-edit the persisted risk value: the chain hash no longer recomputes.
    const budgetPath = join(trustRoot(dataDir), TRUST_BUDGET_FILE);
    const raw = JSON.parse(readFileSync(budgetPath, "utf8")) as {
      entries: { risk: number }[];
    };
    raw.entries[0].risk = 0.000001;
    writeFileSync(budgetPath, JSON.stringify(raw, null, 2), "utf8");

    const reopened = openTrustStack({ dataDir, env: noEnv, now: () => 2, epsilon: 0.2 });
    reopened.gate.calibrate("memory", points);
    expect(reopened.budget!.verifyChain().ok).toBe(false);
    expect(reopened.budget!.verifyChain().reason).toBe("hash_mismatch");

    // Fails SAFE: the report shows fully spent, not the understated number
    // that was written into the file.
    const report = reopened.budget!.report();
    expect(report.exhausted).toBe(true);
    expect(report.spentRisk).toBe(report.totalRisk);

    // And the gate refuses to admit anything more.
    const second = await reopened.gate.admit(memorySubject("m-2", "two"));
    expect(second.accepted).toBe(false);
    expect(second.abstention?.code).toBe("budget-exhausted");
    expect(second.certificate).toBeUndefined();
  });
});
