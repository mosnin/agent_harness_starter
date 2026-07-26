import { describe, expect, it } from "vitest";

import {
  CertificateAuthority,
  canonicalize,
  certifiesOutput,
  generatePrivateKeyHex,
  sha256Hex,
  verifyCertificate,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";

const OUTPUT_TEXT = "The answer is 42.\n";
const TRACE_JSON = JSON.stringify({ steps: [{ tool: "exec", ok: true }] });

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

function makePayload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(OUTPUT_TEXT),
    taskId: "task-styx-0042",
    verifierTier: "T0-execution",
    ensembleScore: 0.97,
    pCorrect: 0.99,
    epsilon: 0.01,
    traceSha256: sha256Hex(TRACE_JSON),
    verifierVersions: ["exec-oracle@1.2.0", "genrm-rubric@0.9.3", "xmodel-agree@2.0.1"],
    issuedAt: 1_752_537_600_000,
    ...overrides,
  };
}

async function issueFixture(): Promise<{
  ca: CertificateAuthority;
  cert: VerificationCertificate;
}> {
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(7)));
  const cert = await ca.issue(makePayload());
  return { ca, cert };
}

describe("styx certificate", () => {
  it("sha256Hex matches the known NIST vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("canonicalize is deterministic regardless of key insertion order, preserving array order", () => {
    const a = makePayload();
    // Same values, different property insertion order.
    const b: CertificatePayload = {
      issuedAt: a.issuedAt,
      verifierVersions: [...a.verifierVersions],
      traceSha256: a.traceSha256,
      epsilon: a.epsilon,
      pCorrect: a.pCorrect,
      ensembleScore: a.ensembleScore,
      verifierTier: a.verifierTier,
      taskId: a.taskId,
      outputSha256: a.outputSha256,
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
    // Arrays are order-sensitive: reordering changes the canonical form.
    const c = makePayload({
      verifierVersions: [...a.verifierVersions].reverse(),
    });
    expect(canonicalize(c)).not.toBe(canonicalize(a));
    // Sorted keys: canonical form starts with the lexicographically first key.
    expect(canonicalize(a).startsWith('{"ensembleScore":')).toBe(true);
  });

  it("issue -> verifyCertificate roundtrip is true", async () => {
    const { ca, cert } = await issueFixture();
    expect(cert.publicKey).toBe(ca.publicKeyHex());
    expect(cert.signature).toMatch(/^[0-9a-f]{128}$/);
    await expect(verifyCertificate(cert)).resolves.toBe(true);
  });

  it("tampering with any single payload field invalidates the certificate", async () => {
    const { cert } = await issueFixture();
    const p = cert.payload;
    const flippedHexChar =
      (p.outputSha256[0] === "0" ? "1" : "0") + p.outputSha256.slice(1);
    const tampered: Array<Partial<CertificatePayload>> = [
      { outputSha256: flippedHexChar },
      { taskId: "task-styx-0043" },
      { verifierTier: "T4-consistency" },
      { ensembleScore: 0.971 },
      { pCorrect: 0.999 },
      { epsilon: 0.02 },
      { traceSha256: sha256Hex(TRACE_JSON + " ") },
      { verifierVersions: [...p.verifierVersions].reverse() },
      { issuedAt: p.issuedAt + 1 },
    ];
    for (const override of tampered) {
      const forged: VerificationCertificate = {
        ...cert,
        payload: { ...p, verifierVersions: [...p.verifierVersions], ...override },
      };
      await expect(verifyCertificate(forged)).resolves.toBe(false);
    }
    // Untouched original still verifies (tamper loop did not mutate it).
    await expect(verifyCertificate(cert)).resolves.toBe(true);
  });

  it("verifying against the wrong public key fails", async () => {
    const { cert } = await issueFixture();
    const otherCa = new CertificateAuthority(generatePrivateKeyHex(fixedRng(9)));
    expect(otherCa.publicKeyHex()).not.toBe(cert.publicKey);
    const swapped: VerificationCertificate = { ...cert, publicKey: otherCa.publicKeyHex() };
    await expect(verifyCertificate(swapped)).resolves.toBe(false);
  });

  it("garbage, truncated, or malformed signatures return false without throwing", async () => {
    const { cert } = await issueFixture();
    const bad: VerificationCertificate[] = [
      { ...cert, signature: "deadbeef" }, // far too short
      { ...cert, signature: cert.signature.slice(0, 126) }, // truncated
      { ...cert, signature: "zz".repeat(64) }, // non-hex
      { ...cert, signature: "" },
      { ...cert, signature: "ff".repeat(64) }, // right length, invalid point math
      { ...cert, publicKey: "not-hex-at-all" },
      { ...cert, publicKey: "ab" }, // wrong key length
    ];
    for (const c of bad) {
      await expect(verifyCertificate(c)).resolves.toBe(false);
    }
  });

  it("certifiesOutput is true for the exact signed text", async () => {
    const { cert } = await issueFixture();
    await expect(certifiesOutput(cert, OUTPUT_TEXT)).resolves.toBe(true);
  });

  it("certifiesOutput is false for different text and for a tampered hash", async () => {
    const { cert } = await issueFixture();
    await expect(certifiesOutput(cert, OUTPUT_TEXT + "!")).resolves.toBe(false);
    await expect(certifiesOutput(cert, "")).resolves.toBe(false);
    // Attacker rewrites outputSha256 to match text B: hash now matches, but
    // the signature no longer covers the payload -> still false.
    const otherText = "A completely different deliverable.";
    const rebound: VerificationCertificate = {
      ...cert,
      payload: {
        ...cert.payload,
        verifierVersions: [...cert.payload.verifierVersions],
        outputSha256: sha256Hex(otherText),
      },
    };
    await expect(certifiesOutput(rebound, otherText)).resolves.toBe(false);
  });

  it("generatePrivateKeyHex with an injected rng is deterministic and yields a stable public key", () => {
    const k1 = generatePrivateKeyHex(fixedRng(7));
    const k2 = generatePrivateKeyHex(fixedRng(7));
    expect(k1).toBe(k2);
    expect(k1).toBe("07".repeat(32));
    const pub1 = new CertificateAuthority(k1).publicKeyHex();
    const pub2 = new CertificateAuthority(k2).publicKeyHex();
    expect(pub1).toBe(pub2);
    expect(pub1).toMatch(/^[0-9a-f]{64}$/);
    // Default path uses real randomness: two draws should differ.
    expect(generatePrivateKeyHex()).not.toBe(generatePrivateKeyHex());
  });

  it("generatePrivateKeyHex rejects an rng that returns the wrong length", () => {
    expect(() => generatePrivateKeyHex((n) => new Uint8Array(n - 1))).toThrow(RangeError);
  });
});
