/**
 * capability.test.ts
 *
 * REAL-VS-MOCK POLICY: crypto is always real — every token here is signed
 * by a real `GovIdentity` (real ed25519 via `@noble/ed25519`, real sha256
 * via `node:crypto`, both wired through `../identity`'s
 * `govCanonicalize`/`govDigest`/`signGov`/`verifyGovSignature`). Nothing
 * stubs `CapabilityIssuer`, `CapabilityEnforcer`, `isAttenuation`, or
 * `resourceMatches` — every assertion exercises the real engine, including
 * deliberately forged/tampered tokens built by hand from the exported
 * types (never through a mocked signer). Every clock is an explicit `at`
 * value; nothing here reads `Date.now()`.
 *
 * Design notes on two points the locked contract leaves to this
 * implementation (documented here so the choice is visible, not buried):
 *  - `net:` hostnames compare CASE-INSENSITIVELY (DNS is case-insensitive);
 *    every other resource segment compares case-sensitively.
 *  - The `audience` field is checked against `req.args.audience` (the
 *    locked `CapabilityRequest` has no dedicated audience field, and
 *    `args` is the extensible slot the rest of the caveat grammar already
 *    reads from).
 *  - Per-request replay protection is keyed by the caller-supplied
 *    `req.nonce` (scoped to the leaf token), not the token's own embedded
 *    `nonce` — the latter is mint-time entropy folded into the signed body
 *    (making `tokenId` content-addressed and unique); the former defends
 *    against literal replay of one captured (chain, request) pair while
 *    still letting a `max-uses` token be legitimately re-invoked.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GovIdentity, govCanonicalize, signGov, verifyGovSignature, agentIdFromPublicKey, govDigest } from "../identity";
import {
  CapabilityIssuer,
  CapabilityEnforcer,
  resourceMatches,
  isAttenuation,
  toLegacyCapabilityToken,
  type GovCapabilityToken,
  type CapabilityGrant,
  type CapabilityCaveat,
  type CapabilityRequest,
  type CapabilityDenyCode,
} from "../capability";
import { MemoryReplayGuard, DurableReplayGuard } from "../replay-guard";
import { CapabilityChecker } from "../../security/tokens";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function clock(startAt: number): { now: () => number; set: (t: number) => void } {
  let t = startAt;
  return { now: () => t, set: (v: number) => (t = v) };
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function baseGrants(): CapabilityGrant[] {
  return [{ resource: "tool:http_request", actions: ["invoke"] }];
}

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gov-capability-"));
  return { dir, file: join(dir, "gov", "nonces.json") };
}

/**
 * Rebuild the exact signing convention `capability.ts` uses (documented in
 * its header): sign `govCanonicalize(token-without-`signature`)`. Used ONLY
 * to construct deliberately hand-forged tokens for attack tests — an
 * attacker who understands the protocol can always do this; the point of
 * these tests is that `CapabilityEnforcer` still catches the result.
 */
function resign(identity: GovIdentity, tokenWithoutSignature: Omit<GovCapabilityToken, "signature">): GovCapabilityToken {
  const canonical = govCanonicalize(tokenWithoutSignature);
  const signature = signGov(identity.privateKeyHex(), canonical);
  return { ...tokenWithoutSignature, signature };
}

// ---------------------------------------------------------------------------
// Basic mint / authorize round trip
// ---------------------------------------------------------------------------

describe("CapabilityIssuer.mint + CapabilityEnforcer.authorize — happy path", () => {
  it("mints a token that authorizes a matching request and denies a non-matching one", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const c = clock(1_000_000);
    const issuer = new CapabilityIssuer(rootId, { now: c.now, nonceGen: counter("nonce") });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });

    expect(token.schema).toBe("hades.gov.capability.v1");
    expect(token.depth).toBe(0);
    expect(token.parentTokenId).toBeUndefined();
    expect(token.issuer).toBe(rootId.agentId());
    expect(token.issuerPublicKey).toBe(rootId.publicKeyHex());
    expect(token.signerPublicKey).toBe(rootId.publicKeyHex());

    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: c.now });

    const ok = enforcer.authorize([token], {
      subject: holderId.agentId(),
      action: "invoke",
      resource: "tool:http_request",
      at: c.now(),
    });
    expect(ok).toEqual(expect.objectContaining({ allow: true, code: "allow" }));

    const badResource = enforcer.authorize([token], {
      subject: holderId.agentId(),
      action: "invoke",
      resource: "tool:other_thing",
      at: c.now(),
    });
    expect(badResource.allow).toBe(false);
    expect(badResource.code).toBe("no-matching-grant");
  });

  it("assert() throws with the deny code embedded, and never throws on allow", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 0 });

    expect(() =>
      enforcer.assert([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 }),
    ).not.toThrow();

    expect(() =>
      enforcer.assert([token], { subject: "agent:someone-else", action: "invoke", resource: "tool:http_request", at: 0 }),
    ).toThrow(/subject-mismatch/);
  });

  it("authorize() NEVER throws, even on completely garbage input", () => {
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [] });
    expect(() => enforcer.authorize([], { subject: "a", action: "x", resource: "y", at: 0 })).not.toThrow();
    expect(() => enforcer.authorize(null as unknown as GovCapabilityToken[], { subject: "a", action: "x", resource: "y", at: 0 })).not.toThrow();
    expect(() => enforcer.authorize([{} as GovCapabilityToken], { subject: "a", action: "x", resource: "y", at: 0 })).not.toThrow();
    expect(() => enforcer.authorize([{ weird: true } as unknown as GovCapabilityToken], null as unknown as CapabilityRequest)).not.toThrow();
    const r1 = enforcer.authorize([], { subject: "a", action: "x", resource: "y", at: 0 });
    expect(r1.allow).toBe(false);
    expect(r1.code).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// (1) Forgery
// ---------------------------------------------------------------------------

describe("forgery", () => {
  it("editing grants after signing invalidates the signature", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });

    const tampered: GovCapabilityToken = { ...token, grants: [{ resource: "*", actions: ["*"] }] };
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 0 });
    const decision = enforcer.authorize([tampered], { subject: holderId.agentId(), action: "invoke", resource: "anything", at: 0 });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("signature-invalid");
  });

  it("re-signing a tampered token with an untrusted key fails untrusted-issuer, not signature-invalid", () => {
    const rootId = GovIdentity.generate();
    const attacker = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });

    // Attacker edits the grants AND correctly re-signs under their OWN key,
    // updating issuer/issuerPublicKey/signerPublicKey to match (a fully
    // "self-consistent" forgery) — this must still fail because the
    // attacker's key was never trusted as a root issuer.
    const { signature: _drop, ...body } = token;
    const forgedBody = {
      ...body,
      issuer: attacker.agentId(),
      issuerPublicKey: attacker.publicKeyHex(),
      signerPublicKey: attacker.publicKeyHex(),
      grants: [{ resource: "*", actions: ["*"] }],
    };
    const forged = resign(attacker, forgedBody);

    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 0 });
    const decision = enforcer.authorize([forged], { subject: holderId.agentId(), action: "invoke", resource: "anything", at: 0 });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("untrusted-issuer");
  });

  it("swapping signerPublicKey to the attacker's key WITHOUT re-signing fails signature-invalid", () => {
    const rootId = GovIdentity.generate();
    const attacker = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });

    const forged: GovCapabilityToken = { ...token, signerPublicKey: attacker.publicKeyHex() }; // signature left stale
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex(), attacker.publicKeyHex()], now: () => 0 });
    const decision = enforcer.authorize([forged], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("signature-invalid");
  });

  it("swapping signerPublicKey to the attacker's key AND re-signing under it still fails (issuer/signer mismatch)", () => {
    const rootId = GovIdentity.generate();
    const attacker = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });

    const { signature: _drop, ...body } = token;
    const forgedBody = { ...body, signerPublicKey: attacker.publicKeyHex() }; // issuer/issuerPublicKey UNCHANGED
    const forged = resign(attacker, forgedBody); // attacker signs under their own key — verifies fine in isolation

    // Sanity: the raw signature really does verify under the attacker's key.
    const { signature, ...forgedBodyOnly } = forged;
    expect(verifyGovSignature(attacker.publicKeyHex(), govCanonicalize(forgedBodyOnly), signature)).toBe(true);

    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex(), attacker.publicKeyHex()], now: () => 0 });
    const decision = enforcer.authorize([forged], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("signature-invalid"); // issuerPublicKey !== signerPublicKey
  });

  it("the signature is over the body EXCLUDING `signature` — verifying against a canonical body that includes it fails", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });

    const { signature, ...withoutSignature } = token;
    // Correct: canonicalize WITHOUT `signature` -> verifies.
    expect(verifyGovSignature(token.signerPublicKey, govCanonicalize(withoutSignature), signature)).toBe(true);
    // Wrong: canonicalize the FULL token (including `signature`) -> does NOT verify.
    // If the implementation ever accidentally included `signature` in its
    // own signed message, this assertion is what would catch it.
    expect(verifyGovSignature(token.signerPublicKey, govCanonicalize(token), signature)).toBe(false);
  });

  it("a tokenId edited to a different (still well-formed) value invalidates the signature", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const tampered: GovCapabilityToken = { ...token, tokenId: "cap:deadbeef" };
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 0 });
    const decision = enforcer.authorize([tampered], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(decision.code).toBe("signature-invalid");
  });
});

// ---------------------------------------------------------------------------
// (2) Attenuation is structurally one-way
// ---------------------------------------------------------------------------

describe("attenuation is structurally one-way", () => {
  function baseParent(): GovCapabilityToken {
    return {
      schema: "hades.gov.capability.v1",
      tokenId: "cap:parent",
      issuer: "agent:root",
      issuerPublicKey: "aa".repeat(32),
      subject: "agent:holder",
      grants: [
        { resource: "fs:read:/data/**", actions: ["read", "list"] },
        { resource: "tool:http_request", actions: ["invoke"] },
      ],
      caveats: [
        { kind: "expires-at", at: 100_000 },
        { kind: "max-uses", uses: 5 },
        { kind: "host-allowlist", hosts: ["a.com", "b.com"] },
        { kind: "path-under", root: "/work/sub" },
      ],
      issuedAt: 0,
      expiresAt: 100_000,
      depth: 0,
      nonce: "n-parent",
      signature: "sig-parent",
      signerPublicKey: "aa".repeat(32),
    };
  }

  function validChild(): GovCapabilityToken {
    return {
      schema: "hades.gov.capability.v1",
      tokenId: "cap:child",
      issuer: "agent:holder",
      issuerPublicKey: "bb".repeat(32),
      subject: "agent:grandchild",
      grants: [
        { resource: "fs:read:/data/x", actions: ["read"] },
        { resource: "tool:http_request", actions: ["invoke"] },
      ],
      caveats: [
        { kind: "expires-at", at: 50_000 },
        { kind: "max-uses", uses: 2 },
        { kind: "host-allowlist", hosts: ["a.com"] },
        { kind: "path-under", root: "/work/sub/deeper" },
      ],
      issuedAt: 10,
      expiresAt: 50_000,
      depth: 1,
      parentTokenId: "cap:parent",
      nonce: "n-child",
      signature: "sig-child",
      signerPublicKey: "bb".repeat(32),
    };
  }

  it("a genuine narrowing (equal-or-tighter on every axis) is a valid attenuation", () => {
    const parent = baseParent();
    const child = validChild();
    const result = isAttenuation(parent, child);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("an EXACT structural copy (zero-op attenuation) is also valid — narrowing is not required to be strict per-field", () => {
    const parent = baseParent();
    const child: GovCapabilityToken = { ...validChild(), grants: parent.grants.map((g) => ({ ...g, actions: [...g.actions] })), caveats: parent.caveats.map((c) => ({ ...c })), expiresAt: parent.expiresAt };
    expect(isAttenuation(parent, child).ok).toBe(true);
  });

  // The 8 widening dimensions the comprehensiveness bar names explicitly.
  const widenings: Array<{ name: string; mutate: (parent: GovCapabilityToken, child: GovCapabilityToken) => GovCapabilityToken }> = [
    {
      name: "new resource not covered by any parent grant",
      mutate: (_p, c) => ({ ...c, grants: [...c.grants, { resource: "net:evil.example.com", actions: ["connect"] }] }),
    },
    {
      name: "broader wildcard where the parent grant was an exact literal",
      mutate: (_p, c) => ({ ...c, grants: c.grants.map((g) => (g.resource === "tool:http_request" ? { ...g, resource: "tool:*" } : g)) }),
    },
    {
      name: "extra action beyond what the matching parent grant allows",
      mutate: (_p, c) => ({ ...c, grants: c.grants.map((g) => (g.resource === "tool:http_request" ? { ...g, actions: [...g.actions, "delete"] } : g)) }),
    },
    {
      name: "dropped caveat (parent's host-allowlist entirely absent from child)",
      mutate: (_p, c) => ({ ...c, caveats: c.caveats.filter((cv) => cv.kind !== "host-allowlist") }),
    },
    {
      name: "later expiry than the parent",
      mutate: (p, c) => ({ ...c, expiresAt: p.expiresAt + 1, caveats: c.caveats.map((cv) => (cv.kind === "expires-at" ? { kind: "expires-at" as const, at: p.expiresAt + 1 } : cv)) }),
    },
    {
      name: "larger max-uses than the parent",
      mutate: (p, c) => ({ ...c, caveats: c.caveats.map((cv) => (cv.kind === "max-uses" ? { kind: "max-uses" as const, uses: (p.caveats.find((x) => x.kind === "max-uses") as { uses: number }).uses + 1 } : cv)) }),
    },
    {
      name: "wider host list than the parent's host-allowlist",
      mutate: (_p, c) => ({ ...c, caveats: c.caveats.map((cv) => (cv.kind === "host-allowlist" ? { kind: "host-allowlist" as const, hosts: [...cv.hosts, "evil.example.com"] } : cv)) }),
    },
    {
      name: "shallower path-under root than the parent's",
      mutate: (_p, c) => ({ ...c, caveats: c.caveats.map((cv) => (cv.kind === "path-under" ? { kind: "path-under" as const, root: "/work" } : cv)) }),
    },
  ];

  for (const { name, mutate } of widenings) {
    it(`rejects widening: ${name}`, () => {
      const parent = baseParent();
      const widened = mutate(parent, validChild());
      const result = isAttenuation(parent, widened);
      expect(result.ok).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  }

  it("rejects a child with depth not exactly parent.depth + 1", () => {
    const parent = baseParent();
    const child = { ...validChild(), depth: 5 };
    expect(isAttenuation(parent, child).ok).toBe(false);
  });

  it("rejects a child whose parentTokenId does not point at the parent", () => {
    const parent = baseParent();
    const child = { ...validChild(), parentTokenId: "cap:someone-else" };
    expect(isAttenuation(parent, child).ok).toBe(false);
  });

  it("rejects a child whose issuer is not the parent's subject", () => {
    const parent = baseParent();
    const child = { ...validChild(), issuer: "agent:not-the-holder" };
    expect(isAttenuation(parent, child).ok).toBe(false);
  });

  it("CapabilityIssuer.attenuate() throws for every one of the 8 widening attempts", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const c = clock(0);
    const issuer = new CapabilityIssuer(rootId, { now: c.now, nonceGen: counter("n") });
    const parent = issuer.mint({
      subject: holderId.agentId(),
      grants: [
        { resource: "fs:read:/data/**", actions: ["read", "list"] },
        { resource: "tool:http_request", actions: ["invoke"] },
      ],
      caveats: [
        { kind: "max-uses", uses: 5 },
        { kind: "host-allowlist", hosts: ["a.com", "b.com"] },
        { kind: "path-under", root: "/work/sub" },
      ],
      ttlMs: 100_000,
    });

    // new resource
    expect(() =>
      issuer.attenuate(parent, holderId, { grants: [...parent.grants, { resource: "net:evil.example.com", actions: ["connect"] }] }),
    ).toThrow();
    // broader wildcard
    expect(() =>
      issuer.attenuate(parent, holderId, { grants: parent.grants.map((g) => (g.resource === "tool:http_request" ? { ...g, resource: "tool:*" } : g)) }),
    ).toThrow();
    // extra action
    expect(() =>
      issuer.attenuate(parent, holderId, { grants: parent.grants.map((g) => (g.resource === "tool:http_request" ? { ...g, actions: [...g.actions, "delete"] } : g)) }),
    ).toThrow();
    // dropped caveat
    expect(() => issuer.attenuate(parent, holderId, { caveats: parent.caveats.filter((cv) => cv.kind !== "host-allowlist") })).toThrow();
    // later expiry
    expect(() => issuer.attenuate(parent, holderId, { ttlMs: 999_999_999 })).toThrow();
    // larger max-uses
    expect(() => issuer.attenuate(parent, holderId, { caveats: parent.caveats.map((cv) => (cv.kind === "max-uses" ? { kind: "max-uses" as const, uses: 999 } : cv)) })).toThrow();
    // wider host list
    expect(() =>
      issuer.attenuate(parent, holderId, { caveats: parent.caveats.map((cv) => (cv.kind === "host-allowlist" ? { kind: "host-allowlist" as const, hosts: [...cv.hosts, "evil.com"] } : cv)) }),
    ).toThrow();
    // shallower path root
    expect(() => issuer.attenuate(parent, holderId, { caveats: parent.caveats.map((cv) => (cv.kind === "path-under" ? { kind: "path-under" as const, root: "/" } : cv)) })).toThrow();

    // A genuine narrowing, for contrast, must succeed.
    const child = issuer.attenuate(parent, holderId, { grants: [{ resource: "tool:http_request", actions: ["invoke"] }] });
    expect(child.depth).toBe(1);
    expect(isAttenuation(parent, child).ok).toBe(true);
  });

  it("a hand-forged, correctly-signed but WIDENED child is still rejected at authorize() with attenuation-violation", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const c = clock(0);
    const issuer = new CapabilityIssuer(rootId, { now: c.now, nonceGen: counter("n") });
    const parent = issuer.mint({ subject: holderId.agentId(), grants: [{ resource: "tool:http_request", actions: ["invoke"] }], ttlMs: 100_000 });

    // Bypass CapabilityIssuer.attenuate() entirely: hand-build a WIDENED
    // child (adds an action the parent never granted) and sign it for real
    // with the holder's own key — a fully legitimate signature over an
    // illegitimate scope.
    const preBody = {
      schema: "hades.gov.capability.v1" as const,
      issuer: holderId.agentId(),
      issuerPublicKey: holderId.publicKeyHex(),
      subject: "agent:grandchild",
      grants: [{ resource: "tool:http_request", actions: ["invoke", "delete"] }], // WIDENED: extra action
      caveats: [] as CapabilityCaveat[],
      issuedAt: 1,
      expiresAt: parent.expiresAt,
      depth: 1,
      parentTokenId: parent.tokenId,
      nonce: "forged-nonce",
      signerPublicKey: holderId.publicKeyHex(),
    };
    const tokenId = `cap:${govDigest(preBody)}`;
    const forgedChild = resign(holderId, { ...preBody, tokenId });

    // Confirm the forged token really is validly signed on its own.
    expect(agentIdFromPublicKey(holderId.publicKeyHex())).toBe(holderId.agentId());

    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 1 });
    const decision = enforcer.authorize([parent, forgedChild], {
      subject: "agent:grandchild",
      action: "delete",
      resource: "tool:http_request",
      at: 1,
    });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("attenuation-violation");
  });
});

// ---------------------------------------------------------------------------
// (3) Confused deputy
// ---------------------------------------------------------------------------

describe("confused deputy", () => {
  it("a token minted for subject A used by subject B fails subject-mismatch", () => {
    const rootId = GovIdentity.generate();
    const subjectA = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: subjectA.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 0 });

    const decision = enforcer.authorize([token], { subject: "agent:totally-different", action: "invoke", resource: "tool:http_request", at: 0 });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("subject-mismatch");
  });

  it("a token with audience:'desktop' presented without a matching audience fails audience-mismatch", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), audience: "desktop", ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: () => 0 });

    const cliAttempt = enforcer.authorize([token], {
      subject: holderId.agentId(),
      action: "invoke",
      resource: "tool:http_request",
      at: 0,
      args: { audience: "cli" },
    });
    expect(cliAttempt.allow).toBe(false);
    expect(cliAttempt.code).toBe("audience-mismatch");

    const noAudienceAttempt = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(noAudienceAttempt.allow).toBe(false);
    expect(noAudienceAttempt.code).toBe("audience-mismatch");

    const desktopAttempt = enforcer.authorize([token], {
      subject: holderId.agentId(),
      action: "invoke",
      resource: "tool:http_request",
      at: 0,
      args: { audience: "desktop" },
    });
    expect(desktopAttempt.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (4) Time
// ---------------------------------------------------------------------------

describe("time boundaries", () => {
  it("denies expired at exactly at === expiresAt (not just after)", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 1000 }); // expiresAt = 1000
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });

    const justBefore = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 999 });
    expect(justBefore.allow).toBe(true);

    const exactBoundary = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 1000 });
    expect(exactBoundary.allow).toBe(false);
    expect(exactBoundary.code).toBe("expired");

    const wellAfter = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 5000 });
    expect(wellAfter.code).toBe("expired");
  });

  it("denies not-yet-valid before issuedAt", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 5000 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 1000 }); // issuedAt = 5000
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });

    const tooEarly = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 4999 });
    expect(tooEarly.allow).toBe(false);
    expect(tooEarly.code).toBe("not-yet-valid");

    const exactlyIssued = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 5000 });
    expect(exactlyIssued.allow).toBe(true); // issuedAt itself is valid
  });

  it("an expires-at CAVEAT (distinct from the token's own field) fails with caveat-failed at its own boundary", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({
      subject: holderId.agentId(),
      grants: baseGrants(),
      caveats: [{ kind: "expires-at", at: 500 }], // tighter than the token's own 60s TTL
      ttlMs: 60_000,
    });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });

    const decision = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 500 });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("caveat-failed");
  });
});

// ---------------------------------------------------------------------------
// (5) Replay
// ---------------------------------------------------------------------------

describe("replay defense", () => {
  it("a single-use request nonce consumed twice denies replayed the second time", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const guard = new MemoryReplayGuard();
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], replayGuard: guard });

    const req: CapabilityRequest = { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, nonce: "req-1" };
    const first = enforcer.authorize([token], req);
    expect(first.allow).toBe(true);
    const second = enforcer.authorize([token], req);
    expect(second.allow).toBe(false);
    expect(second.code).toBe("replayed");
  });

  it("still denies replay after DurableReplayGuard is closed and reopened from a real temp file", () => {
    const { dir, file } = tempFile();
    try {
      const rootId = GovIdentity.generate();
      const holderId = GovIdentity.generate();
      const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
      const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 600_000 });
      const req: CapabilityRequest = { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, nonce: "captured-req" };

      const guard1 = DurableReplayGuard.open({ file, ttlMs: 10_000_000 });
      const enforcer1 = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], replayGuard: guard1 });
      expect(enforcer1.authorize([token], req).allow).toBe(true);
      guard1.close();

      // Simulate a process restart: fresh guard + fresh enforcer, same file.
      const guard2 = DurableReplayGuard.open({ file, ttlMs: 10_000_000 });
      const enforcer2 = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], replayGuard: guard2 });
      const replay = enforcer2.authorize([token], req);
      expect(replay.allow).toBe(false);
      expect(replay.code).toBe("replayed");
      guard2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a max-uses:3 token allows exactly 3 uses and denies the 4th with use-limit-exceeded", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), caveats: [{ kind: "max-uses", uses: 3 }], ttlMs: 60_000 });
    const guard = new MemoryReplayGuard(); // implements both ReplayGuard and UseCounter
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], replayGuard: guard, useCounter: guard });

    const mk = (nonce: string): CapabilityRequest => ({ subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, nonce });

    expect(enforcer.authorize([token], mk("u1")).allow).toBe(true);
    expect(enforcer.authorize([token], mk("u2")).allow).toBe(true);
    expect(enforcer.authorize([token], mk("u3")).allow).toBe(true);
    const fourth = enforcer.authorize([token], mk("u4"));
    expect(fourth.allow).toBe(false);
    expect(fourth.code).toBe("use-limit-exceeded");

    expect(guard.count(token.tokenId)).toBe(3); // the failed 4th attempt did NOT increment
  });

  it("TTL pruning removes only expired nonces and never resurrects one still valid", () => {
    const guard = new MemoryReplayGuard();
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 10_000_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], replayGuard: guard });

    const req: CapabilityRequest = { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, nonce: "n" };
    expect(enforcer.authorize([token], req).allow).toBe(true);

    guard.pruneOlderThan(500, 1000); // not expired (age 500 < ttl 1000)
    const stillReplayed = enforcer.authorize([token], { ...req, at: 500 });
    expect(stillReplayed.code).toBe("replayed");

    guard.pruneOlderThan(1000, 1000); // now expired (age 1000 >= ttl 1000)
    const freshAgain = enforcer.authorize([token], { ...req, at: 1000 });
    expect(freshAgain.allow).toBe(true); // legitimately treated as a new use, not a resurrection of a still-open replay window
  });
});

// ---------------------------------------------------------------------------
// (6) Least-privilege checkpoint
// ---------------------------------------------------------------------------

describe("resourceMatches — segmented pattern matcher", () => {
  it("exact literal patterns match only themselves", () => {
    expect(resourceMatches("tool:http_request", "tool:http_request")).toBe(true);
    expect(resourceMatches("tool:http_request", "tool:other")).toBe(false);
  });

  it("`*` matches exactly one path segment and never crosses a segment boundary", () => {
    expect(resourceMatches("fs:read:/data/*", "fs:read:/data/a")).toBe(true);
    expect(resourceMatches("fs:read:/data/*", "fs:read:/data/a/b")).toBe(false); // the exact case from the spec
    expect(resourceMatches("fs:read:/data/*", "fs:read:/data")).toBe(false); // `*` requires exactly one segment, not zero
  });

  it("`**` is a recursive tail wildcard: matches zero or more remaining segments", () => {
    expect(resourceMatches("fs:read:/data/**", "fs:read:/data")).toBe(true);
    expect(resourceMatches("fs:read:/data/**", "fs:read:/data/a")).toBe(true);
    expect(resourceMatches("fs:read:/data/**", "fs:read:/data/a/b/c")).toBe(true);
    expect(resourceMatches("fs:read:/data/**", "fs:read:/other")).toBe(false);
  });

  it("net: hostnames match case-insensitively", () => {
    expect(resourceMatches("net:api.example.com", "net:API.EXAMPLE.COM")).toBe(true);
    expect(resourceMatches("net:api.example.com", "net:Api.Example.Com")).toBe(true);
  });

  it("net: suffix-confusion is denied — a longer host string never matches a shorter pattern", () => {
    expect(resourceMatches("net:api.example.com", "net:evil.example.com.attacker.tld")).toBe(false);
    expect(resourceMatches("net:api.example.com", "net:api.example.com.attacker.tld")).toBe(false);
  });

  it("net: IDN/punycode lookalikes (different bytes) do not match", () => {
    const cyrillicLookalike = "net:аpi.example.com"; // Cyrillic 'а' (U+0430), not Latin 'a'
    expect(resourceMatches("net:api.example.com", cyrillicLookalike)).toBe(false);
    expect(resourceMatches("net:api.example.com", "net:xn--pi-9d1e.example.com")).toBe(false);
  });

  it("fs: resource paths are case-sensitive (unlike net: hosts)", () => {
    expect(resourceMatches("fs:read:/Data/foo", "fs:read:/data/foo")).toBe(false);
  });

  it("a wildcard segment never satisfies a literal parent segment and vice versa", () => {
    expect(resourceMatches("tool:http_request", "tool:*")).toBe(false); // concrete resources never legitimately carry wildcards, but even if one did, it must not "match more broadly"
    expect(resourceMatches("tool:*", "tool:http_request")).toBe(true);
  });
});

describe("path-under caveat — hostile path traversal", () => {
  function tokenWith(caveats: CapabilityCaveat[]) {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: [{ resource: "tool:file_ops", actions: ["read"] }], caveats, ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    return { holderId, token, enforcer };
  }

  function check(path: string) {
    const { holderId, token, enforcer } = tokenWith([{ kind: "path-under", root: "/work" }]);
    return enforcer.authorize([token], { subject: holderId.agentId(), action: "read", resource: "tool:file_ops", at: 0, args: { path } });
  }

  it("allows a legitimate relative path under the root", () => {
    expect(check("sub/file.txt").allow).toBe(true);
  });

  it("allows the root itself", () => {
    expect(check(".").allow).toBe(true);
  });

  it("denies a classic relative traversal", () => {
    const d = check("../../etc/passwd");
    expect(d.allow).toBe(false);
    expect(d.code).toBe("caveat-failed");
  });

  it("denies traversal buried inside an otherwise-plausible subpath", () => {
    expect(check("sub/../../etc/passwd").allow).toBe(false);
  });

  it("denies a raw absolute-path escape", () => {
    expect(check("/etc/passwd").allow).toBe(false);
  });

  it("allows an absolute path that legitimately IS under the root", () => {
    expect(check("/work/sub/file.txt").allow).toBe(true);
  });

  it("denies URL-encoded traversal (%2e%2e)", () => {
    expect(check("%2e%2e/%2e%2e/etc/passwd").allow).toBe(false);
  });

  it("denies double-URL-encoded traversal (%252e%252e)", () => {
    expect(check("%252e%252e/%252e%252e/etc/passwd").allow).toBe(false);
  });

  it("denies a sibling directory that merely shares the root as a string prefix", () => {
    expect(check("../work-evil/secret").allow).toBe(false);
  });

  it("denies when no path arg is present at all (deny-by-default)", () => {
    const { holderId, token, enforcer } = tokenWith([{ kind: "path-under", root: "/work" }]);
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "read", resource: "tool:file_ops", at: 0 });
    expect(d.allow).toBe(false);
    expect(d.code).toBe("caveat-failed");
  });
});

describe("host-allowlist caveat", () => {
  function check(hosts: string[], resource: string) {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: [{ resource: "net:*", actions: ["connect"] }], caveats: [{ kind: "host-allowlist", hosts }], ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    return enforcer.authorize([token], { subject: holderId.agentId(), action: "connect", resource, at: 0 });
  }

  it("allows an exact allowed host", () => {
    expect(check(["api.example.com"], "net:api.example.com").allow).toBe(true);
  });

  it("denies a suffix-confusion host", () => {
    expect(check(["api.example.com"], "net:evil.example.com.attacker.tld").allow).toBe(false);
  });

  it("allows case-insensitively", () => {
    expect(check(["api.example.com"], "net:API.EXAMPLE.COM").allow).toBe(true);
  });

  it("denies a host not on the list at all", () => {
    expect(check(["api.example.com"], "net:other.example.com").allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (7) Every deny code has a dedicated test producing exactly it
// ---------------------------------------------------------------------------

describe("every CapabilityDenyCode is individually reachable", () => {
  function setup() {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const grandchildId = GovIdentity.generate();
    const c = clock(0);
    const issuer = new CapabilityIssuer(rootId, { now: c.now, nonceGen: counter("n") });
    return { rootId, holderId, grandchildId, c, issuer };
  }

  it("malformed", () => {
    const { rootId } = setup();
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([{ schema: "hades.gov.capability.v1" } as unknown as GovCapabilityToken], { subject: "a", action: "x", resource: "y", at: 0 });
    expect(d.code).toBe("malformed" satisfies CapabilityDenyCode);
  });

  it("schema-mismatch", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const bad = { ...token, schema: "hades.gov.capability.v2" } as unknown as GovCapabilityToken;
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([bad], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("schema-mismatch" satisfies CapabilityDenyCode);
  });

  it("signature-invalid", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const bad = { ...token, subject: "agent:swapped" };
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([bad], { subject: "agent:swapped", action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("signature-invalid" satisfies CapabilityDenyCode);
  });

  it("untrusted-issuer", () => {
    const { holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [GovIdentity.generate().publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("untrusted-issuer" satisfies CapabilityDenyCode);
  });

  it("expired", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 100 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 100 });
    expect(d.code).toBe("expired" satisfies CapabilityDenyCode);
  });

  it("not-yet-valid", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 1000 });
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 999 });
    expect(d.code).toBe("not-yet-valid" satisfies CapabilityDenyCode);
  });

  it("subject-mismatch", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: "agent:not-the-holder", action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("subject-mismatch" satisfies CapabilityDenyCode);
  });

  it("audience-mismatch", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), audience: "desktop", ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, args: { audience: "cli" } });
    expect(d.code).toBe("audience-mismatch" satisfies CapabilityDenyCode);
  });

  it("no-matching-grant", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:unrelated_thing", at: 0 });
    expect(d.code).toBe("no-matching-grant" satisfies CapabilityDenyCode);
  });

  it("action-not-granted", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "delete", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("action-not-granted" satisfies CapabilityDenyCode);
  });

  it("caveat-failed", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), caveats: [{ kind: "arg-equals", arg: "user", value: "alice" }], ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, args: { user: "bob" } });
    expect(d.code).toBe("caveat-failed" satisfies CapabilityDenyCode);
    expect(d.failedCaveat).toEqual({ kind: "arg-equals", arg: "user", value: "alice" });
  });

  it("caveat-failed for an UNRECOGNIZED caveat kind — deny-by-default, never a silent pass", () => {
    const { rootId, holderId, issuer } = setup();
    const exotic = { kind: "some-future-caveat-kind", threshold: 42 } as unknown as CapabilityCaveat;
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), caveats: [exotic], ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("caveat-failed" satisfies CapabilityDenyCode);
  });

  it("replayed", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const guard = new MemoryReplayGuard();
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], replayGuard: guard });
    const req: CapabilityRequest = { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0, nonce: "x" };
    enforcer.authorize([token], req);
    const d = enforcer.authorize([token], req);
    expect(d.code).toBe("replayed" satisfies CapabilityDenyCode);
  });

  it("revoked", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], revokedTokenIds: new Set([token.tokenId]) });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("revoked" satisfies CapabilityDenyCode);
  });

  it("chain-broken (child signed by a key unrelated to the parent's subject)", () => {
    const { rootId, holderId, grandchildId, issuer, c } = setup();
    const parent = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const stranger = GovIdentity.generate();
    // A legitimately-signed token by an unrelated identity, wired up to
    // look like a continuation of `parent`'s chain but signed by the wrong key.
    const preBody = {
      schema: "hades.gov.capability.v1" as const,
      issuer: stranger.agentId(),
      issuerPublicKey: stranger.publicKeyHex(),
      subject: grandchildId.agentId(),
      grants: baseGrants(),
      caveats: [] as CapabilityCaveat[],
      issuedAt: 0,
      expiresAt: parent.expiresAt,
      depth: 1,
      parentTokenId: parent.tokenId,
      nonce: "n-stranger",
      signerPublicKey: stranger.publicKeyHex(),
    };
    const tokenId = `cap:${govDigest(preBody)}`;
    const child = resign(stranger, { ...preBody, tokenId });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([parent, child], { subject: grandchildId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("chain-broken" satisfies CapabilityDenyCode);
  });

  it("attenuation-violation", () => {
    const { rootId, holderId, grandchildId, issuer } = setup();
    const parent = issuer.mint({ subject: holderId.agentId(), grants: [{ resource: "tool:http_request", actions: ["invoke"] }], ttlMs: 60_000 });
    const preBody = {
      schema: "hades.gov.capability.v1" as const,
      issuer: holderId.agentId(),
      issuerPublicKey: holderId.publicKeyHex(),
      subject: grandchildId.agentId(),
      grants: [{ resource: "tool:http_request", actions: ["invoke", "delete"] }], // widened
      caveats: [] as CapabilityCaveat[],
      issuedAt: 0,
      expiresAt: parent.expiresAt,
      depth: 1,
      parentTokenId: parent.tokenId,
      nonce: "n-widen",
      signerPublicKey: holderId.publicKeyHex(),
    };
    const tokenId = `cap:${govDigest(preBody)}`;
    const child = resign(holderId, { ...preBody, tokenId });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()] });
    const d = enforcer.authorize([parent, child], { subject: grandchildId.agentId(), action: "delete", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("attenuation-violation" satisfies CapabilityDenyCode);
  });

  it("depth-exceeded", () => {
    const { rootId, holderId, issuer, c } = setup();
    const parent = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 60_000 });
    const child = issuer.attenuate(parent, holderId, {});
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], maxDepth: 0 });
    const d = enforcer.authorize([parent, child], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("depth-exceeded" satisfies CapabilityDenyCode);
  });

  it("use-limit-exceeded", () => {
    const { rootId, holderId, issuer } = setup();
    const token = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), caveats: [{ kind: "max-uses", uses: 1 }], ttlMs: 60_000 });
    const guard = new MemoryReplayGuard();
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], useCounter: guard });
    enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    const d = enforcer.authorize([token], { subject: holderId.agentId(), action: "invoke", resource: "tool:http_request", at: 0 });
    expect(d.code).toBe("use-limit-exceeded" satisfies CapabilityDenyCode);
  });
});

// ---------------------------------------------------------------------------
// (8) Legacy adapter round trip against the REAL CapabilityChecker
// ---------------------------------------------------------------------------

describe("toLegacyCapabilityToken — round trip against the real CapabilityChecker", () => {
  it("a valid, unexpired gov token adapts into a legacy token the real checker authorizes", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const govToken = issuer.mint({
      subject: holderId.agentId(),
      grants: [{ resource: "tool:http_request", actions: ["invoke", "cancel"] }],
      ttlMs: 60_000,
    });

    const legacy = toLegacyCapabilityToken(govToken);
    expect(legacy.tokenId).toBe(govToken.tokenId);
    expect(legacy.agentId).toBe(holderId.agentId());
    expect(legacy.issuedAt).toBe(govToken.issuedAt);
    expect(legacy.expiresAt).toBe(govToken.expiresAt);

    const checker = new CapabilityChecker({ now: () => 1000 });
    expect(checker.isValid(legacy)).toBe(true);
    expect(checker.authorize(legacy, "tool:http_request#invoke")).toBe(true);
    expect(checker.authorize(legacy, "tool:http_request#cancel")).toBe(true);
    expect(checker.authorize(legacy, "tool:http_request#delete")).toBe(false);
    expect(checker.authorize(legacy, "fs:read#anything")).toBe(false);
    expect(() => checker.assert(legacy, "tool:http_request#invoke")).not.toThrow();
    expect(() => checker.assert(legacy, "tool:http_request#delete")).toThrow();
  });

  it("an expired gov token adapts into a legacy token the real checker also treats as invalid", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const govToken = issuer.mint({ subject: holderId.agentId(), grants: baseGrants(), ttlMs: 1000 });
    const legacy = toLegacyCapabilityToken(govToken);

    const checker = new CapabilityChecker({ now: () => 5000 }); // well past expiresAt=1000
    expect(checker.isValid(legacy)).toBe(false);
    expect(checker.authorize(legacy, "tool:http_request#invoke")).toBe(false);
  });

  it("a `*` wildcard-actions grant adapts to the legacy wildcard capability", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const issuer = new CapabilityIssuer(rootId, { now: () => 0 });
    const govToken = issuer.mint({ subject: holderId.agentId(), grants: [{ resource: "*", actions: ["*"] }], ttlMs: 60_000 });
    const legacy = toLegacyCapabilityToken(govToken);
    expect(legacy.capabilities).toContain("*");
    const checker = new CapabilityChecker({ now: () => 0 });
    expect(checker.authorize(legacy, "literally:anything")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end delegation chain
// ---------------------------------------------------------------------------

describe("end-to-end delegation chain", () => {
  it("root -> holder -> delegate, each link narrower, authorizes correctly at the leaf and denies what the leaf doesn't have", () => {
    const rootId = GovIdentity.generate();
    const holderId = GovIdentity.generate();
    const delegateId = GovIdentity.generate();
    const c = clock(0);
    const issuer = new CapabilityIssuer(rootId, { now: c.now, nonceGen: counter("n") });

    const rootToken = issuer.mint({
      subject: holderId.agentId(),
      grants: [
        { resource: "fs:read:/data/**", actions: ["read", "list"] },
        { resource: "tool:http_request", actions: ["invoke"] },
      ],
      caveats: [{ kind: "max-uses", uses: 10 }],
      ttlMs: 100_000,
    });

    const midToken = issuer.attenuate(rootToken, holderId, {
      subject: delegateId.agentId(),
      grants: [{ resource: "fs:read:/data/reports/*", actions: ["read"] }],
      caveats: [{ kind: "max-uses", uses: 4 }],
    });
    expect(midToken.depth).toBe(1);
    expect(isAttenuation(rootToken, midToken).ok).toBe(true);

    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [rootId.publicKeyHex()], now: c.now, useCounter: new MemoryReplayGuard() });

    const allowed = enforcer.authorize([rootToken, midToken], {
      subject: delegateId.agentId(),
      action: "read",
      resource: "fs:read:/data/reports/q1",
      at: 0,
    });
    expect(allowed.allow).toBe(true);

    // Not covered by the NARROWED mid-level grant (root would have allowed
    // it, but the intersection down the chain must deny).
    const deniedByIntersection = enforcer.authorize([rootToken, midToken], {
      subject: delegateId.agentId(),
      action: "read",
      resource: "fs:read:/data/other",
      at: 0,
    });
    expect(deniedByIntersection.allow).toBe(false);
    expect(deniedByIntersection.code).toBe("no-matching-grant");

    // tool:http_request was never re-granted at the mid level -> also denied via intersection.
    const deniedTool = enforcer.authorize([rootToken, midToken], {
      subject: delegateId.agentId(),
      action: "invoke",
      resource: "tool:http_request",
      at: 0,
    });
    expect(deniedTool.allow).toBe(false);
    expect(deniedTool.code).toBe("no-matching-grant");
  });
});


// ---------------------------------------------------------------------------
// Overlapping grants — a token may legitimately carry several grants whose
// resource patterns overlap. Enforcement must consider ALL of them, not just
// the first that happens to match the resource.
// ---------------------------------------------------------------------------

describe("CapabilityEnforcer — overlapping grants within one token", () => {
  function stack(): { identity: GovIdentity; issuer: CapabilityIssuer; enforcer: CapabilityEnforcer } {
    const identity = GovIdentity.generate();
    return {
      identity,
      issuer: new CapabilityIssuer(identity, { now: () => 1_000 }),
      enforcer: new CapabilityEnforcer({ trustedIssuerPublicKeys: [identity.publicKeyHex()], now: () => 1_000 }),
    };
  }

  it("authorizes an action granted by a LATER grant even when an earlier grant also matches the resource", () => {
    const { identity, issuer, enforcer } = stack();
    // Broad read grant first, narrow write grant second — both match
    // "fs:/tmp/scratch/notes.txt". Only the second carries fs:write.
    const token = issuer.mint({
      subject: identity.agentId(),
      grants: [
        { resource: "fs:**", actions: ["fs:read"] },
        { resource: "fs:/tmp/scratch/**", actions: ["fs:write"] },
      ],
    });
    const decision = enforcer.authorize([token], {
      subject: identity.agentId(),
      action: "fs:write",
      resource: "fs:/tmp/scratch/notes.txt",
      at: 1_001,
    });
    expect(decision.allow).toBe(true);
    expect(decision.matchedGrant?.resource).toBe("fs:/tmp/scratch/**");
  });

  it("still denies with action-not-granted when NO overlapping grant carries the action", () => {
    const { identity, issuer, enforcer } = stack();
    const token = issuer.mint({
      subject: identity.agentId(),
      grants: [
        { resource: "fs:**", actions: ["fs:read"] },
        { resource: "fs:/tmp/scratch/**", actions: ["fs:read"] },
      ],
    });
    const decision = enforcer.authorize([token], {
      subject: identity.agentId(),
      action: "fs:write",
      resource: "fs:/tmp/scratch/notes.txt",
      at: 1_001,
    });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("action-not-granted");
  });

  it("reserves no-matching-grant for a resource no grant covers at all (the two codes stay distinct)", () => {
    const { identity, issuer, enforcer } = stack();
    const token = issuer.mint({
      subject: identity.agentId(),
      grants: [
        { resource: "fs:**", actions: ["fs:read"] },
        { resource: "fs:/tmp/scratch/**", actions: ["fs:write"] },
      ],
    });
    const decision = enforcer.authorize([token], {
      subject: identity.agentId(),
      action: "fs:write",
      resource: "net:example.com",
      at: 1_001,
    });
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("no-matching-grant");
  });

  it("the overlap resolution is order-independent (narrow-first grants behave identically)", () => {
    const { identity, issuer, enforcer } = stack();
    const token = issuer.mint({
      subject: identity.agentId(),
      grants: [
        { resource: "fs:/tmp/scratch/**", actions: ["fs:write"] },
        { resource: "fs:**", actions: ["fs:read"] },
      ],
    });
    const write = enforcer.authorize([token], { subject: identity.agentId(), action: "fs:write", resource: "fs:/tmp/scratch/a", at: 1_001 });
    const read = enforcer.authorize([token], { subject: identity.agentId(), action: "fs:read", resource: "fs:/etc/hosts", at: 1_001 });
    expect(write.allow).toBe(true);
    expect(read.allow).toBe(true);
  });
});
