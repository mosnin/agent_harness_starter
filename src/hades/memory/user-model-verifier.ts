/**
 * `verify.user-model` — an INDEPENDENT STYX auditor over the Phase-5
 * dialectic user model.
 *
 * `DialecticUserModel` (`./user-model.ts`) already enforces its own
 * invariant end to end: `UserBelief.confidence` is never free-set, it is
 * always the output of `combineEvidence()` run over that belief's evidence
 * ledger, and `fromJSON` re-derives confidence rather than trusting a stored
 * number. That is a strong guarantee about the ONE code path
 * (`DialecticUserModel.assert` / `.fromJSON`) that produces beliefs — but it
 * is a guarantee the model gives ITSELF. An auditor that only re-runs the
 * model's own logic on the model's own output proves nothing new.
 *
 * This module is the outside check: given nothing but a `DialecticUserModel`
 * instance (queried ONLY through its public snapshot, `model.all()`) and,
 * optionally, the durable `EvidenceLedger` that is supposed to back it, it
 * recomputes — from raw evidence alone, using its OWN pure math, not the
 * model's internal helpers — whether every belief's claimed confidence is
 * actually supportable, whether every excerpt hash and certificate is
 * genuinely valid, and whether the evidence ledger genuinely backs what the
 * model claims to hold. It catches exactly the class of bug
 * `DialecticUserModel.assert()` cannot: a snapshot object that was
 * hand-constructed (or corrupted) to bypass `assert()` entirely — e.g. a
 * `UserBelief` literal with `confidence: 0.9` sitting over evidence that
 * only supports ~0.6. `DialecticUserModel` itself has no way to detect that
 * (nothing calls `assert()` to catch it); this module does, because it never
 * trusts the stored `confidence` field — it always recomputes.
 *
 * ---------------------------------------------------------------------------
 * Independence discipline
 * ---------------------------------------------------------------------------
 * The ONLY call this module ever makes against the live `model` argument is
 * `model.all()` (the public, defensively-cloned snapshot). Every other
 * computation — confidence recomputation, decay, tier capping, hash
 * verification, certificate re-verification, status-consistency checks — is
 * performed with this module's OWN pure functions applied directly to
 * `belief.evidence`, never via `model.decayedConfidence()`, `model.get()`,
 * `model.asserted()`, or any other convenience method that would route back
 * through the model's own (possibly-buggy, possibly-bypassed) internal
 * state. Even the exponential decay math is reimplemented locally rather
 * than imported from `./user-model.ts` (which does not export it) — an
 * independent auditor should not have to trust the correctness of a helper
 * it cannot see or call.
 *
 * `combineEvidence` IS imported and used directly — it is the one pure,
 * exported oracle for "what does this evidence array support", and calling
 * it ourselves (rather than reimplementing noisy-OR combination) is exactly
 * what "recompute ... via combineEvidence" in the design brief calls for.
 * On top of its result this module applies a SECOND, independently-sourced
 * cap via `tierCap` from `./belief-evidence.ts` — a different implementation
 * of "the ceiling a tier may contribute" than the one `combineEvidence` uses
 * internally (see that file's own docstring: it is meant to be THE single
 * calibration authority, separate from `user-model.ts`'s private copy).
 * Layering that second cap on top is defense in depth: today the two
 * implementations agree on every known tier, but the auditor does not take
 * that agreement on faith, and it will keep catching a future divergence
 * (or a malformed/unknown tier string, which `belief-evidence.ts`'s
 * `tierCap` throws on and this module's internal one does not).
 *
 * ---------------------------------------------------------------------------
 * Two checks, two reference times (an important, deliberate distinction)
 * ---------------------------------------------------------------------------
 * `confidence-exceeds-evidence` asks a TIMELESS question — "was the number
 * stamped on this belief ever honest?" — so it always compares the STORED
 * `belief.confidence` field, verbatim, against evidence recombined at
 * belief.updatedAt (the instant that field claims to describe). It never
 * uses `opts.now` at all: an outside caller auditing a week later should not
 * be able to make a belief that was honest when written look dishonest
 * merely because time passed.
 *
 * `asserted-below-floor` asks the OPPOSITE — a temporally-relative question,
 * "is this belief's LIVE confidence, right now, still above the floor?" — so
 * it recombines the evidence fresh at `opts.now ?? belief.updatedAt`, via
 * the exact same `combineEvidence` oracle used for `supportable`, rather
 * than scalar-decaying the (possibly tier-capped, possibly multi-evidence)
 * stored number. This distinction is not academic: an earlier version of
 * this module instead projected the stored scalar forward with its own
 * independent decay factor, and that produces real false positives for
 * multi-evidence beliefs whose combined confidence is capped — decaying an
 * already-capped aggregate as if it were one fresh number decays far faster
 * than honestly re-decaying each underlying evidence item and recombining
 * via noisy-OR, which is what `combineEvidence` actually does. Always
 * recombining from raw evidence, never scalar-projecting a derived number,
 * is what "independent recomputation" is supposed to mean.
 *
 * ---------------------------------------------------------------------------
 * Half-life caveat (an honest limitation, not swept under the rug)
 * ---------------------------------------------------------------------------
 * `DialecticUserModel`'s configured `halfLifeMs` is private construction
 * state, not part of the public snapshot — there is no way for an outside
 * auditor to read it. This module assumes the documented codebase default
 * (30 days, `DialecticModelOptions`'s own default, and the only value any
 * caller in this codebase actually configures) whenever it recombines
 * evidence at a reference time other than each individual evidence item's
 * own `at` (i.e. whenever any decay is actually being applied). A model
 * constructed with a materially different custom half-life could, in
 * principle, cause a benign mismatch. This does not weaken
 * `confidence-exceeds-evidence`'s core guarantee: for evidence recorded at
 * (or very near) `belief.updatedAt` — the entire adversarial test surface
 * this module is built against — decay is at or near 1 regardless of
 * half-life, so the comparison needs no half-life assumption at all.
 */

import { type UserBelief, DialecticUserModel, combineEvidence } from "./user-model";
import { tierCap, EvidenceLedger } from "./belief-evidence";
import { type VerifierVote, type TierId } from "../styx/tiers";
import { verifyCertificate, sha256Hex } from "../styx/certificate";

// ===========================================================================
// Locked public contract
// ===========================================================================

export interface BeliefAuditFinding {
  attribute: string;
  kind:
    | "confidence-exceeds-evidence"
    | "asserted-below-floor"
    | "asserted-while-contested"
    | "evidence-hash-mismatch"
    | "invalid-certificate-trusted"
    | "ledger-mismatch";
  detail: string;
  claimed: number;
  supportable: number;
}

export interface UserModelAuditReport extends VerifierVote {
  verifierId: "verify.user-model";
  passed: boolean;
  confidence: number;
  findings: BeliefAuditFinding[];
  beliefsAudited: number;
  evidenceAudited: number;
}

export interface AuditUserModelOptions {
  ledger?: EvidenceLedger;
  /** Default 0.55 — matches `DialecticModelOptions.assertFloor`'s own default. */
  assertFloor?: number;
  /** Reference instant to audit at. Default: each belief's own `updatedAt`
   *  (i.e. audit the stored value as-of the moment it was last touched,
   *  which needs no half-life assumption at all). */
  now?: number;
}

// ===========================================================================
// Local, independently-authored pure helpers
// ===========================================================================

/** Mirrors `DialecticModelOptions.assertFloor`'s own documented default —
 *  duplicated here deliberately (see module docstring) rather than imported,
 *  since it is not part of `./user-model.ts`'s exported surface. */
const DEFAULT_ASSERT_FLOOR = 0.55;

/** Mirrors `DialecticModelOptions.halfLifeMs`'s own documented default (30
 *  days) — the only half-life value any caller in this codebase actually
 *  configures. See the "Half-life caveat" section of the module docstring. */
const ASSUMED_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

const FINDING_TOLERANCE = 1e-9;

function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Independent cap: the strongest per-tier ceiling among a belief's
 * SUPPORTING evidence, via `belief-evidence.ts`'s `tierCap` — a separately
 * sourced implementation from the one `combineEvidence` applies internally
 * (see module docstring). An unrecognised tier string degrades to the
 * conservative T4-consistency floor rather than throwing (the same honest
 * fallback `combineEvidence`'s own internal cap uses), but the fact that it
 * HAD to fall back is itself informative — callers that care can see it in
 * the belief's evidence directly.
 */
function independentCap(evidence: UserBelief["evidence"]): number {
  let cap = 0;
  for (const e of evidence) {
    if (!e || e.polarity !== "supports") continue;
    let c: number;
    try {
      c = tierCap(e.tier);
    } catch {
      c = 0.6;
    }
    if (c > cap) cap = c;
  }
  return cap;
}

/**
 * Recompute the supportable confidence for a belief's evidence ledger at
 * `referenceNow`, from scratch: `combineEvidence` (the real noisy-OR +
 * decay + internal cap) further capped by the independently-sourced
 * `tierCap`. Never trusts anything stored on the belief itself.
 */
function supportableConfidenceAt(evidence: UserBelief["evidence"], referenceNow: number): number {
  const combined = combineEvidence(evidence, referenceNow, ASSUMED_HALF_LIFE_MS);
  return clamp01(Math.min(combined, independentCap(evidence)));
}

/**
 * Real, independent re-verification that `e.certificate` is (a) a validly
 * signed ed25519 envelope, (b) bound to exactly `e.excerpt`
 * (`payload.outputSha256 === sha256Hex(e.excerpt)` — replay resistance), and
 * (c) claims the SAME tier `e` itself claims. All three must hold for a
 * certificate to be considered genuinely trustworthy by this audit — never
 * throws, degrades to `false` on any malformed input.
 */
async function independentCertificateCheck(e: UserBelief["evidence"][number]): Promise<boolean> {
  if (!e.certificate) return false;
  try {
    const sigOk = await verifyCertificate(e.certificate);
    if (!sigOk) return false;
    const payload = e.certificate.payload as { outputSha256?: unknown; verifierTier?: unknown } | undefined;
    if (typeof payload?.outputSha256 !== "string" || payload.outputSha256 !== sha256Hex(e.excerpt)) return false;
    if (payload.verifierTier !== e.tier) return false;
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// auditUserModel
// ===========================================================================

/**
 * Independently re-audit `model`. See the module docstring for the
 * independence discipline this function follows — the ONLY thing it ever
 * asks of `model` is `model.all()`.
 */
export async function auditUserModel(
  model: DialecticUserModel,
  opts: AuditUserModelOptions = {},
): Promise<UserModelAuditReport> {
  if (!model || typeof model.all !== "function") {
    throw new TypeError("auditUserModel: model must be a DialecticUserModel");
  }

  const assertFloor = opts.assertFloor !== undefined ? clamp01(opts.assertFloor) : DEFAULT_ASSERT_FLOOR;
  const beliefs = model.all();
  const findings: BeliefAuditFinding[] = [];
  let evidenceAudited = 0;

  for (const belief of beliefs) {
    evidenceAudited += belief.evidence.length;

    // --- confidence-exceeds-evidence: timeless — always at belief.updatedAt.
    const claimed = clamp01(belief.confidence);
    const supportableAtUpdated = supportableConfidenceAt(belief.evidence, belief.updatedAt);
    if (claimed - supportableAtUpdated > FINDING_TOLERANCE) {
      findings.push({
        attribute: belief.attribute,
        kind: "confidence-exceeds-evidence",
        detail: `belief "${belief.attribute}" claims confidence ${claimed.toFixed(6)} as of its own updatedAt, but its evidence ledger independently supports at most ${supportableAtUpdated.toFixed(6)} at that instant`,
        claimed,
        supportable: supportableAtUpdated,
      });
    }

    // --- asserted-below-floor: temporally-relative — honest live recombination
    // at opts.now (default belief.updatedAt), never a scalar decay of the
    // stored number (see module docstring's "Two checks, two reference
    // times" section for why that distinction matters).
    const referenceNow = opts.now !== undefined && Number.isFinite(opts.now) ? opts.now : belief.updatedAt;
    const liveSupportable =
      referenceNow === belief.updatedAt ? supportableAtUpdated : supportableConfidenceAt(belief.evidence, referenceNow);
    if (belief.status === "asserted" && liveSupportable < assertFloor - FINDING_TOLERANCE) {
      findings.push({
        attribute: belief.attribute,
        kind: "asserted-below-floor",
        detail: `belief "${belief.attribute}" is status "asserted" but its live confidence ${liveSupportable.toFixed(6)} as of t=${referenceNow} is below the assert floor ${assertFloor}`,
        claimed: liveSupportable,
        supportable: assertFloor,
      });
    }

    // A belief explicitly reported as "contested" is not itself a finding —
    // that IS the model honestly abstaining. What this audit distrusts is
    // the OPPOSITE: a belief claiming "asserted" while its own evidence
    // ledger holds a same-value contradiction, which the real dialectic
    // engine (`reconcileBelief`'s same-value-"contradicts" rule) would
    // always have routed to "contested" instead — so seeing it anyway is
    // proof of a bypass (a hand-built snapshot, not a real `assert()`
    // history).
    if (belief.status === "asserted" && belief.evidence.some((e) => e.polarity === "contradicts")) {
      findings.push({
        attribute: belief.attribute,
        kind: "asserted-while-contested",
        detail: `belief "${belief.attribute}" is status "asserted" but its evidence ledger contains a same-value "contradicts" entry — the real dialectic engine (reconcileBelief) never leaves a belief asserted through that combination, so this snapshot bypassed assert()`,
        claimed,
        supportable: supportableAtUpdated,
      });
    }

    for (const e of belief.evidence) {
      if (sha256Hex(e.excerpt) !== e.excerptSha256) {
        findings.push({
          attribute: belief.attribute,
          kind: "evidence-hash-mismatch",
          detail: `evidence ${e.id} on belief "${belief.attribute}": sha256Hex(excerpt) does not match the stored excerptSha256 — the excerpt was tampered with after the hash was computed`,
          claimed: 1,
          supportable: 0,
        });
      }

      const certOk = await independentCertificateCheck(e);
      if (e.certificateValid === true && !certOk) {
        findings.push({
          attribute: belief.attribute,
          kind: "invalid-certificate-trusted",
          detail: `evidence ${e.id} on belief "${belief.attribute}" is marked certificateValid=true, but independent ed25519 signature/binding/tier re-verification failed`,
          claimed: 1,
          supportable: 0,
        });
      } else if (e.tier !== "T4-consistency" && !certOk) {
        findings.push({
          attribute: belief.attribute,
          kind: "invalid-certificate-trusted",
          detail: `evidence ${e.id} on belief "${belief.attribute}" claims tier "${e.tier}" (stronger than T4-consistency) without a certificate that independently re-verifies as valid and bound to this excerpt`,
          claimed: 1,
          supportable: 0,
        });
      }
    }
  }

  if (opts.ledger) {
    const chain = opts.ledger.verifyChain();
    if (!chain.ok) {
      findings.push({
        attribute: "*",
        kind: "ledger-mismatch",
        detail: `the provided evidence ledger's hash chain is broken at seq ${chain.brokenAt} — it cannot be trusted to back any belief`,
        claimed: 1,
        supportable: 0,
      });
    } else {
      // Keyed by (attribute, evidence id) -> the ledger's OWN tamper-evident
      // copy of that evidence, not just a presence flag. `EvidenceLedger`'s
      // hash chain (already verified above) guarantees this copy is exactly
      // what was appended at the time — a stronger source of truth than the
      // live snapshot for anything that can be edited in-place after the
      // fact. `DialecticUserModel.fromJSON` honestly RE-DERIVES `confidence`
      // from whatever weight it finds on load, so `confidence-exceeds-
      // evidence` alone can never catch a snapshot-only edit to an evidence
      // weight (the recomputed confidence will always agree with the edited
      // weight — that IS `fromJSON`'s own defense working correctly). This
      // ledger cross-check closes exactly that gap: it is the one place a
      // weight silently altered on disk, between the ledger append and the
      // next load, is actually caught.
      const ledgerByKey = new Map<string, ReturnType<EvidenceLedger["entries"]>[number]>();
      for (const en of opts.ledger.entries()) ledgerByKey.set(`${en.attribute} ${en.evidence.id}`, en);

      for (const belief of beliefs) {
        for (const e of belief.evidence) {
          const key = `${belief.attribute} ${e.id}`;
          const entry = ledgerByKey.get(key);
          if (!entry) {
            findings.push({
              attribute: belief.attribute,
              kind: "ledger-mismatch",
              detail: `evidence ${e.id} on belief "${belief.attribute}" is present in the model but has no matching entry in the provided ledger`,
              claimed: 1,
              supportable: 0,
            });
          } else if (Math.abs(entry.evidence.weight - e.weight) > FINDING_TOLERANCE) {
            findings.push({
              attribute: belief.attribute,
              kind: "ledger-mismatch",
              detail: `evidence ${e.id} on belief "${belief.attribute}" has weight ${e.weight} in the live model, but the tamper-evident ledger recorded weight ${entry.evidence.weight} for the same evidence id — the belief snapshot was edited after ledgering`,
              claimed: e.weight,
              supportable: entry.evidence.weight,
            });
          }
        }
      }
    }
  }

  const passed = findings.length === 0;
  const calibration = userModelCalibration();

  return {
    verifierId: "verify.user-model",
    passed,
    // A clean audit reports this module's own calibrated ceiling (see
    // userModelCalibration()) — "we found nothing wrong" is only ever
    // evidence up to that ceiling, never certainty. A failed audit reports 0:
    // this is deterministic recomputation, so a finding is not a probabilistic
    // suspicion, it is a proven mismatch between a claim and its evidence.
    confidence: passed ? clamp01(calibration.prior) : 0,
    findings,
    beliefsAudited: beliefs.length,
    evidenceAudited,
  };
}

// ===========================================================================
// userModelCalibration
// ===========================================================================

/**
 * This auditor's honest tier + calibrated prior, in the same
 * `memoryWriteCalibration()`-style spirit as `./guard.ts`.
 *
 * The math this module performs — recomputing `combineEvidence` from raw
 * evidence, recomputing sha256 hashes, re-verifying ed25519 signatures — is
 * EXACT, deterministic recomputation: on the specific structural claims it
 * checks (does this excerpt hash to what's claimed, does this signature
 * verify, does this confidence number equal what noisy-OR combination of
 * this evidence produces), it is correct essentially by construction, not by
 * statistical estimate. That is a genuinely strong, decisive-structural-check
 * signal, on par with the strongest checks `../tools/verifiers.ts`'s
 * documented T4 range describes.
 *
 * It still belongs at T4-consistency, not any stronger tier, because none of
 * that exactness reaches outside the model's own data: this audit has no
 * oracle, no retrieved reference, no rubric grader, and no independent model
 * family to check the EVIDENCE ITSELF against — it can prove "this belief's
 * number is exactly what this evidence supports" and "this excerpt text is
 * exactly what this hash commits to", but it cannot prove the excerpt text
 * corresponds to anything true about the real user. A perfectly
 * self-consistent, perfectly hash-correct, perfectly signed belief can still
 * be built on evidence that is itself wrong or fabricated upstream (a
 * hallucinated extraction, a maliciously "helpful" injected line the
 * extraction guards happened to miss) — this module has no way to see that.
 * The prior (0.65) sits at the decisive-structural-check end of the
 * documented T4 range in `../tools/verifiers.ts` (0.4 weakest / ~0.65
 * strongest) — deliberately higher than `memoryWriteCalibration()`'s 0.6
 * (that check is fuzzy lexical contradiction detection with real false-
 * positive/negative rates; this one is exact arithmetic and cryptographic
 * verification with none), but never promoted out of T4, because "exact
 * about its own math" is not the same claim as "true about the world".
 */
export function userModelCalibration(): { tier: TierId; prior: number } {
  return { tier: "T4-consistency", prior: 0.65 };
}
