/**
 * `MarketService` — the desktop `market.*` backend, over the REAL market
 * stack (`src/hades/market/**`).
 *
 * Structurally a `MarketHandler` (see `./sidecar.ts`), so central wiring can
 * hand it to the `Sidecar` and the desktop reads the SAME reputation ledger,
 * economy, replay registry and trusted ed25519 issuer that `hades market`
 * reads from a terminal — one `openMarket()` root, never a second private
 * copy and never a re-implementation.
 *
 * Everything this service reports is measured by real code:
 *   - reputation numbers come from the real hash-chained `ReputationLedger`;
 *   - clearing prices come from the real `WorkExchange` second-price
 *     mechanism, over the real reputation shrinkage;
 *   - the issuer key is read (never minted) from this install's trust gate.
 *
 * Two honesty rules are enforced HERE, not left to the renderer:
 *
 *   1. `scoreDefined: false` travels with any participant whose Brier SKILL
 *      score is mathematically undefined (their realized outcomes carry no
 *      variance yet). The renderer is contractually required to draw "n/a"
 *      rather than a `0.00` that reads as "scored terribly".
 *   2. `market.simulate` always carries `modelLabel` — the engine's own
 *      `MODEL_LABEL` — and the contract's guard REJECTS an empty one, so a
 *      simulated cohort can never reach a pane stripped of its banner.
 *
 * `market.book` is a pure read: it ranks and prices a caller-supplied order
 * book and returns the result. It never settles, never moves escrow, never
 * records a reputation event, and never persists. Money only moves through
 * `Economy.submitClaim`, which requires a real certificate and is reachable
 * only from a surface that can produce one.
 */

import type {
  MarketBookWire,
  MarketCommand,
  MarketEvent,
  MarketParticipantWire,
  MarketReputationWire,
  MarketSimulationWire,
  MarketStatusWire,
} from "../ipc/market-contract";
import {
  marketStatus,
  openMarket,
  type MarketStack,
  type MarketStackOptions,
} from "../../hades/market/wiring";
import type { TaskOrder, WorkOffer } from "../../hades/market/exchange";
import {
  MODEL_LABEL,
  formatMarketConvergenceReport,
  runMarketConvergence,
} from "../../hades/market/convergence";

const UNCERTAINTY_EPS = 1e-9;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MarketServiceOptions {
  /** Lazily open the stack. A factory (not a value) so constructing the
   *  service never touches `<dataDir>/market`. */
  stack?: () => MarketStack;
  /** Used to build the default lazy factory when `stack` is omitted. */
  stackOptions?: MarketStackOptions;
  now?: () => number;
  /**
   * Hard ceiling on a single `market.simulate` request, because the renderer
   * supplies the size and a real simulation runs REAL ed25519 signing per
   * task — an unbounded request would be a trivial way to wedge the sidecar.
   * Defaults to 200 rounds x 8 tasks.
   */
  maxSimulationRounds?: number;
  maxSimulationTasksPerRound?: number;
}

export class MarketService {
  private readonly openStack: () => MarketStack;
  private readonly now: () => number;
  private readonly maxRounds: number;
  private readonly maxTasksPerRound: number;
  private cached?: MarketStack;

  constructor(opts: MarketServiceOptions = {}) {
    const stackOptions = opts.stackOptions ?? {};
    this.openStack = opts.stack ?? ((): MarketStack => openMarket(stackOptions));
    this.now = opts.now ?? ((): number => Date.now());
    this.maxRounds = opts.maxSimulationRounds ?? 200;
    this.maxTasksPerRound = opts.maxSimulationTasksPerRound ?? 8;
  }

  private stack(): MarketStack {
    if (!this.cached) this.cached = this.openStack();
    return this.cached;
  }

  async handle(cmd: MarketCommand): Promise<MarketEvent> {
    try {
      switch (cmd.kind) {
        case "market.status":
          return { kind: "market.status", status: this.status(), at: this.now() };
        case "market.reputation":
          return {
            kind: "market.reputation",
            participants: this.reputation(cmd.participantId, cmd.bins),
            at: this.now(),
          };
        case "market.book":
          return { kind: "market.book", book: this.book(cmd.orders, cmd.offers, cmd.now), at: this.now() };
        case "market.simulate":
          return {
            kind: "market.simulated",
            simulation: await this.simulate(cmd.seed, cmd.rounds, cmd.tasksPerRound),
            at: this.now(),
          };
        default: {
          const exhaustive: never = cmd;
          return {
            kind: "market.error",
            op: String((exhaustive as { kind?: unknown })?.kind ?? "market.unknown"),
            message: "unsupported market command",
            at: this.now(),
          };
        }
      }
    } catch (err) {
      return { kind: "market.error", op: cmd.kind, message: errMsg(err), at: this.now() };
    }
  }

  // -------------------------------------------------------------------------

  private status(): MarketStatusWire {
    const view = marketStatus(this.stack());
    const participants: MarketParticipantWire[] = view.participants.map((p) => ({
      id: p.id,
      kind: p.kind,
      balance: p.balance,
      escrowed: p.escrowed,
      standing: p.standing,
      settledN: p.settledN,
      fabricatedN: p.fabricatedN,
      score: p.score,
      scoreDefined: p.scoreDefined,
      n: p.n,
      passRate: p.passRate,
      brier: p.brier,
      decayedBrier: p.decayedBrier,
      calibrationGap: p.calibrationGap,
    }));
    return {
      root: view.root,
      issuerPublicKeyHex: view.issuerPublicKeyHex,
      issuerKeySource: view.issuerKeySource,
      trustedIssuers: view.trustedIssuers,
      acceptedTiers: view.acceptedTiers,
      maxEpsilon: view.maxEpsilon,
      requireTraceBinding: view.requireTraceBinding,
      treasury: view.treasury,
      totalTokens: view.totalTokens,
      participants,
      openAwards: view.openAwards,
      settlements: view.settlements,
      fabrications: view.fabrications,
      certificatesSpent: view.certificatesSpent,
      chainOk: view.chainOk,
      loadErrors: view.loadErrors,
    };
  }

  private reputation(participantId?: string, bins?: number): MarketReputationWire[] {
    const stack = this.stack();
    const binCount = bins !== undefined && Number.isFinite(bins) && bins > 0 ? Math.trunc(bins) : 10;
    const states =
      participantId === undefined
        ? stack.reputation.states()
        : [stack.reputation.state(participantId)].filter((s) => s !== null);
    return states.map((s) => ({
      participantId: s.participantId,
      kind: s.kind,
      n: s.n,
      verifiedN: s.verifiedN,
      fabricatedN: s.fabricatedN,
      brier: s.brier,
      decayedBrier: s.decayedBrier,
      reliability: s.decomposition.reliability,
      resolution: s.decomposition.resolution,
      uncertainty: s.decomposition.uncertainty,
      passRate: s.passRate,
      wilsonLower: s.wilsonLower,
      meanClaim: s.meanClaim,
      calibrationGap: s.calibrationGap,
      score: s.score,
      scoreDefined: s.fabricatedN > 0 || s.decomposition.uncertainty > UNCERTAINTY_EPS,
      standingHint: s.standingHint,
      calibration: stack.reputation.calibrationCurve(s.participantId, binCount),
    }));
  }

  private book(orders: unknown[], offers: unknown[], now: number): MarketBookWire {
    const stack = this.stack();
    const result = stack.exchange.clear(orders as TaskOrder[], offers as WorkOffer[], now);
    return {
      now,
      matches: result.matches.map((m) => ({
        taskId: m.taskId,
        participantId: m.participantId,
        offerPrice: m.offerPrice,
        clearingPrice: m.clearingPrice,
        claimedPCorrect: m.claimedPCorrect,
        adjustedPCorrect: m.adjustedPCorrect,
        expectedVerifiedValue: m.expectedVerifiedValue,
        reputationScore: m.reputationScore,
        runnerUpId: m.runnerUp ? m.runnerUp.participantId : null,
      })),
      unmatched: result.unmatched.map((u) => ({ taskId: u.taskId, reason: u.reason })),
      rejected: result.rejected.map((r) => ({
        participantId: String((r.offer as { participantId?: unknown } | null)?.participantId ?? "(malformed)"),
        taskId: String((r.offer as { taskId?: unknown } | null)?.taskId ?? "(malformed)"),
        reason: r.reason,
        detail: r.detail,
      })),
    };
  }

  private async simulate(seed?: number, rounds?: number, tasksPerRound?: number): Promise<MarketSimulationWire> {
    const resolvedSeed = seed !== undefined && Number.isFinite(seed) ? Math.trunc(seed) : 5;
    const resolvedRounds = Math.max(
      1,
      Math.min(this.maxRounds, rounds !== undefined && Number.isFinite(rounds) ? Math.trunc(rounds) : 40),
    );
    const resolvedTasks = Math.max(
      1,
      Math.min(
        this.maxTasksPerRound,
        tasksPerRound !== undefined && Number.isFinite(tasksPerRound) ? Math.trunc(tasksPerRound) : 4,
      ),
    );
    const report = await runMarketConvergence({
      seed: resolvedSeed,
      rounds: resolvedRounds,
      tasksPerRound: resolvedTasks,
    });
    return {
      modelLabel: report.modelLabel.length > 0 ? report.modelLabel : MODEL_LABEL,
      seed: report.seed,
      rounds: report.rounds,
      tasksPerRound: resolvedTasks,
      spearman: report.spearman,
      convergedAtRound: report.convergedAtRound,
      participants: report.participants.map((p) => ({
        participantId: p.participantId,
        archetype: p.archetype,
        trueReliability: p.trueReliability,
        score: p.finalScore,
        standing: p.finalStanding,
        wins: p.matchesWon,
        fabricationsCaught: p.fabricatedN,
      })),
      report: formatMarketConvergenceReport(report).split("\n"),
    };
  }
}
