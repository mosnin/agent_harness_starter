/**
 * Hades desktop routing wire protocol (`route.*`).
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the
 * budget-constrained, risk-controlled router (`src/hades/routing/**`) — the
 * same stack `hades route` drives from a terminal, opened over the same
 * `<dataDir>/routing` root, so the desktop app and the CLI share one arm
 * catalog, one measured cost model, one bandit posterior, one budget and one
 * hash-chained routing ledger.
 *
 *  - `route.status`  -> `route.status`  — budget/spend/λ, chain verdict, and
 *    every arm's measured cost, posterior and conformal threshold.
 *  - `route.arms`    -> `route.arms`    — the routable arm space under a
 *    caller-supplied requirement set, WITH the rejection reason for every arm
 *    that did not make the cut.
 *  - `route.explain` -> `route.explain` — how the bandit would rank the
 *    eligible arms for one context. A pure read.
 *  - `route.ledger`  -> `route.ledger`  — per-arm attribution off the
 *    tamper-evident chain.
 *  - any failure     -> `route.error` (never silence, never a fabricated "ok").
 *
 * ## What deliberately never crosses this wire
 *
 * There is no `route.record` and no `route.bench` command, by design:
 *
 *   - `record` MUTATES durable state — it moves the budget, updates a
 *     posterior and appends to a hash-chained ledger. A renderer that could
 *     forge outcomes could forge an arm's whole track record.
 *   - `bench` SPENDS REAL MONEY at a provider. Nothing a renderer sends
 *     should be able to start billing.
 *
 * Both remain reachable from `hades route record|bench`, where the operator is
 * the one issuing the command. `route.explain` is a pure read of the ranking
 * mechanism: it advances the bandit's in-memory PRNG (a Thompson draw is a
 * draw) but records no outcome, moves no money and never persists.
 *
 * ## What this lane will never claim
 *
 * `RouteArmWire.unpriced` and `RouteArmWire.costSource` are first-class,
 * mandatory fields precisely so a renderer cannot draw "$0.0000" over an arm
 * whose price is simply UNKNOWN. "Free" and "unpriced" are different facts and
 * both travel with the data. `riskThresholdFinite: false` likewise marks a
 * stratum that ABSTAINS — `threshold` is `Infinity` there, which does not
 * survive JSON (it becomes `null`), so the boolean is what a renderer must
 * key on.
 *
 * This module mirrors `./market-contract.ts`'s conventions exactly (same guard
 * shapes, same exhaustiveness assertions, same codec error style) and is
 * intentionally standalone — it imports nothing, so merging it into
 * `./contract.ts`'s unions introduces no coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** One routable arm, as the desktop UI understands it. */
export interface RouteArmWire {
  armId: string;
  provider: string;
  modelId: string;
  execTarget: string | null;
  displayName: string;
  contextWindow: number | null;
  /**
   * True when this model has NO published price. A renderer MUST show "n/a"
   * rather than `usdMean`, which would read as "free".
   */
  unpriced: boolean;
  eligible: boolean;
  /** Why it was rejected, or null when eligible. */
  rejectionCode: string | null;
  rejectionDetail: string | null;
  usdMean: number;
  usdP90: number;
  latencyMsMean: number;
  costSamples: number;
  /** `measured` | `priced-prior` | `unpriced` — the provenance of the USD figures. */
  costSource: string;
  pulls: number;
  verified: number;
  pVerifiedMean: number;
  /** 0 for an arm that has never been pulled — nothing was measured. */
  measuredVtphPerDollar: number;
  /**
   * The conformal accept threshold. `Infinity` does not survive JSON, so this
   * is `null` when the stratum abstains — see {@link RouteArmWire.riskThresholdFinite}.
   */
  riskThreshold: number | null;
  /** False ⇒ this stratum ABSTAINS: it has no evidence to accept anything with. */
  riskThresholdFinite: boolean;
  riskSource: string;
  riskCalibrationSize: number;
}

/** The whole router, as the desktop UI understands it. */
export interface RouteStatusWire {
  root: string | null;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  lambda: number;
  seed: number;
  epsilon: number;
  tier: string;
  totalArms: number;
  eligibleArms: number;
  unpricedArms: number;
  ledgerEntries: number;
  /** False when the persisted routing chain did not re-verify and was REFUSED. */
  chainOk: boolean;
  chainCode: string;
  riskStrata: number;
  riskCalibrated: number;
  riskPooledFallbacks: number;
  riskAbstainingStrata: number;
  riskPoints: number;
  verifiersTracked: number;
  arms: RouteArmWire[];
  loadErrors: Array<{ artifact: string; message: string }>;
}

/** An eligibility pass: what is routable, and why everything else is not. */
export interface RouteEligibilityWire {
  promptTokens: number;
  expectedOutputTokens: number;
  eligible: RouteArmWire[];
  rejected: Array<{ armId: string; code: string; detail: string }>;
}

/** One ranked candidate from `route.explain`. */
export interface RouteRankedArmWire {
  armId: string;
  sampledScore: number;
  shadowCost: number;
  estimatedUsd: number;
  unpriced: boolean;
  pulls: number;
  verified: number;
  pVerifiedMean: number;
}

/** How the bandit would rank the eligible arms for one context. */
export interface RouteExplainWire {
  taskId: string;
  category: string;
  difficulty: number;
  decomposable: boolean;
  chosenArmId: string | null;
  reason: string;
  lambda: number;
  budgetRemainingUsd: number;
  ranked: RouteRankedArmWire[];
  rejected: Array<{ armId: string; code: string; detail: string }>;
  /** Always present and non-empty: this call changed nothing durable. */
  note: string;
}

/** Per-arm attribution off the tamper-evident chain. */
export interface RouteAttributionWire {
  armId: string;
  tasks: number;
  verifiedCorrect: number;
  /** claimedVerified but the independent grader said false — the trust-failure metric. */
  silentWrong: number;
  declined: number;
  usd: number;
  wallMs: number;
  vtph: number;
  vtphPerDollar: number;
  escalatedInto: number;
}

export interface RouteLedgerEntryWire {
  seq: number;
  taskId: string;
  category: string;
  armId: string;
  actualUsd: number;
  wallMs: number;
  claimedVerified: boolean;
  graded: boolean | null;
  hash: string;
}

export interface RouteLedgerWire {
  chainOk: boolean;
  chainCode: string;
  chainEntries: number;
  brokenAt: number | null;
  attribution: RouteAttributionWire[];
  entries: RouteLedgerEntryWire[];
}

// ---------------------------------------------------------------------------
// Commands / events
// ---------------------------------------------------------------------------

export type RouteCommand =
  | { kind: "route.status"; tier?: string; promptTokens?: number; expectedOutputTokens?: number }
  | {
      kind: "route.arms";
      promptTokens?: number;
      expectedOutputTokens?: number;
      provider?: string;
      maxUsdPerTask?: number;
      minContextWindow?: number;
      allowUnpriced?: boolean;
    }
  | {
      kind: "route.explain";
      category: string;
      taskId?: string;
      difficulty?: number;
      decomposable?: boolean;
      promptTokens?: number;
      expectedOutputTokens?: number;
    }
  | { kind: "route.ledger"; entries?: number };

export type RouteEvent =
  | { kind: "route.status"; status: RouteStatusWire; at: number }
  | { kind: "route.arms"; eligibility: RouteEligibilityWire; at: number }
  | { kind: "route.explain"; explain: RouteExplainWire; at: number }
  | { kind: "route.ledger"; ledger: RouteLedgerWire; at: number }
  | { kind: "route.error"; op: string; message: string; at: number };

export const ROUTE_COMMAND_KINDS = [
  "route.status",
  "route.arms",
  "route.explain",
  "route.ledger",
] as const satisfies readonly RouteCommand["kind"][];

export const ROUTE_EVENT_KINDS = [
  "route.status",
  "route.arms",
  "route.explain",
  "route.ledger",
  "route.error",
] as const satisfies readonly RouteEvent["kind"][];

// Compile-time exhaustiveness in BOTH directions: a kind added to a union
// without being added to its tuple (or vice versa) fails to type-check.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [Union] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<RouteCommand["kind"], typeof ROUTE_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<RouteEvent["kind"], typeof ROUTE_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive guards (same shape as ./market-contract.ts, including its
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

/** Finite only — a NaN/Infinity would survive JSON round-tripping as `null`
 *  and read as "absent" rather than "broken". */
function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNullableNumber(x: unknown): x is number | null {
  return x === null || isNumber(x);
}

function isNullableString(x: unknown): x is string | null {
  return x === null || isString(x);
}

function isNullableBoolean(x: unknown): x is boolean | null {
  return x === null || isBoolean(x);
}

function isOptionalNumber(x: unknown): x is number | undefined {
  return x === undefined || isNumber(x);
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || isString(x);
}

function isOptionalBoolean(x: unknown): x is boolean | undefined {
  return x === undefined || isBoolean(x);
}

function isArrayOf<T>(x: unknown, guard: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every(guard);
}

function isRejectionArray(
  x: unknown,
): x is Array<{ armId: string; code: string; detail: string }> {
  return (
    Array.isArray(x) &&
    x.every((r) => isPlainObject(r) && isString(r.armId) && isString(r.code) && isString(r.detail))
  );
}

// ---------------------------------------------------------------------------
// View guards
// ---------------------------------------------------------------------------

export function isRouteArmWire(x: unknown): x is RouteArmWire {
  return (
    isPlainObject(x) &&
    isString(x.armId) &&
    isString(x.provider) &&
    isString(x.modelId) &&
    isNullableString(x.execTarget) &&
    isString(x.displayName) &&
    isNullableNumber(x.contextWindow) &&
    isBoolean(x.unpriced) &&
    isBoolean(x.eligible) &&
    isNullableString(x.rejectionCode) &&
    isNullableString(x.rejectionDetail) &&
    isNumber(x.usdMean) &&
    isNumber(x.usdP90) &&
    isNumber(x.latencyMsMean) &&
    isNumber(x.costSamples) &&
    isString(x.costSource) &&
    isNumber(x.pulls) &&
    isNumber(x.verified) &&
    isNumber(x.pVerifiedMean) &&
    isNumber(x.measuredVtphPerDollar) &&
    isNullableNumber(x.riskThreshold) &&
    isBoolean(x.riskThresholdFinite) &&
    // An abstaining stratum has no numeric threshold, and a finite one must
    // carry the number. Rejecting the mismatch here is what stops a renderer
    // from drawing an accept bar for a gate that accepts nothing.
    (x.riskThresholdFinite ? isNumber(x.riskThreshold) : x.riskThreshold === null) &&
    isString(x.riskSource) &&
    isNumber(x.riskCalibrationSize)
  );
}

export function isRouteStatusWire(x: unknown): x is RouteStatusWire {
  return (
    isPlainObject(x) &&
    isNullableString(x.root) &&
    isNumber(x.budgetUsd) &&
    isNumber(x.spentUsd) &&
    isNumber(x.remainingUsd) &&
    isNumber(x.lambda) &&
    isNumber(x.seed) &&
    isNumber(x.epsilon) &&
    isString(x.tier) &&
    isNumber(x.totalArms) &&
    isNumber(x.eligibleArms) &&
    isNumber(x.unpricedArms) &&
    isNumber(x.ledgerEntries) &&
    isBoolean(x.chainOk) &&
    isString(x.chainCode) &&
    isNumber(x.riskStrata) &&
    isNumber(x.riskCalibrated) &&
    isNumber(x.riskPooledFallbacks) &&
    isNumber(x.riskAbstainingStrata) &&
    isNumber(x.riskPoints) &&
    isNumber(x.verifiersTracked) &&
    isArrayOf(x.arms, isRouteArmWire) &&
    Array.isArray(x.loadErrors) &&
    x.loadErrors.every((e) => isPlainObject(e) && isString(e.artifact) && isString(e.message))
  );
}

export function isRouteEligibilityWire(x: unknown): x is RouteEligibilityWire {
  return (
    isPlainObject(x) &&
    isNumber(x.promptTokens) &&
    isNumber(x.expectedOutputTokens) &&
    isArrayOf(x.eligible, isRouteArmWire) &&
    isRejectionArray(x.rejected)
  );
}

export function isRouteRankedArmWire(x: unknown): x is RouteRankedArmWire {
  return (
    isPlainObject(x) &&
    isString(x.armId) &&
    isNumber(x.sampledScore) &&
    isNumber(x.shadowCost) &&
    isNumber(x.estimatedUsd) &&
    isBoolean(x.unpriced) &&
    isNumber(x.pulls) &&
    isNumber(x.verified) &&
    isNumber(x.pVerifiedMean)
  );
}

export function isRouteExplainWire(x: unknown): x is RouteExplainWire {
  return (
    isPlainObject(x) &&
    isString(x.taskId) &&
    isString(x.category) &&
    isNumber(x.difficulty) &&
    isBoolean(x.decomposable) &&
    isNullableString(x.chosenArmId) &&
    isString(x.reason) &&
    isNumber(x.lambda) &&
    isNumber(x.budgetRemainingUsd) &&
    isArrayOf(x.ranked, isRouteRankedArmWire) &&
    isRejectionArray(x.rejected) &&
    // Non-empty is REQUIRED: the note is what tells a reader that an explain
    // view is a hypothetical and moved nothing.
    isString(x.note) &&
    x.note.length > 0
  );
}

export function isRouteAttributionWire(x: unknown): x is RouteAttributionWire {
  return (
    isPlainObject(x) &&
    isString(x.armId) &&
    isNumber(x.tasks) &&
    isNumber(x.verifiedCorrect) &&
    isNumber(x.silentWrong) &&
    isNumber(x.declined) &&
    isNumber(x.usd) &&
    isNumber(x.wallMs) &&
    isNumber(x.vtph) &&
    isNumber(x.vtphPerDollar) &&
    isNumber(x.escalatedInto)
  );
}

export function isRouteLedgerEntryWire(x: unknown): x is RouteLedgerEntryWire {
  return (
    isPlainObject(x) &&
    isNumber(x.seq) &&
    isString(x.taskId) &&
    isString(x.category) &&
    isString(x.armId) &&
    isNumber(x.actualUsd) &&
    isNumber(x.wallMs) &&
    isBoolean(x.claimedVerified) &&
    isNullableBoolean(x.graded) &&
    isString(x.hash)
  );
}

export function isRouteLedgerWire(x: unknown): x is RouteLedgerWire {
  return (
    isPlainObject(x) &&
    isBoolean(x.chainOk) &&
    isString(x.chainCode) &&
    isNumber(x.chainEntries) &&
    isNullableNumber(x.brokenAt) &&
    isArrayOf(x.attribution, isRouteAttributionWire) &&
    isArrayOf(x.entries, isRouteLedgerEntryWire)
  );
}

// ---------------------------------------------------------------------------
// Command / event guards
// ---------------------------------------------------------------------------

export function isRouteCommand(x: unknown): x is RouteCommand {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "route.status":
      return isOptionalString(x.tier) && isOptionalNumber(x.promptTokens) && isOptionalNumber(x.expectedOutputTokens);
    case "route.arms":
      return (
        isOptionalNumber(x.promptTokens) &&
        isOptionalNumber(x.expectedOutputTokens) &&
        isOptionalString(x.provider) &&
        isOptionalNumber(x.maxUsdPerTask) &&
        isOptionalNumber(x.minContextWindow) &&
        isOptionalBoolean(x.allowUnpriced)
      );
    case "route.explain":
      return (
        isString(x.category) &&
        x.category.length > 0 &&
        isOptionalString(x.taskId) &&
        isOptionalNumber(x.difficulty) &&
        isOptionalBoolean(x.decomposable) &&
        isOptionalNumber(x.promptTokens) &&
        isOptionalNumber(x.expectedOutputTokens)
      );
    case "route.ledger":
      return isOptionalNumber(x.entries);
    default:
      return false;
  }
}

export function isRouteEvent(x: unknown): x is RouteEvent {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "route.status":
      return isRouteStatusWire(x.status) && isNumber(x.at);
    case "route.arms":
      return isRouteEligibilityWire(x.eligibility) && isNumber(x.at);
    case "route.explain":
      return isRouteExplainWire(x.explain) && isNumber(x.at);
    case "route.ledger":
      return isRouteLedgerWire(x.ledger) && isNumber(x.at);
    case "route.error":
      return isString(x.op) && isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}
