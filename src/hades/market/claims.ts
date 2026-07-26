/**
 * Certificate-Gated Claim Adjudication (Phase 15 hardening — T2).
 *
 * Today's market takes a worker's `certified: boolean` on trust. This module
 * closes that hole: a `ClaimAdjudicator` takes a participant's claim of
 * verified work — an output plus (optionally) an attached ed25519
 * `VerificationCertificate` — and independently re-derives whether the claim
 * is actually true, using the REAL crypto in `../styx/certificate`. It never
 * trusts a boolean; it checks the signature, the issuer, the output binding,
 * the task binding, the tier, the epsilon policy, the trace binding, cert
 * freshness, and cross-task replay.
 *
 * THE CORE THESIS: attaching a certificate to a claim IS the assertion of
 * verification.
 *
 *   - NO certificate attached  -> "unverified". Honest abstention: the
 *     participant never claimed cryptographic proof, so there is nothing to
 *     catch them lying about. Score 0, `fabricated: false`.
 *
 *   - A certificate attached that fails ANY binding check -> "fabricated".
 *     The participant asserted verified work it cannot actually prove.
 *     Score is EXACTLY 0, always, and `fabricated: true` carries the
 *     demotion signal a market/reputation layer can act on.
 *
 *   - A certificate that passes every check -> "verified", score =
 *     `payload.pCorrect` (the cryptographically authentic, calibrated
 *     probability the real engine emitted at certification time).
 *
 * Every number this module reports as fact (pCorrect / tier / epsilon) is
 * read ONLY from a payload whose ed25519 signature has already been
 * confirmed valid — an attacker-controlled payload behind a broken signature
 * never gets to inject numbers into the output. "score" is 0 for every
 * fabricated claim; that is not a heuristic, it is the invariant this module
 * exists to guarantee.
 *
 * Determinism: `now` is always caller-supplied (no `Date.now`), there is no
 * randomness and no I/O. `adjudicate` never throws for any input, including
 * `null`/`undefined`/garbage forced through `as`.
 */

import {
  certifiesOutput,
  sha256Hex,
  verifyCertificate,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";
import { TIER_ORDER, type TierId } from "../styx/tiers";
import type { ParticipantId } from "./reputation";

// ---------------------------------------------------------------------------
// Rejection codes
// ---------------------------------------------------------------------------

export type ClaimRejectionCode =
  | "malformed-claim"
  | "no-certificate"
  | "bad-signature"
  | "untrusted-issuer"
  | "output-mismatch"
  | "task-mismatch"
  | "trace-mismatch"
  | "replayed-certificate"
  | "epsilon-over-policy"
  | "tier-overclaim"
  | "tier-not-accepted"
  | "stale-certificate"
  | "future-certificate"
  | "empty-verifier-versions"
  | "unknown-verifier-version"
  | "score-out-of-range"
  | "claim-exceeds-certificate";

/** Canonical order — also the stable sort order `codes` is reported in. */
export const ALL_CLAIM_REJECTION_CODES: readonly ClaimRejectionCode[] = [
  "malformed-claim",
  "no-certificate",
  "bad-signature",
  "untrusted-issuer",
  "output-mismatch",
  "task-mismatch",
  "trace-mismatch",
  "replayed-certificate",
  "epsilon-over-policy",
  "tier-overclaim",
  "tier-not-accepted",
  "stale-certificate",
  "future-certificate",
  "empty-verifier-versions",
  "unknown-verifier-version",
  "score-out-of-range",
  "claim-exceeds-certificate",
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifiedClaim {
  taskId: string;
  participantId: ParticipantId;
  outputText: string;
  claimedPCorrect: number;
  certificate?: VerificationCertificate;
  traceJson?: string;
  submittedAt: number;
}

export type ClaimStatus = "verified" | "unverified" | "fabricated";

export interface ClaimPolicy {
  /** hex ed25519 public keys, lowercased on ingest. */
  trustedIssuers: readonly string[];
  maxEpsilon: number;
  acceptedTiers: readonly TierId[];
  maxCertificateAgeMs: number;
  clockSkewToleranceMs: number;
  knownVerifierVersions?: readonly string[];
  requireTraceBinding: boolean;
}

export interface ClaimAdjudication {
  status: ClaimStatus;
  taskId: string;
  participantId: ParticipantId;
  /** stable, deduped, sorted by ALL_CLAIM_REJECTION_CODES order. */
  codes: ClaimRejectionCode[];
  certSha256?: string;
  pCorrect?: number;
  tier?: TierId;
  epsilon?: number;
  /** 0 for fabricated, ALWAYS. */
  score: number;
  fabricated: boolean;
  /** human-readable, one line, no fabricated numbers. */
  detail: string;
}

/**
 * Sane, conservative default policy. Callers should tighten `acceptedTiers` /
 * `maxEpsilon` / `knownVerifierVersions` for their own risk posture; these
 * defaults accept every known tier and impose a generous (but bounded)
 * freshness window.
 */
export function defaultClaimPolicy(trustedIssuers: readonly string[]): ClaimPolicy {
  return {
    trustedIssuers: normalizeIssuers(trustedIssuers),
    maxEpsilon: 0.1,
    acceptedTiers: [...TIER_ORDER],
    maxCertificateAgeMs: 24 * 60 * 60 * 1000, // 24h
    clockSkewToleranceMs: 5 * 60 * 1000, // 5min
    knownVerifierVersions: undefined,
    requireTraceBinding: true,
  };
}

function normalizeIssuers(issuers: readonly string[]): string[] {
  if (!Array.isArray(issuers)) return [];
  return issuers.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase());
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isTierId(v: unknown): v is TierId {
  return typeof v === "string" && (TIER_ORDER as readonly string[]).includes(v);
}

function extractIdentity(claim: unknown): { taskId: string; participantId: string } {
  if (isRecord(claim)) {
    return {
      taskId: typeof claim.taskId === "string" ? claim.taskId : "",
      participantId: typeof claim.participantId === "string" ? claim.participantId : "",
    };
  }
  return { taskId: "", participantId: "" };
}

/**
 * Structural validity of the VerifiedClaim envelope itself — independent of
 * whether a certificate is attached or valid. This is what `malformed-claim`
 * guards: garbage at the claim level, not at the certificate level.
 */
function isValidClaimShape(claim: unknown): claim is VerifiedClaim {
  if (!isRecord(claim)) return false;
  if (typeof claim.taskId !== "string" || claim.taskId.length === 0) return false;
  if (typeof claim.participantId !== "string" || claim.participantId.length === 0) return false;
  if (typeof claim.outputText !== "string") return false;
  if (!isFiniteNumber(claim.claimedPCorrect)) return false;
  if (!isFiniteNumber(claim.submittedAt)) return false;
  if (claim.traceJson !== undefined && typeof claim.traceJson !== "string") return false;
  return true;
}

/** Stable, cycle-safe stringify of an arbitrary (possibly hostile) value. */
function stableUnknownStringify(v: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (v === null) return "null";
  if (typeof v !== "object") {
    if (typeof v === "function") return '"[function]"';
    if (typeof v === "bigint") return JSON.stringify(`${v.toString()}n`);
    if (typeof v === "number" && !Number.isFinite(v)) return JSON.stringify(String(v));
    try {
      const s = JSON.stringify(v);
      return s === undefined ? "null" : s;
    } catch {
      return JSON.stringify(String(v));
    }
  }
  if (seen.has(v)) return '"[circular]"';
  seen.add(v);
  if (Array.isArray(v)) {
    return "[" + v.map((x) => stableUnknownStringify(x, seen)).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  let keys: string[];
  try {
    keys = Object.keys(obj).sort();
  } catch {
    return '"[unreadable]"';
  }
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableUnknownStringify(obj[k], seen)).join(",") +
    "}"
  );
}

/**
 * A stable fingerprint for an (possibly malformed) attached certificate.
 * When the certificate carries a usable signature string, the fingerprint is
 * sha256(signature) — the same key the replay registry uses, so a caller can
 * cross-reference. Otherwise falls back to hashing a stable serialization of
 * whatever was attached, so `certSha256` is always present when something was
 * attached (matches the contract: present iff a certificate was attached).
 */
function certificateFingerprint(rawCert: unknown): string {
  if (isRecord(rawCert) && typeof rawCert.signature === "string" && rawCert.signature.length > 0) {
    try {
      return sha256Hex(rawCert.signature);
    } catch {
      /* fall through to whole-value hash */
    }
  }
  return sha256Hex(stableUnknownStringify(rawCert));
}

interface ReadPayload {
  payload: Record<string, unknown> | null;
  publicKeyHex: string | undefined;
  signatureRaw: string | undefined;
}

function readCertificate(rawCert: unknown): ReadPayload {
  if (!isRecord(rawCert)) {
    return { payload: null, publicKeyHex: undefined, signatureRaw: undefined };
  }
  const payload = isRecord(rawCert.payload) ? (rawCert.payload as Record<string, unknown>) : null;
  const publicKeyHex = typeof rawCert.publicKey === "string" ? rawCert.publicKey.toLowerCase() : undefined;
  const signatureRaw = typeof rawCert.signature === "string" ? rawCert.signature : undefined;
  return { payload, publicKeyHex, signatureRaw };
}

interface PayloadFields {
  outputSha256?: string;
  taskId?: string;
  verifierTierRaw?: string;
  ensembleScore?: number;
  pCorrect?: number;
  epsilon?: number;
  traceSha256?: string;
  verifierVersions?: unknown[];
  issuedAt?: number;
}

function readPayloadFields(payload: Record<string, unknown> | null): PayloadFields {
  if (!payload) return {};
  return {
    outputSha256: typeof payload.outputSha256 === "string" ? payload.outputSha256 : undefined,
    taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
    verifierTierRaw: typeof payload.verifierTier === "string" ? payload.verifierTier : undefined,
    ensembleScore: isFiniteNumber(payload.ensembleScore) ? payload.ensembleScore : undefined,
    pCorrect: isFiniteNumber(payload.pCorrect) ? payload.pCorrect : undefined,
    epsilon: isFiniteNumber(payload.epsilon) ? payload.epsilon : undefined,
    traceSha256: typeof payload.traceSha256 === "string" ? payload.traceSha256 : undefined,
    verifierVersions: Array.isArray(payload.verifierVersions) ? payload.verifierVersions : undefined,
    issuedAt: isFiniteNumber(payload.issuedAt) ? payload.issuedAt : undefined,
  };
}

interface ReplayEntry {
  taskId: string;
  outputSha256: string;
  /** The participant a certificate was FIRST successfully consumed by. A
   *  different participant presenting the same signature is certificate
   *  theft, not honest work — see the replay block in `run()`. */
  participantId: ParticipantId;
}

// ---------------------------------------------------------------------------
// ClaimAdjudicator
// ---------------------------------------------------------------------------

export class ClaimAdjudicator {
  private readonly policy: ClaimPolicy;
  private readonly trustedSet: ReadonlySet<string>;
  private readonly knownVersionsSet: ReadonlySet<string> | undefined;
  private replaySeen: Map<string, ReplayEntry> = new Map();

  constructor(policy: ClaimPolicy) {
    this.policy = policy;
    this.trustedSet = new Set(normalizeIssuers(policy?.trustedIssuers ?? []));
    this.knownVersionsSet = policy?.knownVerifierVersions
      ? new Set(policy.knownVerifierVersions)
      : undefined;
  }

  async adjudicate(claim: VerifiedClaim, now: number): Promise<ClaimAdjudication> {
    try {
      return await this.run(claim, now);
    } catch {
      const ident = extractIdentity(claim);
      return {
        status: "unverified",
        taskId: ident.taskId,
        participantId: ident.participantId as ParticipantId,
        codes: ["malformed-claim"],
        certSha256: undefined,
        pCorrect: undefined,
        tier: undefined,
        epsilon: undefined,
        score: 0,
        fabricated: false,
        detail: "adjudication failed on structurally invalid input",
      };
    }
  }

  /** Number of distinct (by signature) certificates ever recorded. */
  seenCertificates(): number {
    return this.replaySeen.size;
  }

  /** Drop replay-registry entries first bound to `taskId`. */
  forget(taskId: string): void {
    for (const [key, entry] of this.replaySeen) {
      if (entry.taskId === taskId) this.replaySeen.delete(key);
    }
  }

  /** Clear all replay state. */
  reset(): void {
    this.replaySeen = new Map();
  }

  /**
   * The replay registry as a deterministic JSON string (entries emitted in
   * sorted key order, so two adjudicators fed the same consumptions
   * serialize byte-identically).
   *
   * This exists because the registry is the ONLY defence against re-spending
   * a certificate, and a process boundary would otherwise erase it: an
   * adjudicator that forgets everything on restart lets any certificate ever
   * issued be consumed a second time by the next `hades market` invocation.
   * A durable surface must persist this alongside the reputation ledger.
   */
  serializeReplayRegistry(): string {
    const keys = [...this.replaySeen.keys()].sort();
    const parts = keys.map((k) => {
      const e = this.replaySeen.get(k)!;
      return `${JSON.stringify(k)}:{"taskId":${JSON.stringify(e.taskId)},"outputSha256":${JSON.stringify(
        e.outputSha256,
      )},"participantId":${JSON.stringify(e.participantId)}}`;
    });
    return `{"version":1,"seen":{${parts.join(",")}}}`;
  }

  /**
   * Restore a registry produced by {@link serializeReplayRegistry},
   * REPLACING whatever is currently held. Returns the number of entries
   * loaded. Throws `TypeError` on a malformed envelope rather than silently
   * loading an empty registry — a silently-empty replay registry is
   * indistinguishable from "no certificate has ever been spent", which is
   * exactly the state an attacker wants it in.
   */
  loadReplayRegistry(json: string): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new TypeError(`replay registry is not valid JSON: ${(err as Error).message}`);
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.seen)) {
      throw new TypeError("unrecognized replay-registry envelope");
    }
    const next = new Map<string, ReplayEntry>();
    for (const [key, value] of Object.entries(parsed.seen)) {
      if (
        typeof key !== "string" ||
        key.length === 0 ||
        !isRecord(value) ||
        typeof value.taskId !== "string" ||
        typeof value.outputSha256 !== "string" ||
        typeof value.participantId !== "string"
      ) {
        throw new TypeError(`malformed replay-registry entry for key "${String(key)}"`);
      }
      next.set(key, {
        taskId: value.taskId,
        outputSha256: value.outputSha256,
        participantId: value.participantId,
      });
    }
    this.replaySeen = next;
    return next.size;
  }

  // -------------------------------------------------------------------------

  private async run(claim: VerifiedClaim, now: number): Promise<ClaimAdjudication> {
    const ident = extractIdentity(claim);

    if (!isValidClaimShape(claim)) {
      return {
        status: "unverified",
        taskId: ident.taskId,
        participantId: ident.participantId as ParticipantId,
        codes: ["malformed-claim"],
        certSha256: undefined,
        pCorrect: undefined,
        tier: undefined,
        epsilon: undefined,
        score: 0,
        fabricated: false,
        detail: "claim payload is structurally invalid and cannot be adjudicated",
      };
    }

    const safeNow = isFiniteNumber(now) ? now : 0;
    const rawCert: unknown = claim.certificate;

    if (rawCert === undefined || rawCert === null) {
      return {
        status: "unverified",
        taskId: claim.taskId,
        participantId: claim.participantId,
        codes: ["no-certificate"],
        certSha256: undefined,
        pCorrect: undefined,
        tier: undefined,
        epsilon: undefined,
        score: 0,
        fabricated: false,
        detail: "no certificate attached — honest abstention, not a lie",
      };
    }

    const certSha256 = certificateFingerprint(rawCert);
    const { payload, publicKeyHex, signatureRaw } = readCertificate(rawCert);

    let sigValid = false;
    try {
      sigValid = await verifyCertificate(rawCert as VerificationCertificate);
    } catch {
      sigValid = false;
    }

    const codes = new Set<ClaimRejectionCode>();

    if (!sigValid) {
      // A broken signature invalidates every downstream field: canonicalize()
      // covers the WHOLE payload, so ANY tampering (or an outright forgery)
      // collapses to this single code. Nothing else about the payload can be
      // trusted enough to report.
      codes.add("bad-signature");
      return this.buildResult(claim, codes, {
        certSha256,
        pCorrect: undefined,
        tier: undefined,
        epsilon: undefined,
      });
    }

    // From here on the signature is cryptographically authentic: the payload
    // really was issued, unmodified, by the holder of `publicKeyHex`. Every
    // remaining check is a POLICY check on genuine content, and ALL
    // applicable codes are collected (multi-fault claims report everything).
    const fields = readPayloadFields(payload);
    const cert = rawCert as VerificationCertificate;

    if (!publicKeyHex || !this.trustedSet.has(publicKeyHex)) {
      codes.add("untrusted-issuer");
    }

    const boundToOutput = await certifiesOutput(cert, claim.outputText).catch(() => false);
    if (!boundToOutput) codes.add("output-mismatch");

    if (fields.taskId === undefined || fields.taskId !== claim.taskId) {
      codes.add("task-mismatch");
    }

    if (this.policy.requireTraceBinding) {
      if (typeof claim.traceJson !== "string") {
        codes.add("trace-mismatch");
      } else if (
        fields.traceSha256 === undefined ||
        sha256Hex(claim.traceJson) !== fields.traceSha256.toLowerCase()
      ) {
        codes.add("trace-mismatch");
      }
    }

    if (
      fields.epsilon === undefined ||
      fields.epsilon < 0 ||
      fields.epsilon > this.policy.maxEpsilon + 1e-9
    ) {
      codes.add("epsilon-over-policy");
    }

    let tierValue: TierId | undefined;
    if (fields.verifierTierRaw !== undefined && isTierId(fields.verifierTierRaw)) {
      tierValue = fields.verifierTierRaw;
    }
    if (tierValue === undefined) {
      // A verifierTier string that doesn't even appear in TIER_ORDER is a
      // fabricated tier label — using tier ordering to catch nonsense claims.
      codes.add("tier-overclaim");
    } else if (!this.policy.acceptedTiers.includes(tierValue)) {
      codes.add("tier-not-accepted");
    }

    if (fields.issuedAt === undefined) {
      codes.add("stale-certificate");
    } else {
      if (fields.issuedAt > safeNow + this.policy.clockSkewToleranceMs) {
        codes.add("future-certificate");
      }
      if (fields.issuedAt < safeNow - this.policy.maxCertificateAgeMs) {
        codes.add("stale-certificate");
      }
    }

    if (fields.verifierVersions === undefined || fields.verifierVersions.length === 0) {
      codes.add("empty-verifier-versions");
    } else if (this.knownVersionsSet) {
      const known = this.knownVersionsSet;
      const allKnown = fields.verifierVersions.every((v) => typeof v === "string" && known.has(v));
      if (!allKnown) codes.add("unknown-verifier-version");
    }

    const pOk = fields.pCorrect !== undefined && fields.pCorrect >= 0 && fields.pCorrect <= 1;
    const eOk =
      fields.ensembleScore !== undefined && fields.ensembleScore >= 0 && fields.ensembleScore <= 1;
    if (!pOk || !eOk) codes.add("score-out-of-range");

    if (pOk && claim.claimedPCorrect > (fields.pCorrect as number) + 1e-9) {
      codes.add("claim-exceeds-certificate");
    }

    // Replay is checked LAST, and the registry is written ONLY by a
    // presentation that survived every other check. Two properties depend on
    // that ordering:
    //
    //  1. NO REGISTRY POISONING. If a rejected presentation could bind a
    //     certificate, anyone who observes a signature (settlement records
    //     are public) could pre-bind it to a bogus task/output and the
    //     legitimate holder's own later, correct submission would come back
    //     `replayed-certificate` -> fabricated -> slashed and banned. Only a
    //     genuine, fully-valid consumption binds.
    //  2. NO CERTIFICATE THEFT. The binding includes the participant that
    //     consumed it. A second participant re-presenting a stolen but
    //     otherwise byte-identical certificate (same task, same output —
    //     which passes every content check, because it IS the real
    //     certificate) is caught here and only here.
    //
    // Same participant + same task + same output = idempotent re-submission,
    // which is not a replay and carries no code.
    if (signatureRaw !== undefined && signatureRaw.length > 0) {
      const sigKey = sha256Hex(signatureRaw);
      const submittedOutputSha = sha256Hex(claim.outputText);
      const prior = this.replaySeen.get(sigKey);
      if (prior === undefined) {
        if (codes.size === 0) {
          this.replaySeen.set(sigKey, {
            taskId: claim.taskId,
            outputSha256: submittedOutputSha,
            participantId: claim.participantId,
          });
        }
      } else if (
        prior.taskId !== claim.taskId ||
        prior.outputSha256 !== submittedOutputSha ||
        prior.participantId !== claim.participantId
      ) {
        codes.add("replayed-certificate");
      }
    }

    return this.buildResult(claim, codes, {
      certSha256,
      pCorrect: pOk ? (fields.pCorrect as number) : undefined,
      tier: tierValue,
      epsilon: fields.epsilon !== undefined ? fields.epsilon : undefined,
    });
  }

  private buildResult(
    claim: VerifiedClaim,
    codes: Set<ClaimRejectionCode>,
    extra: {
      certSha256: string;
      pCorrect: number | undefined;
      tier: TierId | undefined;
      epsilon: number | undefined;
    },
  ): ClaimAdjudication {
    const sortedCodes = ALL_CLAIM_REJECTION_CODES.filter((c) => codes.has(c));
    const fabricated = sortedCodes.length > 0;
    const status: ClaimStatus = fabricated ? "fabricated" : "verified";
    const score = fabricated ? 0 : (extra.pCorrect as number);

    const detail = fabricated
      ? `certificate rejected: ${sortedCodes.join(", ")}`
      : `certificate verified: tier=${extra.tier}, pCorrect=${(extra.pCorrect as number).toFixed(6)}, epsilon<=${this.policy.maxEpsilon}`;

    return {
      status,
      taskId: claim.taskId,
      participantId: claim.participantId,
      codes: sortedCodes,
      certSha256: extra.certSha256,
      pCorrect: extra.pCorrect,
      tier: extra.tier,
      epsilon: extra.epsilon,
      score,
      fabricated,
      detail,
    };
  }
}

// Re-exported for callers who need the raw payload shape without importing
// the engine module directly.
export type { CertificatePayload };
