import { describe, expect, it } from "vitest";

import {
  HANDOFF_VERSION,
  issueHandoffCertificate,
  verifyHandoffAtBoundary,
  encodeHandoff,
  decodeHandoff,
  type CertifiedHandoff,
} from "../cert-handoff";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type VerificationCertificate,
} from "../../styx/certificate";

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

function fixedClock(ms: number): () => number {
  return () => ms;
}

async function issueFixture(
  overrides: Partial<Parameters<typeof issueHandoffCertificate>[0]> = {},
): Promise<{ authority: CertificateAuthority; handoff: CertifiedHandoff }> {
  const authority = new CertificateAuthority(generatePrivateKeyHex(fixedRng(3)));
  const handoff = await issueHandoffCertificate({
    authority,
    taskId: "goal-abc-123",
    objective: "Summarize the quarterly report",
    resultText: "The quarterly report shows 12% growth.",
    verdict: "accept",
    score: 0.93,
    verifierVersions: ["gate-check:has-claims", "gate-check:evidence-traceability"],
    now: fixedClock(1_700_000_000_000),
    ...overrides,
  });
  return { authority, handoff };
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("issueHandoffCertificate", () => {
  it("builds an honest CertificatePayload and a verifiable certificate for verdict=accept", async () => {
    const { authority, handoff } = await issueFixture();

    expect(handoff.version).toBe(HANDOFF_VERSION);
    expect(handoff.taskId).toBe("goal-abc-123");
    expect(handoff.objective).toBe("Summarize the quarterly report");
    expect(handoff.resultText).toBe("The quarterly report shows 12% growth.");
    expect(handoff.resultSha256).toBe(sha256Hex(handoff.resultText));

    const payload = handoff.certificate.payload;
    expect(payload.outputSha256).toBe(handoff.resultSha256);
    expect(payload.taskId).toBe("goal-abc-123");
    expect(payload.verifierTier).toBe("mcp-handoff:accept");
    expect(payload.ensembleScore).toBe(0.93);
    expect(payload.pCorrect).toBe(0.93);
    expect(payload.epsilon).toBe(0); // accept -> no further conformal slack claimed
    expect(payload.verifierVersions).toEqual([
      "gate-check:has-claims",
      "gate-check:evidence-traceability",
    ]);
    expect(payload.issuedAt).toBe(1_700_000_000_000);
    expect(handoff.certificate.publicKey).toBe(authority.publicKeyHex());
    expect(handoff.certificate.signature).toMatch(/^[0-9a-f]{128}$/);

    const verdict = await verifyHandoffAtBoundary(handoff);
    expect(verdict).toEqual({ ok: true, reasons: [] });
  });

  it("verdict=abstain sets epsilon=1 and a distinct verifierTier, and still verifies", async () => {
    const { handoff } = await issueFixture({ verdict: "abstain", score: 0.2 });
    expect(handoff.certificate.payload.verifierTier).toBe("mcp-handoff:abstain");
    expect(handoff.certificate.payload.epsilon).toBe(1);
    expect(handoff.certificate.payload.ensembleScore).toBe(0.2);
    const verdict = await verifyHandoffAtBoundary(handoff);
    expect(verdict.ok).toBe(true);
  });

  it("defaults `now` to Date.now when omitted", async () => {
    const authority = new CertificateAuthority(generatePrivateKeyHex(fixedRng(4)));
    const before = Date.now();
    const handoff = await issueHandoffCertificate({
      authority,
      taskId: "t1",
      objective: "obj",
      resultText: "text",
      verdict: "accept",
      score: 1,
      verifierVersions: [],
    });
    const after = Date.now();
    expect(handoff.certificate.payload.issuedAt).toBeGreaterThanOrEqual(before);
    expect(handoff.certificate.payload.issuedAt).toBeLessThanOrEqual(after);
  });

  it("is deterministic under an injected clock: two calls with identical inputs produce identical payloads and signatures", async () => {
    const authority = new CertificateAuthority(generatePrivateKeyHex(fixedRng(5)));
    const input = {
      authority,
      taskId: "goal-x",
      objective: "same objective",
      resultText: "same result text",
      verdict: "accept" as const,
      score: 0.8,
      verifierVersions: ["gate-check:a"],
      now: fixedClock(42),
    };
    const a = await issueHandoffCertificate(input);
    const b = await issueHandoffCertificate(input);
    expect(a.certificate.payload).toEqual(b.certificate.payload);
    // ed25519 (RFC 8032) signing is deterministic: same key + same message -> same signature.
    expect(a.certificate.signature).toBe(b.certificate.signature);
    expect(a.resultSha256).toBe(b.resultSha256);
  });
});

describe("encodeHandoff / decodeHandoff", () => {
  it("round-trips a real handoff exactly", async () => {
    const { handoff } = await issueFixture();
    const wire = encodeHandoff(handoff);
    const decoded = decodeHandoff(wire);
    expect(decoded).toEqual(handoff);
  });

  it("round-trips resultText with combining-character unicode byte-exactly", async () => {
    // "é" as e + U+0301 COMBINING ACUTE ACCENT, not the precomposed U+00E9.
    const resultText = "Café résumé — unnormalized ⚡🚀";
    const { handoff } = await issueFixture({ resultText });
    const wire = encodeHandoff(handoff);
    const decoded = decodeHandoff(wire) as CertifiedHandoff;
    expect(decoded.resultText).toBe(resultText);
    // Exact codepoint sequence preserved, not NFC/NFD-normalized away.
    expect(decoded.resultText.normalize("NFC")).not.toBe(decoded.resultText);
    const verdict = await verifyHandoffAtBoundary(decoded);
    expect(verdict).toEqual({ ok: true, reasons: [] });
  });

  it("decodeHandoff never throws on malformed JSON — returns undefined", () => {
    expect(decodeHandoff("{not valid json")).toBeUndefined();
    expect(decodeHandoff("")).toBeUndefined();
    expect(decodeHandoff("undefined")).toBeUndefined();
  });

  it("decodeHandoff passes through valid-JSON-but-wrong-shape values unchanged", () => {
    expect(decodeHandoff("42")).toBe(42);
    expect(decodeHandoff('"just a string"')).toBe("just a string");
    expect(decodeHandoff("null")).toBeNull();
    expect(decodeHandoff("[1,2,3]")).toEqual([1, 2, 3]);
  });
});

// ===========================================================================
// verifyHandoffAtBoundary — adversarial matrix. Every vector: never throws,
// ok===false, and (per vector) collects every applicable reason.
// ===========================================================================

describe("verifyHandoffAtBoundary — adversarial matrix", () => {
  it("rejects non-object inputs without throwing", async () => {
    for (const bad of [undefined, null, 42, "a string", true, [1, 2, 3]]) {
      const v = await verifyHandoffAtBoundary(bad);
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    }
  });

  it("collects one reason per missing required top-level field", async () => {
    const { handoff } = await issueFixture();
    const fields: Array<keyof CertifiedHandoff> = [
      "version",
      "taskId",
      "objective",
      "resultText",
      "resultSha256",
      "certificate",
    ];
    for (const field of fields) {
      const clone = deepClone(handoff) as unknown as Record<string, unknown>;
      delete clone[field as string];
      const v = await verifyHandoffAtBoundary(clone);
      expect(v.ok).toBe(false);
      expect(v.reasons.some((r) => r.toLowerCase().includes(field.toLowerCase()))).toBe(true);
    }
  });

  it("a completely empty object collects multiple independent reasons, not just the first", async () => {
    const v = await verifyHandoffAtBoundary({});
    expect(v.ok).toBe(false);
    // At minimum: version, taskId, objective, resultText, resultSha256, certificate.
    expect(v.reasons.length).toBeGreaterThanOrEqual(6);
  });

  it("rejects an unsupported version number", async () => {
    const { handoff } = await issueFixture();
    const clone = deepClone(handoff) as unknown as Record<string, unknown>;
    clone.version = 999;
    const v = await verifyHandoffAtBoundary(clone);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /version/i.test(r))).toBe(true);
  });

  it("rejects a resultSha256 that does not match sha256Hex(resultText)", async () => {
    const { handoff } = await issueFixture();
    const clone = deepClone(handoff);
    clone.resultSha256 = sha256Hex("a completely different string");
    const v = await verifyHandoffAtBoundary(clone);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /resultSha256 mismatch/.test(r))).toBe(true);
    // Certificate is now also mismatched against the (unchanged) claimed hash's
    // sibling check — the certificate binding check independently fires too.
    expect(v.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it("binding confusion: certificate payload's outputSha256 tampered to a different hash than resultSha256", async () => {
    const { handoff } = await issueFixture();
    const clone = deepClone(handoff);
    // Tamper only the certificate's bound hash, leaving resultText/resultSha256
    // (the handoff's own claim) untouched — a pure binding-confusion attack.
    clone.certificate.payload.outputSha256 = sha256Hex("swapped-in different content");
    const v = await verifyHandoffAtBoundary(clone);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /binds a different hash/.test(r))).toBe(true);
    // Mutating the signed payload also invalidates the signature — both fire.
    expect(v.reasons.some((r) => /signature is invalid/.test(r))).toBe(true);
  });

  it("signature/payload mismatch: a validly-signed certificate for a DIFFERENT result is swapped in", async () => {
    const { authority, handoff: handoffA } = await issueFixture({ resultText: "Result A text" });
    const handoffB = await issueHandoffCertificate({
      authority,
      taskId: "goal-b",
      objective: "objective B",
      resultText: "Result B text — completely different",
      verdict: "accept",
      score: 0.9,
      verifierVersions: [],
      now: fixedClock(1_700_000_000_000),
    });

    // Swap B's (legitimately signed, cryptographically valid) certificate into A's handoff.
    const forged: CertifiedHandoff = { ...deepClone(handoffA), certificate: deepClone(handoffB.certificate) };
    const v = await verifyHandoffAtBoundary(forged);
    expect(v.ok).toBe(false);
    // The signature itself IS valid (it's a real cert for real payload B) —
    // the failure is purely the hash binding not matching handoff A's claim.
    expect(v.reasons.some((r) => /binds a different hash/.test(r))).toBe(true);
    expect(v.reasons.some((r) => /signature is invalid/.test(r))).toBe(false);
  });

  it("rejects a signature hex of the wrong length", async () => {
    const { handoff } = await issueFixture();
    const clone = deepClone(handoff);
    clone.certificate.signature = "deadbeef"; // far too short
    const v = await verifyHandoffAtBoundary(clone);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /signature is invalid/.test(r))).toBe(true);
  });

  it("rejects a garbage non-hex signature without throwing", async () => {
    const { handoff } = await issueFixture();
    const clone = deepClone(handoff);
    clone.certificate.signature = "zz".repeat(64);
    const v = await verifyHandoffAtBoundary(clone);
    expect(v.ok).toBe(false);
  });

  it("publicKey substitution: a cert re-signed by a DIFFERENT authority over the SAME payload still verifies cryptographically — trust in the pubkey is the caller's policy layer", async () => {
    const { handoff } = await issueFixture();
    const otherAuthority = new CertificateAuthority(generatePrivateKeyHex(fixedRng(9)));
    const resigned: VerificationCertificate = await otherAuthority.issue(handoff.certificate.payload);
    const swapped: CertifiedHandoff = { ...deepClone(handoff), certificate: resigned };

    const v = await verifyHandoffAtBoundary(swapped);
    // Cryptographically the check passes — same payload, validly re-signed.
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    // The pubkey that did the signing is visible on the object the caller
    // already has in hand (the decoded handoff), so a caller's own trust
    // policy (e.g. "only accept certificates from this pinned authority key")
    // can inspect it directly — verifyHandoffAtBoundary intentionally does
    // not enforce any particular pubkey, only that A signature is valid.
    expect(swapped.certificate.publicKey).toBe(otherAuthority.publicKeyHex());
    expect(swapped.certificate.publicKey).not.toBe(handoff.certificate.publicKey);
  });

  it("collects reasons for a doubly-tampered handoff: wrong resultSha256 AND wrong version simultaneously", async () => {
    const { handoff } = await issueFixture();
    const clone = deepClone(handoff) as unknown as Record<string, unknown>;
    clone.version = 2;
    (clone as unknown as CertifiedHandoff).resultSha256 = sha256Hex("nope");
    const v = await verifyHandoffAtBoundary(clone);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /version/i.test(r))).toBe(true);
    expect(v.reasons.some((r) => /resultSha256 mismatch/.test(r))).toBe(true);
  });

  it("a genuinely valid handoff has zero reasons and ok:true", async () => {
    const { handoff } = await issueFixture();
    const v = await verifyHandoffAtBoundary(handoff);
    expect(v).toEqual({ ok: true, reasons: [] });
  });
});
