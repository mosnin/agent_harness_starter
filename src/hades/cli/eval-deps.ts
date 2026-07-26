/**
 * eval-deps.ts — CENTRAL INTEGRATION of `hades eval`'s deps seam.
 *
 * `eval-command.ts` was built terminal-free against an injected
 * `EvalCliDeps` (real engine types only, per its locked import boundary).
 * This module is the product wiring that fills that seam with the real
 * thing:
 *
 *   root           -> `<dataDir>/eval`, where `dataDir` follows the EXACT
 *                      same convention every other `src/hades/cli/*-deps.ts`
 *                      module already uses (`env.HADES_DATA_DIR ?? ".hades"`
 *                      — see `defaultStateDeps` in `state-command.ts` and
 *                      `openTrustStack` in `trust/wiring.ts`). This repo has
 *                      no `HADES_HOME` convention anywhere else, so none is
 *                      introduced here.
 *   ledger         -> a real, lazily-opened, cached `EvalHistoryLedger` at
 *                      `root` (lazy so `hades eval help` never touches disk).
 *   runContinuous  -> the real `runContinuousEval` (`../eval/continuous`).
 *   status         -> the real `evalStatus` (`../eval/continuous`).
 *   bisect         -> the real `autoBisect` (`../eval/bisect`).
 *   measure        -> the real `runEvalMeasurement` (`../eval/measure`) over
 *                      the real `EVAL_TASKS` (`../bench/eval-suite`), the
 *                      real deterministic "faithful" scripted runner.
 *   resolveRevision -> the real `resolveRevision` (`../eval/revision`),
 *                      resolved with `cwd: root` — the SAME convention
 *                      `runContinuousEval`'s own default `resolve` uses
 *                      (`resolveRevision({ cwd: opts.root })`), which is
 *                      safe because `git` walks upward from `cwd` to find
 *                      the enclosing work tree, so a `<dataDir>/eval`
 *                      subdirectory still resolves the whole repo's HEAD.
 *   loadPolicy/savePolicy -> the real `loadPolicy`/`savePolicy`
 *                      (`../eval/regression-gate`), bound to `root`.
 *   readFile/fileExists -> the real `node:fs` reads.
 *   now            -> `Date.now`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EvalHistoryLedger } from "../eval/history";
import { runContinuousEval, evalStatus } from "../eval/continuous";
import { autoBisect } from "../eval/bisect";
import { runEvalMeasurement, defaultMeasureRunner } from "../eval/measure";
import { resolveRevision as coreResolveRevision } from "../eval/revision";
import { loadPolicy as coreLoadPolicy, savePolicy as coreSavePolicy } from "../eval/regression-gate";
import { EVAL_TASKS } from "../bench/eval-suite";
import { openTrustStack, type TrustStack } from "../trust/wiring";
import type { AdmitFn } from "../trust/risk-eval";
import type { TrustSubject } from "../trust/registry";
import type { ScorecardRevision, EvalScorecard } from "../eval/scorecard";
import type { EvalCliDeps } from "./eval-command";

export interface EvalDepsOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the computed `dataDir` (same override semantics as
   *  `HADES_DATA_DIR`) — the resolved eval root is always `<dataDir>/eval`.
   *  Primarily for tests that want a real, isolated temp directory without
   *  mutating `process.env`. */
  root?: string;
  /** Opens the REAL trust stack whose `UnifiedTrustGate.admit` drives the
   *  measurement's risk lane. Injectable so a test can bind an isolated
   *  stack; absent -> the real `openTrustStack` over this install's data
   *  directory. Set `admit: null` to deliberately leave the risk lane
   *  unmeasured (the scorecard then says so, with a reason). */
  trust?: () => TrustStack;
  /** Explicit override of the admission port. `null` means "no admission
   *  gate" — an honestly UNMEASURED risk lane rather than a fabricated pass. */
  admit?: AdmitFn | null;
}

/**
 * Build the real `EvalCliDeps` for `runEvalCommand`. Every capability below
 * is the genuine article — no constant-returning stub, nothing fabricated.
 */
export function defaultEvalCliDeps(opts: EvalDepsOptions = {}): EvalCliDeps {
  const env = opts.env ?? process.env;
  const dataDir = opts.root ?? env.HADES_DATA_DIR ?? ".hades";
  const root = join(dataDir, "eval");

  // Lazily opened + cached so a read-only invocation (e.g. `hades eval
  // help`) never touches disk, but every subcommand that DOES need the
  // ledger within one process reuses the same instance (matching
  // `defaultTrustDeps`'s `stack` caching convention in trust-command.ts).
  let cachedLedger: EvalHistoryLedger | undefined;
  const ledger = (): EvalHistoryLedger => {
    if (cachedLedger === undefined) cachedLedger = new EvalHistoryLedger({ root });
    return cachedLedger;
  };

  const resolveRevision = (): ScorecardRevision => coreResolveRevision({ cwd: root });

  // The risk lane's admission port is the REAL `UnifiedTrustGate` from this
  // install — the exact same object and the exact same structural join
  // `hades trust riskeval` already uses (see `riskeval` in trust-command.ts),
  // never a stand-in. Without it `runEvalMeasurement` leaves the risk lane
  // honestly UNMEASURED (NaN, with a reason), which the never-regress gate's
  // `risk-lane-unmeasured` rule then blocks on — so before this wiring
  // existed, a real `hades eval run --gate` could only ever BLOCK.
  //
  // The stack is opened LAZILY and cached: constructing it mints/reads an
  // ed25519 signing key and opens the trust budget ledger under
  // `<dataDir>/trust`, which must not happen for `hades eval help` or any
  // read-only subcommand.
  //
  // Honesty rule, and the reason this is gated on calibration: an
  // UNCALIBRATED trust gate ABSTAINS on every subject. Driving it anyway
  // produces a lane that is technically `measured: true` but degenerate —
  // 192 attempts, 0 accepted, and therefore `silentWrongRate: 0` and
  // `withinBound: true` from a gate that admitted nothing. The never-regress
  // gate has no rule that can tell that apart from a genuinely clean risk
  // lane, so it would sail through as a pass. That is exactly the
  // "fabricated 0 that reads as a passing measurement" this whole subsystem
  // exists to refuse (it is also why `hades trust riskeval` reports
  // DEGENERATE, never PASS, for an abstain-all gate).
  //
  // So the real gate is bound ONLY when it can actually ADMIT something for
  // the `"procedure"` domain — the domain `runRiskEval` submits under.
  // "Calibrated" alone is not that test: a conformal fit over a verifier set
  // with no correct-vs-wrong separation honestly returns a threshold of
  // +Infinity, which IS a successful calibration and still abstains on every
  // subject. The real predicate is therefore a FINITE fitted threshold.
  //
  // When it is not met, no admission port is supplied at all, the risk lane
  // stays honestly UNMEASURED with a reason naming the fix, and the gate's
  // `risk-lane-unmeasured` rule blocks. Blocking is the correct outcome: a
  // never-regress gate whose risk lane means nothing must not certify a
  // build as non-regressed.
  const RISK_EVAL_DOMAIN = "procedure";

  let cachedTrust: TrustStack | undefined;
  const trustStack = (): TrustStack => {
    if (cachedTrust === undefined) {
      cachedTrust = opts.trust ? opts.trust() : openTrustStack({ env, ...(opts.root !== undefined ? { dataDir: opts.root } : {}) });
    }
    return cachedTrust;
  };

  const degenerateReason = (detail: string): string =>
    `the real UnifiedTrustGate for this install cannot admit anything in the "${RISK_EVAL_DOMAIN}" domain ` +
    `(${detail}), so every admission would abstain and the lane would report 0 accepted of N attempts -- a ` +
    "degenerate 0-of-0 that would read as a passing silent-wrong rate. Refusing to drive it rather than " +
    "record that as a measurement. Run `hades trust calibrate --from-eval` to fit a real threshold for this " +
    "domain; if that reports NO discrimination (a +Infinity threshold), the registered verifiers genuinely " +
    "cannot separate correct from wrong on this corpus and the honest fix is a better verifier, not a " +
    "looser bound. `hades trust status` shows the current per-domain fit.";

  /** Resolves the admission port at MEASUREMENT time (not at deps-construction
   *  time), so the trust stack is only opened when a measurement really runs
   *  and a calibration performed between two invocations is picked up. */
  function resolveAdmit(): { admit: AdmitFn } | { admit: null; reason: string } {
    if (opts.admit !== undefined) {
      return opts.admit === null
        ? { admit: null, reason: degenerateReason("no admission port was wired by the caller") }
        : { admit: opts.admit };
    }
    let stack: TrustStack;
    try {
      stack = trustStack();
    } catch (err) {
      return {
        admit: null,
        reason:
          "the real trust stack for this install could not be opened, so no admission gate is available to " +
          `drive the risk lane: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!stack.calibratedDomains.includes(RISK_EVAL_DOMAIN)) {
      const why = stack.calibrationErrors[RISK_EVAL_DOMAIN];
      return {
        admit: null,
        reason: degenerateReason(why !== undefined ? `it is not calibrated: ${why}` : "it is not calibrated"),
      };
    }
    // Calibrated is necessary but NOT sufficient — see the note above.
    const threshold = stack.gate.stats()[RISK_EVAL_DOMAIN]?.threshold;
    if (threshold === undefined || !Number.isFinite(threshold)) {
      return {
        admit: null,
        reason: degenerateReason(
          threshold === undefined
            ? "its calibration reports no fitted threshold"
            : `its fitted conformal threshold is ${threshold > 0 ? "+Infinity" : String(threshold)} -- the ` +
              "registered verifiers show no correct-vs-wrong separation at this epsilon",
        ),
      };
    }
    return {
      admit: async (subject) => {
        const admission = await stack.gate.admit(subject as unknown as TrustSubject);
        return admission as unknown as Awaited<ReturnType<AdmitFn>>;
      },
    };
  }

  const measure = async (
    revision: ScorecardRevision,
    mopts?: { label?: string; now?: () => number },
  ): Promise<EvalScorecard> => {
    const def = defaultMeasureRunner();
    const port = resolveAdmit();
    return runEvalMeasurement({
      revision,
      tasks: EVAL_TASKS,
      runner: def.runner,
      runnerLabel: def.label,
      mode: def.mode,
      ...(mopts?.label !== undefined ? { label: mopts.label } : {}),
      ...(mopts?.now !== undefined ? { now: mopts.now } : {}),
      ...(port.admit !== null ? { admit: port.admit } : { unmeasuredReason: port.reason }),
    });
  };

  return {
    root,
    ledger,
    runContinuous: (runOpts) => runContinuousEval(runOpts),
    status: (statusOpts) => evalStatus(statusOpts),
    bisect: (req) => autoBisect(req),
    measure,
    resolveRevision,
    loadPolicy: () => coreLoadPolicy(root),
    savePolicy: (p) => coreSavePolicy(root, p),
    readFile: (p: string) => readFileSync(p, "utf8"),
    fileExists: (p: string) => existsSync(p),
    now: () => Date.now(),
  };
}
