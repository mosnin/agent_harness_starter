/**
 * Hades desktop trust-gate wire protocol (`trust.*`).
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the unified
 * trust gate (`src/hades/trust/**`) — the same stack `hades trust` drives
 * from a terminal, opened over the same `<dataDir>/trust` root, so the
 * desktop app and the CLI share one verifier registry, one ed25519 signing
 * identity, one hash-chained budget and one persisted calibration.
 *
 *  - `trust.status`    -> `trust.status`    — verifier set, per-domain
 *    calibration (including an explicitly-flagged +Infinity threshold), the
 *    budget report and the independent chain verdict.
 *  - `trust.verifiers` -> `trust.verifiers` — every registered verifier with
 *    its REGISTERED tier and prior ceiling.
 *  - `trust.calibrate` -> `trust.calibrated` — fit a domain from REAL
 *    labeled observations derived from the real eval corpus. It carries
 *    `confirm: true` explicitly: a renderer that forgets it gets a dry-run
 *    preview, never a silent overwrite of the persisted calibration —
 *    exactly like `--dry-run`/absence of it on the CLI.
 *  - `trust.budget`    -> `trust.budget`    — budget report + chain verdict.
 *  - any failure       -> `trust.error` (never silence, never a fabricated "ok").
 *
 * ## What deliberately never crosses this wire
 *
 * The ed25519 PRIVATE key. `TrustStatusView.publicKeyHex` is the public half
 * only, and `keySource` is a label (`env`/`persisted`/`generated`/`ephemeral`),
 * never a path and never key material. Certificates themselves are not
 * pushed over this lane either: a certificate is bound to one exact output
 * text, and this lane's job is reporting the gate's configuration and
 * accounting, not shipping signed artifacts around.
 *
 * ## What this lane will never claim
 *
 * `TrustDomainView` carries `thresholdIsInfinite` and `auc` as first-class
 * fields precisely so a renderer cannot draw "calibrated ✓" over a gate that
 * abstains on everything, or over a threshold fitted on scores with no
 * correct-vs-wrong separation. Both facts travel with the data.
 *
 * This module mirrors `./migrate-contract.ts`'s conventions exactly (same
 * guard shapes, same exhaustiveness assertions, same codec error style) and
 * is intentionally standalone — it imports nothing, so merging it into
 * `./contract.ts`'s unions introduces no coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** One registered verifier, as the desktop UI understands it. */
export interface TrustVerifierView {
  id: string;
  version: string;
  domain: string;
  /** The REGISTERED tier — a verdict may never claim a stronger one. */
  tier: string;
  /** The REGISTERED prior — a hard ceiling on every confidence it emits. */
  prior: number;
}

/** One trust domain's calibration state. */
export interface TrustDomainView {
  domain: string;
  verifiers: number;
  calibrated: boolean;
  /** Number of REAL labeled (score, correct) observations backing the fit. */
  points: number;
  /** Null when uncalibrated; +Infinity is transported as null plus the flag below. */
  threshold: number | null;
  /** True when the fit admits NOTHING — the gate abstains on this whole domain. */
  thresholdIsInfinite: boolean;
  epsilon: number | null;
  /**
   * Rank AUC of correct-vs-wrong on the stored points, or null when one
   * class is empty. `0.5` means the verifiers carry no correctness signal
   * at all, so a "calibrated" badge would be misleading without it.
   */
  auc: number | null;
  /** Plain-English separation verdict, safe to render verbatim. */
  separation: string;
  /** Where the stored points actually came from. */
  provenance?: string;
  /** Why a stored calibration could not be applied, when that happened. */
  error?: string;
}

/** Budget accounting + the independent chain verdict. */
export interface TrustBudgetView {
  totalRisk: number;
  spentRisk: number;
  remainingRisk: number;
  exhausted: boolean;
  entries: number;
  chainRoot: string;
  chainHead: string;
  chainOk: boolean;
  chainReason?: string;
  chainFirstBadSeq?: number;
  perDomain: Array<{ domain: string; cap: number | null; spent: number; remaining: number | null; admissions: number }>;
}

/** The whole gate, as the desktop UI understands it. */
export interface TrustStatusView {
  root: string | null;
  epsilon: number;
  /** `env` | `persisted` | `generated` | `ephemeral` — a label, never a path. */
  keySource: string;
  /** The PUBLIC half only. */
  publicKeyHex: string;
  verifierCount: number;
  domains: TrustDomainView[];
  budget: TrustBudgetView | null;
  /** Present when the persisted calibration file could not be read. */
  calibrationLoadError: string | null;
}

/** The outcome of a calibration fit. */
export interface TrustCalibrationView {
  domain: string;
  points: number;
  correct: number;
  wrong: number;
  auc: number | null;
  separation: string;
  threshold: number | null;
  thresholdIsInfinite: boolean;
  epsilon: number | null;
  /** False for a dry run, or when the real ConformalGate refused the fit. */
  persisted: boolean;
  dryRun: boolean;
  /** The real refusal message when the fit was rejected; null when it fitted. */
  fitError: string | null;
  provenance: string;
  /** Observations dropped because a solver/grader threw — never counted correct. */
  droppedObservations: number;
}

// ---------------------------------------------------------------------------
// Commands / events
// ---------------------------------------------------------------------------

export type TrustCommand =
  | { kind: "trust.status" }
  | { kind: "trust.verifiers"; domain?: string }
  | { kind: "trust.calibrate"; domain?: string; confirm: boolean }
  | { kind: "trust.budget" };

export type TrustEvent =
  | { kind: "trust.status"; status: TrustStatusView; at: number }
  | { kind: "trust.verifiers"; verifiers: TrustVerifierView[]; at: number }
  | { kind: "trust.calibrated"; result: TrustCalibrationView; at: number }
  | { kind: "trust.budget"; budget: TrustBudgetView; at: number }
  | { kind: "trust.error"; op: string; message: string; at: number };

export const TRUST_COMMAND_KINDS = [
  "trust.status",
  "trust.verifiers",
  "trust.calibrate",
  "trust.budget",
] as const satisfies readonly TrustCommand["kind"][];

export const TRUST_EVENT_KINDS = [
  "trust.status",
  "trust.verifiers",
  "trust.calibrated",
  "trust.budget",
  "trust.error",
] as const satisfies readonly TrustEvent["kind"][];

// Compile-time exhaustiveness in BOTH directions: a kind added to a union
// without being added to its tuple (or vice versa) fails to type-check.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [Union] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<TrustCommand["kind"], typeof TRUST_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<TrustEvent["kind"], typeof TRUST_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive guards (same shape as ./migrate-contract.ts, including its
// prototype-pollution rejection — these payloads cross a process boundary)
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  for (const k of Object.keys(x as object)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return false;
  }
  return true;
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

/** Finite only: a NaN/Infinity that reached a renderer would render as junk
 *  and, worse, would survive JSON round-tripping as `null` and read as
 *  "absent" rather than "broken". +Infinity thresholds travel as an explicit
 *  `null` + `thresholdIsInfinite: true` pair for exactly this reason. */
function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || isString(x);
}

function isArrayOf<T>(x: unknown, guard: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every(guard);
}

// ---------------------------------------------------------------------------
// View guards
// ---------------------------------------------------------------------------

export function isTrustVerifierView(x: unknown): x is TrustVerifierView {
  return (
    isPlainObject(x) &&
    isString(x.id) &&
    isString(x.version) &&
    isString(x.domain) &&
    isString(x.tier) &&
    isNumber(x.prior)
  );
}

export function isTrustDomainView(x: unknown): x is TrustDomainView {
  return (
    isPlainObject(x) &&
    isString(x.domain) &&
    isNumber(x.verifiers) &&
    isBoolean(x.calibrated) &&
    isNumber(x.points) &&
    isNullableNumber(x.threshold) &&
    isBoolean(x.thresholdIsInfinite) &&
    isNullableNumber(x.epsilon) &&
    isNullableNumber(x.auc) &&
    isString(x.separation) &&
    isOptionalString(x.provenance) &&
    isOptionalString(x.error)
  );
}

export function isTrustBudgetView(x: unknown): x is TrustBudgetView {
  return (
    isPlainObject(x) &&
    isNumber(x.totalRisk) &&
    isNumber(x.spentRisk) &&
    isNumber(x.remainingRisk) &&
    isBoolean(x.exhausted) &&
    isNumber(x.entries) &&
    isString(x.chainRoot) &&
    isString(x.chainHead) &&
    isBoolean(x.chainOk) &&
    isOptionalString(x.chainReason) &&
    (x.chainFirstBadSeq === undefined || isNumber(x.chainFirstBadSeq)) &&
    Array.isArray(x.perDomain) &&
    x.perDomain.every(
      (d) =>
        isPlainObject(d) &&
        isString(d.domain) &&
        isNullableNumber(d.cap) &&
        isNumber(d.spent) &&
        isNullableNumber(d.remaining) &&
        isNumber(d.admissions),
    )
  );
}

export function isTrustStatusView(x: unknown): x is TrustStatusView {
  return (
    isPlainObject(x) &&
    (x.root === null || isString(x.root)) &&
    isNumber(x.epsilon) &&
    isString(x.keySource) &&
    isString(x.publicKeyHex) &&
    isNumber(x.verifierCount) &&
    isArrayOf(x.domains, isTrustDomainView) &&
    (x.budget === null || isTrustBudgetView(x.budget)) &&
    (x.calibrationLoadError === null || isString(x.calibrationLoadError))
  );
}

export function isTrustCalibrationView(x: unknown): x is TrustCalibrationView {
  return (
    isPlainObject(x) &&
    isString(x.domain) &&
    isNumber(x.points) &&
    isNumber(x.correct) &&
    isNumber(x.wrong) &&
    isNullableNumber(x.auc) &&
    isString(x.separation) &&
    isNullableNumber(x.threshold) &&
    isBoolean(x.thresholdIsInfinite) &&
    isNullableNumber(x.epsilon) &&
    isBoolean(x.persisted) &&
    isBoolean(x.dryRun) &&
    (x.fitError === null || isString(x.fitError)) &&
    isString(x.provenance) &&
    isNumber(x.droppedObservations)
  );
}

// ---------------------------------------------------------------------------
// Command / event guards
// ---------------------------------------------------------------------------

export function isTrustCommand(x: unknown): x is TrustCommand {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "trust.status":
    case "trust.budget":
      return true;
    case "trust.verifiers":
      return isOptionalString(x.domain);
    case "trust.calibrate":
      // `confirm` is REQUIRED (and must be a real boolean): calibrating is
      // the one command here that PERSISTS, so it can never be reached by a
      // payload that merely forgot a field. A `false` is a dry run.
      return isBoolean(x.confirm) && isOptionalString(x.domain);
    default:
      return false;
  }
}

export function isTrustEvent(x: unknown): x is TrustEvent {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "trust.status":
      return isTrustStatusView(x.status) && isNumber(x.at);
    case "trust.verifiers":
      return isArrayOf(x.verifiers, isTrustVerifierView) && isNumber(x.at);
    case "trust.calibrated":
      return isTrustCalibrationView(x.result) && isNumber(x.at);
    case "trust.budget":
      return isTrustBudgetView(x.budget) && isNumber(x.at);
    case "trust.error":
      return isString(x.op) && isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}
