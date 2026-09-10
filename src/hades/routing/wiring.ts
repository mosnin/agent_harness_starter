/**
 * routing/wiring — the ONE assembly of the budget-constrained router that
 * every surface (CLI, desktop sidecar, TUI) shares.
 *
 * This is the central-integration counterpart of `../market/wiring.ts` and
 * `../trust/wiring.ts`, built the same way and on the same data root, because
 * the three subsystems are one pipeline:
 *
 *   the router CHOOSES an arm -> the trust gate ISSUES a certificate ->
 *   the market PRICES it.
 *
 * Everything durable lives under `<dataDir>/routing/`:
 *
 *   cost.json        — {@link ArmCostModel} snapshot: the MEASURED $/token and
 *                      latency history per arm. Without it, every restart
 *                      would throw away real observations and fall back to
 *                      list prices.
 *   bandit.json      — {@link BudgetedRouterBandit} snapshot, including
 *                      `spentUsd` and the PRNG stream position. Without it a
 *                      restart would silently RESET the budget, which is the
 *                      state an overspend wants to be in.
 *   calibration.json — {@link PerVerifierCalibrator} snapshot (raw
 *                      observations; fits are rebuilt by replay, never
 *                      trusted from the file).
 *   risk-points.json — the labelled {@link RiskCalibrationPoint}s the
 *                      conformal gate is fit from. `ConformalRouteRisk` has
 *                      no snapshot of its own by design: a threshold is only
 *                      meaningful next to the calibration set that produced
 *                      it, so we persist the EVIDENCE and re-derive the
 *                      threshold on every open.
 *   ledger.json      — the hash-chained {@link RoutingLedger}. A chain that
 *                      does not re-verify is REFUSED, not silently loaded.
 *
 * REAL-VS-MOCK POLICY. Every number any surface prints from this stack is
 * produced by the real modules in this directory over real state on this
 * machine: real published prices (`../models/client`'s `DEFAULT_PRICES`) and
 * real measured usage for cost, a real Thompson posterior for value, a real
 * split-conformal threshold for risk, a real SHA-256 hash chain for
 * attribution. Nothing in this file synthesizes a number. An arm the price
 * table does not know is reported `unpriced` — never as a free arm.
 *
 * Loading is fail-soft PER FILE and never silent: a corrupt or tampered
 * artifact leaves that component empty and records the reason in
 * {@link RouterStack.loadErrors} for the surfaces to print.
 *
 * Purity: `openRouter` touches the filesystem (that is its job). Every
 * routing DECISION path below takes its clock as an argument.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ModelRegistry } from "../models/registry";
import { defaultModelRegistry } from "../models/defaults";
import type { PriceEntry } from "../models/client";
import { DEFAULT_PRICES } from "../models/client";
import { TIER_ORDER, routeTier, type TaskSignals, type TierId } from "../styx/tiers";
import type { AgentRunner, AgentRunResult, EvalTask } from "../bench/vtph";

import {
  ArmCatalog,
  ArmCostModel,
  type ArmCostModelOptions,
  type ArmRequirements,
  type CostEstimate,
  type RoutingArm,
  type TaskCostContext,
} from "./arms";
import { BudgetedRouterBandit, type BanditOptions, type RoutingContext } from "./bandit";
import { PerVerifierCalibrator, type CalibratorOptions } from "./calibration";
import {
  ConformalRouteRisk,
  type RiskCalibrationPoint,
  type RouteRiskConfig,
  type RouteVerdict,
} from "./risk";
import { RoutingLedger, type ArmAttribution, type ChainCheck, type RoutingDecision } from "./ledger";
import type { RouterLike, RoutedRun } from "./route-bench";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const ROUTER_COST_FILE = "cost.json";
export const ROUTER_BANDIT_FILE = "bandit.json";
export const ROUTER_CALIBRATION_FILE = "calibration.json";
export const ROUTER_RISK_FILE = "risk-points.json";
export const ROUTER_LEDGER_FILE = "ledger.json";

/** Every routing artifact lives under `<dataDir>/routing`. */
export function routerRoot(dataDir: string): string {
  return join(dataDir, "routing");
}

// ---------------------------------------------------------------------------
// Options / stack
// ---------------------------------------------------------------------------

export interface RouterStackOptions {
  /** `$HADES_DATA_DIR` or `.hades` when omitted. Pass `null` for a fully in-memory stack. */
  dataDir?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Defaults to the real shipped `defaultModelRegistry()`. */
  registry?: ModelRegistry;
  /** Defaults to the real shipped `DEFAULT_PRICES`. */
  prices?: readonly PriceEntry[];
  /** Execution targets crossed with every model; omitted => one arm per model. */
  execTargets?: readonly string[];
  /** Hard dollar budget the bandit's Lagrangian is dual to. Default `$HADES_ROUTE_BUDGET_USD` or 10. */
  budgetUsd?: number;
  /** PRNG seed — routing decisions are reproducible from it. Default `$HADES_ROUTE_SEED` or 1. */
  seed?: number;
  /** Silent-wrong risk budget for the conformal gate. Default `$HADES_ROUTE_EPSILON` or 0.05. */
  epsilon?: number;
  bandit?: Partial<Omit<BanditOptions, "seed" | "budgetUsd">>;
  cost?: ArmCostModelOptions;
  calibrator?: CalibratorOptions;
  risk?: Partial<Omit<RouteRiskConfig, "epsilon">>;
  /** Hard eligibility policy applied before any arm is considered. */
  requirements?: ArmRequirements;
  /** Real-time availability predicate handed to the catalog. */
  available?: (arm: RoutingArm) => boolean;
}

export interface RouterStack {
  catalog: ArmCatalog;
  cost: ArmCostModel;
  bandit: BudgetedRouterBandit;
  calibrator: PerVerifierCalibrator;
  risk: ConformalRouteRisk;
  ledger: RoutingLedger;
  /** The labelled points `risk` was fit from — persisted, appended to by `recordRisk`. */
  riskPoints: RiskCalibrationPoint[];
  requirements: ArmRequirements;
  budgetUsd: number;
  seed: number;
  epsilon: number;
  /** `<dataDir>/routing`, or `null` for an in-memory stack. */
  root: string | null;
  /** True iff the persisted routing ledger re-verified from its own bytes. */
  chainOk: boolean;
  /** Per-artifact reason a persisted file could not be loaded. Empty on a clean open. */
  loadErrors: Record<string, string>;
  /** Persist the whole stack back to {@link RouterStack.root}. No-op in memory. */
  save(): void;
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const TIER_SET: ReadonlySet<string> = new Set(TIER_ORDER);

/**
 * Structural validation of a persisted risk-calibration set. A point that is
 * not exactly `{armId: string, tier: TierId, score: finite in [0,1], correct:
 * boolean}` is REJECTED (the whole file is refused), because a conformal
 * threshold silently fit over garbage is worse than no threshold at all — it
 * would accept output it has no evidence for.
 */
export function parseRiskPoints(raw: string): RiskCalibrationPoint[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("risk points file must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) throw new Error(`unsupported risk points version: ${String(obj.version)}`);
  if (!Array.isArray(obj.points)) throw new Error("risk points file must carry a `points` array");
  const out: RiskCalibrationPoint[] = [];
  for (let i = 0; i < obj.points.length; i++) {
    const p: unknown = obj.points[i];
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`points[${i}] must be an object`);
    const r = p as Record<string, unknown>;
    if (typeof r.armId !== "string" || r.armId.length === 0) throw new Error(`points[${i}].armId must be a non-empty string`);
    if (typeof r.tier !== "string" || !TIER_SET.has(r.tier)) throw new Error(`points[${i}].tier is not a known tier: ${String(r.tier)}`);
    if (typeof r.score !== "number" || !Number.isFinite(r.score) || r.score < 0 || r.score > 1) {
      throw new Error(`points[${i}].score must be a finite number in [0,1]`);
    }
    if (typeof r.correct !== "boolean") throw new Error(`points[${i}].correct must be a boolean`);
    out.push({ armId: r.armId, tier: r.tier as TierId, score: r.score, correct: r.correct });
  }
  return out;
}

/**
 * Assemble the real router stack over `<dataDir>/routing`, restoring every
 * durable artifact that is present and readable.
 */
export function openRouter(opts: RouterStackOptions = {}): RouterStack {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir === undefined ? (env.HADES_DATA_DIR ?? ".hades") : opts.dataDir;
  const root = dataDir === null ? null : routerRoot(dataDir);
  const loadErrors: Record<string, string> = {};

  const registry = opts.registry ?? defaultModelRegistry();
  const prices = opts.prices ?? DEFAULT_PRICES;
  const budgetUsd = Math.max(0, opts.budgetUsd ?? numFromEnv(env.HADES_ROUTE_BUDGET_USD, 10));
  const seed = opts.seed ?? numFromEnv(env.HADES_ROUTE_SEED, 1);
  const epsilonRaw = opts.epsilon ?? numFromEnv(env.HADES_ROUTE_EPSILON, 0.05);
  // The conformal gate refuses an epsilon outside (0,1) — clamp into a legal
  // open interval here so a bad env var degrades to a strict gate instead of
  // making the whole stack unopenable.
  const epsilon = Math.min(0.999, Math.max(1e-6, Number.isFinite(epsilonRaw) ? epsilonRaw : 0.05));

  const catalog = new ArmCatalog({
    registry,
    prices,
    execTargets: opts.execTargets,
    available: opts.available,
  });

  // ---- cost model ----------------------------------------------------------
  let cost = new ArmCostModel({ prices, ...opts.cost });
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, ROUTER_COST_FILE));
      if (raw !== null) cost = ArmCostModel.restore(JSON.parse(raw), { prices, ...opts.cost });
    } catch (err) {
      loadErrors[ROUTER_COST_FILE] = errText(err);
    }
  }

  // ---- bandit --------------------------------------------------------------
  const banditOptions: BanditOptions = { seed, budgetUsd, ...opts.bandit };
  let bandit = new BudgetedRouterBandit(banditOptions);
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, ROUTER_BANDIT_FILE));
      if (raw !== null) bandit = BudgetedRouterBandit.restore(JSON.parse(raw), banditOptions);
    } catch (err) {
      loadErrors[ROUTER_BANDIT_FILE] = errText(err);
    }
  }

  // ---- verifier calibrator -------------------------------------------------
  let calibrator = new PerVerifierCalibrator(opts.calibrator ?? {});
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, ROUTER_CALIBRATION_FILE));
      if (raw !== null) calibrator = PerVerifierCalibrator.restore(JSON.parse(raw), opts.calibrator ?? {});
    } catch (err) {
      loadErrors[ROUTER_CALIBRATION_FILE] = errText(err);
    }
  }

  // ---- conformal risk gate (fit from the persisted EVIDENCE) ---------------
  const riskPoints: RiskCalibrationPoint[] = [];
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, ROUTER_RISK_FILE));
      if (raw !== null) riskPoints.push(...parseRiskPoints(raw));
    } catch (err) {
      loadErrors[ROUTER_RISK_FILE] = errText(err);
    }
  }
  const risk = new ConformalRouteRisk({ epsilon, ...opts.risk });
  try {
    risk.calibrate(riskPoints);
  } catch (err) {
    // A point set the gate itself refuses is dropped rather than left
    // half-applied: an uncalibrated gate abstains, which is the safe state.
    loadErrors[ROUTER_RISK_FILE] = errText(err);
    riskPoints.length = 0;
    risk.calibrate([]);
  }

  // ---- routing ledger ------------------------------------------------------
  let ledger = new RoutingLedger();
  let chainOk = true;
  if (root !== null) {
    try {
      const raw = readIfPresent(join(root, ROUTER_LEDGER_FILE));
      if (raw !== null) {
        const loaded = RoutingLedger.deserialize(raw);
        const verdict = loaded.verifyChain();
        if (!verdict.ok) {
          chainOk = false;
          loadErrors[ROUTER_LEDGER_FILE] =
            `hash chain does not verify (code "${verdict.code}", first break at seq ${String(verdict.brokenAt)}) — the persisted routing ledger was REFUSED, not loaded`;
        } else {
          ledger = loaded;
        }
      }
    } catch (err) {
      chainOk = false;
      loadErrors[ROUTER_LEDGER_FILE] = errText(err);
    }
  }

  const stack: RouterStack = {
    catalog,
    cost,
    bandit,
    calibrator,
    risk,
    ledger,
    riskPoints,
    requirements: opts.requirements ?? {},
    budgetUsd,
    seed,
    epsilon,
    root,
    chainOk,
    loadErrors,
    save(): void {
      if (root === null) return;
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ROUTER_COST_FILE), JSON.stringify(stack.cost.snapshot()), { mode: 0o600 });
      writeFileSync(join(root, ROUTER_BANDIT_FILE), JSON.stringify(stack.bandit.snapshot()), { mode: 0o600 });
      writeFileSync(join(root, ROUTER_CALIBRATION_FILE), JSON.stringify(stack.calibrator.snapshot()), { mode: 0o600 });
      writeFileSync(
        join(root, ROUTER_RISK_FILE),
        JSON.stringify({ version: 1, points: stack.riskPoints }),
        { mode: 0o600 },
      );
      writeFileSync(join(root, ROUTER_LEDGER_FILE), stack.ledger.serialize(), { mode: 0o600 });
    },
  };
  return stack;
}

// ---------------------------------------------------------------------------
// Status view — the shape every surface renders from
// ---------------------------------------------------------------------------

export interface RouterArmView {
  armId: string;
  provider: string;
  modelId: string;
  execTarget: string | null;
  displayName: string;
  contextWindow: number | null;
  /** True iff this model has NO published price — never rendered as free. */
  unpriced: boolean;
  eligible: boolean;
  /** Why it was rejected, or null when eligible. */
  rejectionCode: string | null;
  rejectionDetail: string | null;
  usdMean: number;
  usdP90: number;
  latencyMsMean: number;
  costSamples: number;
  /** `measured` | `priced-prior` | `unpriced` — the provenance of the two USD figures. */
  costSource: CostEstimate["source"];
  pulls: number;
  verified: number;
  pVerifiedMean: number;
  measuredVtphPerDollar: number;
  /** The conformal accept threshold for this arm at `tier`, `Infinity` when it abstains. */
  riskThreshold: number;
  riskSource: string;
  riskCalibrationSize: number;
}

export interface RouterStatusView {
  root: string | null;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  lambda: number;
  seed: number;
  epsilon: number;
  /** The tier every risk profile in `arms` was read at (see `routerStatus`). */
  tier: TierId;
  totalArms: number;
  eligibleArms: number;
  unpricedArms: number;
  ledgerEntries: number;
  chainOk: boolean;
  chainCode: string;
  riskStrata: number;
  riskCalibrated: number;
  riskPooledFallbacks: number;
  riskAbstainingStrata: number;
  riskPoints: number;
  verifiersTracked: number;
  arms: RouterArmView[];
  loadErrors: Array<{ artifact: string; message: string }>;
}

export interface RouterStatusOptions {
  /** Token context the cost/eligibility figures are quoted at. Defaults to 2000 in / 500 out. */
  ctx?: TaskCostContext;
  /** Tier the per-arm risk profile is read at. Default `T4-consistency` (the weakest, always-available tier). */
  tier?: TierId;
  /** Wall clock for staleness blending in cost estimates. Default 0 (maximally fresh). */
  now?: number;
}

export const DEFAULT_STATUS_CTX: TaskCostContext = { promptTokens: 2000, expectedOutputTokens: 500 };

/** Build the whole status view from REAL stack state — no derived guesses. */
export function routerStatus(stack: RouterStack, opts: RouterStatusOptions = {}): RouterStatusView {
  const ctx = opts.ctx ?? DEFAULT_STATUS_CTX;
  const tier = opts.tier ?? "T4-consistency";
  const now = opts.now ?? 0;

  const eligibility = stack.catalog.eligible(stack.requirements, ctx, stack.cost);
  const eligibleIds = new Set(eligibility.arms.map((a) => a.id));
  const rejectionById = new Map(eligibility.rejected.map((r) => [r.armId, r]));

  const arms: RouterArmView[] = stack.catalog.arms().map((arm) => {
    const estimate = stack.cost.estimate(arm, ctx, now);
    const posterior = stack.bandit.posterior(arm.id);
    const profile = stack.risk.profile(arm.id, tier);
    const rejection = rejectionById.get(arm.id) ?? null;
    return {
      armId: arm.id,
      provider: arm.provider,
      modelId: arm.modelId,
      execTarget: arm.execTarget,
      displayName: arm.displayName,
      contextWindow: arm.contextWindow,
      unpriced: arm.unpriced,
      eligible: eligibleIds.has(arm.id),
      rejectionCode: rejection ? rejection.code : null,
      rejectionDetail: rejection ? rejection.detail : null,
      usdMean: estimate.usdMean,
      usdP90: estimate.usdP90,
      latencyMsMean: estimate.latencyMsMean,
      costSamples: estimate.samples,
      costSource: estimate.source,
      pulls: posterior.pulls,
      verified: posterior.verified,
      pVerifiedMean: posterior.pVerifiedMean,
      measuredVtphPerDollar: posterior.measuredVtphPerDollar,
      riskThreshold: profile.threshold,
      riskSource: profile.source,
      riskCalibrationSize: profile.calibrationSize,
    };
  });

  const chain: ChainCheck = stack.ledger.verifyChain();
  const riskStats = stack.risk.stats();

  return {
    root: stack.root,
    budgetUsd: stack.budgetUsd,
    spentUsd: stack.bandit.spentUsd(),
    remainingUsd: stack.bandit.budgetRemainingUsd(),
    lambda: stack.bandit.lambda(),
    seed: stack.seed,
    epsilon: stack.epsilon,
    tier,
    totalArms: arms.length,
    eligibleArms: eligibility.arms.length,
    unpricedArms: arms.filter((a) => a.unpriced).length,
    ledgerEntries: chain.entries,
    chainOk: stack.chainOk && chain.ok,
    chainCode: chain.code,
    riskStrata: riskStats.strata,
    riskCalibrated: riskStats.calibrated,
    riskPooledFallbacks: riskStats.pooledFallbacks,
    riskAbstainingStrata: riskStats.abstainingStrata,
    riskPoints: stack.riskPoints.length,
    verifiersTracked: stack.calibrator.report().length,
    arms,
    loadErrors: Object.entries(stack.loadErrors).map(([artifact, message]) => ({ artifact, message })),
  };
}

/** Per-arm attribution straight off the hash-chained ledger. */
export function routerAttribution(stack: RouterStack): ArmAttribution[] {
  return stack.ledger.attribution();
}

// ---------------------------------------------------------------------------
// Recording a real outcome (the write path every surface shares)
// ---------------------------------------------------------------------------

export interface RouteOutcomeRecord {
  taskId: string;
  category: string;
  armId: string;
  reason: string;
  candidates: readonly string[];
  fannedOut?: readonly string[];
  escalations?: number;
  estimatedUsd: number;
  actualUsd: number;
  wallMs: number;
  tokensIn: number;
  tokensOut: number;
  claimedVerified: boolean;
  /** Independent ground truth, or `null` when nothing graded this run. */
  graded: boolean | null;
  pCorrect: number;
  certificateId?: string | null;
  at: number;
  /** Optional verifier telemetry — feeds the per-(verifier, arm) calibrator. */
  verifierId?: string;
  verifierScore?: number;
  tier?: TierId;
  signals?: TaskSignals;
  difficulty?: number;
  decomposable?: boolean;
  promptTokens?: number;
}

/**
 * Fold ONE real, completed routing outcome into every component of the stack:
 * the measured cost model, the bandit posterior + budget, the conformal
 * gate's calibration evidence, the per-verifier calibrator and the
 * tamper-evident ledger.
 *
 * The bandit's `verified` signal is the INDEPENDENT grade when one exists and
 * only falls back to the arm's own `claimedVerified` when nothing graded the
 * run — an arm never gets to grade itself into a better posterior while a
 * grader is available.
 *
 * Does NOT persist; call {@link RouterStack.save} when the caller is ready.
 */
export function recordRouteOutcome(stack: RouterStack, rec: RouteOutcomeRecord): RoutingDecision {
  const tier = rec.tier ?? routeTier(rec.signals ?? {});

  stack.cost.record({
    armId: rec.armId,
    tokensIn: rec.tokensIn,
    tokensOut: rec.tokensOut,
    usd: rec.actualUsd,
    latencyMs: rec.wallMs,
    at: rec.at,
  });

  const ctx: RoutingContext = {
    taskId: rec.taskId,
    category: rec.category,
    difficulty: rec.difficulty ?? 0.5,
    decomposable: rec.decomposable ?? false,
    signals: rec.signals ?? {},
    promptTokens: rec.promptTokens ?? rec.tokensIn,
  };

  stack.bandit.update({
    armId: rec.armId,
    context: ctx,
    verified: rec.graded === null ? rec.claimedVerified : rec.graded,
    usd: rec.actualUsd,
    wallMs: rec.wallMs,
    fannedOut: (rec.fannedOut ?? []).length,
  });

  if (rec.graded !== null) {
    // A conformal calibration point needs a SCORE and a LABEL. The score is
    // the router's own pre-execution P(correct) belief for this arm; the
    // label is the independent grade. Without a grade there is no label, so
    // no point is recorded — an unlabelled guess would corrupt the bound.
    const point: RiskCalibrationPoint = {
      armId: rec.armId,
      tier,
      score: Math.min(1, Math.max(0, Number.isFinite(rec.pCorrect) ? rec.pCorrect : 0)),
      correct: rec.graded,
    };
    stack.riskPoints.push(point);
    stack.risk.calibrate(stack.riskPoints);

    if (typeof rec.verifierId === "string" && rec.verifierId.length > 0) {
      stack.calibrator.observe({
        verifierId: rec.verifierId,
        armId: rec.armId,
        score: Math.min(1, Math.max(0, Number.isFinite(rec.verifierScore ?? NaN) ? (rec.verifierScore as number) : point.score)),
        passed: rec.claimedVerified,
        correct: rec.graded,
        at: rec.at,
      });
      stack.calibrator.fit(rec.at);
    }
  }

  const decision: RoutingDecision = {
    taskId: rec.taskId,
    category: rec.category,
    armId: rec.armId,
    reason: rec.reason,
    candidates: [...rec.candidates],
    fannedOut: [...(rec.fannedOut ?? [])],
    escalations: rec.escalations ?? 0,
    estimatedUsd: rec.estimatedUsd,
    actualUsd: rec.actualUsd,
    wallMs: rec.wallMs,
    claimedVerified: rec.claimedVerified,
    graded: rec.graded,
    pCorrect: rec.pCorrect,
    certificateId: rec.certificateId ?? null,
    at: rec.at,
  };
  stack.ledger.append(decision);
  return decision;
}

// ---------------------------------------------------------------------------
// The routed runner — the actual product surface of this phase
// ---------------------------------------------------------------------------

export interface RoutedRunnerOptions {
  /**
   * The REAL executor for one arm. Returning `null` means "this build cannot
   * execute that arm", and the router treats the arm as unavailable rather
   * than pretending it ran.
   */
  runnerFor: (arm: RoutingArm) => AgentRunner | null;
  /** Injected clock. Defaults to the real `Date.now`. */
  now?: () => number;
  /** Token context used to price candidates BEFORE execution. Default 2000/500. */
  ctx?: TaskCostContext;
  /**
   * Verifier signals per task. Default: `multiModelAvailable` iff the eligible
   * set spans more than one provider — a real property of this install, not an
   * assumption about the task.
   */
  signalsFor?: (task: EvalTask, eligible: readonly RoutingArm[]) => TaskSignals;
  /** Hard cap on escalations the risk gate may spend on one task. Default 1. */
  maxEscalations?: number;
  /** Persist the stack after every task. Default false (the caller batches). */
  saveEachTask?: boolean;
}

/**
 * Build a {@link RouterLike} that actually routes: it prices the eligible arm
 * space with the measured cost model, picks with the budgeted bandit, executes
 * with a REAL per-arm runner, asks the conformal gate whether the result clears
 * this tier's risk bar, escalates to the gate's own proposed arm when it does
 * not, and folds every completed attempt back into the stack (cost, posterior,
 * budget, calibration evidence, ledger).
 *
 * The `verified` signal fed back to the bandit is `task.grade(output)` — the
 * independent grader the eval suite ships — never the arm's self-claim. That is
 * the whole point: an arm that lies gets a WORSE posterior, not a better one.
 *
 * A task with no executable eligible arm returns a declined
 * ({@link AgentRunResult.claimedVerified} `false`) run with an explicit
 * provenance line rather than throwing or inventing an answer.
 */
export function createRoutedRunner(stack: RouterStack, opts: RoutedRunnerOptions): RouterLike {
  const now = opts.now ?? ((): number => Date.now());
  const baseCtx = opts.ctx ?? DEFAULT_STATUS_CTX;
  const maxEscalations = Math.max(0, Math.floor(opts.maxEscalations ?? 1));

  return {
    async route(task: EvalTask): Promise<RoutedRun> {
      const startedAt = now();
      const eligibility = stack.catalog.eligible(stack.requirements, baseCtx, stack.cost);
      const runnable = eligibility.arms.filter((a) => opts.runnerFor(a) !== null);
      const candidates = runnable.map((a) => a.id);

      if (candidates.length === 0) {
        const why =
          eligibility.rejected.length > 0
            ? `no runnable arm (${eligibility.rejected.length} rejected, first: ${eligibility.rejected[0]!.code})`
            : "no runnable arm (the catalog is empty or nothing is executable in this build)";
        return {
          output: "",
          claimedVerified: false,
          tokensIn: 0,
          tokensOut: 0,
          usd: 0,
          provenance: [`router:declined ${why}`],
          armId: "",
          fannedOut: [],
          escalations: 0,
          pCorrect: 0,
        };
      }

      const signals = opts.signalsFor
        ? opts.signalsFor(task, runnable)
        : { multiModelAvailable: new Set(runnable.map((a) => a.provider)).size > 1 };
      const tier = routeTier(signals);

      const armById = new Map(runnable.map((a) => [a.id, a]));
      const ctx: RoutingContext = {
        taskId: task.id,
        category: task.category,
        difficulty: task.decomposable ? 0.75 : 0.35,
        decomposable: task.decomposable,
        signals,
        promptTokens: baseCtx.promptTokens,
      };
      const estimateUsd = (armId: string): number => {
        const arm = armById.get(armId);
        return arm ? stack.cost.estimate(arm, baseCtx, startedAt).usdMean : 0;
      };

      let escalations = 0;
      const attempted: string[] = [];
      let last: {
        armId: string;
        result: AgentRunResult;
        graded: boolean;
        pCorrect: number;
        reason: string;
        wallMs: number;
        estimatedUsd: number;
      } | null = null;

      let nextArmId: string | null = null;
      let selectionReason = "";

      for (;;) {
        let armId: string;
        if (nextArmId !== null) {
          armId = nextArmId;
          nextArmId = null;
        } else {
          const remaining = candidates.filter((id) => !attempted.includes(id));
          const selection = stack.bandit.select(ctx, remaining, estimateUsd);
          if (selection.armId === null) break;
          armId = selection.armId;
          selectionReason = `bandit:${selection.reason} lambda=${selection.lambda.toFixed(6)}`;
        }

        const arm = armById.get(armId);
        const runner = arm ? opts.runnerFor(arm) : null;
        if (!arm || !runner) break;

        attempted.push(armId);
        const estimatedUsd = stack.cost.estimate(arm, baseCtx, startedAt).usdMean;
        const attemptStart = now();
        let result: AgentRunResult;
        try {
          result = await runner(task);
        } catch (err) {
          result = {
            output: "",
            claimedVerified: false,
            tokensIn: 0,
            tokensOut: 0,
            usd: 0,
            provenance: [`arm-error:${errText(err)}`],
          };
        }
        const attemptEnd = now();
        const wallMs = Math.max(0, attemptEnd - attemptStart);
        const graded = task.grade(result.output);
        const pCorrect = stack.bandit.posterior(armId, ctx).pVerifiedMean;

        const reason =
          (selectionReason || "bandit:selected") + (escalations > 0 ? ` escalation#${escalations}` : "");

        recordRouteOutcome(stack, {
          taskId: task.id,
          category: task.category,
          armId,
          reason,
          candidates,
          escalations,
          estimatedUsd,
          actualUsd: Number.isFinite(result.usd) ? result.usd : 0,
          wallMs,
          tokensIn: Number.isFinite(result.tokensIn) ? result.tokensIn : 0,
          tokensOut: Number.isFinite(result.tokensOut) ? result.tokensOut : 0,
          claimedVerified: result.claimedVerified === true,
          graded,
          pCorrect,
          at: attemptStart,
          tier,
          signals,
          difficulty: ctx.difficulty,
          decomposable: task.decomposable,
          promptTokens: baseCtx.promptTokens,
        });

        last = { armId, result, graded, pCorrect, reason, wallMs, estimatedUsd };
        if (opts.saveEachTask) stack.save();

        if (escalations >= maxEscalations) break;

        const ladder = candidates.filter((id) => !attempted.includes(id));
        if (ladder.length === 0) break;

        let verdict: RouteVerdict;
        try {
          verdict = stack.risk.decide({
            armId,
            tier,
            pCorrect,
            escalationLadder: ladder,
            fanOutCandidates: [],
            costOf: (id: string): number => Math.max(0, estimateUsd(id)),
            spentUsd: stack.bandit.spentUsd(),
            budgetUsd: stack.budgetUsd,
            escalations,
          });
        } catch {
          break; // a gate that will not decide never silently accepts an escalation
        }

        if (verdict.action !== "escalate") break;
        nextArmId = verdict.nextArmId;
        escalations += 1;
      }

      if (last === null) {
        return {
          output: "",
          claimedVerified: false,
          tokensIn: 0,
          tokensOut: 0,
          usd: 0,
          provenance: ["router:declined no arm could be executed"],
          armId: "",
          fannedOut: [],
          escalations: 0,
          pCorrect: 0,
        };
      }

      return {
        output: last.result.output,
        claimedVerified: last.result.claimedVerified === true,
        tokensIn: Number.isFinite(last.result.tokensIn) ? last.result.tokensIn : 0,
        tokensOut: Number.isFinite(last.result.tokensOut) ? last.result.tokensOut : 0,
        usd: Number.isFinite(last.result.usd) ? last.result.usd : 0,
        provenance: [last.reason, ...(Array.isArray(last.result.provenance) ? last.result.provenance : [])],
        armId: last.armId,
        fannedOut: [],
        escalations,
        pCorrect: last.pCorrect,
      };
    },
  };
}
