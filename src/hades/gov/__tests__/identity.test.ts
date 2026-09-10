import { describe, expect, it } from "vitest";

import {
  GovIdentity,
  agentIdFromPublicKey,
  govCanonicalize,
  govDigest,
  signGov,
  signRotation,
  verifyGovSignature,
  verifyIdentityChain,
  verifyRotationHistory,
  type IdentityFailureCode,
  type SignedIdentityDoc,
  type SignedRotationRecord,
} from "../identity";

// ---------------------------------------------------------------------------
// Deterministic RNG helper for reproducible key generation in tests.
// ---------------------------------------------------------------------------

function seededRng(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      // xorshift32
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

function flipBit(hex: string, byteIndex: number): string {
  const bytes = hex.match(/.{1,2}/g)!;
  const idx = byteIndex % bytes.length;
  const val = parseInt(bytes[idx], 16) ^ 0x01;
  bytes[idx] = val.toString(16).padStart(2, "0");
  return bytes.join("");
}

// ---------------------------------------------------------------------------
// govCanonicalize
// ---------------------------------------------------------------------------

describe("govCanonicalize", () => {
  it("sorts object keys lexicographically at every depth regardless of insertion order", () => {
    const a = { b: 1, a: { z: 1, y: 2, x: { c: 3, b: 4, a: 5 } }, c: [3, 2, 1] };
    const b = { c: [3, 2, 1], a: { x: { a: 5, c: 3, b: 4 }, y: 2, z: 1 }, b: 1 };
    expect(govCanonicalize(a)).toBe(govCanonicalize(b));
  });

  it("preserves array element order even though it sorts object keys", () => {
    expect(govCanonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(govCanonicalize([1, 2, 3])).not.toBe(govCanonicalize([3, 2, 1]));
  });

  it("is stable across many shuffles of the same object (same key->value mapping, different insertion order)", () => {
    const fixedValues: Record<string, number> = { zeta: 26, alpha: 1, gamma: 3, beta: 2, delta: 4, epsilon: 5 };
    const keys = Object.keys(fixedValues);
    const canonical = new Set<string>();
    for (let trial = 0; trial < 20; trial++) {
      const shuffled = [...keys].sort(() => Math.random() - 0.5);
      const obj: Record<string, number> = {};
      for (const k of shuffled) obj[k] = fixedValues[k];
      canonical.add(govCanonicalize(obj));
    }
    expect(canonical.size).toBe(1);
  });

  it("handles unicode keys and values", () => {
    const value = { "éclair": "café", "日本": "東京", emoji: "😀" };
    const out = govCanonicalize(value);
    expect(JSON.parse(out)).toEqual(value);
    // Round-trips identically on a second canonicalization (stable output).
    expect(govCanonicalize(JSON.parse(out))).toBe(out);
  });

  it("sorts numeric-string keys lexicographically, not numerically", () => {
    const out = govCanonicalize({ "10": "ten", "2": "two", "1": "one" });
    // lexicographic: "1" < "10" < "2"
    expect(out).toBe('{"1":"one","10":"ten","2":"two"}');
  });

  it("renders empty objects and arrays correctly", () => {
    expect(govCanonicalize({})).toBe("{}");
    expect(govCanonicalize([])).toBe("[]");
    expect(govCanonicalize({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  it("handles a normal key literally named 'constructor' without incident", () => {
    const out = govCanonicalize({ constructor: "not-a-function", a: 1 });
    expect(out).toBe('{"a":1,"constructor":"not-a-function"}');
  });

  it("rejects a '__proto__' own key at the top level, naming the path", () => {
    const payload: unknown = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
    expect(() => govCanonicalize(payload)).toThrow(TypeError);
    try {
      govCanonicalize(payload);
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).toContain("__proto__");
      expect(String((err as Error).message)).toContain("$");
    }
  });

  it("rejects a nested '__proto__' own key, naming the nested path", () => {
    const payload: unknown = JSON.parse('{"a":{"b":{"__proto__":1}}}');
    try {
      govCanonicalize(payload);
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).toContain("$.a.b");
    }
  });

  it("rejects undefined values, naming the exact path", () => {
    try {
      govCanonicalize({ a: [1, undefined, 3] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect(String((err as Error).message)).toContain("$.a[1]");
    }
  });

  it("rejects function and symbol values", () => {
    expect(() => govCanonicalize({ a: () => 1 })).toThrow(TypeError);
    expect(() => govCanonicalize({ a: Symbol("x") })).toThrow(TypeError);
  });

  it("rejects bigint values", () => {
    expect(() => govCanonicalize({ a: 10n })).toThrow(TypeError);
  });

  it("rejects NaN and +/-Infinity", () => {
    expect(() => govCanonicalize({ a: NaN })).toThrow(TypeError);
    expect(() => govCanonicalize({ a: Infinity })).toThrow(TypeError);
    expect(() => govCanonicalize({ a: -Infinity })).toThrow(TypeError);
  });

  it("rejects cycles instead of looping forever", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => govCanonicalize(obj)).toThrow(TypeError);
  });

  it("rejects a cycle through an array", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => govCanonicalize(arr)).toThrow(TypeError);
  });

  it("does not confuse a repeated (non-circular) reference with a cycle", () => {
    const shared = { x: 1 };
    const out = govCanonicalize({ a: shared, b: shared });
    expect(out).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("produces identical bytes for structurally equal values and different bytes for different ones (corpus, no collisions)", () => {
    const corpus: unknown[] = [
      { a: 1, b: 2 },
      { a: 1, b: 3 },
      { a: 1 },
      { b: 2, a: 1 },
      [1, 2],
      [2, 1],
      "1",
      1,
      true,
      false,
      null,
      { nested: { deep: [1, { x: "y" }] } },
      { nested: { deep: [1, { x: "z" }] } },
    ];
    const canon = corpus.map((v) => govCanonicalize(v));
    // equal-structure pair: index 0 and index 3 differ only in key order.
    expect(canon[0]).toBe(canon[3]);
    // every other pair (excluding the known-equal pair) must be distinct.
    const seen = new Map<string, number>();
    canon.forEach((c, i) => {
      if (seen.has(c)) {
        const other = seen.get(c)!;
        const isKnownEqualPair = (other === 0 && i === 3) || (other === 3 && i === 0);
        expect(isKnownEqualPair).toBe(true);
      } else {
        seen.set(c, i);
      }
    });
  });
});

describe("govDigest", () => {
  it("equals sha256Hex(govCanonicalize(value)) and changes with any field", () => {
    const a = govDigest({ a: 1, b: 2 });
    const b = govDigest({ a: 1, b: 2 });
    const c = govDigest({ a: 1, b: 3 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to key order", () => {
    expect(govDigest({ x: 1, y: 2 })).toBe(govDigest({ y: 2, x: 1 }));
  });
});

// ---------------------------------------------------------------------------
// signGov / verifyGovSignature — real ed25519 round trips
// ---------------------------------------------------------------------------

describe("signGov / verifyGovSignature", () => {
  it("round-trips: generate -> sign -> verify true", () => {
    const id = GovIdentity.generate(seededRng(1));
    const canonical = govCanonicalize({ hello: "world", n: 42 });
    const sig = signGov(id.privateKeyHex(), canonical);
    expect(verifyGovSignature(id.publicKeyHex(), canonical, sig)).toBe(true);
  });

  it("fails when one bit of the message is flipped", () => {
    const id = GovIdentity.generate(seededRng(2));
    const canonical = govCanonicalize({ hello: "world" });
    const sig = signGov(id.privateKeyHex(), canonical);
    const tampered = canonical.slice(0, -1) + (canonical.endsWith("}") ? " }" : "x");
    expect(verifyGovSignature(id.publicKeyHex(), tampered, sig)).toBe(false);
  });

  it("fails when one bit of the signature is flipped", () => {
    const id = GovIdentity.generate(seededRng(3));
    const canonical = govCanonicalize({ hello: "world" });
    const sig = signGov(id.privateKeyHex(), canonical);
    const tamperedSig = flipBit(sig, 0);
    expect(verifyGovSignature(id.publicKeyHex(), canonical, tamperedSig)).toBe(false);
  });

  it("fails when one bit of the public key is flipped", () => {
    const id = GovIdentity.generate(seededRng(4));
    const canonical = govCanonicalize({ hello: "world" });
    const sig = signGov(id.privateKeyHex(), canonical);
    const tamperedPub = flipBit(id.publicKeyHex(), 0);
    expect(verifyGovSignature(tamperedPub, canonical, sig)).toBe(false);
  });

  it("fails for a signature produced by a different key", () => {
    const idA = GovIdentity.generate(seededRng(5));
    const idB = GovIdentity.generate(seededRng(6));
    const canonical = govCanonicalize({ hello: "world" });
    const sigFromB = signGov(idB.privateKeyHex(), canonical);
    expect(verifyGovSignature(idA.publicKeyHex(), canonical, sigFromB)).toBe(false);
  });

  it("returns false (never throws) for malformed hex inputs", () => {
    const id = GovIdentity.generate(seededRng(7));
    const canonical = govCanonicalize({ hello: "world" });
    const sig = signGov(id.privateKeyHex(), canonical);

    // odd-length hex
    expect(verifyGovSignature(id.publicKeyHex().slice(0, -1), canonical, sig)).toBe(false);
    // non-hex characters
    expect(verifyGovSignature("zz".repeat(32), canonical, sig)).toBe(false);
    // empty strings
    expect(verifyGovSignature("", canonical, sig)).toBe(false);
    expect(verifyGovSignature(id.publicKeyHex(), canonical, "")).toBe(false);
    // 63-byte and 65-byte public keys
    expect(verifyGovSignature(id.publicKeyHex().slice(2), canonical, sig)).toBe(false); // 31 bytes
    expect(verifyGovSignature(id.publicKeyHex() + "ab", canonical, sig)).toBe(false); // 33 bytes
    // wrong-length signature
    expect(verifyGovSignature(id.publicKeyHex(), canonical, sig.slice(2))).toBe(false);
    expect(verifyGovSignature(id.publicKeyHex(), canonical, sig + "ab")).toBe(false);
  });

  it("never throws even given non-hex garbage for every argument", () => {
    expect(() => verifyGovSignature("not-hex!!", "x", "also not hex")).not.toThrow();
    expect(verifyGovSignature("not-hex!!", "x", "also not hex")).toBe(false);
  });
});

describe("agentIdFromPublicKey", () => {
  it("matches the exact locked format", async () => {
    const id = GovIdentity.generate(seededRng(8));
    const { createHash } = await import("node:crypto");
    const expected = "agent:" + createHash("sha256").update(id.publicKeyHex(), "utf8").digest("hex").slice(0, 32);
    expect(id.agentId()).toBe(expected);
    expect(agentIdFromPublicKey(id.publicKeyHex())).toBe(expected);
  });

  it("different public keys yield different agent ids", () => {
    const a = GovIdentity.generate(seededRng(9));
    const b = GovIdentity.generate(seededRng(10));
    expect(a.agentId()).not.toBe(b.agentId());
  });
});

// ---------------------------------------------------------------------------
// GovIdentity
// ---------------------------------------------------------------------------

describe("GovIdentity", () => {
  it("generate() with an injected rng is deterministic", () => {
    const a = GovIdentity.generate(seededRng(42));
    const b = GovIdentity.generate(seededRng(42));
    expect(a.privateKeyHex()).toBe(b.privateKeyHex());
    expect(a.publicKeyHex()).toBe(b.publicKeyHex());
  });

  it("fromPrivateKey round-trips through privateKeyHex/publicKeyHex/agentId", () => {
    const a = GovIdentity.generate(seededRng(11));
    const b = GovIdentity.fromPrivateKey(a.privateKeyHex());
    expect(b.publicKeyHex()).toBe(a.publicKeyHex());
    expect(b.agentId()).toBe(a.agentId());
  });

  it("fromPrivateKey throws on malformed hex", () => {
    expect(() => GovIdentity.fromPrivateKey("not-hex")).toThrow();
    expect(() => GovIdentity.fromPrivateKey("ab")).toThrow(); // too short
  });

  it("sign()/signValue() produce signatures verifiable via verifyGovSignature", () => {
    const id = GovIdentity.generate(seededRng(12));
    const sig1 = id.sign(govCanonicalize({ x: 1 }));
    expect(verifyGovSignature(id.publicKeyHex(), govCanonicalize({ x: 1 }), sig1)).toBe(true);

    const sig2 = id.signValue({ y: 2 });
    expect(verifyGovSignature(id.publicKeyHex(), govCanonicalize({ y: 2 }), sig2)).toBe(true);
  });

  it("issueSelf() produces a self-signed root document with the correct fields", () => {
    const id = GovIdentity.generate(seededRng(13));
    const inputRoles = ["reader", "writer"];
    const signed = id.issueSelf({ roles: inputRoles, displayName: "Test Agent", issuedAt: 1000, notAfter: 2000 });

    expect(signed.doc.schema).toBe("hades.gov.identity.v1");
    expect(signed.doc.publicKey).toBe(id.publicKeyHex());
    expect(signed.doc.agentId).toBe(id.agentId());
    expect(signed.doc.issuer).toBe(id.agentId());
    expect(signed.doc.roles).toEqual(["reader", "writer"]);
    expect(signed.doc.notBefore).toBe(1000);
    expect(signed.doc.notAfter).toBe(2000);
    expect(signed.doc.parentPublicKey).toBeUndefined();
    expect(signed.signerPublicKey).toBe(id.publicKeyHex());
    expect(verifyGovSignature(signed.signerPublicKey, govCanonicalize(signed.doc), signed.signature)).toBe(true);

    // roles array is defensively copied, not aliased.
    inputRoles.push("admin");
    expect(signed.doc.roles).toEqual(["reader", "writer"]);
  });

  it("issueSelf() defaults notBefore to issuedAt when omitted", () => {
    const id = GovIdentity.generate(seededRng(14));
    const signed = id.issueSelf({ roles: [], issuedAt: 5000 });
    expect(signed.doc.notBefore).toBe(5000);
    expect(signed.doc.notAfter).toBeUndefined();
  });

  it("delegate() produces a document signed by the PARENT's key, not the child's", () => {
    const parent = GovIdentity.generate(seededRng(15));
    const child = GovIdentity.generate(seededRng(16));
    const signed = parent.delegate({ childPublicKey: child.publicKeyHex(), roles: ["reader"], issuedAt: 1000 });

    expect(signed.doc.publicKey).toBe(child.publicKeyHex());
    expect(signed.doc.agentId).toBe(child.agentId());
    expect(signed.doc.issuer).toBe(parent.agentId());
    expect(signed.doc.parentPublicKey).toBe(parent.publicKeyHex());
    expect(signed.signerPublicKey).toBe(parent.publicKeyHex());
    expect(verifyGovSignature(parent.publicKeyHex(), govCanonicalize(signed.doc), signed.signature)).toBe(true);
    // The child's own key must NOT verify this signature (parent signed it).
    expect(verifyGovSignature(child.publicKeyHex(), govCanonicalize(signed.doc), signed.signature)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyIdentityChain — hostile path validation
// ---------------------------------------------------------------------------

describe("verifyIdentityChain", () => {
  const NOW = 10_000;

  function rootIdentity(seed: number): GovIdentity {
    return GovIdentity.generate(seededRng(seed));
  }

  it("accepts a valid root-only chain", () => {
    const root = rootIdentity(100);
    const rootDoc = root.issueSelf({ roles: ["admin"], issuedAt: NOW - 100 });
    const result = verifyIdentityChain([rootDoc], { trustRootPublicKey: root.publicKeyHex(), now: NOW });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.agentId).toBe(root.agentId());
    expect(result.publicKey).toBe(root.publicKeyHex());
    expect(result.effectiveRoles).toEqual(["admin"]);
    expect(result.depth).toBe(0);
  });

  it("accepts a valid multi-hop delegate chain with a proper role subset at each hop", () => {
    const root = rootIdentity(101);
    const mid = rootIdentity(102);
    const leaf = rootIdentity(103);

    const rootDoc = root.issueSelf({ roles: ["admin", "reader", "writer"], issuedAt: NOW - 300 });
    const midDoc = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader", "writer"], issuedAt: NOW - 200 });
    const leafDoc = mid.delegate({ childPublicKey: leaf.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 100 });

    const result = verifyIdentityChain([rootDoc, midDoc, leafDoc], { trustRootPublicKey: root.publicKeyHex(), now: NOW });
    expect(result.ok).toBe(true);
    expect(result.effectiveRoles).toEqual(["reader"]);
    expect(result.depth).toBe(2);
    expect(result.agentId).toBe(leaf.agentId());
  });

  function expectExactlyOneFailure(chain: readonly SignedIdentityDoc[], opts: Parameters<typeof verifyIdentityChain>[1], code: IdentityFailureCode): void {
    const result = verifyIdentityChain(chain, opts);
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
    expect(result.failures[0].code).toBe(code);
  }

  it("malformed: an empty chain", () => {
    expectExactlyOneFailure([], { trustRootPublicKey: "ab".repeat(32), now: NOW }, "malformed");
  });

  it("malformed: a chain entry that is not a well-formed SignedIdentityDoc", () => {
    const garbage = [{ not: "a doc" }] as unknown as SignedIdentityDoc[];
    expectExactlyOneFailure(garbage, { trustRootPublicKey: "ab".repeat(32), now: NOW }, "malformed");
  });

  it("schema-mismatch: doc.schema is wrong", () => {
    const root = rootIdentity(110);
    const rootDoc = root.issueSelf({ roles: [], issuedAt: NOW - 10 });
    const tampered: SignedIdentityDoc = { ...rootDoc, doc: { ...rootDoc.doc, schema: "wrong.schema.v1" as unknown as "hades.gov.identity.v1" } };
    expectExactlyOneFailure([tampered], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "schema-mismatch");
  });

  it("agent-id-mismatch: doc.agentId does not equal agentIdFromPublicKey(doc.publicKey)", () => {
    const root = rootIdentity(111);
    const rootDoc = root.issueSelf({ roles: [], issuedAt: NOW - 10 });
    const tampered: SignedIdentityDoc = { ...rootDoc, doc: { ...rootDoc.doc, agentId: "agent:0000000000000000000000000000000" } };
    expectExactlyOneFailure([tampered], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "agent-id-mismatch");
  });

  it("unknown-root: chain[0].publicKey does not match trustRootPublicKey", () => {
    const root = rootIdentity(112);
    const impostorTrustRoot = rootIdentity(113);
    const rootDoc = root.issueSelf({ roles: [], issuedAt: NOW - 10 });
    expectExactlyOneFailure([rootDoc], { trustRootPublicKey: impostorTrustRoot.publicKeyHex(), now: NOW }, "unknown-root");
  });

  it("signature-invalid: an attacker re-signs a delegate doc with their OWN key", () => {
    const root = rootIdentity(114);
    const mid = rootIdentity(115);
    const attacker = rootIdentity(116);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    const legitDelegate = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 50 });
    // Attacker keeps the doc (so agentId/publicKey/parentPublicKey/issuer all
    // still line up with the real parent) but swaps in their own signature —
    // the classic forged-signature attack.
    const forged: SignedIdentityDoc = { ...legitDelegate, signature: attacker.sign(govCanonicalize(legitDelegate.doc)) };
    expectExactlyOneFailure([rootDoc, forged], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "signature-invalid");
  });

  it("role-escalation: a delegate claims a role its parent lacks", () => {
    const root = rootIdentity(117);
    const mid = rootIdentity(118);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    const escalated = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader", "admin"], issuedAt: NOW - 50 });
    expectExactlyOneFailure([rootDoc, escalated], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "role-escalation");
  });

  it("depth-exceeded: a chain longer than maxDepth", () => {
    const root = rootIdentity(119);
    const mid = rootIdentity(120);
    const leaf = rootIdentity(121);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    const midDoc = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 60 });
    const leafDoc = mid.delegate({ childPublicKey: leaf.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 20 });
    expectExactlyOneFailure([rootDoc, midDoc, leafDoc], { trustRootPublicKey: root.publicKeyHex(), now: NOW, maxDepth: 1 }, "depth-exceeded");
  });

  it("expired: an expired intermediate invalidates everything below it", () => {
    const root = rootIdentity(122);
    const mid = rootIdentity(123);
    const leaf = rootIdentity(124);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 500 });
    const midDoc = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 400, notAfter: NOW - 300 });
    const leafDoc = mid.delegate({ childPublicKey: leaf.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 200 });
    expectExactlyOneFailure([rootDoc, midDoc, leafDoc], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "expired");
  });

  it("not-yet-valid: notBefore is in the future", () => {
    const root = rootIdentity(125);
    const rootDoc = root.issueSelf({ roles: [], issuedAt: NOW - 10, notBefore: NOW + 1000 });
    expectExactlyOneFailure([rootDoc], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "not-yet-valid");
  });

  it("revoked: a revoked key anywhere in the path fails, even mid-chain", () => {
    const root = rootIdentity(126);
    const mid = rootIdentity(127);
    const leaf = rootIdentity(128);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    const midDoc = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 60 });
    const leafDoc = mid.delegate({ childPublicKey: leaf.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 20 });
    expectExactlyOneFailure(
      [rootDoc, midDoc, leafDoc],
      { trustRootPublicKey: root.publicKeyHex(), now: NOW, revokedPublicKeys: new Set([mid.publicKeyHex()]) },
      "revoked",
    );
  });

  it("broken-link: a delegate's parentPublicKey/issuer does not match the previous document", () => {
    const root = rootIdentity(129);
    const impostor = rootIdentity(130);
    const mid = rootIdentity(131);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    // Signed by `impostor` but the doc claims to descend from `root` — the
    // signerPublicKey therefore does not match the previous document's key.
    const brokenDelegate = impostor.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 50 });
    expectExactlyOneFailure([rootDoc, brokenDelegate], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "broken-link");
  });

  it("broken-link: a chain that loops back to an earlier key", () => {
    const root = rootIdentity(132);
    const mid = rootIdentity(133);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    const midDoc = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 60 });
    // mid delegates back to root's OWN public key — a loop.
    const loopDoc = mid.delegate({ childPublicKey: root.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 20 });
    expectExactlyOneFailure([rootDoc, midDoc, loopDoc], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "broken-link");
  });

  it("self-signed-non-root: a delegate document signs itself instead of being signed by its parent", () => {
    const root = rootIdentity(134);
    const mid = rootIdentity(135);
    const rootDoc = root.issueSelf({ roles: ["reader"], issuedAt: NOW - 100 });
    const legit = root.delegate({ childPublicKey: mid.publicKeyHex(), roles: ["reader"], issuedAt: NOW - 50 });
    // mid re-signs its own doc with its own key, posing as a self-issued root.
    const selfSigned: SignedIdentityDoc = {
      doc: legit.doc,
      signature: mid.sign(govCanonicalize(legit.doc)),
      signerPublicKey: mid.publicKeyHex(),
    };
    expectExactlyOneFailure([rootDoc, selfSigned], { trustRootPublicKey: root.publicKeyHex(), now: NOW }, "self-signed-non-root");
  });
});

// ---------------------------------------------------------------------------
// Rotation — continuity
// ---------------------------------------------------------------------------

describe("signRotation / verifyRotationHistory", () => {
  it("signs the same canonical record with both the old and new key", () => {
    const oldKey = GovIdentity.generate(seededRng(200));
    const newKey = GovIdentity.generate(seededRng(201));
    const signed = signRotation(oldKey, newKey, { schema: "hades.gov.rotation.v1", at: 1000, reason: "scheduled", sequence: 0 });

    expect(signed.record.oldPublicKey).toBe(oldKey.publicKeyHex());
    expect(signed.record.newPublicKey).toBe(newKey.publicKeyHex());
    const canonical = govCanonicalize(signed.record);
    expect(verifyGovSignature(oldKey.publicKeyHex(), canonical, signed.oldKeySignature)).toBe(true);
    expect(verifyGovSignature(newKey.publicKeyHex(), canonical, signed.newKeySignature)).toBe(true);
    // Cross-checks must fail: the old signature must not verify under the new key and vice versa.
    expect(verifyGovSignature(newKey.publicKeyHex(), canonical, signed.oldKeySignature)).toBe(false);
    expect(verifyGovSignature(oldKey.publicKeyHex(), canonical, signed.newKeySignature)).toBe(false);
  });

  it("verifies an empty history as trivially ok at the genesis key", () => {
    const genesis = GovIdentity.generate(seededRng(202));
    const result = verifyRotationHistory([], { genesisPublicKey: genesis.publicKeyHex() });
    expect(result.ok).toBe(true);
    expect(result.currentPublicKey).toBe(genesis.publicKeyHex());
  });

  it("verifies an N-step rotation history to the current key", () => {
    const keys = [200, 300, 400, 500].map((s) => GovIdentity.generate(seededRng(s)));
    const records: SignedRotationRecord[] = [];
    for (let i = 0; i < keys.length - 1; i++) {
      records.push(signRotation(keys[i], keys[i + 1], { schema: "hades.gov.rotation.v1", at: 1000 + i, reason: `step-${i}`, sequence: i }));
    }
    const result = verifyRotationHistory(records, { genesisPublicKey: keys[0].publicKeyHex() });
    expect(result.ok).toBe(true);
    expect(result.currentPublicKey).toBe(keys[keys.length - 1].publicKeyHex());
    expect(result.failures).toEqual([]);
  });

  it("fails when a record is signed by only one of the two keys", () => {
    const oldKey = GovIdentity.generate(seededRng(210));
    const newKey = GovIdentity.generate(seededRng(211));
    const attacker = GovIdentity.generate(seededRng(212));
    const signed = signRotation(oldKey, newKey, { schema: "hades.gov.rotation.v1", at: 1000, reason: "r", sequence: 0 });
    const tampered: SignedRotationRecord = { ...signed, newKeySignature: attacker.sign(govCanonicalize(signed.record)) };
    const result = verifyRotationHistory([tampered], { genesisPublicKey: oldKey.publicKeyHex() });
    expect(result.ok).toBe(false);
    expect(result.failures[0].code).toBe("signature-invalid");
  });

  it("fails when a spliced record's oldPublicKey skips a generation", () => {
    const keys = [220, 221, 222].map((s) => GovIdentity.generate(seededRng(s)));
    const r0 = signRotation(keys[0], keys[1], { schema: "hades.gov.rotation.v1", at: 1000, reason: "a", sequence: 0 });
    // Splice: record[1] jumps straight from keys[0] to keys[2], skipping keys[1].
    const r1 = signRotation(keys[0], keys[2], { schema: "hades.gov.rotation.v1", at: 1001, reason: "b", sequence: 1 });
    const result = verifyRotationHistory([r0, r1], { genesisPublicKey: keys[0].publicKeyHex() });
    expect(result.ok).toBe(false);
    expect(result.failures[0].code).toBe("broken-link");
  });

  it("fails on a reordered history", () => {
    const keys = [230, 231, 232].map((s) => GovIdentity.generate(seededRng(s)));
    const r0 = signRotation(keys[0], keys[1], { schema: "hades.gov.rotation.v1", at: 1000, reason: "a", sequence: 0 });
    const r1 = signRotation(keys[1], keys[2], { schema: "hades.gov.rotation.v1", at: 1001, reason: "b", sequence: 1 });
    const result = verifyRotationHistory([r1, r0], { genesisPublicKey: keys[0].publicKeyHex() });
    expect(result.ok).toBe(false);
    // r1 arrives first at sequence position 0 but claims sequence 1.
    expect(result.failures[0].code).toBe("broken-link");
  });

  it("fails when sequence numbers are not dense starting at 0", () => {
    const oldKey = GovIdentity.generate(seededRng(240));
    const newKey = GovIdentity.generate(seededRng(241));
    const signed = signRotation(oldKey, newKey, { schema: "hades.gov.rotation.v1", at: 1000, reason: "r", sequence: 5 });
    const result = verifyRotationHistory([signed], { genesisPublicKey: oldKey.publicKeyHex() });
    expect(result.ok).toBe(false);
    expect(result.failures[0].code).toBe("broken-link");
  });
});
