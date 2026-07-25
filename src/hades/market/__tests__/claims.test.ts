/**
 * ADVERSARIAL VERIFICATION of the Certificate-Gated Claim Adjudicator
 * (`src/hades/market/claims.ts`).
 *
 * This suite does not just check the happy path — it ATTACKS every leg of
 * the "verified" claim: forged signatures, signatures from the wrong key,
 * every individually-tampered CertificatePayload field, output/task
 * rebinding, cross-task replay, epsilon/tier/freshness/version policy
 * violations, out-of-range scores, over-claimed confidence, trace binding,
 * and a battery of structurally hostile inputs. Every "fabricated" path is
 * additionally asserted to score EXACTLY 0.
 *
 * REAL crypto throughout: a real `CertificateAuthority` (ed25519 via
 * @noble/ed25519, seeded deterministically — no Math.random) issues REAL
 * certificates; nothing here is stubbed. Deterministic: `now` is always
 * passed explicitly, never `Date.now()`.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_CLAIM_REJECTION_CODES,
  ClaimAdjudicator,
  defaultClaimPolicy,
  type ClaimAdjudication,
  type ClaimPolicy,
  type ClaimRejectionCode,
  type VerifiedClaim,
} from "../claims";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";
import { TIER_ORDER } from "../../styx/tiers";

// ---------------------------------------------------------------------------
// Deterministic key material — xorshift32 seeded byte generator, no
// Math.random anywhere. Distinct seeds give distinct REAL ed25519 keypairs.
// ---------------------------------------------------------------------------

function seededRng(seed: number): (bytes: number) => Uint8Array {
  let state = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state >>>= 0;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

const CA_TRUSTED = new CertificateAuthority(generatePrivateKeyHex(seededRng(1)));
const CA_UNTRUSTED = new CertificateAuthority(generatePrivateKeyHex(seededRng(2)));
const CA_OTHER = new CertificateAuthority(generatePrivateKeyHex(seededRng(3)));
const CA_TRUSTED_2 = new CertificateAuthority(generatePrivateKeyHex(seededRng(4)));

// Sanity: seeds really do produce distinct real keypairs.
if (
  CA_TRUSTED.publicKeyHex() === CA_UNTRUSTED.publicKeyHex() ||
  CA_TRUSTED.publicKeyHex() === CA_OTHER.publicKeyHex() ||
  CA_UNTRUSTED.publicKeyHex() === CA_OTHER.publicKeyHex()
) {
  throw new Error("test setup bug: seeded CAs collided");
}

const NOW = 1_700_000_000_000;
const OUTPUT_TEXT = "the delivered agent output, verbatim";
const TRACE_JSON = JSON.stringify({ steps: ["plan", "execute", "verify"], ok: true });

function makePayload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(OUTPUT_TEXT),
    taskId: "task-alpha",
    verifierTier: "T1-reference",
    ensembleScore: 0.93,
    pCorrect: 0.95,
    epsilon: 0.05,
    traceSha256: sha256Hex(TRACE_JSON),
    verifierVersions: ["genrm-v1", "consistency-v2"],
    issuedAt: NOW - 1000,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    taskId: "task-alpha",
    participantId: "participant-1",
    outputText: OUTPUT_TEXT,
    claimedPCorrect: 0.9,
    traceJson: TRACE_JSON,
    submittedAt: NOW - 500,
    ...overrides,
  };
}

function basePolicy(overrides: Partial<ClaimPolicy> = {}): ClaimPolicy {
  return {
    ...defaultClaimPolicy([CA_TRUSTED.publicKeyHex(), CA_TRUSTED_2.publicKeyHex()]),
    ...overrides,
  };
}

async function issueValid(
  payloadOverrides: Partial<CertificatePayload> = {},
  ca: CertificateAuthority = CA_TRUSTED,
): Promise<VerificationCertificate> {
  return ca.issue(makePayload(payloadOverrides));
}

function flipHexChar(hex: string): string {
  const i = 0;
  const c = hex[i];
  const flipped = c === "0" ? "1" : "0";
  return flipped + hex.slice(1);
}

// ===========================================================================
// 0. defaultClaimPolicy sanity
// ===========================================================================

describe("defaultClaimPolicy", () => {
  it("lowercases trusted issuers on ingest", () => {
    const policy = defaultClaimPolicy(["ABCDEF0123"]);
    expect(policy.trustedIssuers).toEqual(["abcdef0123"]);
  });

  it("accepts every known tier and requires trace binding by default", () => {
    const policy = defaultClaimPolicy([]);
    expect([...policy.acceptedTiers].sort()).toEqual([...TIER_ORDER].sort());
    expect(policy.requireTraceBinding).toBe(true);
    expect(policy.maxEpsilon).toBeGreaterThan(0);
    expect(policy.maxCertificateAgeMs).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 1. Honest abstention — no certificate
// ===========================================================================

describe("no certificate attached", () => {
  const adjudicator = new ClaimAdjudicator(basePolicy());

  it("is 'unverified', not 'fabricated' — honest abstention", async () => {
    const result = await adjudicator.adjudicate(makeClaim({ certificate: undefined }), NOW);
    expect(result.status).toBe("unverified");
    expect(result.codes).toEqual(["no-certificate"]);
    expect(result.score).toBe(0);
    expect(result.fabricated).toBe(false);
    expect(result.certSha256).toBeUndefined();
    expect(result.pCorrect).toBeUndefined();
  });

  it("explicit null certificate (hostile cast) is also honest abstention, not fabrication", async () => {
    const claim = { ...makeClaim(), certificate: null } as unknown as VerifiedClaim;
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("unverified");
    expect(result.codes).toEqual(["no-certificate"]);
    expect(result.score).toBe(0);
    expect(result.fabricated).toBe(false);
  });
});

// ===========================================================================
// 2. Signature bytes flipped
// ===========================================================================

describe("2. tampered signature bytes", () => {
  it("a single flipped signature hex character -> bad-signature, fabricated, score 0", async () => {
    const cert = await issueValid();
    const forged: VerificationCertificate = { ...cert, signature: flipHexChar(cert.signature) };
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const result = await adjudicator.adjudicate(makeClaim({ certificate: forged }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
    expect(result.score).toBe(0);
    expect(result.fabricated).toBe(true);
    expect(result.pCorrect).toBeUndefined();
  });
});

// ===========================================================================
// 3. Signature of the right shape but from a DIFFERENT real key pair
// ===========================================================================

describe("3. signature from a different real keypair", () => {
  it("well-formed 64-byte signature that just doesn't match the claimed public key -> bad-signature", async () => {
    const payload = makePayload();
    const certA = await CA_TRUSTED.issue(payload);
    const certB = await CA_OTHER.issue(payload); // same payload, different real key
    const forged: VerificationCertificate = {
      payload: certA.payload,
      signature: certB.signature, // valid signature, but for CA_OTHER's key
      publicKey: certA.publicKey, // claims to be CA_TRUSTED
    };
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const result = await adjudicator.adjudicate(makeClaim({ certificate: forged }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
    expect(result.score).toBe(0);
  });
});

// ===========================================================================
// 4. Valid signature from a real but untrusted issuer
// ===========================================================================

describe("4. untrusted issuer", () => {
  it("genuinely valid certificate from a key outside trustedIssuers -> untrusted-issuer only", async () => {
    const cert = await issueValid({}, CA_UNTRUSTED);
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["untrusted-issuer"]);
    expect(result.score).toBe(0);
    // The signature IS authentic, so we still surface the authentic numbers.
    expect(result.pCorrect).toBeCloseTo(0.95, 9);
  });
});

// ===========================================================================
// 5. Every CertificatePayload field tampered independently after signing
// ===========================================================================

describe("5. every payload field tampered post-signature -> caught by the real signature check alone", () => {
  const adjudicator = new ClaimAdjudicator(basePolicy());

  async function tamperedResult(mutate: (p: CertificatePayload) => CertificatePayload): Promise<ClaimAdjudication> {
    const cert = await issueValid();
    const forged: VerificationCertificate = {
      ...cert,
      payload: mutate({ ...cert.payload, verifierVersions: [...cert.payload.verifierVersions] }),
    };
    return adjudicator.adjudicate(makeClaim({ certificate: forged }), NOW);
  }

  const cases: Array<[string, (p: CertificatePayload) => CertificatePayload]> = [
    ["outputSha256", (p) => ({ ...p, outputSha256: sha256Hex("something else entirely") })],
    ["taskId", (p) => ({ ...p, taskId: "task-beta" })],
    ["verifierTier", (p) => ({ ...p, verifierTier: "T0-execution" })],
    ["ensembleScore", (p) => ({ ...p, ensembleScore: 0.42 })],
    ["pCorrect", (p) => ({ ...p, pCorrect: 0.5 })],
    ["epsilon", (p) => ({ ...p, epsilon: 0.5 })],
    ["traceSha256", (p) => ({ ...p, traceSha256: sha256Hex("a different trace") })],
    ["verifierVersions (element added)", (p) => ({ ...p, verifierVersions: [...p.verifierVersions, "extra-v9"] })],
    ["verifierVersions (element removed)", (p) => ({ ...p, verifierVersions: p.verifierVersions.slice(0, -1) })],
    ["verifierVersions (reordered)", (p) => ({ ...p, verifierVersions: [...p.verifierVersions].reverse() })],
    [
      "verifierVersions (element value changed)",
      (p) => ({ ...p, verifierVersions: ["mutated-verifier-vX", ...p.verifierVersions.slice(1)] }),
    ],
    ["issuedAt", (p) => ({ ...p, issuedAt: p.issuedAt + 1 })],
  ];

  it.each(cases)("tampering %s alone breaks the signature", async (_name, mutate) => {
    const result = await tamperedResult(mutate);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
    expect(result.score).toBe(0);
  });

  it("covers at least 12 independently-tampered fields", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });
});

// ===========================================================================
// 6. Valid certificate presented for a DIFFERENT outputText
// ===========================================================================

describe("6. output rebinding", () => {
  it("a genuinely valid certificate presented against different output text -> output-mismatch", async () => {
    const cert = await issueValid();
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const result = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, outputText: "this is NOT what was certified" }),
      NOW,
    );
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["output-mismatch"]);
    expect(result.score).toBe(0);
  });
});

// ===========================================================================
// 7. Valid certificate for task A presented on task B
// ===========================================================================

describe("7. task rebinding", () => {
  it("a genuinely valid certificate for task A submitted under task B -> task-mismatch", async () => {
    const cert = await issueValid({ taskId: "task-A" });
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const result = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, taskId: "task-B" }),
      NOW,
    );
    expect(result.status).toBe("fabricated");
    expect(result.codes).toContain("task-mismatch");
    expect(result.score).toBe(0);
  });
});

// ===========================================================================
// 8. Replay — cross-task forbidden, same-task idempotent
// ===========================================================================

describe("8. replay registry", () => {
  it("replaying the same certificate across two different tasks -> replayed-certificate", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ taskId: "task-A" });

    const first = await adjudicator.adjudicate(makeClaim({ certificate: cert, taskId: "task-A" }), NOW);
    expect(first.status).toBe("verified");
    expect(adjudicator.seenCertificates()).toBe(1);

    const second = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, taskId: "task-B", participantId: "participant-2" }),
      NOW,
    );
    expect(second.status).toBe("fabricated");
    expect(second.codes).toContain("replayed-certificate");
    expect(second.codes).toContain("task-mismatch"); // payload still says task-A
    expect(second.score).toBe(0);
    // Replay registry records the signature once, not once per presentation.
    expect(adjudicator.seenCertificates()).toBe(1);
  });

  it("re-presenting the SAME certificate for the SAME task/output is idempotent, not fabrication", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid();
    const claim = makeClaim({ certificate: cert });

    const first = await adjudicator.adjudicate(claim, NOW);
    const second = await adjudicator.adjudicate(claim, NOW + 10);
    const third = await adjudicator.adjudicate(claim, NOW + 20);

    for (const r of [first, second, third]) {
      expect(r.status).toBe("verified");
      expect(r.codes).toEqual([]);
      expect(r.fabricated).toBe(false);
    }
    expect(adjudicator.seenCertificates()).toBe(1);
  });

  it("replaying the same certificate against a different OUTPUT (same task) -> replayed-certificate", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid();

    const first = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(first.status).toBe("verified");

    // Different output text -> also fails output-mismatch, but the replay
    // registry independently flags the reuse of the same signature.
    const second = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, outputText: "a totally different delivered output" }),
      NOW,
    );
    expect(second.status).toBe("fabricated");
    expect(second.codes).toContain("replayed-certificate");
    expect(second.codes).toContain("output-mismatch");
  });
});

// ===========================================================================
// 9. Epsilon above policy
// ===========================================================================

describe("9. epsilon policy", () => {
  it("certificate epsilon above policy.maxEpsilon -> epsilon-over-policy", async () => {
    const policy = basePolicy({ maxEpsilon: 0.02 });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ epsilon: 0.2 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["epsilon-over-policy"]);
    expect(result.score).toBe(0);
  });

  it("epsilon at or under the policy bound is accepted", async () => {
    const policy = basePolicy({ maxEpsilon: 0.1 });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ epsilon: 0.1 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("verified");
  });
});

// ===========================================================================
// 10. Tier above/weaker than acceptedTiers, and a fabricated tier label
// ===========================================================================

describe("10. tier policy", () => {
  it("a tier not in acceptedTiers (even a strong one) -> tier-not-accepted", async () => {
    const policy = basePolicy({ acceptedTiers: ["T2-genrm"] });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ verifierTier: "T0-execution" }); // strong, but excluded
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["tier-not-accepted"]);
  });

  it("a tier weaker than required (excluded from acceptedTiers) -> tier-not-accepted", async () => {
    const policy = basePolicy({ acceptedTiers: ["T2-genrm"] });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ verifierTier: "T4-consistency" }); // weak, excluded
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["tier-not-accepted"]);
  });

  it("an in-policy tier is accepted", async () => {
    const policy = basePolicy({ acceptedTiers: ["T1-reference", "T2-genrm"] });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ verifierTier: "T1-reference" });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("verified");
  });

  it("a fabricated/unknown tier label (not in TIER_ORDER at all) -> tier-overclaim", async () => {
    const policy = basePolicy();
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ verifierTier: "T9-imaginary-tier" });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["tier-overclaim"]);
    expect(result.tier).toBeUndefined();
  });
});

// ===========================================================================
// 11. Freshness — future and stale
// ===========================================================================

describe("11. certificate freshness", () => {
  it("issuedAt beyond clockSkewToleranceMs in the future -> future-certificate", async () => {
    const policy = basePolicy({ clockSkewToleranceMs: 60_000 });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ issuedAt: NOW + 10 * 60_000 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["future-certificate"]);
  });

  it("issuedAt older than maxCertificateAgeMs -> stale-certificate", async () => {
    const policy = basePolicy({ maxCertificateAgeMs: 60_000 });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ issuedAt: NOW - 10 * 60_000 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["stale-certificate"]);
  });

  it("a fresh certificate within both bounds is accepted", async () => {
    const policy = basePolicy({ clockSkewToleranceMs: 60_000, maxCertificateAgeMs: 60_000 });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ issuedAt: NOW - 1000 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("verified");
  });
});

// ===========================================================================
// 12. Empty and unknown verifierVersions
// ===========================================================================

describe("12. verifierVersions policy", () => {
  it("empty verifierVersions -> empty-verifier-versions", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ verifierVersions: [] });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["empty-verifier-versions"]);
  });

  it("a verifierVersion outside the policy's known list -> unknown-verifier-version", async () => {
    const policy = basePolicy({ knownVerifierVersions: ["genrm-v1", "consistency-v2"] });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ verifierVersions: ["genrm-v1", "totally-unknown-v7"] });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["unknown-verifier-version"]);
  });

  it("no knownVerifierVersions restriction (undefined) -> any non-empty list is accepted", async () => {
    const policy = basePolicy({ knownVerifierVersions: undefined });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid({ verifierVersions: ["anything-goes-v1"] });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("verified");
  });
});

// ===========================================================================
// 13. pCorrect / ensembleScore outside [0,1] or non-finite
// ===========================================================================

describe("13. score domain validity", () => {
  it("pCorrect above 1 -> score-out-of-range", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ pCorrect: 1.5 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert, claimedPCorrect: 0.5 }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["score-out-of-range"]);
    expect(result.pCorrect).toBeUndefined();
  });

  it("ensembleScore below 0 -> score-out-of-range", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ ensembleScore: -0.3 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["score-out-of-range"]);
  });

  it("non-finite pCorrect (NaN, signed as-is) -> score-out-of-range, never throws", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ pCorrect: Number.NaN, ensembleScore: 0.5 });
    const result = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, claimedPCorrect: 0.1 }),
      NOW,
    );
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["score-out-of-range"]);
    expect(result.score).toBe(0);
  });
});

// ===========================================================================
// 14. claimedPCorrect above the certificate's pCorrect
// ===========================================================================

describe("14. claim exceeds certificate", () => {
  it("claimedPCorrect strictly greater than payload.pCorrect -> claim-exceeds-certificate", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ pCorrect: 0.8 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert, claimedPCorrect: 0.99 }), NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["claim-exceeds-certificate"]);
    expect(result.score).toBe(0);
  });

  it("claimedPCorrect exactly equal to payload.pCorrect is fine", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ pCorrect: 0.8 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert, claimedPCorrect: 0.8 }), NOW);
    expect(result.status).toBe("verified");
    expect(result.score).toBe(0.8);
  });

  it("claimedPCorrect below payload.pCorrect (modest claim) is fine", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ pCorrect: 0.8 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert, claimedPCorrect: 0.1 }), NOW);
    expect(result.status).toBe("verified");
  });
});

// ===========================================================================
// 15. Trace binding
// ===========================================================================

describe("15. trace binding", () => {
  it("traceJson sha256 mismatching payload.traceSha256, requireTraceBinding=true -> trace-mismatch", async () => {
    const policy = basePolicy({ requireTraceBinding: true });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid();
    const result = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, traceJson: "a completely different trace" }),
      NOW,
    );
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["trace-mismatch"]);
  });

  it("missing traceJson while requireTraceBinding=true -> trace-mismatch", async () => {
    const policy = basePolicy({ requireTraceBinding: true });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid();
    const result = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, traceJson: undefined }),
      NOW,
    );
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["trace-mismatch"]);
  });

  it("mismatching trace is IGNORED when requireTraceBinding=false", async () => {
    const policy = basePolicy({ requireTraceBinding: false });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid();
    const result = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, traceJson: "irrelevant, unrelated trace text" }),
      NOW,
    );
    expect(result.status).toBe("verified");
  });
});

// ===========================================================================
// 16. Structurally hostile inputs — never throw
// ===========================================================================

describe("16. hostile inputs never throw", () => {
  const adjudicator = new ClaimAdjudicator(basePolicy());

  it("claim is null", async () => {
    const result = await adjudicator.adjudicate(null as unknown as VerifiedClaim, NOW);
    expect(result.status).toBe("unverified");
    expect(result.codes).toEqual(["malformed-claim"]);
    expect(result.score).toBe(0);
  });

  it("claim is undefined", async () => {
    const result = await adjudicator.adjudicate(undefined as unknown as VerifiedClaim, NOW);
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("claim is a bare string", async () => {
    const result = await adjudicator.adjudicate("i am not a claim" as unknown as VerifiedClaim, NOW);
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("claim is a number", async () => {
    const result = await adjudicator.adjudicate(42 as unknown as VerifiedClaim, NOW);
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("claim is an array", async () => {
    const result = await adjudicator.adjudicate([1, 2, 3] as unknown as VerifiedClaim, NOW);
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("claim is missing required fields", async () => {
    const result = await adjudicator.adjudicate({ taskId: "t" } as unknown as VerifiedClaim, NOW);
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("claim.claimedPCorrect is non-numeric", async () => {
    const claim = { ...makeClaim(), claimedPCorrect: "high" } as unknown as VerifiedClaim;
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("certificate as a bare string", async () => {
    const claim = { ...makeClaim(), certificate: "definitely-not-a-cert" } as unknown as VerifiedClaim;
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.certSha256).toBeDefined();
    expect(result.score).toBe(0);
  });

  it("certificate as an array", async () => {
    const claim = { ...makeClaim(), certificate: [1, 2, 3] } as unknown as VerifiedClaim;
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.score).toBe(0);
  });

  it("certificate.payload is null", async () => {
    const cert = await issueValid();
    const claim = {
      ...makeClaim(),
      certificate: { ...cert, payload: null } as unknown as VerificationCertificate,
    };
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.score).toBe(0);
  });

  it("signature is odd-length hex", async () => {
    const cert = await issueValid();
    const claim = { ...makeClaim(), certificate: { ...cert, signature: cert.signature.slice(0, -1) } };
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
  });

  it("signature is 63 bytes (too short)", async () => {
    const cert = await issueValid();
    const claim = { ...makeClaim(), certificate: { ...cert, signature: cert.signature.slice(0, 126) } };
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
  });

  it("signature is 65 bytes (too long)", async () => {
    const cert = await issueValid();
    const claim = { ...makeClaim(), certificate: { ...cert, signature: cert.signature + "ab" } };
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
  });

  it("publicKey is non-hex garbage", async () => {
    const cert = await issueValid();
    const claim = {
      ...makeClaim(),
      certificate: { ...cert, publicKey: "not-hex-at-all-zzz!!" },
    };
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.codes).toEqual(["bad-signature"]);
  });

  it("prototype-polluted certificate object", async () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"payload":null}');
    const claim = { ...makeClaim(), certificate: polluted as unknown as VerificationCertificate };
    const result = await adjudicator.adjudicate(claim, NOW);
    expect(result.status).toBe("fabricated");
    expect(result.score).toBe(0);
    // eslint-disable-next-line no-prototype-builtins
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // global prototype untouched
  });

  it("prototype-polluted top-level claim object", async () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"taskId":"t","participantId":"p"}');
    const result = await adjudicator.adjudicate(polluted as unknown as VerifiedClaim, NOW);
    expect(result.status).toBe("unverified");
    expect(result.codes).toEqual(["malformed-claim"]);
  });

  it("now is NaN — still returns a well-formed result, never throws", async () => {
    const cert = await issueValid();
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), Number.NaN);
    expect(result.status === "verified" || result.status === "fabricated").toBe(true);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

// ===========================================================================
// Multi-fault claims report ALL applicable codes, in stable order
// ===========================================================================

describe("multi-fault claims", () => {
  it("stacks untrusted-issuer + epsilon-over-policy + tier-not-accepted + stale-certificate, in ALL_CLAIM_REJECTION_CODES order", async () => {
    const policy = basePolicy({
      maxEpsilon: 0.01,
      acceptedTiers: ["T0-execution"],
      maxCertificateAgeMs: 1000,
    });
    const adjudicator = new ClaimAdjudicator(policy);
    const cert = await issueValid(
      {
        epsilon: 0.5,
        verifierTier: "T3-agreement",
        issuedAt: NOW - 1_000_000,
      },
      CA_UNTRUSTED,
    );
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);

    expect(result.status).toBe("fabricated");
    expect(result.score).toBe(0);
    expect(result.codes).toEqual([
      "untrusted-issuer",
      "epsilon-over-policy",
      "tier-not-accepted",
      "stale-certificate",
    ]);

    // codes must appear in the canonical ALL_CLAIM_REJECTION_CODES order.
    const ranks = result.codes.map((c) => ALL_CLAIM_REJECTION_CODES.indexOf(c));
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });

  it("codes array is deduped even if a condition could logically double-fire", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ epsilon: 5 }); // absurdly over policy
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    const unique = new Set(result.codes);
    expect(unique.size).toBe(result.codes.length);
  });
});

// ===========================================================================
// certSha256 presence invariant
// ===========================================================================

describe("certSha256 presence", () => {
  it("is present iff a certificate was attached", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());

    const noCert = await adjudicator.adjudicate(makeClaim({ certificate: undefined }), NOW);
    expect(noCert.certSha256).toBeUndefined();

    const malformed = await adjudicator.adjudicate(null as unknown as VerifiedClaim, NOW);
    expect(malformed.certSha256).toBeUndefined();

    const cert = await issueValid();
    const withCert = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(withCert.certSha256).toBeDefined();
    expect(withCert.certSha256).toMatch(/^[0-9a-f]{64}$/);

    const fabricatedWithCert = await adjudicator.adjudicate(
      makeClaim({ certificate: cert, taskId: "wrong-task" }),
      NOW,
    );
    expect(fabricatedWithCert.certSha256).toBeDefined();
  });

  it("differs for two structurally different certificates and matches for identical ones", async () => {
    const certA = await issueValid({ taskId: "task-A" });
    const certB = await issueValid({ taskId: "task-B" });
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const rA = await adjudicator.adjudicate(makeClaim({ certificate: certA, taskId: "task-A" }), NOW);
    const rB = await adjudicator.adjudicate(makeClaim({ certificate: certB, taskId: "task-B" }), NOW);
    expect(rA.certSha256).not.toBe(rB.certSha256);

    const rA2 = await adjudicator.adjudicate(makeClaim({ certificate: certA, taskId: "task-A" }), NOW + 1);
    expect(rA2.certSha256).toBe(rA.certSha256);
  });
});

// ===========================================================================
// forget / reset
// ===========================================================================

describe("forget and reset", () => {
  it("forget(taskId) clears replay state for that task without affecting others", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const certX = await issueValid({ taskId: "task-X" });
    const certY = await issueValid({ taskId: "task-Y" });

    await adjudicator.adjudicate(makeClaim({ certificate: certX, taskId: "task-X" }), NOW);
    await adjudicator.adjudicate(makeClaim({ certificate: certY, taskId: "task-Y" }), NOW);
    expect(adjudicator.seenCertificates()).toBe(2);

    adjudicator.forget("task-X");
    expect(adjudicator.seenCertificates()).toBe(1);

    // task-X's certificate can now be freshly "first seen" again (no replay code).
    const replayed = await adjudicator.adjudicate(
      makeClaim({ certificate: certX, taskId: "task-X" }),
      NOW,
    );
    expect(replayed.status).toBe("verified");
    expect(replayed.codes).toEqual([]);

    // task-Y's registration is untouched.
    const stillReplayed = await adjudicator.adjudicate(
      makeClaim({ certificate: certY, taskId: "task-Z", participantId: "p2" }),
      NOW,
    );
    expect(stillReplayed.codes).toContain("replayed-certificate");
  });

  it("reset() clears all replay state", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid();
    await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(adjudicator.seenCertificates()).toBe(1);
    adjudicator.reset();
    expect(adjudicator.seenCertificates()).toBe(0);

    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert }), NOW);
    expect(result.status).toBe("verified");
    expect(result.codes).toEqual([]);
  });
});

// ===========================================================================
// Reuse at scale, no cross-participant leakage
// ===========================================================================

describe("reuse across many claims, no cross-participant leakage", () => {
  it("seenCertificates() grows monotonically and distinct participants never collide", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const N = 500;
    for (let i = 0; i < N; i++) {
      const cert = await issueValid({ taskId: `task-${i}`, outputSha256: sha256Hex(`output-${i}`) });
      const result = await adjudicator.adjudicate(
        makeClaim({
          certificate: cert,
          taskId: `task-${i}`,
          participantId: `participant-${i}`,
          outputText: `output-${i}`,
        }),
        NOW,
      );
      expect(result.status).toBe("verified");
      expect(result.participantId).toBe(`participant-${i}`);
      expect(adjudicator.seenCertificates()).toBe(i + 1);
    }
    expect(adjudicator.seenCertificates()).toBe(N);
  });

  it("two participants independently certified for the same task/output text do not collide (distinct real signatures)", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert1 = await issueValid({}, CA_TRUSTED);
    const cert2 = await issueValid({}, CA_TRUSTED_2);

    const r1 = await adjudicator.adjudicate(
      makeClaim({ certificate: cert1, participantId: "alice" }),
      NOW,
    );
    const r2 = await adjudicator.adjudicate(
      makeClaim({ certificate: cert2, participantId: "bob" }),
      NOW,
    );
    expect(r1.status).toBe("verified");
    expect(r2.status).toBe("verified");
    expect(adjudicator.seenCertificates()).toBe(2);
  });
});

// ===========================================================================
// The happy path, precisely
// ===========================================================================

describe("verified happy path", () => {
  it("a fully compliant certificate yields status=verified, score=payload.pCorrect, no codes", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy());
    const cert = await issueValid({ pCorrect: 0.87654321 });
    const result = await adjudicator.adjudicate(makeClaim({ certificate: cert, claimedPCorrect: 0.5 }), NOW);
    expect(result.status).toBe("verified");
    expect(result.codes).toEqual([]);
    expect(result.fabricated).toBe(false);
    expect(result.score).toBeCloseTo(0.87654321, 9);
    expect(result.pCorrect).toBeCloseTo(0.87654321, 9);
    expect(result.tier).toBe("T1-reference");
    expect(result.epsilon).toBeCloseTo(0.05, 9);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.detail).not.toMatch(/NaN|undefined/);
  });
});

// ===========================================================================
// GLOBAL INVARIANT: every fabricated path scores EXACTLY 0
// ===========================================================================

describe("global invariant: fabricated always scores exactly 0", () => {
  it("sweeps the full forgery matrix and asserts score === 0 && fabricated === true for every one", async () => {
    const adjudicator = new ClaimAdjudicator(basePolicy({ acceptedTiers: ["T2-genrm"] }));
    const validPayload = makePayload();
    const validCert = await CA_TRUSTED.issue(validPayload);

    const attacks: Array<{ name: string; claim: VerifiedClaim }> = [
      {
        name: "flipped signature",
        claim: makeClaim({ certificate: { ...validCert, signature: flipHexChar(validCert.signature) } }),
      },
      {
        name: "untrusted issuer",
        claim: makeClaim({ certificate: await issueValid({}, CA_UNTRUSTED) }),
      },
      {
        name: "output mismatch",
        claim: makeClaim({ certificate: validCert, outputText: "not the certified output" }),
      },
      {
        name: "task mismatch",
        claim: makeClaim({ certificate: validCert, taskId: "some-other-task" }),
      },
      {
        name: "trace mismatch",
        claim: makeClaim({ certificate: validCert, traceJson: "wrong trace" }),
      },
      {
        name: "epsilon over policy",
        claim: makeClaim({
          certificate: await issueValid({ epsilon: 0.99, verifierTier: "T2-genrm" }),
        }),
      },
      {
        name: "tier overclaim (fake tier)",
        claim: makeClaim({ certificate: await issueValid({ verifierTier: "T9-fake" }) }),
      },
      {
        name: "tier not accepted",
        claim: makeClaim({ certificate: await issueValid({ verifierTier: "T0-execution" }) }),
      },
      {
        name: "stale certificate",
        claim: makeClaim({
          certificate: await issueValid({
            verifierTier: "T2-genrm",
            issuedAt: NOW - 365 * 24 * 60 * 60 * 1000,
          }),
        }),
      },
      {
        name: "future certificate",
        claim: makeClaim({
          certificate: await issueValid({ verifierTier: "T2-genrm", issuedAt: NOW + 365 * 24 * 60 * 60 * 1000 }),
        }),
      },
      {
        name: "empty verifier versions",
        claim: makeClaim({
          certificate: await issueValid({ verifierTier: "T2-genrm", verifierVersions: [] }),
        }),
      },
      {
        name: "score out of range",
        claim: makeClaim({
          certificate: await issueValid({ verifierTier: "T2-genrm", pCorrect: 3.0 }),
        }),
      },
      {
        name: "claim exceeds certificate",
        claim: makeClaim({
          certificate: await issueValid({ verifierTier: "T2-genrm", pCorrect: 0.5 }),
          claimedPCorrect: 0.999,
        }),
      },
      {
        name: "hostile certificate string",
        claim: { ...makeClaim(), certificate: "garbage" as unknown as VerificationCertificate },
      },
    ];

    expect(attacks.length).toBeGreaterThanOrEqual(13);

    for (const { name, claim } of attacks) {
      const result = await adjudicator.adjudicate(claim, NOW);
      expect(result.fabricated, `${name}: expected fabricated=true`).toBe(true);
      expect(result.score, `${name}: expected score===0`).toBe(0);
      expect(result.status, `${name}: expected status='fabricated'`).toBe("fabricated");
      expect(result.codes.length, `${name}: expected at least one code`).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// adjudicate never throws, for any input
// ===========================================================================

describe("adjudicate never throws", () => {
  const adjudicator = new ClaimAdjudicator(basePolicy());
  const hostileInputs: unknown[] = [
    null,
    undefined,
    "x",
    0,
    NaN,
    [],
    {},
    { certificate: {} },
    { certificate: { payload: {}, signature: 123, publicKey: null } },
    { certificate: { payload: { verifierVersions: "not-an-array" }, signature: "zz", publicKey: "zz" } },
    Object.assign(Object.create(null), { taskId: "t" }),
  ];

  it.each(hostileInputs.map((v, i) => [i, v] as const))("hostile input #%i never throws", async (_i, v) => {
    await expect(adjudicator.adjudicate(v as unknown as VerifiedClaim, NOW)).resolves.toBeDefined();
  });
});

// ===========================================================================
// ALL_CLAIM_REJECTION_CODES completeness
// ===========================================================================

describe("ALL_CLAIM_REJECTION_CODES", () => {
  it("contains all 17 declared codes exactly once", () => {
    const expected: ClaimRejectionCode[] = [
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
    ];
    expect([...ALL_CLAIM_REJECTION_CODES].sort()).toEqual([...expected].sort());
    expect(new Set(ALL_CLAIM_REJECTION_CODES).size).toBe(ALL_CLAIM_REJECTION_CODES.length);
  });
});
