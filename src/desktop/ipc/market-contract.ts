/**
 * Hades desktop verified-work-market wire protocol (`market.*`).
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the market
 * (`src/hades/market/**`) — the same stack `hades market` drives from a
 * terminal, opened over the same `<dataDir>/market` root and trusting the
 * same `<dataDir>/trust/signing-key` identity, so the desktop app and the
 * CLI share one reputation ledger, one economy, one certificate replay
 * registry and one trusted issuer.
 *
 *  - `market.status`     -> `market.status`     — trusted issuer, treasury,
 *    every participant's balance/escrow/standing/reputation, the chain
 *    verdict and any artifact load errors.
 *  - `market.reputation` -> `market.reputation` — the Murphy decomposition
 *    and calibration curve for one participant (or all of them), measured
 *    from the real hash-chained ledger.
 *  - `market.book`       -> `market.book`       — clear a trust-gated
 *    second-price round over caller-supplied orders/offers.
 *  - `market.simulate`   -> `market.simulated`  — the LABELLED simulation.
 *  - any failure         -> `market.error` (never silence, never a fabricated "ok").
 *
 * ## What deliberately never crosses this wire
 *
 * The ed25519 PRIVATE key, and certificates themselves. `MarketStatusView`
 * carries the PUBLIC issuer key only. Certificates are bound to one exact
 * output text; adjudicating one is the CLI/sidecar's job, not something a
 * renderer should be able to trigger by shipping signed artifacts around.
 * `market.book` is a pure read of the ranking mechanism — it never settles
 * money, never mutates escrow and never records a reputation event.
 *
 * ## What this lane will never claim
 *
 * `MarketParticipantWire.scoreDefined` is a first-class field precisely so a
 * renderer cannot draw "reputation 0.00" over a participant whose Brier
 * SKILL score is mathematically UNDEFINED (no realized-outcome variance
 * yet). "Not scoreable" and "scored terribly" are different facts and both
 * travel with the data. `MarketSimulationView.modelLabel` is likewise
 * mandatory and non-empty: every simulated number this lane emits arrives
 * carrying its own "this is a model" banner.
 *
 * This module mirrors `./trust-contract.ts`'s conventions exactly (same
 * guard shapes, same exhaustiveness assertions, same codec error style) and
 * is intentionally standalone — it imports nothing, so merging it into
 * `./contract.ts`'s unions introduces no coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** One market participant, as the desktop UI understands it. */
export interface MarketParticipantWire {
  id: string;
  kind: string;
  balance: number;
  escrowed: number;
  /** `active` | `probation` | `demoted` | `banned`. */
  standing: string;
  settledN: number;
  fabricatedN: number;
  /** Null when the participant has no recorded reputation events at all. */
  score: number | null;
  /**
   * False when the Brier SKILL score is mathematically undefined for this
   * participant (their realized outcomes carry no variance yet). A renderer
   * MUST show "n/a" rather than `score` when this is false.
   */
  scoreDefined: boolean;
  n: number;
  passRate: number | null;
  brier: number | null;
  decayedBrier: number | null;
  calibrationGap: number | null;
}

/** The whole market, as the desktop UI understands it. */
export interface MarketStatusWire {
  root: string | null;
  /** The PUBLIC half only. Empty string when this install has no identity yet. */
  issuerPublicKeyHex: string;
  /** `env` | `persisted` | `absent` — a label, never a path. */
  issuerKeySource: string;
  trustedIssuers: string[];
  acceptedTiers: string[];
  maxEpsilon: number;
  requireTraceBinding: boolean;
  treasury: number;
  totalTokens: number;
  participants: MarketParticipantWire[];
  openAwards: number;
  settlements: number;
  fabrications: number;
  certificatesSpent: number;
  /** False when the persisted reputation chain did not re-verify and was REFUSED. */
  chainOk: boolean;
  loadErrors: Array<{ artifact: string; message: string }>;
}

/** One participant's measured reputation detail. */
export interface MarketReputationWire {
  participantId: string;
  kind: string;
  n: number;
  verifiedN: number;
  fabricatedN: number;
  brier: number;
  decayedBrier: number;
  reliability: number;
  resolution: number;
  uncertainty: number;
  passRate: number;
  wilsonLower: number;
  meanClaim: number;
  calibrationGap: number;
  score: number;
  /** See {@link MarketParticipantWire.scoreDefined}. */
  scoreDefined: boolean;
  standingHint: string;
  calibration: Array<{ lo: number; hi: number; n: number; meanClaim: number; observedRate: number }>;
}

/** One cleared match from a `market.book` round. */
export interface MarketMatchWire {
  taskId: string;
  participantId: string;
  offerPrice: number;
  clearingPrice: number;
  claimedPCorrect: number;
  /** The claim AFTER reputation shrinkage — what the ranking actually used. */
  adjustedPCorrect: number;
  expectedVerifiedValue: number;
  reputationScore: number;
  runnerUpId: string | null;
}

/** A whole clearing round. */
export interface MarketBookWire {
  now: number;
  matches: MarketMatchWire[];
  unmatched: Array<{ taskId: string; reason: string }>;
  rejected: Array<{ participantId: string; taskId: string; reason: string; detail: string }>;
}

/** The labelled convergence simulation. */
export interface MarketSimulationWire {
  /** Mandatory, non-empty: every number below is SIMULATED, and says so. */
  modelLabel: string;
  seed: number;
  rounds: number;
  tasksPerRound: number;
  spearman: number;
  convergedAtRound: number | null;
  participants: Array<{
    participantId: string;
    archetype: string;
    trueReliability: number;
    score: number;
    standing: string;
    wins: number;
    fabricationsCaught: number;
  }>;
  report: string[];
}

// ---------------------------------------------------------------------------
// Commands / events
// ---------------------------------------------------------------------------

export type MarketCommand =
  | { kind: "market.status" }
  | { kind: "market.reputation"; participantId?: string; bins?: number }
  | { kind: "market.book"; orders: unknown[]; offers: unknown[]; now: number }
  | { kind: "market.simulate"; seed?: number; rounds?: number; tasksPerRound?: number };

export type MarketEvent =
  | { kind: "market.status"; status: MarketStatusWire; at: number }
  | { kind: "market.reputation"; participants: MarketReputationWire[]; at: number }
  | { kind: "market.book"; book: MarketBookWire; at: number }
  | { kind: "market.simulated"; simulation: MarketSimulationWire; at: number }
  | { kind: "market.error"; op: string; message: string; at: number };

export const MARKET_COMMAND_KINDS = [
  "market.status",
  "market.reputation",
  "market.book",
  "market.simulate",
] as const satisfies readonly MarketCommand["kind"][];

export const MARKET_EVENT_KINDS = [
  "market.status",
  "market.reputation",
  "market.book",
  "market.simulated",
  "market.error",
] as const satisfies readonly MarketEvent["kind"][];

// Compile-time exhaustiveness in BOTH directions: a kind added to a union
// without being added to its tuple (or vice versa) fails to type-check.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [Union] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;
const _commandKindsExact: ExactlyKindsOf<MarketCommand["kind"], typeof MARKET_COMMAND_KINDS> = true;
const _eventKindsExact: ExactlyKindsOf<MarketEvent["kind"], typeof MARKET_EVENT_KINDS> = true;
void _commandKindsExact;
void _eventKindsExact;

// ---------------------------------------------------------------------------
// Primitive guards (same shape as ./trust-contract.ts, including its
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

function isOptionalNumber(x: unknown): x is number | undefined {
  return x === undefined || isNumber(x);
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || isString(x);
}

function isArrayOf<T>(x: unknown, guard: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every(guard);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isString);
}

// ---------------------------------------------------------------------------
// View guards
// ---------------------------------------------------------------------------

export function isMarketParticipantWire(x: unknown): x is MarketParticipantWire {
  return (
    isPlainObject(x) &&
    isString(x.id) &&
    isString(x.kind) &&
    isNumber(x.balance) &&
    isNumber(x.escrowed) &&
    isString(x.standing) &&
    isNumber(x.settledN) &&
    isNumber(x.fabricatedN) &&
    isNullableNumber(x.score) &&
    isBoolean(x.scoreDefined) &&
    isNumber(x.n) &&
    isNullableNumber(x.passRate) &&
    isNullableNumber(x.brier) &&
    isNullableNumber(x.decayedBrier) &&
    isNullableNumber(x.calibrationGap)
  );
}

export function isMarketStatusWire(x: unknown): x is MarketStatusWire {
  return (
    isPlainObject(x) &&
    (x.root === null || isString(x.root)) &&
    isString(x.issuerPublicKeyHex) &&
    isString(x.issuerKeySource) &&
    isStringArray(x.trustedIssuers) &&
    isStringArray(x.acceptedTiers) &&
    isNumber(x.maxEpsilon) &&
    isBoolean(x.requireTraceBinding) &&
    isNumber(x.treasury) &&
    isNumber(x.totalTokens) &&
    isArrayOf(x.participants, isMarketParticipantWire) &&
    isNumber(x.openAwards) &&
    isNumber(x.settlements) &&
    isNumber(x.fabrications) &&
    isNumber(x.certificatesSpent) &&
    isBoolean(x.chainOk) &&
    Array.isArray(x.loadErrors) &&
    x.loadErrors.every((e) => isPlainObject(e) && isString(e.artifact) && isString(e.message))
  );
}

export function isMarketReputationWire(x: unknown): x is MarketReputationWire {
  return (
    isPlainObject(x) &&
    isString(x.participantId) &&
    isString(x.kind) &&
    isNumber(x.n) &&
    isNumber(x.verifiedN) &&
    isNumber(x.fabricatedN) &&
    isNumber(x.brier) &&
    isNumber(x.decayedBrier) &&
    isNumber(x.reliability) &&
    isNumber(x.resolution) &&
    isNumber(x.uncertainty) &&
    isNumber(x.passRate) &&
    isNumber(x.wilsonLower) &&
    isNumber(x.meanClaim) &&
    isNumber(x.calibrationGap) &&
    isNumber(x.score) &&
    isBoolean(x.scoreDefined) &&
    isString(x.standingHint) &&
    Array.isArray(x.calibration) &&
    x.calibration.every(
      (b) =>
        isPlainObject(b) &&
        isNumber(b.lo) &&
        isNumber(b.hi) &&
        isNumber(b.n) &&
        isNumber(b.meanClaim) &&
        isNumber(b.observedRate),
    )
  );
}

export function isMarketMatchWire(x: unknown): x is MarketMatchWire {
  return (
    isPlainObject(x) &&
    isString(x.taskId) &&
    isString(x.participantId) &&
    isNumber(x.offerPrice) &&
    isNumber(x.clearingPrice) &&
    isNumber(x.claimedPCorrect) &&
    isNumber(x.adjustedPCorrect) &&
    isNumber(x.expectedVerifiedValue) &&
    isNumber(x.reputationScore) &&
    (x.runnerUpId === null || isString(x.runnerUpId))
  );
}

export function isMarketBookWire(x: unknown): x is MarketBookWire {
  return (
    isPlainObject(x) &&
    isNumber(x.now) &&
    isArrayOf(x.matches, isMarketMatchWire) &&
    Array.isArray(x.unmatched) &&
    x.unmatched.every((u) => isPlainObject(u) && isString(u.taskId) && isString(u.reason)) &&
    Array.isArray(x.rejected) &&
    x.rejected.every(
      (r) =>
        isPlainObject(r) &&
        isString(r.participantId) &&
        isString(r.taskId) &&
        isString(r.reason) &&
        isString(r.detail),
    )
  );
}

export function isMarketSimulationWire(x: unknown): x is MarketSimulationWire {
  return (
    isPlainObject(x) &&
    // Non-empty is REQUIRED: a simulation view without its model banner must
    // never validate, because a renderer would then draw synthetic numbers
    // with nothing marking them as synthetic.
    isString(x.modelLabel) &&
    x.modelLabel.length > 0 &&
    isNumber(x.seed) &&
    isNumber(x.rounds) &&
    isNumber(x.tasksPerRound) &&
    isNumber(x.spearman) &&
    isNullableNumber(x.convergedAtRound) &&
    Array.isArray(x.participants) &&
    x.participants.every(
      (p) =>
        isPlainObject(p) &&
        isString(p.participantId) &&
        isString(p.archetype) &&
        isNumber(p.trueReliability) &&
        isNumber(p.score) &&
        isString(p.standing) &&
        isNumber(p.wins) &&
        isNumber(p.fabricationsCaught),
    ) &&
    isStringArray(x.report)
  );
}

// ---------------------------------------------------------------------------
// Command / event guards
// ---------------------------------------------------------------------------

export function isMarketCommand(x: unknown): x is MarketCommand {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "market.status":
      return true;
    case "market.reputation":
      return isOptionalString(x.participantId) && isOptionalNumber(x.bins);
    case "market.book":
      // `orders`/`offers` are deliberately `unknown[]`: the REAL engine's own
      // structural validation is the authority on what a usable TaskOrder /
      // WorkOffer is, and it reports every rejection with a documented code.
      // Re-deriving those rules here would be a second, drifting copy.
      return Array.isArray(x.orders) && Array.isArray(x.offers) && isNumber(x.now);
    case "market.simulate":
      return isOptionalNumber(x.seed) && isOptionalNumber(x.rounds) && isOptionalNumber(x.tasksPerRound);
    default:
      return false;
  }
}

export function isMarketEvent(x: unknown): x is MarketEvent {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "market.status":
      return isMarketStatusWire(x.status) && isNumber(x.at);
    case "market.reputation":
      return isArrayOf(x.participants, isMarketReputationWire) && isNumber(x.at);
    case "market.book":
      return isMarketBookWire(x.book) && isNumber(x.at);
    case "market.simulated":
      return isMarketSimulationWire(x.simulation) && isNumber(x.at);
    case "market.error":
      return isString(x.op) && isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}
