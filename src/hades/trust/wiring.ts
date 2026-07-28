/**
 * Central wiring for the unified trust gate.
 *
 * `registry.ts` / `action-adapters.ts` / `emission-adapters.ts` /
 * `unified-gate.ts` / `budget.ts` / `risk-eval.ts` are deliberately
 * dependency-light building blocks: none of them opens a file, mints a key,
 * or decides where anything lives. This module is the ONE place that
 * assembles them into the concrete stack every SURFACE uses — the
 * `hades trust` CLI, the desktop `trust.*` sidecar lane, and anything added
 * later — so all of them select from the SAME verifier set, sign with the
 * SAME certificate identity, spend from the SAME hash-chained budget, and
 * read the SAME persisted per-domain conformal calibration. Without this,
 * "one unified trust gate" would be a coincidence rather than a guarantee.
 *
 * ## What is REAL here (read before trusting a number this produces)
 *
 *  - The verifier set is the real one: every entry of `actionVerifiers()`
 *    (the ten shipped `toolVerifiers()` adapters + the real
 *    `ProvenanceLedger` chain check) and every entry of
 *    `emissionVerifiers()` (the real `verifyMemoryWrite`, the real
 *    `auditUserModel`, and the two new certificate-binding / procedure
 *    verifiers). Nothing is mocked and nothing is enumerated by hand.
 *  - Certificates are signed by a real `CertificateAuthority` over a real
 *    ed25519 key (see {@link resolveTrustSigningKey}).
 *  - Calibration points are REAL (score, correct) observations, never
 *    synthesized: either recorded from graded production admissions via
 *    {@link TrustCalibrationStore.record}, or produced by
 *    {@link collectEvalCalibration}, which fuses genuine verifier votes over
 *    the real `EVAL_TASKS` corpus and labels every point with that task's
 *    OWN ground-truth `grade()`.
 *  - A domain with no stored calibration stays UNCALIBRATED and the gate
 *    abstains on it. There is no default threshold, no "assume 0.5", and no
 *    seeded fake calibration set anywhere in this module. An honest
 *    "cannot certify" is the designed outcome, not a failure to wire.
 *
 * ## Honest note on what calibration can and cannot buy
 *
 * Split-conformal calibration converts a verifier's score distribution into
 * a threshold with a distribution-free `P(wrong | emitted) <= epsilon`
 * guarantee. It cannot manufacture discrimination that the verifiers do not
 * have. If the registered verifiers for a domain are all structural
 * (integrity/self-consistency) checks — which is exactly what this build
 * ships for `procedure` — then correct and wrong outputs score alike, the
 * fitted threshold is `+Infinity`, and the gate abstains on everything in
 * that domain. That is the correct, honest result and
 * {@link summarizeDiscrimination} reports it explicitly rather than letting
 * a reader mistake an abstain-everything gate for a working one.
 *
 * @module hades/trust/wiring
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CertificateAuthority, generatePrivateKeyHex } from "../styx/certificate";
import type { CalibrationPoint, GateStats } from "../styx/gate";
import { EVAL_TASKS } from "../bench/eval-suite";
import type { EvalTask } from "../bench/vtph";

import { VerifierRegistry, type TrustDomain, type TrustSubject } from "./registry";
import { actionVerifiers } from "./action-adapters";
import { emissionVerifiers } from "./emission-adapters";
import { referenceRecomputeVerifier } from "./reference-verifier";
import { crossModelAgreementVerifier, type AgreementJudge } from "./agreement-verifier";
import { UnifiedTrustGate, type UnifiedGateConfig } from "./unified-gate";
import { TrustBudgetLedger, type TrustBudgetConfig } from "./budget";
import { evalTrustSubject, scriptedSolvers, type ScriptedSolver } from "./risk-eval";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Every trust-stack artifact lives under `<dataDir>/trust`. */
export function trustRoot(dataDir: string): string {
  return join(dataDir, "trust");
}

export const TRUST_BUDGET_FILE = "budget.json";
export const TRUST_CALIBRATION_FILE = "calibration.json";
export const TRUST_KEY_FILE = "signing-key";

/** The four domains, in the fixed order every report in this module uses. */
export const TRUST_DOMAINS: readonly TrustDomain[] = ["tool", "procedure", "memory", "message"] as const;

// ---------------------------------------------------------------------------
// Signing identity
// ---------------------------------------------------------------------------

export interface TrustKeyResolution {
  privateKeyHex: string;
  /**
   * `"env"`      — taken verbatim from `HADES_STYX_KEY`.
   * `"persisted"`— read from `<root>/signing-key` written by an earlier run.
   * `"generated"`— freshly minted this call (and persisted when `root` is set).
   * `"ephemeral"`— freshly minted and NOT persisted (in-memory stack only);
   *                certificates it signs cannot be re-verified by a later
   *                process, and every surface that uses one says so.
   */
  source: "env" | "persisted" | "generated" | "ephemeral";
  publicKeyHex: string;
}

const KEY_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * Resolve the ed25519 seed the certificate authority signs with.
 *
 * Precedence is `HADES_STYX_KEY` > `<root>/signing-key` > freshly minted.
 * A minted key is PERSISTED (0600) so that a certificate issued by
 * `hades trust admit` today still verifies against tomorrow's process — an
 * ephemeral per-process key would make every certificate this build issues
 * unverifiable the moment the process exits, which is indistinguishable
 * from not issuing one at all.
 *
 * A malformed `HADES_STYX_KEY` is a hard error, never a silent fallback to
 * a different identity: signing under an identity the operator did not ask
 * for is worse than refusing.
 */
export function resolveTrustSigningKey(opts: {
  root?: string;
  env?: Record<string, string | undefined>;
}): TrustKeyResolution {
  const env = opts.env ?? process.env;
  const fromEnv = env.HADES_STYX_KEY?.trim();
  if (fromEnv) {
    if (!KEY_HEX_RE.test(fromEnv)) {
      throw new RangeError(
        "HADES_STYX_KEY must be a 64-character hex ed25519 seed; refusing to sign under a different identity.",
      );
    }
    return { privateKeyHex: fromEnv, source: "env", publicKeyHex: publicKeyOf(fromEnv) };
  }

  const root = opts.root;
  if (root !== undefined) {
    const keyPath = join(root, TRUST_KEY_FILE);
    if (existsSync(keyPath)) {
      let stored = "";
      try {
        stored = readFileSync(keyPath, "utf8").trim();
      } catch {
        stored = "";
      }
      if (KEY_HEX_RE.test(stored)) {
        return { privateKeyHex: stored, source: "persisted", publicKeyHex: publicKeyOf(stored) };
      }
      // An unreadable/corrupt key file is NOT silently replaced: rotating the
      // signing identity behind the operator's back would invalidate every
      // certificate already in the wild with no trace of why.
      throw new Error(
        `Trust signing key at ${keyPath} is unreadable or not a 64-char hex seed. ` +
          "Fix or remove it deliberately — it will not be rotated automatically.",
      );
    }
    const minted = generatePrivateKeyHex();
    mkdirSync(dirname(keyPath), { recursive: true });
    const tmp = `${keyPath}.tmp`;
    writeFileSync(tmp, `${minted}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, keyPath);
    return { privateKeyHex: minted, source: "generated", publicKeyHex: publicKeyOf(minted) };
  }

  const ephemeral = generatePrivateKeyHex();
  return { privateKeyHex: ephemeral, source: "ephemeral", publicKeyHex: publicKeyOf(ephemeral) };
}

function publicKeyOf(privateKeyHex: string): string {
  return new CertificateAuthority(privateKeyHex).publicKeyHex();
}

// ---------------------------------------------------------------------------
// Calibration store
// ---------------------------------------------------------------------------

interface PersistedCalibration {
  version: 1;
  domains: Partial<Record<TrustDomain, CalibrationPoint[]>>;
  /** Free-text provenance per domain — where the points actually came from. */
  provenance: Partial<Record<TrustDomain, string>>;
}

function isTrustDomain(v: unknown): v is TrustDomain {
  return typeof v === "string" && (TRUST_DOMAINS as readonly string[]).includes(v);
}

function isCalibrationPoint(v: unknown): v is CalibrationPoint {
  if (v === null || typeof v !== "object") return false;
  const p = v as { score?: unknown; correct?: unknown };
  return typeof p.score === "number" && Number.isFinite(p.score) && typeof p.correct === "boolean";
}

/**
 * Durable per-domain conformal calibration data.
 *
 * Points are REAL labeled observations — a fused verifier score paired with
 * a ground-truth correctness label — and this class never invents one. An
 * absent or unreadable file is an EMPTY store (every domain uncalibrated,
 * gate abstains), never a defaulted one: a corrupt calibration file must
 * not be able to hand the gate a threshold nobody measured.
 */
export class TrustCalibrationStore {
  private domains: Partial<Record<TrustDomain, CalibrationPoint[]>> = {};
  private provenanceByDomain: Partial<Record<TrustDomain, string>> = {};
  /** True when a file existed but could not be parsed into the expected shape. */
  readonly loadError: string | null = null;

  constructor(private readonly path: string | null) {
    if (path === null || !existsSync(path)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      this.loadError = `unreadable calibration file: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      this.loadError = "calibration file has an unrecognized envelope (expected { version: 1, ... })";
      return;
    }
    const raw = (parsed as PersistedCalibration).domains;
    if (raw === null || typeof raw !== "object") {
      this.loadError = "calibration file has no usable `domains` object";
      return;
    }
    for (const [domain, points] of Object.entries(raw)) {
      if (!isTrustDomain(domain) || !Array.isArray(points)) continue;
      const clean = points.filter(isCalibrationPoint).map((p) => ({ score: p.score, correct: p.correct }));
      if (clean.length > 0) this.domains[domain] = clean;
    }
    const prov = (parsed as PersistedCalibration).provenance;
    if (prov !== null && typeof prov === "object") {
      for (const [domain, text] of Object.entries(prov)) {
        if (isTrustDomain(domain) && typeof text === "string") this.provenanceByDomain[domain] = text;
      }
    }
  }

  points(domain: TrustDomain): CalibrationPoint[] {
    return (this.domains[domain] ?? []).map((p) => ({ ...p }));
  }

  provenance(domain: TrustDomain): string | undefined {
    return this.provenanceByDomain[domain];
  }

  calibratedDomains(): TrustDomain[] {
    return TRUST_DOMAINS.filter((d) => (this.domains[d] ?? []).length > 0);
  }

  /** REPLACE a domain's points (a calibration fit is a snapshot, not a log). */
  record(domain: TrustDomain, points: readonly CalibrationPoint[], provenance: string): void {
    const clean = points.filter(isCalibrationPoint).map((p) => ({ score: p.score, correct: p.correct }));
    this.domains[domain] = clean;
    this.provenanceByDomain[domain] = provenance;
    this.persist();
  }

  /** APPEND observations to a domain (graded production admissions). */
  append(domain: TrustDomain, points: readonly CalibrationPoint[], provenance: string): void {
    const clean = points.filter(isCalibrationPoint).map((p) => ({ score: p.score, correct: p.correct }));
    if (clean.length === 0) return;
    this.domains[domain] = [...(this.domains[domain] ?? []), ...clean];
    this.provenanceByDomain[domain] = provenance;
    this.persist();
  }

  clear(domain: TrustDomain): void {
    delete this.domains[domain];
    delete this.provenanceByDomain[domain];
    this.persist();
  }

  private persist(): void {
    if (this.path === null) return;
    const payload: PersistedCalibration = {
      version: 1,
      domains: this.domains,
      provenance: this.provenanceByDomain,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

export interface TrustStackOptions {
  /** `$HADES_DATA_DIR` or `.hades` when omitted. Pass `null` for a fully in-memory stack. */
  dataDir?: string | null;
  env?: Record<string, string | undefined>;
  /** Injected clock. Defaults to `Date.now` — the ONLY ambient clock in this subsystem. */
  now?: () => number;
  /** Global default target bound on `P(wrong | emitted)`. */
  epsilon?: number;
  perDomain?: UnifiedGateConfig["perDomain"];
  /** Total risk mass spendable per budget window. */
  totalRisk?: number;
  window?: TrustBudgetConfig["window"];
  perDomainCaps?: Record<string, number>;
  /** Skip the budget entirely (the gate then has no `TrustBudgetPort`). */
  noBudget?: boolean;
  /**
   * Independent judges for the T3-agreement verifier (`message` domain).
   * Omitted, that verifier registers but reports an unmet requirement, so
   * `domainCertifiability` counts it out and the doctor reports `message` as
   * still uncertifiable — naming the keys that would enable it. Supplying two
   * or more judges makes the domain genuinely certifiable.
   */
  agreementJudges?: readonly AgreementJudge[];
}

export interface TrustStack {
  registry: VerifierRegistry;
  gate: UnifiedTrustGate;
  budget: TrustBudgetLedger | null;
  issuer: CertificateAuthority;
  calibration: TrustCalibrationStore;
  key: TrustKeyResolution;
  /** `<dataDir>/trust`, or `null` for an in-memory stack. */
  root: string | null;
  epsilon: number;
  /** Domains whose stored calibration was successfully applied to the gate. */
  calibratedDomains: TrustDomain[];
  /** Per-domain reason a stored calibration set could NOT be applied. */
  calibrationErrors: Partial<Record<TrustDomain, string>>;
}

export const DEFAULT_TRUST_EPSILON = 0.05;
/**
 * Default risk mass per session window. `risk = 1 - P(correct) <= epsilon`
 * per admission, so at the default epsilon this permits on the order of
 * `1.0 / 0.05 = 20` worst-case admissions per window before the budget
 * binds — a deliberately conservative starting point an operator raises
 * explicitly rather than a number tuned to make demos look good.
 */
export const DEFAULT_TRUST_TOTAL_RISK = 1.0;

/**
 * Assemble the real stack: every shipped verifier registered, a real CA over
 * a durable key, the durable hash-chained budget, and a `UnifiedTrustGate`
 * with every stored per-domain calibration applied.
 *
 * Calibration application is fail-soft PER DOMAIN and never silent: a domain
 * whose stored point set is too small for `ConformalGate`'s minimum simply
 * stays uncalibrated (the gate abstains on it) and the reason lands in
 * {@link TrustStack.calibrationErrors} for the surfaces to print.
 */
export function openTrustStack(opts: TrustStackOptions = {}): TrustStack {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir === undefined ? (env.HADES_DATA_DIR ?? ".hades") : opts.dataDir;
  const root = dataDir === null ? null : trustRoot(dataDir);
  const now = opts.now ?? ((): number => Date.now());
  const epsilon = opts.epsilon ?? DEFAULT_TRUST_EPSILON;

  const registry = new VerifierRegistry();
  registry.registerAll(actionVerifiers());
  registry.registerAll(emissionVerifiers());
  // The first verifier above T4. Registered under "procedure" for two
  // reasons: procedural runs are where machine-checkable reference specs
  // actually appear, and that domain previously had a single voter, so every
  // single-subject admit() was "degraded-evidence" and it could never certify
  // at all (`hades trust doctor` failed it). It abstains on any subject whose
  // request carries no SPEC: reference, so adding it can only ever ADD
  // information to a fused verdict — never dilute one.
  registry.register(referenceRecomputeVerifier("procedure"));
  // T3-agreement for `message` — the remaining lone-voter domain, and the one
  // where nothing can be recomputed (there is no ground truth for an outbound
  // message, only whether it follows from the request). It is CONDITIONAL:
  // with no judges configured it reports an unmet requirement through
  // `requiresConfig()`, so `domainCertifiability` counts it out and the doctor
  // says the domain still cannot certify, naming the keys that would fix it.
  // `opts.agreementJudges` lets callers (and tests) supply real judges.
  registry.register(
    crossModelAgreementVerifier({
      domain: "message",
      ...(opts.agreementJudges ? { judges: opts.agreementJudges } : {}),
    }),
  );

  const key = resolveTrustSigningKey({ root: root ?? undefined, env });
  const issuer = new CertificateAuthority(key.privateKeyHex);

  const budget = opts.noBudget
    ? null
    : TrustBudgetLedger.open({
        totalRisk: opts.totalRisk ?? DEFAULT_TRUST_TOTAL_RISK,
        window: opts.window ?? { kind: "session" },
        perDomainCaps: opts.perDomainCaps,
        path: root === null ? undefined : join(root, TRUST_BUDGET_FILE),
        now,
      });

  const gate = new UnifiedTrustGate({
    epsilon,
    perDomain: opts.perDomain,
    issuer,
    registry,
    now,
    budget: budget ?? undefined,
  });

  const calibration = new TrustCalibrationStore(root === null ? null : join(root, TRUST_CALIBRATION_FILE));
  const calibratedDomains: TrustDomain[] = [];
  const calibrationErrors: Partial<Record<TrustDomain, string>> = {};
  for (const domain of TRUST_DOMAINS) {
    const points = calibration.points(domain);
    if (points.length === 0) continue;
    try {
      gate.calibrate(domain, points);
      calibratedDomains.push(domain);
    } catch (err) {
      calibrationErrors[domain] = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    registry,
    gate,
    budget,
    issuer,
    calibration,
    key,
    root,
    epsilon,
    calibratedDomains,
    calibrationErrors,
  };
}

// ---------------------------------------------------------------------------
// Real labeled calibration from the real eval corpus
// ---------------------------------------------------------------------------

export interface DiscriminationSummary {
  points: number;
  correct: number;
  wrong: number;
  meanScoreCorrect: number;
  meanScoreWrong: number;
  /**
   * Probability that a randomly chosen CORRECT point scores above a randomly
   * chosen WRONG one (ties counted as 0.5) — the Mann-Whitney U statistic,
   * identical to ROC AUC. `0.5` means the verifiers carry no correctness
   * signal at all for this domain; `null` when one of the two classes is
   * empty and the statistic is undefined.
   */
  auc: number | null;
  /** Plain-English verdict a surface can print verbatim. */
  verdict: string;
}

/**
 * Rank-based AUC over real labeled points. Computed, never estimated: pairs
 * are counted exactly (with ties at 0.5), so this is the true statistic for
 * the given sample, not a sampled approximation.
 */
export function summarizeDiscrimination(points: readonly CalibrationPoint[]): DiscriminationSummary {
  const correct = points.filter((p) => p.correct);
  const wrong = points.filter((p) => !p.correct);
  const mean = (xs: readonly CalibrationPoint[]): number =>
    xs.length === 0 ? 0 : xs.reduce((s, p) => s + p.score, 0) / xs.length;

  let auc: number | null = null;
  if (correct.length > 0 && wrong.length > 0) {
    let wins = 0;
    for (const c of correct) {
      for (const w of wrong) {
        if (c.score > w.score) wins += 1;
        else if (c.score === w.score) wins += 0.5;
      }
    }
    auc = wins / (correct.length * wrong.length);
  }

  let verdict: string;
  if (auc === null) {
    verdict =
      correct.length === 0
        ? "no CORRECT observations — a threshold fitted here cannot be trusted to admit anything"
        : "no WRONG observations — nothing to separate against; the bound is untested";
  } else if (auc >= 0.9) verdict = "strong separation";
  else if (auc >= 0.7) verdict = "usable separation";
  else if (auc > 0.55) verdict = "weak separation";
  else
    verdict =
      "NO discrimination — the registered verifiers score correct and wrong alike, so a conformal " +
      "fit at a tight epsilon will (correctly) abstain on everything in this domain";

  return {
    points: points.length,
    correct: correct.length,
    wrong: wrong.length,
    meanScoreCorrect: mean(correct),
    meanScoreWrong: mean(wrong),
    auc,
    verdict,
  };
}

export interface EvalCalibrationResult {
  domain: TrustDomain;
  points: CalibrationPoint[];
  discrimination: DiscriminationSummary;
  provenance: string;
  /** Tasks whose scripted solver could not answer them (never silently dropped as "correct"). */
  solverErrors: { taskId: string; solverId: string; message: string }[];
}

/**
 * Build the `procedure`-domain `TrustSubject` for one scripted solver's
 * answer to one real eval task.
 *
 * This is a thin, type-narrowing wrapper over {@link evalTrustSubject} — THE
 * single eval-subject builder, which `runRiskEval` (the ADMISSION path) also
 * calls. That sharing is the whole point and is asserted by a test: a
 * calibration subject and the admission subject for the same (task, solver)
 * must be identical, because split-conformal's ε bound only holds when the
 * two are exchangeable draws.
 *
 * ## What is deliberately NOT here (this used to be a defect)
 *
 * This function previously synthesized three evidence fields the solver never
 * produced — `declaredSteps` (derived from the trace it was about to be
 * checked against), `toolStepNames: []` and `stepProvenance: []` — plus a
 * terminating `answer` step whose detail was set equal to `output`. That made
 * `verify.procedure-run` (`./emission-adapters.ts`) vote on every calibration
 * subject and pass every one of them BY CONSTRUCTION: its phantom-step,
 * step-count, step-order and claimed-output checks were all comparing the
 * trace against a manifest built from that same trace. A verifier that cannot
 * fail carries no information, but its constant PASS still moved the fused
 * score — it pinned every task the T1-reference verifier could not decide at
 * the maximum score whether the answer was right or wrong, which is exactly
 * what made a finite conformal threshold unreachable.
 *
 * And it voted only here: `runRiskEval` and `./swarm-bridge.ts` never set
 * `declaredSteps`, so at admission time that verifier abstains. Calibrating on
 * a voter that does not vote in production is a calibration/deployment
 * distribution shift introduced by the harness itself — the precise condition
 * `../styx/gate.ts` documents as breaking the bound.
 *
 * The evidence is now the solver's own, verbatim. A solver that declares no
 * step manifest yields a subject with none, and `verify.procedure-run`
 * abstains with its documented `DECLARED_STEPS_MISSING_OR_INVALID` reason —
 * the same honest outcome `./swarm-bridge.ts` already chose for real swarm
 * results.
 */
export function evalCalibrationSubject(
  task: EvalTask,
  solver: ScriptedSolver,
  produced: { output: string; evidence: Record<string, unknown>; trace: { seq: number; kind: string; detail: string }[] },
): TrustSubject {
  const built = evalTrustSubject(task, solver, produced);
  // `RiskEvalSubject` is a structural MIRROR of `TrustSubject` (risk-eval.ts
  // declares it rather than importing it, to stay dependency-light), so its
  // `domain` is a plain `string`. Re-check the literal instead of casting
  // blindly: a builder that ever returned another domain must fail loudly
  // here rather than be laundered into a `TrustSubject` by a cast.
  if (built.domain !== "procedure") {
    throw new Error(
      `evalCalibrationSubject: expected a "procedure" subject from evalTrustSubject, got ${JSON.stringify(built.domain)}`,
    );
  }
  return { ...built, domain: "procedure" };
}

/**
 * Produce REAL labeled calibration points for the `procedure` domain by
 * fusing genuine verifier votes over the real `EVAL_TASKS` corpus and
 * labeling each point with that task's OWN ground-truth `grade()`.
 *
 * Nothing here is synthesized: the score is whatever
 * `VerifierRegistry.verifyBatch` actually computed from the registered
 * verifiers, and the label is whatever the shipped grader actually returned.
 * The four `scriptedSolvers()` (faithful / lossy / fabricating / refusing)
 * supply the spread of right and wrong answers a conformal fit needs — they
 * are deterministic in-process string transforms, NOT model calls, and the
 * returned `provenance` string says so verbatim.
 *
 * The result carries a {@link DiscriminationSummary} precisely so a caller
 * cannot mistake "we fitted a threshold" for "the threshold means
 * something".
 *
 * ## Who actually votes here (measured, not assumed)
 *
 * Subjects come from {@link evalCalibrationSubject}, i.e. from the SAME
 * builder the admission path uses, so the voter set here is the voter set
 * there. For this build that means exactly one verifier can decide anything:
 * `verify.reference-recompute` (T1), on the corpus tasks whose request
 * carries a machine-checkable reference. `verify.procedure-run` abstains on
 * every one of these subjects because the scripted solvers declare no step
 * manifest — so a task with no reference produces a point with NO
 * contributing vote and the neutral 0.5 score the registry documents for
 * that case, which is the honest encoding of "nothing here decided this".
 */
export async function collectEvalCalibration(opts: {
  registry: VerifierRegistry;
  tasks?: readonly EvalTask[];
  solvers?: readonly ScriptedSolver[];
}): Promise<EvalCalibrationResult> {
  const tasks = opts.tasks ?? EVAL_TASKS;
  const solvers = opts.solvers ?? scriptedSolvers();

  const subjects: TrustSubject[] = [];
  const labels: boolean[] = [];
  const solverErrors: EvalCalibrationResult["solverErrors"] = [];

  for (const solver of solvers) {
    for (const task of tasks) {
      let produced: { output: string; evidence: Record<string, unknown>; trace: { seq: number; kind: string; detail: string }[] };
      try {
        produced = solver.answer(task);
      } catch (err) {
        solverErrors.push({
          taskId: task.id,
          solverId: solver.id,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      let correct: boolean;
      try {
        correct = task.grade(produced.output);
      } catch {
        // A throwing grader can never yield a labeled point: an unlabeled
        // observation is dropped, never defaulted to "correct".
        solverErrors.push({ taskId: task.id, solverId: solver.id, message: "grader threw" });
        continue;
      }
      subjects.push(evalCalibrationSubject(task, solver, produced));
      labels.push(correct);
    }
  }

  const fused = await opts.registry.verifyBatch(subjects);
  const points: CalibrationPoint[] = fused.map((f, i) => ({ score: f.score, correct: labels[i] }));

  return {
    domain: "procedure",
    points,
    discrimination: summarizeDiscrimination(points),
    provenance:
      `real EVAL_TASKS corpus (${tasks.length} tasks) x ${solvers.length} scripted solvers ` +
      `[${solvers.map((s) => s.label).join(", ")}]; scores from VerifierRegistry.verifyBatch over the ` +
      "registered verifiers, labels from each EvalTask's own ground-truth grade(). Solvers are " +
      "deterministic in-process string/regex/arithmetic transforms — NOT model calls, no network I/O.",
    solverErrors,
  };
}

// ---------------------------------------------------------------------------
// Gate stats helper
// ---------------------------------------------------------------------------

/** Per-domain calibration status a surface can render without touching internals. */
export interface TrustDomainStatus {
  domain: TrustDomain;
  calibrated: boolean;
  points: number;
  stats: GateStats | null;
  /** True when the calibration was applied at `openTrustStack` time (as
   *  opposed to a `gate.calibrate()` call made later in this process). */
  calibratedAtOpen: boolean;
  provenance?: string;
  error?: string;
}

/**
 * `calibrated` is read from the GATE, never from `TrustStack.calibratedDomains`.
 * That field is a snapshot taken at open time; a `hades trust calibrate` run
 * later in the same process fits the live gate without changing it, so
 * trusting the snapshot would make `status` report a domain as uncalibrated
 * while the gate was already admitting on it — two different answers to the
 * same question. The gate holds the truth: `stats()` returns an entry for a
 * domain if and only if that domain has been calibrated.
 */
/**
 * Whether a domain can EVER produce a non-degraded single-subject verdict.
 *
 * `VerifierRegistry.verify()` marks any subject with exactly one contributing
 * verifier `degradedReason: "single-verifier"`, and `UnifiedTrustGate` turns
 * that into an unconditional `"degraded-evidence"` abstention — a lone
 * voter's opinion never signs a certificate, however it scores. So a domain
 * with fewer than two registered verifiers is STRUCTURALLY unable to certify
 * anything through `admit()`, no matter how it is calibrated. That is a real
 * property of what this build ships, and surfaces must report it rather than
 * let an operator calibrate a domain that can never accept.
 *
 * The `tool` caveat is genuine and not a rounding of the truth: eleven tool
 * verifiers are registered, but each `toolCallVerifiers()` adapter only
 * claims subjects whose `subjectId` is its OWN tool name. A given tool call
 * therefore draws exactly one of them, and only reaches two contributing
 * voters when the subject also carries `evidence.ledgerJSON` for
 * `verify.exec-provenance`. This function reports the registered count and
 * that caveat; it does not pretend to predict per-subject selection.
 */
export interface DomainCertifiability {
  domain: TrustDomain;
  registered: number;
  /**
   * Verifiers that can actually vote in THIS environment — `registered`
   * minus any whose `requiresConfig()` reports an unmet requirement. This is
   * the number that decides `canEverCertify`, because a registered-but-inert
   * verifier cannot co-vote on anything.
   */
  effective: number;
  /** False when fewer than two EFFECTIVE verifiers exist — `admit()` can never accept. */
  canEverCertify: boolean;
  detail: string;
}

export function domainCertifiability(stack: TrustStack): DomainCertifiability[] {
  return TRUST_DOMAINS.map((domain) => {
    const verifiers = stack.registry.list(domain);
    const registered = verifiers.length;
    // Count only verifiers that are operational right now. A verifier that
    // needs a provider key is registered but silent without one; counting it
    // would make this domain look certifiable when nothing can be certified.
    const unmet = verifiers
      .map((v) => ({ id: v.id, reason: v.requiresConfig?.() }))
      .filter((x): x is { id: string; reason: string } => typeof x.reason === "string");
    const effective = registered - unmet.length;
    const canEverCertify = effective >= 2;
    let detail: string;
    if (!canEverCertify && unmet.length > 0) {
      detail =
        `${registered} registered but only ${effective} can vote here — ` +
        unmet.map((u) => `${u.id}: ${u.reason}`).join("; ");
    } else if (!canEverCertify) {
      detail =
        `only ${registered} verifier(s) registered — every single-subject admit() is ` +
        `"degraded-evidence" (a lone voter can never certify), so this domain cannot accept at all`;
    } else if (domain === "tool") {
      detail =
        `${registered} registered, but each tool adapter claims only its own tool name — a subject ` +
        "reaches two contributing voters only when it also carries evidence.ledgerJSON";
    } else if (domain === "procedure") {
      // The same honesty the `tool` branch above applies, for the same
      // reason, and it is not a hypothetical: `verify.procedure-run` claims
      // EVERY procedure subject via appliesTo but abstains inside verify()
      // unless `evidence.declaredSteps` is present, and neither the eval
      // harness nor `./swarm-bridge.ts` declares a step manifest (both
      // deliberately — synthesizing one manufactures a signal nobody
      // produced). So on the subjects this build actually produces, the
      // T1-reference verifier votes alone, every admit() is
      // "degraded-evidence", and the domain certifies nothing however it is
      // calibrated. Reporting a flat "2 verifiers can co-vote" would hide
      // that.
      detail =
        `${effective} eligible, but they co-vote only on a subject that DECLARES A STEP MANIFEST — ` +
        "verify.procedure-run abstains without evidence.declaredSteps, and the eval and swarm paths " +
        "deliberately declare none, so in practice T1-reference votes alone and admit() reports " +
        "degraded-evidence";
    } else {
      detail = `${effective} verifiers can co-vote on one subject`;
    }
    return { domain, registered, effective, canEverCertify, detail };
  });
}

export function trustDomainStatuses(stack: TrustStack): TrustDomainStatus[] {
  const stats = stack.gate.stats();
  return TRUST_DOMAINS.map((domain) => ({
    domain,
    calibrated: stats[domain] !== undefined,
    points: stack.calibration.points(domain).length,
    stats: stats[domain] ?? null,
    calibratedAtOpen: stack.calibratedDomains.includes(domain),
    provenance: stack.calibration.provenance(domain),
    error: stack.calibrationErrors[domain],
  }));
}
