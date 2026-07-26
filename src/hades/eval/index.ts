/**
 * @module hades/eval
 *
 * The continuous-eval subsystem — the loop that makes "this build got worse"
 * a mechanically detected, mechanically refused event rather than something a
 * human notices three weeks later.
 *
 * The pieces, in dependency order:
 *
 *  1. **`./scorecard`** — `EvalScorecard`: the canonical, hash-sealed record
 *     of one measurement. Its canonical form is deliberately non-finite-safe,
 *     because an UNMEASURED lane reports `NaN` and says why, never a
 *     fabricated `0` that would read as a passing measurement.
 *  2. **`./measure`** — `runEvalMeasurement`: drives the REAL `runVtph` over
 *     the real `EVAL_TASKS`, and the REAL `runRiskEval` epsilon lane whenever
 *     a real `AdmitFn` is wired. No number in a scorecard is re-derived here.
 *  3. **`./revision`** — real `git` revision resolution plus a work-tree
 *     fingerprint, so a scorecard is bound to the exact code that produced it
 *     (including whether the tree was dirty).
 *  4. **`./history`** — `EvalHistoryLedger`: a SHA-256 hash-chained,
 *     tamper-evident, cross-process-locked JSONL ledger of every recorded
 *     measurement.
 *  5. **`./compare`** — baseline selection, paired deltas, an exact McNemar
 *     test (never a chi-square approximation, never a hardcoded p) and a
 *     two-sided CUSUM changepoint detector over the V-TPH$ trend.
 *  6. **`./regression-gate`** — the never-regress gate: a normalized,
 *     hashed policy, eleven named rules, real waiver governance, sealed
 *     verdicts, and a hash-chained verdict journal. Every structural
 *     adversarial case (invalid scorecard, broken chain, missing baseline,
 *     incomparable suites, unmeasured risk lane) fails CLOSED.
 *  7. **`./bisect`** — `autoBisect`: a genuine binary search over recorded
 *     history for the earliest revision that flips a regression predicate,
 *     with honest confidence (`exact` / `bracketed` / `ambiguous`).
 *  8. **`./continuous`** — `runContinuousEval`: measure -> record -> verify
 *     chain -> select baseline -> gate -> journal -> localize, as pure
 *     composition over the modules above.
 *  9. **`./json-line`** — the NaN-safe JSONL codec both hash-chained ledgers
 *     persist through, so what lands on disk decodes back to exactly the
 *     value that was hashed.
 *
 * The terminal surface over all of this is `hades eval`
 * (`../cli/eval-command`, wired to the real engine by `../cli/eval-deps`).
 */

export * from "./scorecard";
export * from "./measure";
export * from "./revision";
export * from "./history";
export * from "./compare";
export * from "./bisect";
export * from "./continuous";
export * from "./json-line";

// `./regression-gate` is re-exported explicitly rather than with `export *`
// for exactly one reason: its `GateDecision` (the never-regress verdict —
// "allow" | "warn" | "block") collides by name with STYX's long-standing
// `GateDecision` (the conformal gate's emit/abstain decision, exported from
// `../styx/index`). Both are load-bearing names in their own subsystem, so
// neither is renamed at its source; the eval one is surfaced through this
// barrel as `EvalGateDecision` so the root `src/hades/index.ts` barrel stays
// unambiguous. Importing `./regression-gate` directly still gives you the
// original name.
export {
  EVAL_GATE_VERSION,
  EVAL_GATE_GENESIS,
  DEFAULT_NEVER_REGRESS_POLICY,
  normalizePolicy,
  policyHash,
  savePolicy,
  loadPolicy,
  evaluateNeverRegressGate,
  verifyGateVerdict,
  formatGateVerdict,
  GateJournalCorruptionError,
  GateJournalVersionError,
  GateJournalVerdictError,
  GateVerdictJournal,
} from "./regression-gate";
export type {
  GateDecision as EvalGateDecision,
  GateSeverity,
  GateWaiver,
  NeverRegressPolicy,
  GateFinding,
  GateVerdict,
  GateEvaluateInput,
  GateFsDeps,
} from "./regression-gate";
