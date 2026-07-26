import { describe, it, expect } from "vitest";
import {
  parseCertificate,
  verifyDropped,
} from "../core/cert-verify";
import { renderCertVerify } from "../ui/cert-view";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../hades/styx/certificate";

const DELIVERED_OUTPUT = "the answer is 42, grounded in the provided trace";

function samplePayload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(DELIVERED_OUTPUT),
    taskId: "task-styx-001",
    verifierTier: "T2-genrm",
    ensembleScore: 0.94,
    pCorrect: 0.972,
    epsilon: 0.021,
    traceSha256: sha256Hex("full-execution-trace-json"),
    verifierVersions: ["genrm@1.4.0", "conformal@0.3.1"],
    issuedAt: Date.UTC(2026, 6, 18, 9, 41, 3),
    ...overrides,
  };
}

/** Mint a genuine cert with the REAL certificate authority. */
async function mintCert(
  payload: CertificatePayload = samplePayload(),
): Promise<VerificationCertificate> {
  const priv = generatePrivateKeyHex();
  const ca = new CertificateAuthority(priv);
  return ca.issue(payload);
}

describe("parseCertificate", () => {
  it("accepts a genuine certificate and narrows its shape", async () => {
    const cert = await mintCert();
    const result = parseCertificate(JSON.stringify(cert));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cert.publicKey).toBe(cert.publicKey);
      expect(result.cert.payload.taskId).toBe("task-styx-001");
    }
  });

  it("returns ok:false (never throws) for malformed JSON", () => {
    const result = parseCertificate("{ not valid json ]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid JSON/i);
  });

  it("returns ok:false for empty input", () => {
    const result = parseCertificate("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });

  it("returns ok:false with a specific reason when a payload field is missing", async () => {
    const cert = await mintCert();
    const broken = JSON.parse(JSON.stringify(cert));
    delete broken.payload.pCorrect;
    const result = parseCertificate(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pCorrect/);
  });

  it("returns ok:false when signature is not a string", async () => {
    const cert = await mintCert();
    const broken = JSON.parse(JSON.stringify(cert));
    broken.signature = 12345;
    const result = parseCertificate(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/signature/);
  });
});

describe("verifyDropped — real ed25519, no stub", () => {
  it("verifies a genuine certificate as valid", async () => {
    const cert = await mintCert();
    const result = await verifyDropped(JSON.stringify(cert));
    expect(result.valid).toBe(true);
    expect(result.reason).toMatch(/authentic/i);
    expect(result.payload?.taskId).toBe("task-styx-001");
    expect(result.publicKey).toBe(cert.publicKey);
    // Parses + Signature valid both pass.
    expect(result.checks.find((c) => c.name === "Parses")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "Signature valid")?.passed).toBe(true);
  });

  it("rejects a cert with a tampered payload field (signature no longer matches)", async () => {
    const cert = await mintCert();
    const tampered = JSON.parse(JSON.stringify(cert));
    // Flip the claimed P(correct) — payload changes, signature does not.
    tampered.payload.pCorrect = 0.999;
    const result = await verifyDropped(JSON.stringify(tampered));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature verification failed/i);
    expect(result.checks.find((c) => c.name === "Signature valid")?.passed).toBe(false);
  });

  it("rejects a cert with a flipped signature byte", async () => {
    const cert = await mintCert();
    const tampered: VerificationCertificate = JSON.parse(JSON.stringify(cert));
    // Flip the first hex nibble of the signature to a different value.
    const first = tampered.signature[0];
    const swapped = first === "0" ? "1" : "0";
    tampered.signature = swapped + tampered.signature.slice(1);
    const result = await verifyDropped(JSON.stringify(tampered));
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.name === "Signature valid")?.passed).toBe(false);
  });

  it("malformed JSON yields valid:false with a parse reason, never a throw", async () => {
    const result = await verifyDropped("totally not json");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid JSON/i);
    expect(result.checks[0]?.name).toBe("Parses");
    expect(result.checks[0]?.passed).toBe(false);
  });

  it("output-match: valid signature AND correct delivered output → valid", async () => {
    const cert = await mintCert();
    const result = await verifyDropped(JSON.stringify(cert), { output: DELIVERED_OUTPUT });
    expect(result.valid).toBe(true);
    expect(result.checks.find((c) => c.name === "Output match")?.passed).toBe(true);
    expect(result.reason).toMatch(/certifies the supplied output/i);
  });

  it("output-match: valid signature but WRONG delivered output → invalid", async () => {
    const cert = await mintCert();
    const result = await verifyDropped(JSON.stringify(cert), {
      output: "a different output than what was certified",
    });
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.name === "Signature valid")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "Output match")?.passed).toBe(false);
    expect(result.reason).toMatch(/does not certify the supplied output/i);
  });
});

describe("renderCertVerify", () => {
  it("null renders the empty paste-prompt state", () => {
    const html = renderCertVerify(null);
    expect(html).toContain("Verify a certificate");
    expect(html).toMatch(/paste a verification certificate/i);
    expect(html).toContain("cert-verify--empty");
  });

  it("renders a valid verdict with all payload fields and the public key", async () => {
    const cert = await mintCert();
    const result = await verifyDropped(JSON.stringify(cert), { output: DELIVERED_OUTPUT });
    const html = renderCertVerify(result);
    expect(html).toContain('data-valid="true"');
    expect(html).toContain("Authentic");
    // Payload fields surfaced.
    expect(html).toContain("T2-genrm"); // tier
    expect(html).toContain("97.2%"); // pCorrect
    expect(html).toContain("2.10%"); // epsilon
    expect(html).toContain("task-styx-001"); // taskId
    expect(html).toContain("2026-07-18"); // issuedAt
    // Public key (truncated form) present.
    expect(html).toContain(cert.publicKey.slice(0, 8));
    // Each check surfaced.
    expect(html).toContain("Signature valid");
    expect(html).toContain("Output match");
  });

  it("renders an invalid verdict with the failing check and reason", async () => {
    const cert = await mintCert();
    const tampered = JSON.parse(JSON.stringify(cert));
    tampered.payload.taskId = "task-forged-999";
    const result = await verifyDropped(JSON.stringify(tampered));
    const html = renderCertVerify(result);
    expect(html).toContain('data-valid="false"');
    expect(html).toContain("Not verified");
    expect(html).toContain("trust-check__icon--fail");
    expect(html).toMatch(/signature verification failed/i);
  });
});
