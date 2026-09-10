/**
 * Desktop `trust.*` service — the real unified trust gate behind the desktop
 * app's trust surface.
 *
 * This is NOT a second trust gate. It drives exactly the stack
 * `openTrustStack()` builds (`src/hades/trust/wiring.ts`) — the same one
 * `hades trust` drives from a terminal, rooted at the same
 * `<dataDir>/trust` — so the registry, the ed25519 signing identity, the
 * hash-chained budget and the persisted per-domain calibration are shared,
 * not duplicated. A certificate issued from the terminal verifies in the
 * app, and both surfaces spend from one budget chain.
 *
 * Three rules this service holds:
 *
 *  1. **Calibrating requires explicit confirmation.** `trust.calibrate`
 *     without `confirm: true` fits and REPORTS but persists nothing — the
 *     desktop equivalent of `--dry-run`. Nothing silently overwrites a
 *     calibration an operator fitted deliberately.
 *  2. **A refused fit is never persisted.** If the real `ConformalGate`
 *     rejects the point set (too few points), `fitError` carries the real
 *     message and `persisted` is false — never a partial or "close enough"
 *     write.
 *  3. **A meaningless threshold is never dressed up as a working one.**
 *     Every domain view carries `thresholdIsInfinite` and the real rank
 *     `auc`, so a renderer cannot draw "calibrated" over a gate that
 *     abstains on everything or over a fit with no correct-vs-wrong
 *     separation. Both facts travel with the data, by contract.
 *
 * The private key never crosses the wire — only `keySource` (a label) and
 * the public half. Every failure becomes a `trust.error` event carrying the
 * real message, never silence and never a fabricated empty status that a
 * renderer would legitimately read as "the gate is fine".
 */

import {
  openTrustStack,
  summarizeDiscrimination,
  collectEvalCalibration,
  trustDomainStatuses,
  TRUST_DOMAINS,
  type TrustStack,
  type TrustStackOptions,
} from "../../hades/trust/wiring";
import type { TrustDomain } from "../../hades/trust/registry";
import type { TrustBudgetReport, ChainVerification } from "../../hades/trust/budget";
import type {
  TrustBudgetView,
  TrustCalibrationView,
  TrustCommand,
  TrustDomainView,
  TrustEvent,
  TrustStatusView,
  TrustVerifierView,
} from "../ipc/trust-contract";

export interface TrustServiceOptions {
  /**
   * How to open the stack. Defaults to `openTrustStack()` — i.e. the SAME
   * `$HADES_DATA_DIR|.hades` install every other Hades surface uses. Opened
   * LAZILY on the first command so constructing the sidecar never mints a
   * signing key or touches the budget ledger.
   */
  stack?: () => TrustStack;
  stackOptions?: TrustStackOptions;
  /** Clock for event timestamps (defaults to `Date.now`). */
  now?: () => number;
}

/** +Infinity cannot survive JSON, and `null` alone would read as "absent"
 *  rather than "admits nothing". The pair is the wire representation. */
function splitThreshold(threshold: number | undefined): { threshold: number | null; thresholdIsInfinite: boolean } {
  if (threshold === undefined) return { threshold: null, thresholdIsInfinite: false };
  if (!Number.isFinite(threshold)) return { threshold: null, thresholdIsInfinite: true };
  return { threshold, thresholdIsInfinite: false };
}

function toBudgetView(report: TrustBudgetReport, chain: ChainVerification): TrustBudgetView {
  return {
    totalRisk: report.totalRisk,
    spentRisk: report.spentRisk,
    remainingRisk: report.remainingRisk,
    exhausted: report.exhausted,
    entries: report.entries,
    chainRoot: report.chainRoot,
    chainHead: report.chainHead,
    chainOk: chain.ok,
    ...(chain.reason !== undefined ? { chainReason: chain.reason } : {}),
    ...(chain.firstBadSeq !== undefined ? { chainFirstBadSeq: chain.firstBadSeq } : {}),
    perDomain: Object.entries(report.perDomain)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, p]) => ({
        domain,
        cap: p.cap,
        spent: p.spent,
        remaining: p.remaining,
        admissions: p.admissions,
      })),
  };
}

export class TrustService {
  private readonly openStack: () => TrustStack;
  private readonly now: () => number;
  private cached?: TrustStack;

  constructor(opts: TrustServiceOptions = {}) {
    const stackOptions = opts.stackOptions;
    this.openStack = opts.stack ?? ((): TrustStack => openTrustStack(stackOptions));
    this.now = opts.now ?? ((): number => Date.now());
  }

  private stack(): TrustStack {
    if (!this.cached) this.cached = this.openStack();
    return this.cached;
  }

  async handle(cmd: TrustCommand): Promise<TrustEvent> {
    try {
      switch (cmd.kind) {
        case "trust.status":
          return { kind: "trust.status", status: this.statusView(), at: this.now() };
        case "trust.verifiers":
          return { kind: "trust.verifiers", verifiers: this.verifierViews(cmd.domain), at: this.now() };
        case "trust.budget": {
          const stack = this.stack();
          if (stack.budget === null) {
            return {
              kind: "trust.error",
              op: cmd.kind,
              message: "this trust stack was built without a budget ledger",
              at: this.now(),
            };
          }
          return {
            kind: "trust.budget",
            budget: toBudgetView(stack.budget.report(), stack.budget.verifyChain()),
            at: this.now(),
          };
        }
        case "trust.calibrate":
          return { kind: "trust.calibrated", result: await this.calibrate(cmd), at: this.now() };
        default: {
          const exhaustive: never = cmd;
          return {
            kind: "trust.error",
            op: String((exhaustive as { kind?: unknown }).kind ?? "unknown"),
            message: "unsupported trust command",
            at: this.now(),
          };
        }
      }
    } catch (err) {
      return {
        kind: "trust.error",
        op: cmd.kind,
        message: err instanceof Error ? err.message : String(err),
        at: this.now(),
      };
    }
  }

  private verifierViews(domain?: string): TrustVerifierView[] {
    const stack = this.stack();
    const filter = (TRUST_DOMAINS as readonly string[]).includes(domain ?? "")
      ? (domain as TrustDomain)
      : undefined;
    return stack.registry.list(filter).map((v) => ({
      id: v.id,
      version: v.version,
      domain: v.domain,
      tier: v.tier,
      prior: v.prior,
    }));
  }

  private statusView(): TrustStatusView {
    const stack = this.stack();
    const domains: TrustDomainView[] = trustDomainStatuses(stack).map((s) => {
      const disc = summarizeDiscrimination(stack.calibration.points(s.domain));
      const { threshold, thresholdIsInfinite } = splitThreshold(s.stats?.threshold);
      return {
        domain: s.domain,
        verifiers: stack.registry.list(s.domain).length,
        calibrated: s.calibrated,
        points: s.points,
        threshold,
        thresholdIsInfinite,
        epsilon: s.stats?.epsilon ?? null,
        auc: disc.auc,
        separation: s.points === 0 ? "uncalibrated — the gate abstains on this domain" : disc.verdict,
        ...(s.provenance !== undefined ? { provenance: s.provenance } : {}),
        ...(s.error !== undefined ? { error: s.error } : {}),
      };
    });

    return {
      root: stack.root,
      epsilon: stack.epsilon,
      keySource: stack.key.source,
      publicKeyHex: stack.key.publicKeyHex,
      verifierCount: stack.registry.list().length,
      domains,
      budget: stack.budget === null ? null : toBudgetView(stack.budget.report(), stack.budget.verifyChain()),
      calibrationLoadError: stack.calibration.loadError,
    };
  }

  private async calibrate(cmd: { domain?: string; confirm: boolean }): Promise<TrustCalibrationView> {
    const stack = this.stack();
    if (cmd.domain !== undefined && cmd.domain !== "procedure") {
      // Mirrors the CLI exactly: the eval corpus yields `procedure`-domain
      // observations. Producing "labeled" data for another domain out of it
      // would be fabrication, so it is refused rather than approximated.
      throw new RangeError(
        `trust.calibrate derives "procedure"-domain observations from the real eval corpus; ` +
          `it cannot produce labeled data for domain "${cmd.domain}".`,
      );
    }

    const collected = await collectEvalCalibration({ registry: stack.registry });
    const disc = collected.discrimination;

    let threshold: number | null = null;
    let thresholdIsInfinite = false;
    let epsilon: number | null = null;
    let fitError: string | null = null;
    try {
      const stats = stack.gate.calibrate(collected.domain, collected.points);
      const split = splitThreshold(stats.threshold);
      threshold = split.threshold;
      thresholdIsInfinite = split.thresholdIsInfinite;
      epsilon = stats.epsilon;
    } catch (err) {
      fitError = err instanceof Error ? err.message : String(err);
    }

    // Persist only on an explicitly-confirmed command whose fit the REAL
    // ConformalGate actually accepted.
    const persisted = cmd.confirm && fitError === null;
    if (persisted) {
      stack.calibration.record(collected.domain, collected.points, collected.provenance);
    }

    return {
      domain: collected.domain,
      points: disc.points,
      correct: disc.correct,
      wrong: disc.wrong,
      auc: disc.auc,
      separation: disc.verdict,
      threshold,
      thresholdIsInfinite,
      epsilon,
      persisted,
      dryRun: !cmd.confirm,
      fitError,
      provenance: collected.provenance,
      droppedObservations: collected.solverErrors.length,
    };
  }
}
