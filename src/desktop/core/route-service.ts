/**
 * `RouteService` — the desktop `route.*` backend, over the REAL router stack
 * (`src/hades/routing/**`).
 *
 * Structurally a `RouteHandler` (see `./sidecar.ts`), so central wiring can
 * hand it to the `Sidecar` and the desktop reads the SAME arm catalog,
 * measured cost model, bandit posterior, budget and hash-chained routing
 * ledger that `hades route` reads from a terminal — one `openRouter()` root,
 * never a second private copy and never a re-implementation.
 *
 * Everything this service reports is measured by real code:
 *   - costs come from the real published price table plus this install's own
 *     REAL recorded usage (and say which of the two they came from);
 *   - P(verified) comes from the real Beta posterior the bandit updates from
 *     independently-graded outcomes;
 *   - thresholds come from the real split-conformal fit over the real
 *     labelled calibration evidence;
 *   - attribution comes from the real SHA-256 hash chain.
 *
 * Three honesty rules are enforced HERE, not left to the renderer:
 *
 *   1. `unpriced: true` travels with any arm the price table does not know.
 *      A renderer MUST show "n/a" rather than a `usdMean` that reads as free.
 *   2. `riskThresholdFinite: false` travels with any stratum that ABSTAINS.
 *      `Infinity` does not survive JSON (it becomes `null`), so the boolean
 *      is what says "this gate accepts nothing", rather than a missing number
 *      that reads as "no limit".
 *   3. `measuredVtphPerDollar` is 0 for an arm that has never been pulled,
 *      because nothing was measured.
 *
 * This lane is READ-ONLY on durable state. There is deliberately no
 * `route.record` (which would move the budget, a posterior and the ledger)
 * and no `route.bench` (which would spend real money at a provider) — see
 * `../ipc/route-contract.ts`. `route.explain` advances the bandit's in-memory
 * PRNG, records nothing and never calls `save()`.
 */

import type {
  RouteArmWire,
  RouteCommand,
  RouteEligibilityWire,
  RouteEvent,
  RouteExplainWire,
  RouteLedgerWire,
  RouteStatusWire,
} from "../ipc/route-contract";
import {
  DEFAULT_STATUS_CTX,
  openRouter,
  routerStatus,
  type RouterArmView,
  type RouterStack,
  type RouterStackOptions,
} from "../../hades/routing/wiring";
import type { ArmRequirements, TaskCostContext } from "../../hades/routing/arms";
import type { RoutingContext } from "../../hades/routing/bandit";
import { TIER_ORDER, type TierId } from "../../hades/styx/tiers";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Finite numbers only cross the wire; a non-finite one becomes 0, never NaN. */
function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export interface RouteServiceOptions {
  /** Lazily open the stack. A factory (not a value) so constructing the
   *  service never touches `<dataDir>/routing`. */
  stack?: () => RouterStack;
  /** Used to build the default lazy factory when `stack` is omitted. */
  stackOptions?: RouterStackOptions;
  now?: () => number;
  /**
   * Hard ceiling on how many ledger entries one `route.ledger` request may
   * return, because the renderer supplies the count and a ledger can grow
   * without bound. Defaults to 500.
   */
  maxLedgerEntries?: number;
  /**
   * Hard ceiling on the token context a renderer may quote costs at — an
   * unbounded value is not dangerous arithmetically, but it is a way to make
   * the UI print a nonsense dollar figure. Defaults to 2,000,000.
   */
  maxTokens?: number;
}

export class RouteService {
  private readonly openStack: () => RouterStack;
  private readonly now: () => number;
  private readonly maxLedgerEntries: number;
  private readonly maxTokens: number;
  private cached?: RouterStack;

  constructor(opts: RouteServiceOptions = {}) {
    const stackOptions = opts.stackOptions ?? {};
    this.openStack = opts.stack ?? ((): RouterStack => openRouter(stackOptions));
    this.now = opts.now ?? ((): number => Date.now());
    this.maxLedgerEntries = opts.maxLedgerEntries ?? 500;
    this.maxTokens = opts.maxTokens ?? 2_000_000;
  }

  private stack(): RouterStack {
    if (!this.cached) this.cached = this.openStack();
    return this.cached;
  }

  async handle(cmd: RouteCommand): Promise<RouteEvent> {
    try {
      switch (cmd.kind) {
        case "route.status":
          return { kind: "route.status", status: this.status(cmd), at: this.now() };
        case "route.arms":
          return { kind: "route.arms", eligibility: this.arms(cmd), at: this.now() };
        case "route.explain":
          return { kind: "route.explain", explain: this.explain(cmd), at: this.now() };
        case "route.ledger":
          return { kind: "route.ledger", ledger: this.ledger(cmd), at: this.now() };
        default: {
          const exhaustive: never = cmd;
          return {
            kind: "route.error",
            op: String((exhaustive as { kind?: unknown }).kind ?? "route.unknown"),
            message: "unsupported route command",
            at: this.now(),
          };
        }
      }
    } catch (err) {
      // Never silence and never fabricate an "ok": a renderer that cannot
      // distinguish "the router failed" from "the router is idle" would draw
      // an empty, healthy-looking panel over a broken stack.
      return { kind: "route.error", op: cmd.kind, message: errMsg(err), at: this.now() };
    }
  }

  // -------------------------------------------------------------------------
  // Shared coercion
  // -------------------------------------------------------------------------

  private ctxOf(promptTokens?: number, expectedOutputTokens?: number): TaskCostContext {
    const clamp = (v: number | undefined, fallback: number): number => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return fallback;
      return Math.min(this.maxTokens, Math.floor(v));
    };
    return {
      promptTokens: clamp(promptTokens, DEFAULT_STATUS_CTX.promptTokens),
      expectedOutputTokens: clamp(expectedOutputTokens, DEFAULT_STATUS_CTX.expectedOutputTokens),
    };
  }

  private tierOf(tier: string | undefined): TierId {
    return typeof tier === "string" && (TIER_ORDER as readonly string[]).includes(tier)
      ? (tier as TierId)
      : "T4-consistency";
  }

  private static toArmWire(a: RouterArmView): RouteArmWire {
    const finite = Number.isFinite(a.riskThreshold);
    return {
      armId: a.armId,
      provider: a.provider,
      modelId: a.modelId,
      execTarget: a.execTarget,
      displayName: a.displayName,
      contextWindow: a.contextWindow === null || !Number.isFinite(a.contextWindow) ? null : a.contextWindow,
      unpriced: a.unpriced,
      eligible: a.eligible,
      rejectionCode: a.rejectionCode,
      rejectionDetail: a.rejectionDetail,
      usdMean: fin(a.usdMean),
      usdP90: fin(a.usdP90),
      latencyMsMean: fin(a.latencyMsMean),
      costSamples: fin(a.costSamples),
      costSource: a.costSource,
      pulls: fin(a.pulls),
      verified: fin(a.verified),
      pVerifiedMean: fin(a.pVerifiedMean),
      measuredVtphPerDollar: fin(a.measuredVtphPerDollar),
      riskThreshold: finite ? a.riskThreshold : null,
      riskThresholdFinite: finite,
      riskSource: a.riskSource,
      riskCalibrationSize: fin(a.riskCalibrationSize),
    };
  }

  // -------------------------------------------------------------------------
  // route.status
  // -------------------------------------------------------------------------

  private status(cmd: Extract<RouteCommand, { kind: "route.status" }>): RouteStatusWire {
    const stack = this.stack();
    const view = routerStatus(stack, {
      ctx: this.ctxOf(cmd.promptTokens, cmd.expectedOutputTokens),
      tier: this.tierOf(cmd.tier),
    });
    return {
      root: view.root,
      budgetUsd: fin(view.budgetUsd),
      spentUsd: fin(view.spentUsd),
      remainingUsd: fin(view.remainingUsd),
      lambda: fin(view.lambda),
      seed: fin(view.seed),
      epsilon: fin(view.epsilon),
      tier: view.tier,
      totalArms: view.totalArms,
      eligibleArms: view.eligibleArms,
      unpricedArms: view.unpricedArms,
      ledgerEntries: view.ledgerEntries,
      chainOk: view.chainOk,
      chainCode: view.chainCode,
      riskStrata: view.riskStrata,
      riskCalibrated: view.riskCalibrated,
      riskPooledFallbacks: view.riskPooledFallbacks,
      riskAbstainingStrata: view.riskAbstainingStrata,
      riskPoints: view.riskPoints,
      verifiersTracked: view.verifiersTracked,
      arms: view.arms.map(RouteService.toArmWire),
      loadErrors: view.loadErrors,
    };
  }

  // -------------------------------------------------------------------------
  // route.arms
  // -------------------------------------------------------------------------

  private arms(cmd: Extract<RouteCommand, { kind: "route.arms" }>): RouteEligibilityWire {
    const stack = this.stack();
    const ctx = this.ctxOf(cmd.promptTokens, cmd.expectedOutputTokens);

    const req: ArmRequirements = { ...stack.requirements };
    if (typeof cmd.provider === "string" && cmd.provider.length > 0) req.providers = [cmd.provider];
    if (typeof cmd.maxUsdPerTask === "number" && Number.isFinite(cmd.maxUsdPerTask)) {
      req.maxUsdPerTask = cmd.maxUsdPerTask;
    }
    if (typeof cmd.minContextWindow === "number" && Number.isFinite(cmd.minContextWindow)) {
      req.minContextWindow = cmd.minContextWindow;
    }
    if (cmd.allowUnpriced === true) req.allowUnpriced = true;

    // Reuse the SAME status projection so the desktop and the CLI cannot
    // drift on what an arm row means; then filter with THIS request's
    // requirements.
    const full = routerStatus(stack, { ctx });
    const byId = new Map(full.arms.map((a) => [a.armId, a]));
    const result = stack.catalog.eligible(req, ctx, stack.cost);
    const rejectedById = new Map(result.rejected.map((r) => [r.armId, r]));

    const eligible: RouteArmWire[] = result.arms.map((arm) => {
      const base = byId.get(arm.id);
      const wire = base
        ? RouteService.toArmWire(base)
        : RouteService.toArmWire({
            armId: arm.id,
            provider: arm.provider,
            modelId: arm.modelId,
            execTarget: arm.execTarget,
            displayName: arm.displayName,
            contextWindow: arm.contextWindow,
            unpriced: arm.unpriced,
            eligible: true,
            rejectionCode: null,
            rejectionDetail: null,
            usdMean: 0,
            usdP90: 0,
            latencyMsMean: 0,
            costSamples: 0,
            costSource: "unpriced",
            pulls: 0,
            verified: 0,
            pVerifiedMean: 0,
            measuredVtphPerDollar: 0,
            riskThreshold: Infinity,
            riskSource: "none",
            riskCalibrationSize: 0,
          });
      // `eligible` here is relative to THIS request's requirements, not the
      // stack-wide ones the status projection used.
      const r = rejectedById.get(arm.id);
      return { ...wire, eligible: true, rejectionCode: r?.code ?? null, rejectionDetail: r?.detail ?? null };
    });

    return {
      promptTokens: ctx.promptTokens,
      expectedOutputTokens: ctx.expectedOutputTokens,
      eligible,
      rejected: result.rejected.map((r) => ({ armId: r.armId, code: r.code, detail: r.detail })),
    };
  }

  // -------------------------------------------------------------------------
  // route.explain
  // -------------------------------------------------------------------------

  private explain(cmd: Extract<RouteCommand, { kind: "route.explain" }>): RouteExplainWire {
    const stack = this.stack();
    const ctx = this.ctxOf(cmd.promptTokens, cmd.expectedOutputTokens);
    const eligibility = stack.catalog.eligible(stack.requirements, ctx, stack.cost);
    const armById = new Map(eligibility.arms.map((a) => [a.id, a]));

    const difficulty =
      typeof cmd.difficulty === "number" && Number.isFinite(cmd.difficulty)
        ? Math.min(1, Math.max(0, cmd.difficulty))
        : 0.5;

    const routingCtx: RoutingContext = {
      taskId: typeof cmd.taskId === "string" && cmd.taskId.length > 0 ? cmd.taskId : `explain:${cmd.category}`,
      category: cmd.category,
      difficulty,
      decomposable: cmd.decomposable === true,
      signals: { multiModelAvailable: new Set(eligibility.arms.map((a) => a.provider)).size > 1 },
      promptTokens: ctx.promptTokens,
    };

    const estimateUsd = (armId: string): number => {
      const arm = armById.get(armId);
      return arm ? stack.cost.estimate(arm, ctx, 0).usdMean : 0;
    };

    const selection = stack.bandit.select(
      routingCtx,
      eligibility.arms.map((a) => a.id),
      estimateUsd,
    );

    return {
      taskId: routingCtx.taskId,
      category: routingCtx.category,
      difficulty,
      decomposable: routingCtx.decomposable,
      chosenArmId: selection.armId,
      reason: selection.reason,
      lambda: fin(selection.lambda),
      budgetRemainingUsd: fin(selection.budgetRemainingUsd),
      ranked: selection.ranked.map((r) => {
        const posterior = stack.bandit.posterior(r.armId, routingCtx);
        return {
          armId: r.armId,
          sampledScore: fin(r.sampledScore),
          shadowCost: fin(r.shadowCost),
          estimatedUsd: fin(estimateUsd(r.armId)),
          unpriced: armById.get(r.armId)?.unpriced ?? false,
          pulls: fin(posterior.pulls),
          verified: fin(posterior.verified),
          pVerifiedMean: fin(posterior.pVerifiedMean),
        };
      }),
      rejected: eligibility.rejected.map((r) => ({ armId: r.armId, code: r.code, detail: r.detail })),
      note: "pure read: this advanced the in-memory PRNG but recorded no outcome, moved no money and saved nothing",
    };
  }

  // -------------------------------------------------------------------------
  // route.ledger
  // -------------------------------------------------------------------------

  private ledger(cmd: Extract<RouteCommand, { kind: "route.ledger" }>): RouteLedgerWire {
    const stack = this.stack();
    const chain = stack.ledger.verifyChain();
    const all = stack.ledger.entries();

    const requested =
      typeof cmd.entries === "number" && Number.isFinite(cmd.entries) && cmd.entries >= 0
        ? Math.floor(cmd.entries)
        : all.length;
    const limit = Math.min(this.maxLedgerEntries, requested);
    const shown = all.slice(Math.max(0, all.length - limit));

    return {
      chainOk: stack.chainOk && chain.ok,
      chainCode: chain.code,
      chainEntries: chain.entries,
      brokenAt: chain.brokenAt,
      attribution: stack.ledger.attribution().map((a) => ({
        armId: a.armId,
        tasks: fin(a.tasks),
        verifiedCorrect: fin(a.verifiedCorrect),
        silentWrong: fin(a.silentWrong),
        declined: fin(a.declined),
        usd: fin(a.usd),
        wallMs: fin(a.wallMs),
        vtph: fin(a.vtph),
        vtphPerDollar: fin(a.vtphPerDollar),
        escalatedInto: fin(a.escalatedInto),
      })),
      entries: shown.map((e) => ({
        seq: e.seq,
        taskId: e.taskId,
        category: e.category,
        armId: e.armId,
        actualUsd: fin(e.actualUsd),
        wallMs: fin(e.wallMs),
        claimedVerified: e.claimedVerified,
        graded: e.graded,
        hash: e.hash,
      })),
    };
  }
}
