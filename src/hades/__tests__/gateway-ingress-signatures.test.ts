import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyMetaSignature,
  verifySlackSignature,
  verifyTelegramSecretToken,
} from "../gateway/ingress/signatures";

// All expected signatures below are computed independently with node:crypto,
// never by calling the functions under test.

function slackSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), rawBody]);
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

function metaSignature(secret: string, rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const secret = "shhh-slack-secret";
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const rawBody = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "Ev1" }), "utf8");

  it("accepts a correctly signed request", () => {
    const signatureHeader = slackSignature(secret, timestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: timestamp,
      signatureHeader,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects when either header is missing", () => {
    const signatureHeader = slackSignature(secret, timestamp, rawBody);
    expect(
      verifySlackSignature({ signingSecret: secret, timestampHeader: undefined, signatureHeader, rawBody, nowMs })
    ).toEqual({ ok: false, reason: "missing-header" });
    expect(
      verifySlackSignature({ signingSecret: secret, timestampHeader: timestamp, signatureHeader: undefined, rawBody, nowMs })
    ).toEqual({ ok: false, reason: "missing-header" });
  });

  it("rejects a non-numeric timestamp header", () => {
    const signatureHeader = slackSignature(secret, "not-a-number", rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: "not-a-number",
      signatureHeader,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "malformed-timestamp" });
  });

  it("rejects a stale timestamp more than 5 minutes in the past", () => {
    const staleTs = String(Math.floor(nowMs / 1000) - 301); // 301s = just past the 300s default
    const signatureHeader = slackSignature(secret, staleTs, rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: staleTs,
      signatureHeader,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects a timestamp more than 5 minutes in the future", () => {
    const futureTs = String(Math.floor(nowMs / 1000) + 301);
    const signatureHeader = slackSignature(secret, futureTs, rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: futureTs,
      signatureHeader,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const boundaryTs = String(Math.floor(nowMs / 1000) - 300); // exactly 300s = default tolerance
    const signatureHeader = slackSignature(secret, boundaryTs, rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: boundaryTs,
      signatureHeader,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: true });
  });

  it("respects a custom toleranceMs", () => {
    const ts = String(Math.floor(nowMs / 1000) - 10);
    const signatureHeader = slackSignature(secret, ts, rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: ts,
      signatureHeader,
      rawBody,
      nowMs,
      toleranceMs: 5_000,
    });
    expect(result).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects a single tampered body byte", () => {
    const signatureHeader = slackSignature(secret, timestamp, rawBody);
    const tampered = Buffer.from(rawBody);
    tampered[0] = tampered[0] ^ 0xff;
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: timestamp,
      signatureHeader,
      rawBody: tampered,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects the right scheme signed with the wrong secret", () => {
    const signatureHeader = slackSignature("a-completely-different-secret", timestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: timestamp,
      signatureHeader,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a signature missing the v0= prefix", () => {
    const bareHex = slackSignature(secret, timestamp, rawBody).slice("v0=".length);
    const result = verifySlackSignature({
      signingSecret: secret,
      timestampHeader: timestamp,
      signatureHeader: bareHex,
      rawBody,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("never throws on a signature header of a different length than expected", () => {
    // Regression guard: timingSafeEqual throws on length mismatch; the
    // implementation must pre-check length rather than let that propagate.
    expect(() =>
      verifySlackSignature({
        signingSecret: secret,
        timestampHeader: timestamp,
        signatureHeader: "v0=short",
        rawBody,
        nowMs,
      })
    ).not.toThrow();
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestampHeader: timestamp,
        signatureHeader: "v0=short",
        rawBody,
        nowMs,
      })
    ).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("verifyMetaSignature", () => {
  const secret = "shhh-meta-app-secret";
  const rawBody = Buffer.from(JSON.stringify({ entry: [{ id: "1" }] }), "utf8");

  it("accepts a correctly signed request", () => {
    const signatureHeader = metaSignature(secret, rawBody);
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader, rawBody })).toEqual({ ok: true });
  });

  it("accepts an upper-case hex digest (hex is case-insensitive)", () => {
    const signatureHeader = metaSignature(secret, rawBody).toUpperCase().replace("SHA256=", "sha256=");
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader, rawBody })).toEqual({ ok: true });
  });

  it("rejects a missing header", () => {
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader: undefined, rawBody })).toEqual({
      ok: false,
      reason: "missing-header",
    });
  });

  it("rejects a header missing the sha256= prefix", () => {
    const bareHex = metaSignature(secret, rawBody).slice("sha256=".length);
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader: bareHex, rawBody })).toEqual({
      ok: false,
      reason: "malformed-header",
    });
  });

  it("rejects a header with non-hex characters after the prefix", () => {
    expect(
      verifyMetaSignature({ appSecret: secret, signatureHeader: "sha256=not-hex-zzzz", rawBody })
    ).toEqual({ ok: false, reason: "malformed-header" });
  });

  it("rejects an empty digest", () => {
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader: "sha256=", rawBody })).toEqual({
      ok: false,
      reason: "malformed-header",
    });
  });

  it("rejects a single tampered body byte", () => {
    const signatureHeader = metaSignature(secret, rawBody);
    const tampered = Buffer.from(rawBody);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader, rawBody: tampered })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects the right scheme signed with the wrong secret", () => {
    const signatureHeader = metaSignature("wrong-secret", rawBody);
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader, rawBody })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("never throws when the digest has a different length than expected", () => {
    expect(() =>
      verifyMetaSignature({ appSecret: secret, signatureHeader: "sha256=ab", rawBody })
    ).not.toThrow();
    expect(verifyMetaSignature({ appSecret: secret, signatureHeader: "sha256=ab", rawBody })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
});

describe("verifyTelegramSecretToken", () => {
  it("accepts a matching token", () => {
    expect(verifyTelegramSecretToken("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyTelegramSecretToken("my-secret-token", "wrong-token")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyTelegramSecretToken("my-secret-token", undefined)).toBe(false);
  });

  it("never throws when the header has a different length than expected", () => {
    expect(() => verifyTelegramSecretToken("my-secret-token", "x")).not.toThrow();
    expect(verifyTelegramSecretToken("my-secret-token", "x")).toBe(false);
  });

  it("rejects an empty-string header", () => {
    expect(verifyTelegramSecretToken("my-secret-token", "")).toBe(false);
  });
});
