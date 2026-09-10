/**
 * reputation — the Brier-scored reputation kernel every other market module
 * (claims adjudication, worker selection, standing/demotion policy) reads.
 *
 * A hash-chained, tamper-evident, append-only ledger of forecast/outcome
 * events per participant. On top of the raw chain it computes, per
 * participant:
 *
 *  - A Murphy decomposition of the classic Brier score (reliability /
 *    resolution / uncertainty — see {@link brierDecomposition}), which is
 *    what makes "resolution, not luck, pays" a provable property rather than
 *    a slogan: a forecaster who never distinguishes hard cases from easy
 *    ones has zero resolution and cannot out-score a genuinely
 *    well-calibrated, differentiating forecaster no matter how large their
 *    task-pool's base rate is.
 *  - An exponentially time-decayed, difficulty-weighted "decayed Brier" used
 *    as the scoring numerator, normalized (Brier-Skill-Score style) against
 *    the *realized* uncertainty of that participant's own task pool — a
 *    participant who only ever forecasts on near-certain (difficulty near 0
 *    or 1) tasks earns almost no credit even for a near-zero raw Brier,
 *    because their own outcome distribution carries almost no uncertainty to
 *    beat.
 *  - Population-prior shrinkage (pseudo-count `priorStrength`) toward the
 *    ledger-wide pooled calibration, so a fresh identity with a handful of
 *    lucky events cannot leapfrog an established, well-evidenced track
 *    record.
 *  - A hard, unconditional zero whenever a participant has ANY adjudged
 *    fabrication — no averaging, no amortizing it away with volume.
 *
 * REAL-VS-MOCK POLICY: pure and fully deterministic. No `Math.random`, no
 * `Date.now`, no `node:fs`, no network. `at` (per event) and `asOf` (per
 * query) are always caller-provided; when `asOf` is omitted this module
 * defaults it to the latest `at` seen anywhere in the ledger (never to the
 * wall clock). Persistence is `serialize()`/`deserialize()` on strings only
 * — the parent process owns all file I/O. Hashing is REAL sha256 via
 * {@link sha256Hex} from `../styx/certificate` (itself backed by
 * `node:crypto`) — no home-rolled crypto.
 */

import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Locked contract — types
// ---------------------------------------------------------------------------

export type ParticipantId = string;

export type ParticipantKind = "agent" | "worker" | "provider" | "procedure" | "tool";

/**
 * Advisory participant standing. Declared here because every module that
 * reads reputation needs the type; the *transition logic* (when/why a
 * participant moves between these) belongs to T3, not this file. This
 * module only ever emits an advisory `standingHint` — it never enforces
 * anything.
 */
export type Standing = "active" | "probation" | "demoted" | "banned";

export interface ReputationEvent {
  participantId: ParticipantId;
  kind: ParticipantKind;
  taskId: string;
  /** [0,1], forecast made BEFORE the outcome. */
  claimedP: number;
  /** 1 iff independently verified pass. */
  outcome: 0 | 1;
  certified: boolean;
  fabricated?: boolean;
  /** [0,1] base rate of the task pool, default 0.5. */
  difficulty?: number;
  /** stake weight > 0, default 1. */
  weight?: number;
  /** ms epoch, caller-provided. */
  at: number;
  certSha256?: string;
}

export interface ReputationLedgerEntry extends ReputationEvent {
  seq: number;
  prevHash: string;
  hash: string;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanClaim: number;
  observedRate: number;
}

export interface BrierDecomposition {
  brier: number;
  reliability: number;
  resolution: number;
  uncertainty: number;
}

export interface ReputationState {
  participantId: ParticipantId;
  kind: ParticipantKind;
  n: number;
  verifiedN: number;
  fabricatedN: number;
  brier: number;
  decayedBrier: number;
  decomposition: BrierDecomposition;
  passRate: number;
  wilsonLower: number;
  meanClaim: number;
  calibrationGap: number;
  /** [0,1] */
  score: number;
  /** advisory only — T3 decides */
  standingHint: Standing;
  lastAt: number;
}

export interface ReputationLedgerOptions {
  /** default 7d */
  halfLifeMs?: number;
  /** default 25 */
  window?: number;
  /** pseudo-count toward the population prior, default 8 */
  priorStrength?: number;
  /** default 0.5 */
  uncertifiedPenalty?: number;
  /** calibration bins, default 10 */
  bins?: number;
}

export class ReputationValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "ReputationValidationError";
  }
}

/** sha256Hex("hades.market.reputation.v1") — the fixed genesis every participant's chain starts from. */
export const REPUTATION_GENESIS: string = sha256Hex("hades.market.reputation.v1");

// ---------------------------------------------------------------------------
// Small numeric guards
// ---------------------------------------------------------------------------

/**
 * Below this, a realized-outcome distribution is treated as carrying no
 * measurable uncertainty — a Brier SKILL score (which divides by that
 * uncertainty) is mathematically undefined there, so {@link reputationScore}
 * falls back to the exact-match rule documented on it. Exported because
 * consumers that GATE on `score` (e.g. the economy's minimum-reputation
 * check) must be able to tell "scored badly" apart from "not scoreable yet",
 * and the honest test for that is exactly this threshold.
 */
export const REPUTATION_UNCERTAINTY_EPS = 1e-9;
const UNCERTAINTY_EPS = REPUTATION_UNCERTAINTY_EPS;
/** Floor on the declared-difficulty informativeness weight, so a chain of all difficulty=0/1 events never divides by zero. */
const MIN_DIFFICULTY_WEIGHT = 1e-6;

const DEFAULTS: Required<ReputationLedgerOptions> = {
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,
  window: 25,
  priorStrength: 8,
  uncertifiedPenalty: 0.5,
  bins: 10,
};

function resolveOptions(opts?: ReputationLedgerOptions): Required<ReputationLedgerOptions> {
  const halfLifeMs = opts?.halfLifeMs ?? DEFAULTS.halfLifeMs;
  const window = opts?.window ?? DEFAULTS.window;
  const priorStrength = opts?.priorStrength ?? DEFAULTS.priorStrength;
  const uncertifiedPenalty = opts?.uncertifiedPenalty ?? DEFAULTS.uncertifiedPenalty;
  const bins = opts?.bins ?? DEFAULTS.bins;

  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    throw new ReputationValidationError(`halfLifeMs must be a finite number > 0, got ${halfLifeMs}`, "halfLifeMs");
  }
  if (!Number.isInteger(window) || window <= 0) {
    throw new ReputationValidationError(`window must be a positive integer, got ${window}`, "window");
  }
  if (!Number.isFinite(priorStrength) || priorStrength < 0) {
    throw new ReputationValidationError(`priorStrength must be a finite number >= 0, got ${priorStrength}`, "priorStrength");
  }
  if (!Number.isFinite(uncertifiedPenalty) || uncertifiedPenalty < 0 || uncertifiedPenalty > 1) {
    throw new ReputationValidationError(
      `uncertifiedPenalty must be a finite number in [0,1], got ${uncertifiedPenalty}`,
      "uncertifiedPenalty",
    );
  }
  if (!Number.isInteger(bins) || bins <= 0) {
    throw new ReputationValidationError(`bins must be a positive integer, got ${bins}`, "bins");
  }
  return { halfLifeMs, window, priorStrength, uncertifiedPenalty, bins };
}

// ---------------------------------------------------------------------------
// Canonical JSON + hash-chain internals
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

type EntryPreimage = Omit<ReputationLedgerEntry, "hash">;

function computeEntryHash(preimage: EntryPreimage): string {
  return sha256Hex(preimage.prevHash + stableStringify(preimage));
}

// ---------------------------------------------------------------------------
// Pure stats: Wilson lower bound
// ---------------------------------------------------------------------------

/**
 * 95%-by-default Wilson score interval lower bound for a binomial
 * proportion `successes / n`. `wilsonLowerBound(0, 0)` is defined to be `0`
 * (n=0 carries no information — the formula itself divides by n).
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const pHat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = pHat + z2 / (2 * n);
  const margin = z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  return (centre - margin) / denom;
}

// ---------------------------------------------------------------------------
// Pure stats: Murphy decomposition of the Brier score
// ---------------------------------------------------------------------------

function assertFiniteInRange(name: string, value: number, lo: number, hi: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) {
    throw new ReputationValidationError(`${name} must be a finite number in [${lo},${hi}], got ${value}`, name);
  }
}

/**
 * Murphy decomposition: `brier = reliability - resolution + uncertainty`,
 * exactly, for any binning. Bins are half-open `[k/bins, (k+1)/bins)` except
 * the last, which is closed at 1 (a point with `p === 1` cannot exceed the
 * top bin's edge, so this is only a matter of assignment, not a distinct
 * "closed" code path). `points` may carry a `weight` (default 1); all sums
 * are weighted sums, so this is a weighted Murphy decomposition.
 *
 * Returns all-zero on an empty `points` array (there is nothing to decompose).
 */
export function brierDecomposition(
  points: ReadonlyArray<{ p: number; outcome: 0 | 1; weight?: number }>,
  bins = 10,
): BrierDecomposition {
  if (!Number.isInteger(bins) || bins <= 0) {
    throw new ReputationValidationError(`bins must be a positive integer, got ${bins}`, "bins");
  }
  if (points.length === 0) {
    return { brier: 0, reliability: 0, resolution: 0, uncertainty: 0 };
  }

  const binWeight = new Array<number>(bins).fill(0);
  const binSumP = new Array<number>(bins).fill(0);
  const binSumO = new Array<number>(bins).fill(0);

  let totalWeight = 0;
  let totalOutcomeWeighted = 0;
  let directSumSquaredError = 0;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    assertFiniteInRange(`points[${i}].p`, pt.p, 0, 1);
    if (pt.outcome !== 0 && pt.outcome !== 1) {
      throw new ReputationValidationError(`points[${i}].outcome must be 0 or 1, got ${pt.outcome}`, `points[${i}].outcome`);
    }
    const w = pt.weight ?? 1;
    if (!Number.isFinite(w) || w <= 0) {
      throw new ReputationValidationError(`points[${i}].weight must be a finite number > 0, got ${w}`, `points[${i}].weight`);
    }

    const idx = Math.min(bins - 1, Math.max(0, Math.floor(pt.p * bins)));
    binWeight[idx] += w;
    binSumP[idx] += w * pt.p;
    binSumO[idx] += w * pt.outcome;

    totalWeight += w;
    totalOutcomeWeighted += w * pt.outcome;
    const err = pt.p - pt.outcome;
    directSumSquaredError += w * err * err;
  }

  const oBar = totalOutcomeWeighted / totalWeight;
  const uncertainty = oBar * (1 - oBar);

  let reliability = 0;
  let resolution = 0;
  for (let k = 0; k < bins; k++) {
    if (binWeight[k] === 0) continue;
    const pBarK = binSumP[k] / binWeight[k];
    const oBarK = binSumO[k] / binWeight[k];
    const share = binWeight[k] / totalWeight;
    reliability += share * (pBarK - oBarK) ** 2;
    resolution += share * (oBarK - oBar) ** 2;
  }

  const brier = directSumSquaredError / totalWeight;
  return { brier, reliability, resolution, uncertainty };
}

// ---------------------------------------------------------------------------
// Calibration curve + expected-calibration-gap
// ---------------------------------------------------------------------------

function computeCalibrationBins(
  points: ReadonlyArray<{ p: number; outcome: 0 | 1 }>,
  bins: number,
): CalibrationBin[] {
  const n = new Array<number>(bins).fill(0);
  const sumP = new Array<number>(bins).fill(0);
  const sumO = new Array<number>(bins).fill(0);
  for (const pt of points) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(pt.p * bins)));
    n[idx] += 1;
    sumP[idx] += pt.p;
    sumO[idx] += pt.outcome;
  }
  const out: CalibrationBin[] = [];
  for (let k = 0; k < bins; k++) {
    out.push({
      lo: k / bins,
      hi: (k + 1) / bins,
      n: n[k],
      meanClaim: n[k] > 0 ? sumP[k] / n[k] : 0,
      observedRate: n[k] > 0 ? sumO[k] / n[k] : 0,
    });
  }
  return out;
}

/** Weighted (by bin occupancy) mean absolute calibration gap — the expected calibration error. */
function calibrationGapFromBins(bins: ReadonlyArray<CalibrationBin>, totalN: number): number {
  if (totalN === 0) return 0;
  let acc = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    acc += (b.n / totalN) * Math.abs(b.meanClaim - b.observedRate);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// reputationScore — pure, single-participant, no population knowledge
// ---------------------------------------------------------------------------

/**
 * `score = clamp(1 - decayedBrier / uncertainty, 0, 1)` (a Brier Skill Score
 * relative to this participant's own realized task-pool uncertainty),
 * EXCEPT:
 *
 *  - `fabricatedN > 0` forces `0`, unconditionally, regardless of every
 *    other field.
 *  - when `uncertainty` is (numerically) zero — every realized outcome for
 *    this participant was identical, so there is no baseline variance to
 *    beat and a skill score is undefined — this returns `1` iff
 *    `decayedBrier` is also (numerically) zero (an exact, deterministic
 *    match), else `0`. This is deliberately NOT a reward for "easy" task
 *    selection: a single lucky near-miss (e.g. claiming 0.99 and being
 *    right) still has `decayedBrier > 0` and therefore scores `0` here —
 *    population-prior shrinkage (applied by {@link ReputationLedger}, not by
 *    this pure function) is what lets real evidence eventually earn credit.
 *
 * This function has no access to any other participant's data, so it never
 * performs prior shrinkage — that is exclusively {@link ReputationLedger}'s
 * job (it is the only thing with a population to shrink toward).
 */
export function reputationScore(
  state: Omit<ReputationState, "score" | "standingHint">,
  _opts?: ReputationLedgerOptions,
): number {
  if (state.fabricatedN > 0) return 0;
  const uncertainty = state.decomposition.uncertainty;
  const db = state.decayedBrier;
  let raw: number;
  if (uncertainty <= UNCERTAINTY_EPS) {
    raw = db <= UNCERTAINTY_EPS ? 1 : 0;
  } else {
    raw = 1 - db / uncertainty;
  }
  if (!Number.isFinite(raw)) raw = 0;
  return Math.min(1, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
// Validation of an incoming event (before it ever touches the chain)
// ---------------------------------------------------------------------------

const PARTICIPANT_KINDS: ReadonlySet<string> = new Set<ParticipantKind>([
  "agent",
  "worker",
  "provider",
  "procedure",
  "tool",
]);

function validateEvent(e: ReputationEvent): void {
  if (typeof e.participantId !== "string" || e.participantId.trim().length === 0) {
    throw new ReputationValidationError("participantId must be a non-empty string", "participantId");
  }
  if (typeof e.kind !== "string" || !PARTICIPANT_KINDS.has(e.kind)) {
    throw new ReputationValidationError(`kind must be one of agent|worker|provider|procedure|tool, got ${String(e.kind)}`, "kind");
  }
  if (typeof e.taskId !== "string" || e.taskId.length === 0) {
    throw new ReputationValidationError("taskId must be a non-empty string", "taskId");
  }
  assertFiniteInRange("claimedP", e.claimedP, 0, 1);
  if (e.outcome !== 0 && e.outcome !== 1) {
    throw new ReputationValidationError(`outcome must be 0 or 1, got ${String(e.outcome)}`, "outcome");
  }
  if (typeof e.certified !== "boolean") {
    throw new ReputationValidationError(`certified must be a boolean, got ${typeof e.certified}`, "certified");
  }
  if (e.fabricated !== undefined && typeof e.fabricated !== "boolean") {
    throw new ReputationValidationError(`fabricated must be a boolean when present, got ${typeof e.fabricated}`, "fabricated");
  }
  if (e.difficulty !== undefined) {
    assertFiniteInRange("difficulty", e.difficulty, 0, 1);
  }
  if (e.weight !== undefined) {
    if (!Number.isFinite(e.weight) || e.weight <= 0) {
      throw new ReputationValidationError(`weight must be a finite number > 0, got ${e.weight}`, "weight");
    }
  }
  if (!Number.isFinite(e.at)) {
    throw new ReputationValidationError(`at must be a finite timestamp, got ${e.at}`, "at");
  }
  if (e.certSha256 !== undefined && typeof e.certSha256 !== "string") {
    throw new ReputationValidationError(`certSha256 must be a string when present, got ${typeof e.certSha256}`, "certSha256");
  }
}

// ---------------------------------------------------------------------------
// Structural validation of a loaded (deserialized) entry
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isWellFormedEntry(v: unknown): v is ReputationLedgerEntry {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.participantId === "string" &&
    v.participantId.length > 0 &&
    typeof v.kind === "string" &&
    PARTICIPANT_KINDS.has(v.kind) &&
    typeof v.taskId === "string" &&
    typeof v.claimedP === "number" &&
    Number.isFinite(v.claimedP) &&
    (v.outcome === 0 || v.outcome === 1) &&
    typeof v.certified === "boolean" &&
    (v.fabricated === undefined || typeof v.fabricated === "boolean") &&
    (v.difficulty === undefined || (typeof v.difficulty === "number" && Number.isFinite(v.difficulty))) &&
    (v.weight === undefined || (typeof v.weight === "number" && Number.isFinite(v.weight))) &&
    typeof v.at === "number" &&
    Number.isFinite(v.at) &&
    (v.certSha256 === undefined || typeof v.certSha256 === "string") &&
    typeof v.seq === "number" &&
    Number.isInteger(v.seq) &&
    typeof v.prevHash === "string" &&
    typeof v.hash === "string"
  );
}

// ---------------------------------------------------------------------------
// Internal: per-event contribution to the decayed, difficulty-weighted score
// ---------------------------------------------------------------------------

interface RawStats {
  n: number;
  verifiedN: number;
  fabricatedN: number;
  decomposition: BrierDecomposition;
  decayedBrier: number;
  passRate: number;
  meanClaim: number;
  wilsonLower: number;
  calibrationGap: number;
  lastAt: number;
}

function computeRawStats(
  events: ReadonlyArray<ReputationEvent>,
  asOf: number,
  resolved: Required<ReputationLedgerOptions>,
): RawStats {
  const included = events.filter((e) => e.at <= asOf);
  const n = included.length;
  if (n === 0) {
    return {
      n: 0,
      verifiedN: 0,
      fabricatedN: 0,
      decomposition: { brier: 0, reliability: 0, resolution: 0, uncertainty: 0 },
      decayedBrier: 0,
      passRate: 0,
      meanClaim: 0,
      wilsonLower: 0,
      calibrationGap: 0,
      lastAt: 0,
    };
  }

  const verifiedN = included.reduce((acc, e) => acc + (e.certified ? 1 : 0), 0);
  const fabricatedN = included.reduce((acc, e) => acc + (e.fabricated ? 1 : 0), 0);
  const passRate = included.reduce((acc, e) => acc + (e.outcome === 1 ? 1 : 0), 0) / n;
  const meanClaimWeightSum = included.reduce((acc, e) => acc + (e.weight ?? 1), 0);
  const meanClaim = included.reduce((acc, e) => acc + (e.weight ?? 1) * e.claimedP, 0) / meanClaimWeightSum;

  const recent = included.slice(-resolved.window);
  const recentSuccesses = recent.reduce((acc, e) => acc + (e.outcome === 1 ? 1 : 0), 0);
  const wilsonLower = wilsonLowerBound(recentSuccesses, recent.length);

  // Points as fed to the Murphy decomposition: fabricated events are scored
  // as claim=1/outcome=0 (maximal penalty) regardless of what was submitted.
  const points = included.map((e) => ({
    p: e.fabricated ? 1 : e.claimedP,
    outcome: e.fabricated ? (0 as const) : e.outcome,
    weight: e.weight ?? 1,
  }));
  const decomposition = brierDecomposition(points, resolved.bins);
  const calibrationBins = computeCalibrationBins(points, resolved.bins);
  const calibrationGap = calibrationGapFromBins(calibrationBins, n);

  let totalW = 0;
  let totalWeightedEffErr = 0;
  let lastAt = -Infinity;
  for (const e of included) {
    if (e.at > lastAt) lastAt = e.at;
    const age = asOf - e.at;
    const decay = Math.pow(0.5, age / resolved.halfLifeMs);
    const d = e.difficulty ?? 0.5;
    const difficultyWeight = Math.max(MIN_DIFFICULTY_WEIGHT, 4 * d * (1 - d));
    const w = (e.weight ?? 1) * difficultyWeight * decay;

    const errRaw = e.fabricated ? 1 : (e.claimedP - e.outcome) ** 2;
    let effErr: number;
    if (e.fabricated) {
      effErr = 1;
    } else if (e.certified) {
      effErr = errRaw;
    } else {
      // Uncertified events contribute at `uncertifiedPenalty` weight to
      // credit but FULL weight to penalty: at errRaw=0 (perfect) the
      // effective error is `1 - uncertifiedPenalty` (credit halved, say);
      // at errRaw=1 (worst) the effective error is exactly 1, unchanged.
      effErr = 1 - resolved.uncertifiedPenalty * (1 - errRaw);
    }
    totalW += w;
    totalWeightedEffErr += w * effErr;
  }
  const decayedBrier = totalW > 0 ? totalWeightedEffErr / totalW : 0;

  return {
    n,
    verifiedN,
    fabricatedN,
    decomposition,
    decayedBrier,
    passRate,
    meanClaim,
    wilsonLower,
    calibrationGap,
    lastAt,
  };
}

function standingHintFor(fabricatedN: number, score: number): Standing {
  if (fabricatedN > 0) return "banned";
  if (score < 0.15) return "demoted";
  if (score < 0.35) return "probation";
  return "active";
}

// ---------------------------------------------------------------------------
// Persisted envelope shape
// ---------------------------------------------------------------------------

interface PersistedEnvelopeV1 {
  version: 1;
  genesis: string;
  order: string[];
  chains: Record<string, ReputationLedgerEntry[]>;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export class ReputationLedger {
  private readonly opts: Required<ReputationLedgerOptions>;
  private chains = new Map<ParticipantId, ReputationLedgerEntry[]>();
  private kinds = new Map<ParticipantId, ParticipantKind>();
  /** Insertion order of first-seen participants — used for deterministic iteration/serialization. */
  private order: ParticipantId[] = [];
  /** Per-participant cache of already-serialized entry JSON, mirrors `chains`. */
  private entryJsonCache = new Map<ParticipantId, string[]>();

  constructor(opts: ReputationLedgerOptions = {}) {
    this.opts = resolveOptions(opts);
  }

  /**
   * Validates and appends `e` to `e.participantId`'s hash chain. Throws
   * {@link ReputationValidationError} on any invalid field — the ledger is
   * left completely unchanged (no partial mutation, no partial persistence)
   * when validation fails.
   */
  record(e: ReputationEvent): ReputationLedgerEntry {
    validateEvent(e);

    const chain = this.chains.get(e.participantId) ?? [];
    const last = chain.length > 0 ? chain[chain.length - 1] : undefined;
    const prevHash = last ? last.hash : REPUTATION_GENESIS;
    const seq = chain.length;

    const preimage: EntryPreimage = {
      participantId: e.participantId,
      kind: e.kind,
      taskId: e.taskId,
      claimedP: e.claimedP,
      outcome: e.outcome,
      certified: e.certified,
      ...(e.fabricated !== undefined ? { fabricated: e.fabricated } : {}),
      ...(e.difficulty !== undefined ? { difficulty: e.difficulty } : {}),
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      at: e.at,
      ...(e.certSha256 !== undefined ? { certSha256: e.certSha256 } : {}),
      seq,
      prevHash,
    };
    const hash = computeEntryHash(preimage);
    const entry: ReputationLedgerEntry = Object.freeze({ ...preimage, hash });

    if (chain.length === 0) {
      this.chains.set(e.participantId, chain);
      this.kinds.set(e.participantId, e.kind);
      this.order.push(e.participantId);
    }
    chain.push(entry);

    let cache = this.entryJsonCache.get(e.participantId);
    if (!cache) {
      cache = [];
      this.entryJsonCache.set(e.participantId, cache);
    }
    cache.push(JSON.stringify(entry));

    return entry;
  }

  /** Read-only, defensively-copied entries for one participant, or every entry (grouped by participant, seq order) if `id` is omitted. */
  entries(id?: ParticipantId): readonly ReputationLedgerEntry[] {
    if (id !== undefined) {
      return [...(this.chains.get(id) ?? [])];
    }
    const out: ReputationLedgerEntry[] = [];
    for (const pid of this.order) {
      out.push(...(this.chains.get(pid) ?? []));
    }
    return out;
  }

  /** The ledger-wide default `asOf`: the latest `at` recorded anywhere, or 0 for an empty ledger. Never the wall clock. */
  private defaultAsOf(): number {
    let max = 0;
    for (const pid of this.order) {
      const chain = this.chains.get(pid)!;
      for (const e of chain) {
        if (e.at > max) max = e.at;
      }
    }
    return max;
  }

  /** Pooled (all-participant, non-fabricated) events as of `asOf` — the population `reputationScore` is shrunk toward. */
  private poolScore(asOf: number): number {
    const pooled: ReputationEvent[] = [];
    for (const pid of this.order) {
      for (const e of this.chains.get(pid)!) {
        if (!e.fabricated) pooled.push(e);
      }
    }
    if (pooled.length === 0) return 0.5;
    const stats = computeRawStats(pooled, asOf, this.opts);
    if (stats.n === 0) return 0.5;
    return reputationScore(
      {
        participantId: "__pool__",
        kind: "agent",
        n: stats.n,
        verifiedN: stats.verifiedN,
        fabricatedN: 0,
        brier: stats.decomposition.brier,
        decayedBrier: stats.decayedBrier,
        decomposition: stats.decomposition,
        passRate: stats.passRate,
        wilsonLower: stats.wilsonLower,
        meanClaim: stats.meanClaim,
        calibrationGap: stats.calibrationGap,
        lastAt: stats.lastAt,
      },
      this.opts,
    );
  }

  /** Full computed reputation state for `id` as of `asOf` (default: ledger-wide latest `at`), or `null` if `id` has no recorded events. */
  state(id: ParticipantId, asOf?: number): ReputationState | null {
    const chain = this.chains.get(id);
    if (!chain || chain.length === 0) return null;
    const effectiveAsOf = asOf ?? this.defaultAsOf();
    const stats = computeRawStats(chain, effectiveAsOf, this.opts);
    if (stats.n === 0) return null;

    const kind = this.kinds.get(id)!;
    const rawScoreInput: Omit<ReputationState, "score" | "standingHint"> = {
      participantId: id,
      kind,
      n: stats.n,
      verifiedN: stats.verifiedN,
      fabricatedN: stats.fabricatedN,
      brier: stats.decomposition.brier,
      decayedBrier: stats.decayedBrier,
      decomposition: stats.decomposition,
      passRate: stats.passRate,
      wilsonLower: stats.wilsonLower,
      meanClaim: stats.meanClaim,
      calibrationGap: stats.calibrationGap,
      lastAt: stats.lastAt,
    };

    let score: number;
    if (stats.fabricatedN > 0) {
      score = 0;
    } else {
      const raw = reputationScore(rawScoreInput, this.opts);
      const prior = this.poolScore(effectiveAsOf);
      const blended = (stats.n * raw + this.opts.priorStrength * prior) / (stats.n + this.opts.priorStrength);
      score = Math.min(1, Math.max(0, blended));
    }

    return {
      ...rawScoreInput,
      score,
      standingHint: standingHintFor(stats.fabricatedN, score),
    };
  }

  /** {@link state} for every participant with at least one recorded event, in first-seen order, evaluated at a single shared `asOf`. */
  states(asOf?: number): ReputationState[] {
    const effectiveAsOf = asOf ?? this.defaultAsOf();
    const out: ReputationState[] = [];
    for (const pid of this.order) {
      const s = this.state(pid, effectiveAsOf);
      if (s) out.push(s);
    }
    return out;
  }

  /** The full-history calibration curve for one participant (fabricated events scored as claim=1/outcome=0, matching {@link BrierDecomposition}). */
  calibrationCurve(id: ParticipantId, bins?: number): CalibrationBin[] {
    const chain = this.chains.get(id) ?? [];
    const resolvedBins = bins ?? this.opts.bins;
    if (!Number.isInteger(resolvedBins) || resolvedBins <= 0) {
      throw new ReputationValidationError(`bins must be a positive integer, got ${resolvedBins}`, "bins");
    }
    const points = chain.map((e) => ({
      p: e.fabricated ? 1 : e.claimedP,
      outcome: e.fabricated ? (0 as const) : e.outcome,
    }));
    return computeCalibrationBins(points, resolvedBins);
  }

  /**
   * Walks the hash chain for `id` (or every participant, if omitted),
   * recomputing each entry's hash from its own fields and comparing it to
   * both the entry's stored `hash` and the following entry's `prevHash`.
   * Returns the exact `{participantId, seq}` of the first divergence.
   */
  verifyChain(id?: ParticipantId): { ok: boolean; brokenAt?: { participantId: ParticipantId; seq: number } } {
    const ids = id !== undefined ? [id] : this.order;
    for (const pid of ids) {
      const chain = this.chains.get(pid) ?? [];
      let expectedPrevHash = REPUTATION_GENESIS;
      for (let i = 0; i < chain.length; i++) {
        const e = chain[i];
        if (e.participantId !== pid || e.seq !== i || e.prevHash !== expectedPrevHash) {
          return { ok: false, brokenAt: { participantId: pid, seq: i } };
        }
        const { hash, ...preimage } = e;
        const expectedHash = computeEntryHash(preimage as EntryPreimage);
        if (expectedHash !== hash) {
          return { ok: false, brokenAt: { participantId: pid, seq: i } };
        }
        expectedPrevHash = hash;
      }
    }
    return { ok: true };
  }

  /** Deterministic, byte-stable serialization: two identically-fed ledgers always produce identical output. */
  serialize(): string {
    const orderJson = JSON.stringify(this.order);
    const chainParts: string[] = [];
    for (const pid of this.order) {
      const cached = this.entryJsonCache.get(pid) ?? [];
      chainParts.push(`${JSON.stringify(pid)}:[${cached.join(",")}]`);
    }
    return `{"version":1,"genesis":${JSON.stringify(REPUTATION_GENESIS)},"order":${orderJson},"chains":{${chainParts.join(",")}}}`;
  }

  /** Reconstructs a ledger from {@link serialize} output. Throws {@link ReputationValidationError} on malformed/truncated/wrong-version JSON — never silently produces an empty ledger. Does NOT itself verify hash-chain integrity; call {@link verifyChain} after loading to detect tampering. */
  static deserialize(json: string, opts?: ReputationLedgerOptions): ReputationLedger {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new ReputationValidationError(`invalid JSON: ${(err as Error).message}`, "json");
    }
    if (!isPlainObject(parsed)) {
      throw new ReputationValidationError("unrecognized reputation-ledger envelope: not an object", "json");
    }
    if (parsed.version !== 1) {
      throw new ReputationValidationError(`unsupported reputation-ledger version: ${String(parsed.version)}`, "version");
    }
    if (typeof parsed.genesis !== "string" || parsed.genesis !== REPUTATION_GENESIS) {
      throw new ReputationValidationError("reputation-ledger genesis mismatch — not a reputation ledger of this format", "genesis");
    }
    if (!Array.isArray(parsed.order) || !parsed.order.every((x) => typeof x === "string")) {
      throw new ReputationValidationError("unrecognized reputation-ledger envelope: malformed order", "order");
    }
    if (!isPlainObject(parsed.chains)) {
      throw new ReputationValidationError("unrecognized reputation-ledger envelope: malformed chains", "chains");
    }

    const envelope = parsed as unknown as PersistedEnvelopeV1;
    const order = envelope.order;
    const orderSet = new Set(order);
    if (orderSet.size !== order.length) {
      throw new ReputationValidationError("malformed reputation-ledger envelope: duplicate entries in order", "order");
    }
    if (Object.keys(envelope.chains).length !== order.length || !order.every((pid) => pid in envelope.chains)) {
      throw new ReputationValidationError("malformed reputation-ledger envelope: order/chains mismatch", "chains");
    }

    const ledger = new ReputationLedger(opts);
    for (const pid of order) {
      const entries = envelope.chains[pid];
      if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isWellFormedEntry)) {
        throw new ReputationValidationError(`malformed chain entries for participantId="${pid}"`, "chains");
      }
      for (const e of entries) {
        if (e.participantId !== pid) {
          throw new ReputationValidationError(`entry participantId mismatch in chain "${pid}"`, "chains");
        }
      }
      ledger.chains.set(pid, entries);
      ledger.kinds.set(pid, entries[entries.length - 1].kind);
      ledger.order.push(pid);
      ledger.entryJsonCache.set(pid, entries.map((e) => JSON.stringify(e)));
    }

    return ledger;
  }
}
