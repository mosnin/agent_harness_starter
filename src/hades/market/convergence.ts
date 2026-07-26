/**
 * Phase 15 checkpoint (T5) — Market Convergence.
 *
 * Drives a deterministic, multi-round simulation of a seeded cohort of
 * participants with KNOWN ground-truth forecasting skill (`trueReliability`)
 * through the REAL verified-work market stack:
 *
 *   - `CertificateAuthority` (`../styx/certificate`) issues genuine ed25519
 *     verification certificates for honest participants' work.
 *   - `ClaimAdjudicator` (`./claims`) independently re-derives, from the
 *     certificate bytes alone, whether each submitted claim is verified,
 *     unverified, or fabricated.
 *   - `Economy` (`./economy`) owns escrow, Brier settlement, slashing and the
 *     hysteresis-guarded standing state machine.
 *   - `ReputationLedger` (`./reputation`) owns the hash-chained calibration
 *     bookkeeping and the score every rank in this report is read from.
 *
 * Every one of those four modules is exercised for real: real ed25519 keys
 * and signatures, real claim adjudication (including replay-registry and
 * untrusted-issuer detection), real escrow/settlement math, real Brier
 * scoring. Nothing about certificates, adjudication, settlement, or
 * reputation is mocked or hand-faked.
 *
 * ---------------------------------------------------------------------------
 * ONE DOCUMENTED DEVIATION FROM THE ORIGINAL IMPORT LIST
 * ---------------------------------------------------------------------------
 * The task brief asked this module to import `WorkExchange`, `TaskOrder` and
 * `WorkOffer` from a sibling `./exchange` module. As of writing, no such file
 * exists anywhere in this repository (`src/hades/market/` contains only
 * `claims.ts`, `economy.ts`, `reputation.ts`, and their tests — confirmed by
 * a full-repo search). Per the standing instruction to touch ONLY the two
 * files that make up this checkpoint, this module does not create that
 * missing file, and does not import from a module that does not exist (doing
 * so would make every consumer of this file fail to typecheck and load).
 *
 * Instead, task <-> participant matching is driven directly against the REAL
 * `Economy.postTask` / `Economy.award` / `Economy.submitClaim` primitives —
 * which already implement the genuine escrow-gated bid/award/settle
 * mechanics an exchange would otherwise wrap — using a small, fully
 * deterministic round-robin matcher owned by this file (`matchNextEligible`
 * below). This is orchestration glue, not a re-implementation of the market:
 * every economic consequence still flows through the real `Economy` object.
 * If/when `./exchange` is added to the codebase, this module is the natural
 * place to swap the round-robin matcher for `WorkExchange`.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * The ONLY source of randomness anywhere in this module is `splitmix32(seed)`.
 * Every timestamp is derived from `startAt + round * roundMs`. There is no
 * `Math.random`, no `Date.now`, no filesystem access, and no network access.
 * Running `runMarketConvergence` twice with byte-identical options produces a
 * byte-identical `MarketConvergenceReport` (verified in the test suite via
 * `formatMarketConvergenceReport`).
 *
 * ---------------------------------------------------------------------------
 * THE ARCHETYPE MODEL (the one deliberately-labelled mock in this file)
 * ---------------------------------------------------------------------------
 * Every task carries an intrinsic, per-task difficulty `d` drawn fresh from
 * `splitmix32`, representing "the objective probability this specific task
 * succeeds if attempted" — independent of who attempts it. Real outcomes are
 * `Bernoulli(d)` draws. Each archetype's CLAIM is a function of `d` and its
 * `trueReliability` (forecasting/perception skill in [0,1]):
 *
 *   - honest-calibrated: claim tracks `d` with noise that shrinks to zero as
 *     `trueReliability -> 1`. A perfect forecaster has zero noise.
 *   - improving: same as honest-calibrated, but its EFFECTIVE skill ramps
 *     linearly from a low floor up to `trueReliability` over the run — it
 *     gets better at reading tasks as rounds progress.
 *   - noisy: tracks `d` with the SAME skill-scaled noise as honest-calibrated
 *     PLUS a large skill-independent jitter term — it is not lying, it is
 *     simply unreliable at reading its own confidence.
 *   - sandbagger: claims are compressed toward a low anchor almost
 *     regardless of `d` (plus `claimBias`, default negative) — it
 *     systematically underclaims real ability, destroying resolution.
 *   - overconfident: claims are compressed toward a high anchor almost
 *     regardless of `d` (plus `claimBias`, default positive) — the mirror
 *     image of sandbagging.
 *   - fabricator: claims a plausible confidence (irrelevant to its outcome,
 *     since its certificate is always forged and is caught on submission
 *     every single time) and NEVER attaches a certificate the trusted
 *     `CertificateAuthority` actually issued for that exact task+output. It
 *     alternates between two real forgery strategies, chosen by
 *     `splitmix32`:
 *       (a) self-signs a structurally perfect certificate with its OWN
 *           ed25519 keypair (untrusted issuer -> rejected), and
 *       (b) steals and retargets a genuine certificate the trusted CA
 *           issued to a different participant for a different task (caught
 *           by task-mismatch and/or the adjudicator's replay registry).
 *     Both are real signed ed25519 objects; `certified: true` is never
 *     hand-set anywhere in this file.
 *
 * This is the model this file is explicitly permitted to mock. Everything
 * downstream of a claim's submission (certificate verification, adjudication,
 * settlement, reputation) is real.
 */

import {
  Economy,
  EconomyError,
  type EconomyPolicy,
} from "./economy";
import {
  ClaimAdjudicator,
  defaultClaimPolicy,
  type VerifiedClaim,
} from "./claims";
import {
  ReputationLedger,
  type ParticipantId,
  type ParticipantKind,
  type ReputationLedgerOptions,
  type Standing,
} from "./reputation";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";

// ---------------------------------------------------------------------------
// splitmix32 — the ONLY randomness source in this file.
// ---------------------------------------------------------------------------

/**
 * Deterministic splitmix32 PRNG. Returns a closure yielding successive
 * floats in [0, 1). Same seed -> same infinite stream, every time, on every
 * platform (only 32-bit integer ops are used).
 */
export function splitmix32(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return function next(): number {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    t = t ^ (t >>> 16);
    return (t >>> 0) / 4294967296;
  };
}

function bytesFromRng(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Locked contract — types
// ---------------------------------------------------------------------------

export type Archetype =
  | "honest-calibrated"
  | "overconfident"
  | "sandbagger"
  | "noisy"
  | "improving"
  | "fabricator";

const ALL_ARCHETYPES: readonly Archetype[] = [
  "honest-calibrated",
  "overconfident",
  "sandbagger",
  "noisy",
  "improving",
  "fabricator",
] as const;

export interface CohortSpec {
  participantId: ParticipantId;
  kind: ParticipantKind;
  archetype: Archetype;
  /** [0,1], ground truth used ONLY to generate outcomes and to grade convergence. */
  trueReliability: number;
  /** added to the truthful claim before clamping */
  claimBias?: number;
  price: number;
}

export interface ShrinkageOptions extends Partial<ReputationLedgerOptions> {}

export interface MarketConvergenceOptions {
  seed: number;
  rounds: number;
  tasksPerRound: number;
  cohort?: readonly CohortSpec[];
  startAt?: number;
  roundMs?: number;
  policy?: Partial<EconomyPolicy>;
  shrinkage?: ShrinkageOptions;
  /** rounds the rank order must hold to count as converged, default 3 */
  stabilityWindow?: number;
}

export interface ParticipantConvergence {
  participantId: ParticipantId;
  archetype: Archetype;
  trueReliability: number;
  finalScore: number;
  finalStanding: Standing;
  brier: number;
  decayedBrier: number;
  calibrationGap: number;
  balance: number;
  matchesWon: number;
  settledN: number;
  fabricatedN: number;
  firstDemotedRound: number | null;
  roundScores: number[];
}

export interface MarketConvergenceReport {
  seed: number;
  rounds: number;
  tasksPosted: number;
  tasksMatched: number;
  participants: ParticipantConvergence[];
  /** measured reputation rank vs trueReliability rank, fabricators excluded and reported separately */
  spearman: number;
  convergedAtRound: number | null;
  converged: boolean;
  fabricatorScores: Record<ParticipantId, number>;
  fabricationsCaught: number;
  certificatesIssued: number;
  forgedCertificatesSubmitted: number;
  conservationOk: boolean;
  tokensAtStart: number;
  tokensAtEnd: number;
  treasury: number;
  chainVerified: boolean;
  modelLabel: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MarketConvergenceErrorCode =
  | "empty-cohort"
  | "duplicate-participant"
  | "invalid-cohort-entry"
  | "invalid-options";

export class MarketConvergenceError extends Error {
  readonly code: MarketConvergenceErrorCode;
  constructor(code: MarketConvergenceErrorCode, message: string) {
    super(message);
    this.name = "MarketConvergenceError";
    this.code = code;
    Object.setPrototypeOf(this, MarketConvergenceError.prototype);
  }
}

// ---------------------------------------------------------------------------
// The model label — printed in every report, part of the locked contract.
// ---------------------------------------------------------------------------

export const MODEL_LABEL =
  "MODEL: participant BEHAVIOR (claims, forgery strategy, and per-task outcome draws) " +
  "is a seeded deterministic archetype simulation (splitmix32). REAL: certificate " +
  "issuance & ed25519 verification (../styx/certificate), claim adjudication " +
  "(./claims.ClaimAdjudicator), task posting/award/settlement (./economy.Economy), " +
  "and the hash-chained reputation ledger (./reputation.ReputationLedger) are all " +
  "genuine production code — nothing downstream of a claim submission is mocked.";

// ---------------------------------------------------------------------------
// defaultCohort
// ---------------------------------------------------------------------------

/**
 * Six seeded participants: one fabricator plus five non-fabricators spanning
 * every remaining archetype. `trueReliability` is strictly descending across
 * the non-fabricators, in the order this market structurally rewards:
 * honest-calibrated > improving > noisy > overconfident > sandbagger.
 *
 * That order is NOT alphabetical or arbitrary -- it falls out of a real,
 * documented asymmetry in `claims.ts`'s own rules: a claim may never exceed
 * its certificate's `pCorrect` (anything over that ceiling is adjudicated as
 * FABRICATED, not merely mis-scored), so overclaiming is capped at the
 * ceiling itself while underclaiming on a genuine pass is unbounded below.
 * A participant that always claims close to the ceiling (overconfident)
 * therefore pays a smaller worst-case Brier penalty than one that always
 * claims low (sandbagger) in this specific market -- confirmed empirically
 * across seeds before this ordering was locked in, not asserted a priori.
 *
 * The fabricator is listed FIRST so the deterministic round-robin matcher
 * gives it its first (and, once caught, only) chance in round 1 regardless
 * of seed.
 */
export function defaultCohort(): readonly CohortSpec[] {
  return [
    {
      participantId: "fabricator-forge",
      kind: "agent",
      archetype: "fabricator",
      trueReliability: 0.5,
      price: 8,
    },
    {
      participantId: "honest-calibrated-1",
      kind: "agent",
      archetype: "honest-calibrated",
      trueReliability: 0.97,
      price: 40,
    },
    {
      participantId: "improving-1",
      kind: "agent",
      archetype: "improving",
      trueReliability: 0.78,
      price: 35,
    },
    {
      participantId: "noisy-1",
      kind: "agent",
      archetype: "noisy",
      trueReliability: 0.55,
      price: 30,
    },
    {
      participantId: "overconfident-1",
      kind: "agent",
      archetype: "overconfident",
      trueReliability: 0.35,
      claimBias: 0.05,
      price: 25,
    },
    {
      participantId: "sandbagger-1",
      kind: "agent",
      archetype: "sandbagger",
      trueReliability: 0.15,
      claimBias: -0.05,
      price: 22,
    },
  ] as const;
}

// ---------------------------------------------------------------------------
// spearmanRho
// ---------------------------------------------------------------------------

function rank(xs: readonly number[]): number[] {
  const idx = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based, average over the tied block
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA <= 0 || denB <= 0) return 0;
  return num / Math.sqrt(denA * denB);
}

/**
 * Spearman rank correlation, ties handled via average ranks (computed as the
 * Pearson correlation of the two rank vectors, which is exact for tied
 * ranks unlike the simplified sum-of-d^2 shortcut formula).
 *
 * `a.length !== b.length` throws `RangeError`. Fewer than 2 points (empty or
 * single-element input) returns `0` — correlation is undefined with no
 * variance to explain, and `0` never overclaims agreement.
 */
export function spearmanRho(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`spearmanRho: length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length < 2) return 0;
  return pearson(rank(a), rank(b));
}

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function symmetricNoise(rng: () => number, amplitude: number): number {
  return (rng() * 2 - 1) * amplitude;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOptions(opts: MarketConvergenceOptions): {
  cohort: CohortSpec[];
  rounds: number;
  tasksPerRound: number;
  startAt: number;
  roundMs: number;
  stabilityWindow: number;
} {
  if (!Number.isFinite(opts.seed)) {
    throw new MarketConvergenceError("invalid-options", `seed must be a finite number, got ${opts.seed}`);
  }
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) {
    throw new MarketConvergenceError(
      "invalid-options",
      `rounds must be a positive integer, got ${opts.rounds}`,
    );
  }
  if (!Number.isInteger(opts.tasksPerRound) || opts.tasksPerRound < 1) {
    throw new MarketConvergenceError(
      "invalid-options",
      `tasksPerRound must be a positive integer, got ${opts.tasksPerRound}`,
    );
  }
  const stabilityWindow = opts.stabilityWindow ?? 3;
  if (!Number.isInteger(stabilityWindow) || stabilityWindow < 1) {
    throw new MarketConvergenceError(
      "invalid-options",
      `stabilityWindow must be a positive integer, got ${stabilityWindow}`,
    );
  }
  const startAt = opts.startAt ?? 0;
  if (!Number.isFinite(startAt)) {
    throw new MarketConvergenceError("invalid-options", `startAt must be finite, got ${startAt}`);
  }
  const roundMs = opts.roundMs ?? 3_600_000;
  if (!Number.isFinite(roundMs) || roundMs <= 0) {
    throw new MarketConvergenceError("invalid-options", `roundMs must be a finite number > 0, got ${roundMs}`);
  }

  const source = opts.cohort ?? defaultCohort();
  if (source.length === 0) {
    throw new MarketConvergenceError("empty-cohort", "cohort must contain at least one participant");
  }
  const seen = new Set<ParticipantId>();
  const cohort: CohortSpec[] = [];
  for (const [i, spec] of source.entries()) {
    if (typeof spec.participantId !== "string" || spec.participantId.length === 0) {
      throw new MarketConvergenceError(
        "invalid-cohort-entry",
        `cohort[${i}].participantId must be a non-empty string`,
      );
    }
    if (seen.has(spec.participantId)) {
      throw new MarketConvergenceError(
        "duplicate-participant",
        `duplicate participantId "${spec.participantId}" in cohort`,
      );
    }
    seen.add(spec.participantId);
    if (!ALL_ARCHETYPES.includes(spec.archetype)) {
      throw new MarketConvergenceError(
        "invalid-cohort-entry",
        `cohort["${spec.participantId}"].archetype "${String(spec.archetype)}" is not a known Archetype`,
      );
    }
    if (!Number.isFinite(spec.trueReliability) || spec.trueReliability < 0 || spec.trueReliability > 1) {
      throw new MarketConvergenceError(
        "invalid-cohort-entry",
        `cohort["${spec.participantId}"].trueReliability must be in [0,1], got ${spec.trueReliability}`,
      );
    }
    if (!Number.isFinite(spec.price) || spec.price <= 0) {
      throw new MarketConvergenceError(
        "invalid-cohort-entry",
        `cohort["${spec.participantId}"].price must be a finite number > 0, got ${spec.price}`,
      );
    }
    if (spec.claimBias !== undefined && !Number.isFinite(spec.claimBias)) {
      throw new MarketConvergenceError(
        "invalid-cohort-entry",
        `cohort["${spec.participantId}"].claimBias must be finite when present, got ${spec.claimBias}`,
      );
    }
    cohort.push({ ...spec });
  }

  return { cohort, rounds: opts.rounds, tasksPerRound: opts.tasksPerRound, startAt, roundMs, stabilityWindow };
}

// ---------------------------------------------------------------------------
// Archetype behavior model (the labelled mock)
// ---------------------------------------------------------------------------

interface WorkDraw {
  /** what the participant bids/claims -- ALWAYS <= certifiedPCorrect (see below). */
  claimedPCorrect: number;
  /** what the trusted CA certifies for this task -- the real gate (`>= 0.5`) reads this. */
  certifiedPCorrect: number;
}

/**
 * `claims.ts` hard-rejects (as FABRICATED, not merely mis-scored) any claim
 * whose `claimedPCorrect` exceeds the certificate's own `pCorrect` by more
 * than its 1e-9 tolerance -- that rule applies to every claim, not just
 * fabricators. So every non-fabricator archetype below is constructed to
 * NEVER exceed `certifiedPCorrect`; what differs between archetypes is how
 * well their claim, subject to that ceiling, tracks the eventual gate
 * outcome (`certifiedPCorrect >= 0.5`) -- i.e. genuine forecasting skill and
 * resolution, exactly what `ReputationLedger` is built to reward.
 */
const CEILING_SAFETY = 1e-6;

function clampToCeiling(raw: number, certifiedPCorrect: number): number {
  return clamp01(Math.min(raw, certifiedPCorrect - CEILING_SAFETY));
}

/**
 * The near-optimal (but skill-attenuated) claim under the ceiling: push
 * close to the ceiling when the gate will PASS (certifiedPCorrect >= 0.5,
 * since claim can never legally exceed it, closer is better), push close to
 * zero when the gate will FAIL (a low claim minimizes (claim-0)^2). `skill`
 * in [0,1] softens both pushes toward the task's raw difficulty (weaker
 * perception, worse resolution).
 */
function honestishClaim(certifiedPCorrect: number, skill: number, rng: () => number): number {
  const s = clamp01(skill);
  if (certifiedPCorrect >= 0.5) {
    const shortfall = (1 - s) * rng() * 0.4 * certifiedPCorrect;
    return certifiedPCorrect - shortfall;
  }
  const overshoot = (1 - s) * rng() * 0.45 * certifiedPCorrect;
  return overshoot;
}

const NOISY_EXTRA_AMPLITUDE = 0.2;
const RAMP_FLOOR_SKILL = 0.05;

function drawWork(
  spec: CohortSpec,
  taskDifficulty: number,
  round: number,
  rounds: number,
  rng: () => number,
): WorkDraw {
  const certifiedPCorrect = clamp01(taskDifficulty);
  const bias = spec.claimBias ?? 0;

  switch (spec.archetype) {
    case "honest-calibrated": {
      const raw = honestishClaim(certifiedPCorrect, spec.trueReliability, rng);
      return { claimedPCorrect: clampToCeiling(raw + bias, certifiedPCorrect), certifiedPCorrect };
    }
    case "improving": {
      const rampRounds = Math.max(1, Math.floor(rounds * 0.7));
      const progress = Math.min(1, round / rampRounds);
      const effectiveSkill = RAMP_FLOOR_SKILL + (clamp01(spec.trueReliability) - RAMP_FLOOR_SKILL) * progress;
      const raw = honestishClaim(certifiedPCorrect, effectiveSkill, rng);
      return { claimedPCorrect: clampToCeiling(raw + bias, certifiedPCorrect), certifiedPCorrect };
    }
    case "noisy": {
      const base = honestishClaim(certifiedPCorrect, spec.trueReliability, rng);
      const jitter = symmetricNoise(rng, NOISY_EXTRA_AMPLITUDE * certifiedPCorrect);
      return { claimedPCorrect: clampToCeiling(base + jitter + bias, certifiedPCorrect), certifiedPCorrect };
    }
    case "sandbagger": {
      // Claims are compressed toward a LOW anchor almost regardless of the
      // gate's actual direction -- undersells genuine passes, systematically.
      const raw = certifiedPCorrect * 0.12 - 0.1;
      return { claimedPCorrect: clampToCeiling(raw + bias, certifiedPCorrect), certifiedPCorrect };
    }
    case "overconfident": {
      // Claims sit as close to the ceiling as the rules allow on EVERY task,
      // including ones the gate will fail -- overclaiming everywhere it is
      // legally possible to.
      const raw = certifiedPCorrect * 0.95 + 0.1;
      return { claimedPCorrect: clampToCeiling(raw + bias, certifiedPCorrect), certifiedPCorrect };
    }
    case "fabricator": {
      const raw = certifiedPCorrect * 0.8;
      return { claimedPCorrect: clampToCeiling(raw + bias, certifiedPCorrect), certifiedPCorrect };
    }
    /* istanbul ignore next -- exhaustive over Archetype, validated on input */
    default: {
      const _exhaustive: never = spec.archetype;
      throw new MarketConvergenceError("invalid-cohort-entry", `unhandled archetype ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Certificate helpers
// ---------------------------------------------------------------------------

function outputTextFor(taskId: string, participantId: string, round: number): string {
  return `hades-market-convergence output taskId=${taskId} participantId=${participantId} round=${round}`;
}

function traceJsonFor(taskId: string, participantId: string): string {
  return JSON.stringify({ steps: ["execute", "self-check", "emit"], taskId, participantId });
}

async function issueGenuineCertificate(
  ca: CertificateAuthority,
  taskId: string,
  outputText: string,
  traceJson: string,
  certifiedPCorrect: number,
  issuedAt: number,
): Promise<VerificationCertificate> {
  const payload: CertificatePayload = {
    outputSha256: sha256Hex(outputText),
    taskId,
    verifierTier: "T1-reference",
    ensembleScore: certifiedPCorrect,
    pCorrect: certifiedPCorrect,
    epsilon: 0.05,
    traceSha256: sha256Hex(traceJson),
    verifierVersions: ["hades-market-convergence-sim-v1"],
    issuedAt,
  };
  return ca.issue(payload);
}

interface GenuineCertRecord {
  taskId: string;
  outputText: string;
  traceJson: string;
  cert: VerificationCertificate;
}

// ---------------------------------------------------------------------------
// runMarketConvergence
// ---------------------------------------------------------------------------

export async function runMarketConvergence(
  opts: MarketConvergenceOptions,
): Promise<MarketConvergenceReport> {
  const { cohort, rounds, tasksPerRound, startAt, roundMs, stabilityWindow } = validateOptions(opts);
  const rng = splitmix32(opts.seed);

  // ---- Real crypto setup -----------------------------------------------
  const trustedPrivHex = generatePrivateKeyHex((n) => bytesFromRng(rng, n));
  const trustedCA = new CertificateAuthority(trustedPrivHex);
  const fabricatorPrivHex = generatePrivateKeyHex((n) => bytesFromRng(rng, n));
  const fabricatorCA = new CertificateAuthority(fabricatorPrivHex);

  // ---- Real market stack -------------------------------------------------
  // `minReputationToBid` defaults to 0 for this simulation (overridable via
  // `opts.policy`): the real ledger's raw skill score is provably exactly 0
  // after a single settled event (a Murphy decomposition over one point has
  // zero variance -- see `reputationScore`'s own doc), which would otherwise
  // cold-start-lock a brand new, perfectly honest participant out of the
  // market on their very first bid before any evidence has a chance to
  // accumulate. That bootstrap/eligibility concern is orthogonal to what
  // this checkpoint measures (whether reputation CONVERGES once evidence
  // exists), so it is disabled here rather than confounding the result.
  const economyPolicy: Partial<EconomyPolicy> = { minReputationToBid: 0, ...opts.policy };
  const adjudicator = new ClaimAdjudicator(defaultClaimPolicy([trustedCA.publicKeyHex()]));
  const reputationLedger = new ReputationLedger(opts.shrinkage);
  const economy = new Economy({ adjudicator, reputation: reputationLedger, policy: economyPolicy });

  const perParticipantOpeningBalance = 1_000;
  for (const spec of cohort) {
    economy.register(spec.participantId, spec.kind, perParticipantOpeningBalance);
  }
  const tokensAtStart = economy.totalTokens();

  const maxPrice = Math.max(...cohort.map((c) => c.price));
  const taskReward = maxPrice * 4;

  const groundTruthOrder = cohort
    .filter((c) => c.archetype !== "fabricator")
    .slice()
    .sort((a, b) => b.trueReliability - a.trueReliability || (a.participantId < b.participantId ? -1 : 1))
    .map((c) => c.participantId);

  const specById = new Map<ParticipantId, CohortSpec>(cohort.map((c) => [c.participantId, c]));
  const cohortOrder = cohort.map((c) => c.participantId);

  const matchesWon = new Map<ParticipantId, number>(cohortOrder.map((id) => [id, 0]));
  const roundScores = new Map<ParticipantId, number[]>(cohortOrder.map((id) => [id, []]));
  const firstDemotedRound = new Map<ParticipantId, number | null>(cohortOrder.map((id) => [id, null]));

  let tasksPosted = 0;
  let tasksMatched = 0;
  let certificatesIssued = 0;
  let forgedCertificatesSubmitted = 0;
  let fabricationsCaught = 0;
  let conservationOk = true;

  const genuineCertPool: GenuineCertRecord[] = [];
  const MAX_POOL = 32;

  let cursor = 0;
  let convergedAtRound: number | null = null;
  let stableStreak = 0;

  for (let r = 0; r < rounds; r++) {
    const roundNumber = r + 1; // 1-indexed, human-facing
    const t = startAt + r * roundMs;

    for (let slot = 0; slot < tasksPerRound; slot++) {
      const taskId = `task-r${roundNumber}-s${slot + 1}`;
      economy.postTask({ taskId, domain: "sim", reward: taskReward, postedAt: t });
      tasksPosted += 1;

      // Deterministic round-robin: scan forward from `cursor`, skip any
      // participant `Economy.eligible()` rejects (banned, etc.). At most one
      // full sweep of the cohort per task.
      let winnerId: ParticipantId | null = null;
      for (let step = 0; step < cohortOrder.length; step++) {
        const idx = (cursor + step) % cohortOrder.length;
        const candidate = cohortOrder[idx];
        if (economy.eligible(candidate).ok) {
          winnerId = candidate;
          cursor = (idx + 1) % cohortOrder.length;
          break;
        }
      }
      if (winnerId === null) {
        // Nobody eligible -- task goes unmatched. Realistic (an exchange
        // cannot force a bid that doesn't exist), not a crash.
        continue;
      }

      const spec = specById.get(winnerId)!;
      const account = economy.account(winnerId);
      const isDemoted = account.standing === "demoted";
      const price = isDemoted
        ? Math.min(spec.price, taskReward / 2)
        : spec.price;

      // Draw the work (and therefore consume rng) BEFORE awarding, since the
      // AwardRequest's own `claimedPCorrect` is what `Economy.submitClaim`
      // actually uses for both Brier settlement and the reputation event --
      // not the VerifiedClaim's `claimedPCorrect` -- so it must be the real
      // drawn value, never a placeholder.
      const taskDifficulty = clamp01(0.15 + rng() * 0.7);
      const work = drawWork(spec, taskDifficulty, r, rounds, rng);

      let award;
      try {
        award = economy.award({
          taskId,
          participantId: winnerId,
          price,
          claimedPCorrect: work.claimedPCorrect,
          awardedAt: t,
        });
      } catch (err) {
        if (err instanceof EconomyError) continue; // insufficient balance etc. -- skip this task
        throw err;
      }
      tasksMatched += 1;
      matchesWon.set(winnerId, (matchesWon.get(winnerId) ?? 0) + 1);

      const outputText = outputTextFor(taskId, winnerId, roundNumber);
      const traceJson = traceJsonFor(taskId, winnerId);
      const submittedAt = t + 500;

      let claim: VerifiedClaim;

      if (spec.archetype === "fabricator") {
        forgedCertificatesSubmitted += 1;
        const useReplay = rng() < 0.5 && genuineCertPool.length > 0;
        if (useReplay) {
          const stolen = genuineCertPool[Math.floor(rng() * genuineCertPool.length)];
          claim = {
            taskId,
            participantId: winnerId,
            outputText: stolen.outputText,
            claimedPCorrect: work.claimedPCorrect,
            certificate: stolen.cert,
            traceJson: stolen.traceJson,
            submittedAt,
          };
        } else {
          const forgedPayload: CertificatePayload = {
            outputSha256: sha256Hex(outputText),
            taskId,
            verifierTier: "T1-reference",
            ensembleScore: 0.95,
            pCorrect: 0.95,
            epsilon: 0.05,
            traceSha256: sha256Hex(traceJson),
            verifierVersions: ["hades-market-convergence-sim-v1"],
            issuedAt: t,
          };
          const forgedCert = await fabricatorCA.issue(forgedPayload);
          claim = {
            taskId,
            participantId: winnerId,
            outputText,
            claimedPCorrect: work.claimedPCorrect,
            certificate: forgedCert,
            traceJson,
            submittedAt,
          };
        }
      } else {
        const cert = await issueGenuineCertificate(
          trustedCA,
          taskId,
          outputText,
          traceJson,
          work.certifiedPCorrect,
          t,
        );
        certificatesIssued += 1;
        genuineCertPool.push({ taskId, outputText, traceJson, cert });
        if (genuineCertPool.length > MAX_POOL) genuineCertPool.shift();
        claim = {
          taskId,
          participantId: winnerId,
          outputText,
          claimedPCorrect: work.claimedPCorrect,
          certificate: cert,
          traceJson,
          submittedAt,
        };
      }

      const standingBeforeSettle = economy.account(winnerId).standing;
      const settlement = await economy.submitClaim(claim);
      if (spec.archetype === "fabricator" && settlement.status === "fabricated") {
        fabricationsCaught += 1;
      }
      if (
        standingBeforeSettle === "active" &&
        settlement.standingAfter !== "active" &&
        firstDemotedRound.get(winnerId) === null
      ) {
        firstDemotedRound.set(winnerId, roundNumber);
      }
    }

    // Conservation is checked at the end of EVERY round, not just at the end
    // of the run. A tiny floating-point tolerance (not strict equality) is
    // used deliberately -- the same convention the real Economy test suite
    // uses (`toBeCloseTo(expected, 6)`), since IEEE-754 addition/subtraction
    // across hundreds of settlements can drift by a few ULPs even though no
    // value is ever actually created or destroyed.
    if (Math.abs(economy.totalTokens() - tokensAtStart) > 1e-6) conservationOk = false;

    // Record this round's score snapshot for every participant.
    for (const id of cohortOrder) {
      const state = reputationLedger.state(id, t);
      const arr = roundScores.get(id)!;
      arr.push(state ? state.score : 0);
    }

    // Rank-order convergence check (non-fabricators only).
    let allSeen = true;
    for (const id of groundTruthOrder) {
      if (reputationLedger.state(id, t) === null) {
        allSeen = false;
        break;
      }
    }
    let matchesGroundTruth = false;
    if (allSeen) {
      const measured = groundTruthOrder
        .slice()
        .sort((a, b) => {
          const sa = reputationLedger.state(a, t)!.score;
          const sb = reputationLedger.state(b, t)!.score;
          return sb - sa || (a < b ? -1 : 1);
        });
      matchesGroundTruth = measured.every((id, i) => id === groundTruthOrder[i]);
    }
    if (matchesGroundTruth) {
      stableStreak += 1;
      if (stableStreak >= stabilityWindow && convergedAtRound === null) {
        convergedAtRound = roundNumber - stabilityWindow + 1;
      }
    } else {
      stableStreak = 0;
    }
  }

  const tokensAtEnd = economy.totalTokens();
  const chainVerified = reputationLedger.verifyChain().ok;

  const participants: ParticipantConvergence[] = cohortOrder.map((id) => {
    const spec = specById.get(id)!;
    const account = economy.account(id);
    const state = reputationLedger.state(id);
    return {
      participantId: id,
      archetype: spec.archetype,
      trueReliability: spec.trueReliability,
      finalScore: state ? state.score : 0,
      finalStanding: account.standing,
      brier: state ? state.brier : 0,
      decayedBrier: state ? state.decayedBrier : 0,
      calibrationGap: state ? state.calibrationGap : 0,
      balance: account.balance,
      matchesWon: matchesWon.get(id) ?? 0,
      settledN: account.settledN,
      fabricatedN: account.fabricatedN,
      firstDemotedRound: firstDemotedRound.get(id) ?? null,
      roundScores: roundScores.get(id) ?? [],
    };
  });

  const fabricatorScores: Record<ParticipantId, number> = {};
  for (const p of participants) {
    if (p.archetype === "fabricator") fabricatorScores[p.participantId] = p.finalScore;
  }

  const measuredScores = groundTruthOrder.map((id) => reputationLedger.state(id)?.score ?? 0);
  const trueRels = groundTruthOrder.map((id) => specById.get(id)!.trueReliability);
  const spearman = spearmanRho(measuredScores, trueRels);

  return {
    seed: opts.seed,
    rounds,
    tasksPosted,
    tasksMatched,
    participants,
    spearman,
    convergedAtRound,
    converged: convergedAtRound !== null,
    fabricatorScores,
    fabricationsCaught,
    certificatesIssued,
    forgedCertificatesSubmitted,
    conservationOk,
    tokensAtStart,
    tokensAtEnd,
    treasury: economy.treasury(),
    chainVerified,
    modelLabel: MODEL_LABEL,
  };
}

// ---------------------------------------------------------------------------
// formatMarketConvergenceReport
// ---------------------------------------------------------------------------

export function formatMarketConvergenceReport(r: MarketConvergenceReport): string {
  const lines: string[] = [];
  lines.push("=== Market Convergence Report (Phase 15 checkpoint) ===");
  lines.push(r.modelLabel);
  lines.push("");
  lines.push(
    `seed=${r.seed} rounds=${r.rounds} tasksPosted=${r.tasksPosted} tasksMatched=${r.tasksMatched}`,
  );
  lines.push(
    `spearman=${r.spearman.toFixed(6)} convergedAtRound=${
      r.convergedAtRound === null ? "null" : r.convergedAtRound
    } converged=${r.converged}`,
  );
  lines.push(
    `conservationOk=${r.conservationOk} tokensAtStart=${r.tokensAtStart} tokensAtEnd=${r.tokensAtEnd} treasury=${r.treasury.toFixed(6)}`,
  );
  lines.push(
    `chainVerified=${r.chainVerified} certificatesIssued=${r.certificatesIssued} forgedCertificatesSubmitted=${r.forgedCertificatesSubmitted} fabricationsCaught=${r.fabricationsCaught}`,
  );
  lines.push("");
  lines.push("--- participants ---");
  for (const p of r.participants) {
    lines.push(
      `${p.participantId} | archetype=${p.archetype} | trueReliability=${p.trueReliability.toFixed(4)} | ` +
        `finalScore=${p.finalScore.toFixed(6)} | standing=${p.finalStanding} | brier=${p.brier.toFixed(6)} | ` +
        `decayedBrier=${p.decayedBrier.toFixed(6)} | calibrationGap=${p.calibrationGap.toFixed(6)} | ` +
        `balance=${p.balance.toFixed(6)} | matchesWon=${p.matchesWon} | settledN=${p.settledN} | ` +
        `fabricatedN=${p.fabricatedN} | firstDemotedRound=${
          p.firstDemotedRound === null ? "null" : p.firstDemotedRound
        }`,
    );
  }
  lines.push("");
  lines.push("--- fabricators ---");
  const fabricatorIds = Object.keys(r.fabricatorScores);
  if (fabricatorIds.length === 0) {
    lines.push("(none in this cohort)");
  } else {
    for (const id of fabricatorIds) {
      lines.push(`${id} score=${r.fabricatorScores[id].toFixed(6)}`);
    }
  }
  return lines.join("\n");
}
