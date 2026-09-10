/**
 * Belief-evidence provenance layer — the "certificate of the interaction it
 * came from" half of the closed learning loop.
 *
 * `UserModel` traits (`../learning/user-model.ts`) are only as trustworthy as
 * the evidence behind them. This module is the single place that turns the
 * engine's real, already-verified artifacts —
 *
 *   - `ExtractedFact`   (`./summarizer.ts` — a salience-scored quote pulled
 *                         from a transcript),
 *   - `MemoryRecord`    (`./store.ts` — a durable fact already accepted into
 *                         long-term memory),
 *   - `MemoryWriteVerdict` (`./guard.ts` — the T4-consistency contradiction
 *                         gate's verdict on a candidate write), and
 *   - `VerificationCertificate` (`../styx/certificate.ts` — a real ed25519
 *                         signed envelope over calibrated verifier output)
 *
 * — into canonical, tier-capped, hash-identified `BeliefEvidence` records
 * (`./user-model.ts`), plus a hash-chained per-attribute `EvidenceLedger` so
 * the full evidence history behind a belief is tamper-evident and can be
 * independently re-verified without trusting whatever is sitting on disk.
 *
 * ---------------------------------------------------------------------------
 * Zero-fabricated-trust invariant
 * ---------------------------------------------------------------------------
 * `tierCap()` is the single calibration authority in this module: every
 * weight this file ever assigns is `min(some real confidence/salience
 * number, tierCap(tier))`. A `VerificationCertificate` can only ever RAISE a
 * belief's tier (and therefore its cap) above the T4-consistency floor if
 * ALL of the following hold:
 *
 *   1. `verifyCertificate(cert)` resolves `true` — a real ed25519 signature
 *      check against the certificate's own embedded public key.
 *   2. `cert.payload.outputSha256 === sha256Hex(excerpt)` — the certificate
 *      is bound to THIS excerpt, not some other output (replay resistance:
 *      a validly-signed cert for a different piece of text must not
 *      transfer trust here).
 *   3. `cert.payload.verifierTier` parses to a tier `tierCap()` recognises.
 *
 * If any of the three fails, the certificate is kept on the returned record
 * (auditable — nothing is silently dropped) but `certificateValid` is
 * `false`, the tier stays (or falls back to) `"T4-consistency"`, and the
 * weight is capped accordingly. There is no code path in this module where
 * an unverified certificate increases a tier or a weight.
 *
 * ---------------------------------------------------------------------------
 * The ledger
 * ---------------------------------------------------------------------------
 * `EvidenceLedger` chains entries exactly like `../browser/trace.ts`'s
 * append-only DOM-action trace: `hash = sha256Hex(prevHash + canonical JSON
 * of the entry's hashable fields)`, rooted at a fixed genesis hash so an
 * empty ledger still has a well-defined `root()`. `verifyChain()` and
 * `restore()` both re-derive every hash from scratch in a single linear
 * pass — no code path here trusts a stored `hash`/`prevHash` without
 * recomputing it.
 */

import type { BeliefEvidence, EvidencePolarity } from "./user-model";
import { type TierId, tierConfidenceFloor } from "../styx/tiers";
import {
  type VerificationCertificate,
  verifyCertificate,
  sha256Hex,
  canonicalize,
} from "../styx/certificate";
import type { ExtractedFact } from "./summarizer";
import type { MemoryRecord } from "./store";
import { type MemoryWriteVerdict, memoryWriteCalibration } from "./guard";

// ===========================================================================
// Canonical JSON — reuse the certificate engine's canonicalizer so hashing
// here is byte-identical in style to certificate/trace hashing (same
// key-sorted, array-order-preserving algorithm), rather than maintaining a
// second, potentially-diverging implementation. `canonicalize`'s declared
// parameter type is `CertificatePayload`, but its body (`stableStringify`)
// is a fully generic recursive JSON canonicalizer with no dependency on
// that shape — the cast below is a deliberate, narrow reuse, not a type
// hole in the data this module actually handles.
// ===========================================================================

function canonicalJson(value: unknown): string {
  return canonicalize(value as Parameters<typeof canonicalize>[0]);
}

// ===========================================================================
// tierCap — the single calibration authority
// ===========================================================================

/**
 * The confidence/weight ceiling for a given verifier tier.
 *
 *  - `"T4-consistency"` reads `memoryWriteCalibration().prior` — the guard
 *    module's own documented, honestly-conservative T4 prior (currently
 *    0.6, but this file never hardcodes it: it is read live so a future
 *    recalibration in `guard.ts` propagates here automatically).
 *  - Every stronger tier uses `tierConfidenceFloor(tier, 0.05)` — the
 *    minimum calibrated P(correct) required to emit at that tier, at a 5%
 *    base error budget. Tiers are ordered strongest → weakest, so this cap
 *    is monotonically non-decreasing as the tier weakens.
 *
 * Throws `RangeError` on any tier string `tierConfidenceFloor` does not
 * recognise (and `"T4-consistency"` is handled before ever reaching it), so
 * this function is also this module's sole authority on "is this a known
 * tier at all" — see `isKnownTier` below, which relies on exactly that.
 */
export function tierCap(tier: TierId): number {
  if (typeof tier !== "string") {
    throw new RangeError(`tierCap: tier must be a string, got ${typeof tier}`);
  }
  if (tier === "T4-consistency") {
    return clamp01(memoryWriteCalibration().prior);
  }
  // Throws RangeError itself for any tier it doesn't recognise.
  return tierConfidenceFloor(tier, 0.05);
}

/** Is `tier` one `tierCap` actually knows how to score? Never throws. */
function isKnownTier(tier: unknown): tier is TierId {
  if (typeof tier !== "string" || tier.length === 0) return false;
  try {
    tierCap(tier as TierId);
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// evidenceId — deterministic content address
// ===========================================================================

export interface EvidenceIdInput {
  excerpt: string;
  sessionId?: string;
  polarity: EvidencePolarity;
  tier: TierId;
  at: number;
}

/**
 * Deterministic sha256 over a canonical (key-sorted) JSON encoding of
 * exactly `{excerpt, sessionId, polarity, tier, at}`. Identical inputs
 * always produce an identical id; changing any one field (including just
 * `polarity`, `tier`, or `at`) changes the id. This determinism is what
 * lets a caller dedup evidence by id as an anti-repetition defense — the
 * same excerpt asserted twice in the same session at the same timestamp
 * with the same polarity/tier collapses to one id, while genuinely
 * different evidence never collides.
 */
export function evidenceId(input: EvidenceIdInput): string {
  if (input === null || typeof input !== "object") {
    throw new TypeError("evidenceId: input must be an object");
  }
  if (typeof input.excerpt !== "string") {
    throw new TypeError("evidenceId: input.excerpt must be a string");
  }
  if (input.sessionId !== undefined && typeof input.sessionId !== "string") {
    throw new TypeError("evidenceId: input.sessionId must be a string when present");
  }
  if (typeof input.polarity !== "string" || input.polarity.length === 0) {
    throw new TypeError("evidenceId: input.polarity must be a non-empty string");
  }
  if (typeof input.tier !== "string" || input.tier.length === 0) {
    throw new TypeError("evidenceId: input.tier must be a non-empty string");
  }
  if (typeof input.at !== "number" || !Number.isFinite(input.at)) {
    throw new TypeError("evidenceId: input.at must be a finite number");
  }
  const key = {
    excerpt: input.excerpt,
    sessionId: input.sessionId,
    polarity: input.polarity,
    tier: input.tier,
    at: input.at,
  };
  return sha256Hex(canonicalJson(key));
}

// ===========================================================================
// Shared helpers
// ===========================================================================

/** Clamp to [0,1]; any non-finite input (NaN, ±Infinity) clamps to 0 — a
 *  broken/missing confidence signal carries no evidentiary weight, it does
 *  not get to silently pass through as "trust everything" (1) either. */
function clamp01(x: unknown): number {
  const n = typeof x === "number" ? x : NaN;
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** `"session:<id>"` → `<id>`; anything else (`"user"`, `undefined`, a
 *  malformed/empty id) → `undefined`. Matches the source convention written
 *  by `../learning/curator.ts` (`source: \`session:${session.id}\``). */
function parseSessionId(source: string | undefined): string | undefined {
  if (typeof source !== "string") return undefined;
  const prefix = "session:";
  if (!source.startsWith(prefix)) return undefined;
  const id = source.slice(prefix.length);
  return id.length > 0 ? id : undefined;
}

/**
 * Real signature check + hash-binding check for a certificate against a
 * specific excerpt. Never throws — a malformed/forged/mismatched cert
 * degrades to `{ tier: "T4-consistency", certificateValid: false }`, it
 * never rejects the caller and it never raises trust.
 */
async function resolveTier(
  excerpt: string,
  certificate: VerificationCertificate | undefined,
): Promise<{ tier: TierId; certificateValid: boolean }> {
  if (!certificate) return { tier: "T4-consistency", certificateValid: false };
  try {
    const sigOk = await verifyCertificate(certificate);
    if (!sigOk) return { tier: "T4-consistency", certificateValid: false };
    const payload = certificate.payload as { outputSha256?: unknown; verifierTier?: unknown } | undefined;
    const boundOk = typeof payload?.outputSha256 === "string" && payload.outputSha256 === sha256Hex(excerpt);
    if (!boundOk) return { tier: "T4-consistency", certificateValid: false };
    const claimedTier = payload?.verifierTier;
    if (isKnownTier(claimedTier)) {
      return { tier: claimedTier, certificateValid: true };
    }
    // Signature and hash-binding are honest, but the tier string itself is
    // one this module cannot score — honest fallback, not a trust bump.
    return { tier: "T4-consistency", certificateValid: false };
  } catch {
    return { tier: "T4-consistency", certificateValid: false };
  }
}

// ===========================================================================
// evidenceFromExtractedFact
// ===========================================================================

export interface EvidenceFromExtractedFactOptions {
  sessionId?: string;
  certificate?: VerificationCertificate;
  polarity?: EvidencePolarity;
  now?: () => number;
}

/**
 * Turn a summarizer `ExtractedFact` into `BeliefEvidence`.
 *
 * The excerpt is `f.evidence` — the verbatim transcript line the fact was
 * pulled from — because that is exactly what a certificate would have to be
 * bound to (`cert.payload.outputSha256 === sha256Hex(f.evidence)`) for the
 * tier upgrade to be honest: the certificate must certify the same text
 * this record is claiming as its evidence, not the derived/summarized
 * `f.fact`.
 *
 * `weight = min(f.salience, tierCap(tier))`, using whatever tier was
 * actually resolved (T4 fallback, or a certificate-earned stronger tier) —
 * so a validly-upgraded belief is capped at ITS tier's ceiling, never at
 * T4's.
 */
export async function evidenceFromExtractedFact(
  f: ExtractedFact,
  opts: EvidenceFromExtractedFactOptions = {},
): Promise<BeliefEvidence> {
  if (f === null || typeof f !== "object") {
    throw new TypeError("evidenceFromExtractedFact: f must be an ExtractedFact");
  }
  if (typeof f.evidence !== "string") {
    throw new TypeError("evidenceFromExtractedFact: f.evidence must be a string");
  }
  if (opts.sessionId !== undefined && typeof opts.sessionId !== "string") {
    throw new TypeError("evidenceFromExtractedFact: opts.sessionId must be a string when present");
  }

  const now = opts.now ?? Date.now;
  const at = now();
  const polarity: EvidencePolarity = opts.polarity ?? "supports";
  const excerpt = f.evidence;

  const { tier, certificateValid } = await resolveTier(excerpt, opts.certificate);
  const salience = clamp01(f.salience);
  const weight = Math.min(salience, tierCap(tier));

  const evidence: BeliefEvidence = {
    id: evidenceId({ excerpt, sessionId: opts.sessionId, polarity, tier, at }),
    excerpt,
    excerptSha256: sha256Hex(excerpt),
    sessionId: opts.sessionId,
    polarity,
    tier,
    weight,
    certificateValid,
    at,
  };
  if (opts.certificate) evidence.certificate = opts.certificate;
  return evidence;
}

// ===========================================================================
// evidenceFromMemoryRecord
// ===========================================================================

export interface EvidenceFromMemoryRecordOptions {
  certificate?: VerificationCertificate;
  now?: () => number;
}

/**
 * Turn an accepted `MemoryRecord` into `BeliefEvidence`. `excerpt = r.fact`
 * (a `MemoryRecord` has no separate verbatim-quote field the way an
 * `ExtractedFact` does — the fact IS the record). `sessionId` is parsed
 * from `r.source` via the `"session:<id>"` convention. Polarity is always
 * `"supports"`: a record already living in long-term memory represents an
 * accepted fact, not a contested one — contested writes are represented via
 * `evidenceFromVerdict` instead. Certificate binding/tier resolution and
 * weight capping follow the identical rules as `evidenceFromExtractedFact`,
 * bound against `sha256Hex(r.fact)`.
 */
export async function evidenceFromMemoryRecord(
  r: MemoryRecord,
  opts: EvidenceFromMemoryRecordOptions = {},
): Promise<BeliefEvidence> {
  if (r === null || typeof r !== "object") {
    throw new TypeError("evidenceFromMemoryRecord: r must be a MemoryRecord");
  }
  if (typeof r.fact !== "string") {
    throw new TypeError("evidenceFromMemoryRecord: r.fact must be a string");
  }

  const now = opts.now ?? Date.now;
  const at = now();
  const polarity: EvidencePolarity = "supports";
  const excerpt = r.fact;
  const sessionId = parseSessionId(r.source);

  const { tier, certificateValid } = await resolveTier(excerpt, opts.certificate);
  const salience = clamp01(r.salience);
  const weight = Math.min(salience, tierCap(tier));

  const evidence: BeliefEvidence = {
    id: evidenceId({ excerpt, sessionId, polarity, tier, at }),
    excerpt,
    excerptSha256: sha256Hex(excerpt),
    sessionId,
    polarity,
    tier,
    weight,
    certificateValid,
    at,
  };
  if (opts.certificate) evidence.certificate = opts.certificate;
  return evidence;
}

// ===========================================================================
// evidenceFromVerdict
// ===========================================================================

export interface EvidenceFromVerdictOptions {
  sessionId?: string;
  now?: () => number;
}

/**
 * Turn a `MemoryWriteVerdict` (the guard's contradiction-gate verdict on a
 * candidate write) into `BeliefEvidence` for `candidateFact`.
 *
 *  - `verdict.passed` → `"supports"`, `excerpt = candidateFact`,
 *    `weight = min(verdict.confidence, tierCap("T4-consistency"))`.
 *  - `!verdict.passed` → `"contradicts"`, `excerpt` is the highest-
 *    confidence contradiction finding's `existing.fact` (the record the
 *    candidate actually conflicts with — that is the evidence a reader
 *    needs to see, not the rejected candidate itself), `weight = min(that
 *    finding's confidence, tierCap("T4-consistency"))`. In the edge case of
 *    a failed verdict with an empty `contradictions` array (a
 *    structurally-inconsistent verdict — `passed: false` with nothing to
 *    show for it), this degrades honestly to `excerpt = candidateFact` /
 *    `weight = min(verdict.confidence, cap)` rather than fabricating a
 *    contradiction record that does not exist.
 *
 * The whole verdict is always `T4-consistency` (`memoryWriteCalibration()`'s
 * own documented tier — this is deterministic lexical contradiction
 * detection, never an oracle), and `verdict` is always populated from the
 * source `MemoryWriteVerdict`'s `verifierId`/`passed`/`confidence`. There is
 * no certificate involved, so `certificateValid` is always `false` here.
 */
export function evidenceFromVerdict(
  candidateFact: string,
  verdict: MemoryWriteVerdict,
  opts: EvidenceFromVerdictOptions = {},
): BeliefEvidence {
  if (typeof candidateFact !== "string") {
    throw new TypeError("evidenceFromVerdict: candidateFact must be a string");
  }
  if (verdict === null || typeof verdict !== "object") {
    throw new TypeError("evidenceFromVerdict: verdict must be a MemoryWriteVerdict");
  }
  if (typeof verdict.verifierId !== "string") {
    throw new TypeError("evidenceFromVerdict: verdict.verifierId must be a string");
  }
  if (typeof verdict.passed !== "boolean") {
    throw new TypeError("evidenceFromVerdict: verdict.passed must be a boolean");
  }

  const now = opts.now ?? Date.now;
  const at = now();
  const tier: TierId = "T4-consistency";
  const cap = tierCap(tier);

  let polarity: EvidencePolarity;
  let excerpt: string;
  let weight: number;

  if (verdict.passed) {
    polarity = "supports";
    excerpt = candidateFact;
    weight = Math.min(clamp01(verdict.confidence), cap);
  } else {
    polarity = "contradicts";
    const contradictions = Array.isArray(verdict.contradictions) ? verdict.contradictions : [];
    if (contradictions.length === 0) {
      excerpt = candidateFact;
      weight = Math.min(clamp01(verdict.confidence), cap);
    } else {
      const top = contradictions.reduce((best, c) => (c.confidence > best.confidence ? c : best));
      excerpt = top.existing.fact;
      weight = Math.min(clamp01(top.confidence), cap);
    }
  }

  const sessionId = opts.sessionId;
  return {
    id: evidenceId({ excerpt, sessionId, polarity, tier, at }),
    excerpt,
    excerptSha256: sha256Hex(excerpt),
    sessionId,
    polarity,
    tier,
    weight,
    certificateValid: false,
    verdict: {
      verifierId: verdict.verifierId,
      passed: verdict.passed,
      confidence: clamp01(verdict.confidence),
    },
    at,
  };
}

// ===========================================================================
// EvidenceLedger — hash-chained, tamper-evident evidence history
// ===========================================================================

export interface LedgerEntry {
  seq: number;
  evidence: BeliefEvidence;
  attribute: string;
  prevHash: string;
  hash: string;
}

/** `sha256Hex("hades.user-model.ledger.v1")` — follows the same fixed-
 *  literal rooting convention as `../browser/trace.ts`'s `TRACE_GENESIS`. */
export const EVIDENCE_LEDGER_GENESIS: string = sha256Hex("hades.user-model.ledger.v1");

/** Deep, JSON-safe clone — `BeliefEvidence` (and its optional nested
 *  `certificate`/`verdict`) is plain serializable data, so this is exact
 *  and cheap, and it is what makes `entries()`/ledger internals immune to
 *  a caller mutating a record they were handed back. */
function cloneEvidence(e: BeliefEvidence): BeliefEvidence {
  return JSON.parse(JSON.stringify(e)) as BeliefEvidence;
}

/**
 * The exact object this module hashes for a ledger entry: `evidence` with
 * its `certificate` (if present) reduced to just its `signature` string.
 * The full certificate (payload, public key, everything) still lives on
 * the entry itself for audit — only the hash INPUT is lean, so the ledger
 * doesn't need to re-derive certificate-internal float/array encoding
 * subtleties to stay tamper-evident about the signature that matters.
 */
function reducedHashKey(seq: number, attribute: string, evidence: BeliefEvidence): unknown {
  const { certificate, ...rest } = evidence as BeliefEvidence & { certificate?: VerificationCertificate };
  const reducedEvidence: Record<string, unknown> = { ...rest };
  if (certificate && typeof certificate.signature === "string") {
    reducedEvidence.certificate = certificate.signature;
  }
  return { seq, attribute, evidence: reducedEvidence };
}

function computeEntryHash(prevHash: string, seq: number, attribute: string, evidence: BeliefEvidence): string {
  return sha256Hex(prevHash + canonicalJson(reducedHashKey(seq, attribute, evidence)));
}

function isPlainEntryShape(en: unknown): en is LedgerEntry {
  if (en === null || typeof en !== "object") return false;
  const o = en as Record<string, unknown>;
  return (
    typeof o.seq === "number" &&
    typeof o.attribute === "string" &&
    typeof o.prevHash === "string" &&
    typeof o.hash === "string" &&
    o.evidence !== null &&
    typeof o.evidence === "object"
  );
}

/**
 * Append-only, hash-chained ledger of `BeliefEvidence`, one per
 * `(attribute, evidence)` pair. Every entry's `hash` chains to the
 * previous entry's `hash` (or, for the first entry, to the ledger's
 * genesis), so tampering with ANY field of ANY past entry — the evidence
 * itself, its `attribute`, or the chain-linkage fields `seq`/`prevHash` —
 * is detectable by re-deriving the chain from scratch. This is the
 * evidentiary backbone that makes a `UserModel` trait's history
 * independently re-verifiable rather than merely "logged".
 */
export class EvidenceLedger {
  private readonly genesis: string;
  private readonly _entries: LedgerEntry[] = [];

  constructor(genesis: string = EVIDENCE_LEDGER_GENESIS) {
    if (typeof genesis !== "string" || genesis.length === 0) {
      throw new TypeError("EvidenceLedger: genesis must be a non-empty string");
    }
    this.genesis = genesis;
  }

  /** Append one piece of evidence for `attribute`. Returns the new entry
   *  (a defensive copy — mutating the return value never affects the
   *  ledger's internal state). */
  append(attribute: string, e: BeliefEvidence): LedgerEntry {
    if (typeof attribute !== "string" || attribute.trim().length === 0) {
      throw new TypeError("EvidenceLedger.append: attribute must be a non-empty string");
    }
    if (e === null || typeof e !== "object") {
      throw new TypeError("EvidenceLedger.append: e must be a BeliefEvidence object");
    }
    const seq = this._entries.length;
    const prevHash = seq === 0 ? this.genesis : this._entries[seq - 1]!.hash;
    const storedEvidence = cloneEvidence(e);
    const hash = computeEntryHash(prevHash, seq, attribute, storedEvidence);
    const entry: LedgerEntry = { seq, evidence: storedEvidence, attribute, prevHash, hash };
    this._entries.push(entry);
    return { ...entry, evidence: cloneEvidence(entry.evidence) };
  }

  /** All entries in append order, as defensive copies. */
  entries(): LedgerEntry[] {
    return this._entries.map((en) => ({ ...en, evidence: cloneEvidence(en.evidence) }));
  }

  /** The last entry's hash, or the genesis hash if the ledger is empty. */
  root(): string {
    return this._entries.length === 0 ? this.genesis : this._entries[this._entries.length - 1]!.hash;
  }

  /**
   * Full re-verification of the whole chain: re-derives every entry's
   * hash from scratch (no trust placed in the stored `hash`/`prevHash`
   * fields), checks `seq` runs 0..n-1 with no gaps, and checks `prevHash`
   * linkage from the genesis onward. Reports the FIRST broken entry (in
   * append order). Single linear pass — O(n) in the number of entries,
   * never re-hashes an entry more than once.
   */
  verifyChain(): { ok: boolean; brokenAt?: number } {
    let prev = this.genesis;
    for (let i = 0; i < this._entries.length; i++) {
      const en = this._entries[i]!;
      if (en.seq !== i) return { ok: false, brokenAt: i };
      if (en.prevHash !== prev) return { ok: false, brokenAt: i };
      const expected = computeEntryHash(en.prevHash, en.seq, en.attribute, en.evidence);
      if (expected !== en.hash) return { ok: false, brokenAt: i };
      prev = en.hash;
    }
    return { ok: true };
  }

  /**
   * Rebuild a ledger from a previously-exported `entries()` array,
   * validating the entire chain (in one linear pass) before adopting it —
   * a broken chain never produces a live `EvidenceLedger`. Throws an
   * `Error` naming the first broken `seq` on any inconsistency: a
   * malformed entry shape, a `seq` that doesn't match its position, a
   * `prevHash` that doesn't chain to the prior entry (or to `genesis` at
   * position 0 — this is also how a genesis mismatch is detected), or a
   * `hash` that doesn't match its recomputation.
   */
  static restore(entries: LedgerEntry[], genesis: string = EVIDENCE_LEDGER_GENESIS): EvidenceLedger {
    if (!Array.isArray(entries)) {
      throw new TypeError("EvidenceLedger.restore: entries must be an array");
    }
    const ledger = new EvidenceLedger(genesis);
    let prev = genesis;
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      if (!isPlainEntryShape(en)) {
        throw new Error(`EvidenceLedger.restore: broken chain at seq ${i} (malformed entry)`);
      }
      if (en.seq !== i) {
        throw new Error(`EvidenceLedger.restore: broken chain at seq ${i} (seq mismatch: entry claims seq ${en.seq})`);
      }
      if (en.prevHash !== prev) {
        throw new Error(`EvidenceLedger.restore: broken chain at seq ${i} (prevHash does not match preceding hash/genesis)`);
      }
      const expected = computeEntryHash(en.prevHash, en.seq, en.attribute, en.evidence);
      if (expected !== en.hash) {
        throw new Error(`EvidenceLedger.restore: broken chain at seq ${i} (hash mismatch — entry has been tampered with)`);
      }
      prev = en.hash;
    }
    ledger._entries.push(...entries.map((en) => ({ ...en, evidence: cloneEvidence(en.evidence) })));
    return ledger;
  }
}
