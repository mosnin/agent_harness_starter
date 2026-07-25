import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../styx/certificate";
import type { GateDecision } from "../styx/gate";
import {
  assessReply,
  BadgeStamper,
  type BadgeEvidence,
  type StampedReply,
} from "../gateway/badge";
import { chunkMessage, platformFormat } from "../gateway/message-format";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const REPLY_TEXT = "The swarm converged on 42 after 3 rounds of adversarial verification.";
const TRACE_JSON = JSON.stringify({ steps: [{ tool: "exec", ok: true }, { tool: "genrm", ok: true }] });

function fixedRng(fill: number): (bytes: number) => Uint8Array {
  return (bytes: number) => new Uint8Array(bytes).fill(fill);
}

function makePayload(
  outputText: string,
  overrides: Partial<CertificatePayload> = {},
): CertificatePayload {
  return {
    outputSha256: sha256Hex(outputText),
    taskId: "goal-badge-0001",
    verifierTier: "T2-genrm",
    ensembleScore: 0.93,
    pCorrect: 0.965,
    epsilon: 0.02,
    traceSha256: sha256Hex(TRACE_JSON),
    verifierVersions: ["exec-oracle@1.2.0", "genrm-rubric@0.9.3"],
    issuedAt: 1_753_315_200_000,
    ...overrides,
  };
}

async function issueFixture(
  outputText: string = REPLY_TEXT,
  overrides: Partial<CertificatePayload> = {},
  rngSeed = 11,
): Promise<{ ca: CertificateAuthority; cert: VerificationCertificate }> {
  const ca = new CertificateAuthority(generatePrivateKeyHex(fixedRng(rngSeed)));
  const cert = await ca.issue(makePayload(outputText, overrides));
  return { ca, cert };
}

function emitDecision(overrides: Partial<GateDecision> = {}): GateDecision {
  return { emit: true, score: 0.93, threshold: 0.9, pCorrectEstimate: 0.965, ...overrides };
}

function abstainDecision(overrides: Partial<GateDecision> = {}): GateDecision {
  return { emit: false, score: 0.62, threshold: 0.9, pCorrectEstimate: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// assessReply — the unforgeability proof
// ---------------------------------------------------------------------------

describe("assessReply", () => {
  it("verified: a genuine certificate over the exact reply text, with emit:true, yields an independently recomputable fingerprint and the certificate's own pCorrect", async () => {
    const { cert } = await issueFixture();
    const stamped = await assessReply(REPLY_TEXT, { decision: emitDecision(), certificate: cert });

    expect(stamped.badge).toBe("verified");
    expect(stamped.certFingerprint).toBe(sha256Hex(cert.signature).slice(0, 12));
    expect(stamped.certFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(stamped.pCorrect).toBe(cert.payload.pCorrect);
    expect(stamped.reason.length).toBeGreaterThan(0);
  });

  it("unverified: the SAME valid certificate presented with reply text differing by one character (sha256 mismatch)", async () => {
    const { cert } = await issueFixture();
    const stamped = await assessReply(REPLY_TEXT + "!", {
      decision: emitDecision(),
      certificate: cert,
    });

    expect(stamped.badge).toBe("unverified");
    expect(stamped.reason).toBe("certificate did not match this message");
    expect(stamped.certFingerprint).toBeUndefined();
    expect(stamped.pCorrect).toBeUndefined();
  });

  it("unverified: certificate payload tampered post-signature (one hex nibble of outputSha256 flipped, re-canonicalized) fails signature verification", async () => {
    const { cert } = await issueFixture();
    const original = cert.payload.outputSha256;
    const flipped = (original[0] === "0" ? "1" : "0") + original.slice(1);
    const tampered: VerificationCertificate = {
      ...cert,
      payload: {
        ...cert.payload,
        verifierVersions: [...cert.payload.verifierVersions],
        outputSha256: flipped,
      },
    };
    // Sanity: the tampered hash may or may not still equal sha256(REPLY_TEXT)
    // depending on which nibble flipped, but the signature can never cover
    // the mutated payload either way.
    const stamped = await assessReply(REPLY_TEXT, { decision: emitDecision(), certificate: tampered });
    expect(stamped.badge).toBe("unverified");
    expect(stamped.reason).toBe("certificate did not match this message");
  });

  it("unverified: certificate with a mismatched publicKey (signature does not verify under the substituted key)", async () => {
    const { cert } = await issueFixture();
    const otherCa = new CertificateAuthority(generatePrivateKeyHex(fixedRng(29)));
    expect(otherCa.publicKeyHex()).not.toBe(cert.publicKey);
    const swapped: VerificationCertificate = { ...cert, publicKey: otherCa.publicKeyHex() };

    const stamped = await assessReply(REPLY_TEXT, { decision: emitDecision(), certificate: swapped });
    expect(stamped.badge).toBe("unverified");
    expect(stamped.reason).toBe("certificate did not match this message");
  });

  it("abstained: emit:false wins even with a fully valid, matching certificate — the gate outranks the cert", async () => {
    const { cert } = await issueFixture();
    const decision = abstainDecision();
    const stamped = await assessReply(REPLY_TEXT, { decision, certificate: cert });

    expect(stamped.badge).toBe("abstained");
    expect(stamped.reason).toContain(decision.score.toFixed(3));
    expect(stamped.reason).toContain(decision.threshold.toFixed(3));
    expect(stamped.certFingerprint).toBeUndefined();
    expect(stamped.pCorrect).toBeUndefined();
  });

  it("abstained: reason reflects the real GateDecision fields to 3 decimals, not rounded/truncated differently", async () => {
    const decision: GateDecision = {
      emit: false,
      score: 0.123456,
      threshold: 0.654321,
      pCorrectEstimate: 0,
    };
    const stamped = await assessReply(REPLY_TEXT, { decision });
    expect(stamped.badge).toBe("abstained");
    expect(stamped.reason).toContain("0.123");
    expect(stamped.reason).toContain("0.654");
  });

  it("unverified: no evidence at all", async () => {
    const stamped = await assessReply(REPLY_TEXT, {});
    expect(stamped.badge).toBe("unverified");
    expect(stamped.reason.length).toBeGreaterThan(0);
    expect(stamped.certFingerprint).toBeUndefined();
    expect(stamped.pCorrect).toBeUndefined();
  });

  it("unverified: emit:true but no certificate was attached", async () => {
    const stamped = await assessReply(REPLY_TEXT, { decision: emitDecision() });
    expect(stamped.badge).toBe("unverified");
    expect(stamped.certFingerprint).toBeUndefined();
  });

  it("unverified: a certificate present alongside a missing decision never renders verified, regardless of cert validity", async () => {
    const { cert } = await issueFixture();
    const stamped = await assessReply(REPLY_TEXT, { certificate: cert });
    expect(stamped.badge).toBe("unverified");
  });

  it("unverified: certifiesOutput throwing is caught and never surfaces as an unhandled rejection", async () => {
    vi.resetModules();
    vi.doMock("../styx/certificate", async () => {
      const actual = await vi.importActual<typeof import("../styx/certificate")>(
        "../styx/certificate",
      );
      return {
        ...actual,
        certifiesOutput: vi.fn().mockRejectedValue(new Error("malformed hex string")),
      };
    });

    try {
      const { assessReply: assessReplyWithThrowingCert } = await import("../gateway/badge");
      const { cert } = await issueFixture();

      await expect(
        assessReplyWithThrowingCert(REPLY_TEXT, { decision: emitDecision(), certificate: cert }),
      ).resolves.toMatchObject({ badge: "unverified" });
    } finally {
      vi.doUnmock("../styx/certificate");
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// BadgeStamper
// ---------------------------------------------------------------------------

describe("BadgeStamper", () => {
  it("stamps exactly one badge line, leaves accepted/goalId/status untouched, and drops `evidence` from the wire reply", async () => {
    const { cert } = await issueFixture();
    const stamper = new BadgeStamper();
    const handler = async (
      _msg: InboundMessage,
    ): Promise<OutboundReply & { evidence?: BadgeEvidence }> => ({
      text: REPLY_TEXT,
      goalId: "goal-1",
      status: "completed",
      accepted: true,
      evidence: { decision: emitDecision(), certificate: cert },
    });
    const wrapped = stamper.wrap(handler);
    const msg: InboundMessage = { platform: "discord", user: "u1", text: "hi" };
    const reply = await wrapped(msg);

    expect(reply.goalId).toBe("goal-1");
    expect(reply.status).toBe("completed");
    expect(reply.accepted).toBe(true);

    const parts = reply.text.split("\n\n");
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(REPLY_TEXT);
    expect(parts[1]).toContain("verified");
    expect((reply as unknown as Record<string, unknown>).evidence).toBeUndefined();

    const wire = JSON.stringify(reply);
    expect(wire).not.toContain(cert.signature);
    expect(wire).not.toContain(cert.publicKey);
    expect(wire).not.toContain(cert.payload.outputSha256);
    expect(wire).not.toContain("evidence");
  });

  it("appends an abstained badge line when the gate declined to emit, and still drops evidence", async () => {
    const stamper = new BadgeStamper();
    const handler = async (): Promise<OutboundReply & { evidence?: BadgeEvidence }> => ({
      text: REPLY_TEXT,
      accepted: true,
      evidence: { decision: abstainDecision() },
    });
    const wrapped = stamper.wrap(handler);
    const reply = await wrapped({ platform: "telegram", user: "u1", text: "hi" });

    expect(reply.text.endsWith(REPLY_TEXT) === false).toBe(true);
    expect(reply.text).toContain("abstained");
    expect((reply as unknown as Record<string, unknown>).evidence).toBeUndefined();
  });

  it("never stamps an empty-text reply", async () => {
    const stamper = new BadgeStamper();
    const handler = async (): Promise<OutboundReply & { evidence?: BadgeEvidence }> => ({
      text: "",
      accepted: false,
    });
    const wrapped = stamper.wrap(handler);
    const reply = await wrapped({ platform: "slack", user: "u1", text: "hi" });

    expect(reply.text).toBe("");
    expect((reply as unknown as Record<string, unknown>).evidence).toBeUndefined();
  });

  it("honors a caller-supplied render function instead of the default renderBadge", async () => {
    const { cert } = await issueFixture();
    const stamper = new BadgeStamper({ render: (s) => `[[${s.badge}]]` });
    const handler = async (): Promise<OutboundReply & { evidence?: BadgeEvidence }> => ({
      text: REPLY_TEXT,
      accepted: true,
      evidence: { decision: emitDecision(), certificate: cert },
    });
    const wrapped = stamper.wrap(handler);
    const reply = await wrapped({ platform: "cli", user: "u1", text: "hi" });

    expect(reply.text).toBe(`${REPLY_TEXT}\n\n[[verified]]`);
  });

  it("a forged evidence object (mismatched certificate) cannot force a verified badge — there is no caller-supplied-badge code path", async () => {
    const { cert: forgedCert } = await issueFixture("a completely different message");
    const stamper = new BadgeStamper();
    const handler = async (): Promise<OutboundReply & { evidence?: BadgeEvidence }> => ({
      text: REPLY_TEXT,
      accepted: true,
      evidence: { decision: emitDecision(), certificate: forgedCert },
    });
    const wrapped = stamper.wrap(handler);
    const reply = await wrapped({ platform: "discord", user: "u1", text: "hi" });

    expect(reply.text).toContain("unverified");
    expect(reply.text).not.toContain("✅");
  });

  it("stamped output, composed with chunkMessage, stays within each platform's maxChars", async () => {
    const platforms = ["telegram", "discord", "slack", "whatsapp", "signal", "email", "cli"];
    for (const platform of platforms) {
      const { maxChars } = platformFormat(platform);
      const longReply = Array.from({ length: Math.ceil((maxChars * 2) / 6) }, (_, i) =>
        `word${i % 10}`,
      ).join(" ");
      const { cert } = await issueFixture(longReply, {}, 41);

      const stamper = new BadgeStamper();
      const handler = async (): Promise<OutboundReply & { evidence?: BadgeEvidence }> => ({
        text: longReply,
        accepted: true,
        evidence: { decision: emitDecision(), certificate: cert },
      });
      const wrapped = stamper.wrap(handler);
      const reply = await wrapped({ platform: platform as InboundMessage["platform"], user: "u1", text: "hi" });

      const chunks = chunkMessage(reply.text, platform);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(maxChars);
      }
    }
  });
});
