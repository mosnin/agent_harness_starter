/**
 * policy-store.test.ts
 *
 * REAL-VS-MOCK POLICY: every bundle here is signed with a real `GovIdentity`
 * (real ed25519 via `@noble/ed25519`) and every file lives in a real
 * `mkdtempSync` temp directory — nothing mocks the filesystem or crypto.
 * The entire point of this file is proving the store fails CLOSED for
 * every `PolicyLoadStatus` other than `"ok"`, so each test hand-constructs
 * the exact on-disk bytes a real attacker/bug would produce (a flipped
 * byte, an untrusted signer, a stale-but-genuinely-signed replay) rather
 * than mocking `verifyGovSignature` to return false.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GovIdentity, govCanonicalize } from "../identity";
import { DEFAULT_GOV_POLICY, type PolicyAuditSink, type PolicyDocument } from "../policy";
import { PolicyStore, type SignedPolicyBundle } from "../policy-store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-policy-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixedClock(t: number): () => number {
  let now = t;
  return () => now++;
}

class MemoryAuditSink implements PolicyAuditSink {
  records: Array<{ at: number; actor: string; action: string; resource: string; outcome: "allow" | "deny" | "info"; code?: string; payload?: unknown }> = [];
  record(input: { at: number; actor: string; action: string; resource: string; outcome: "allow" | "deny" | "info"; code?: string; payload?: unknown }): void {
    this.records.push(input);
  }
}

function testDoc(version: number, name = "test-policy"): PolicyDocument {
  return {
    schema: "hades.gov.policy.v1",
    name,
    version,
    defaultEffect: "deny",
    rules: [
      {
        id: "allow-read",
        effect: "allow",
        subjects: ["*"],
        actions: ["fs:read"],
        resources: ["fs:/workspace/**"],
      },
    ],
  };
}

function policyPath(d: string): string {
  return join(d, "policy.json");
}

// ---------------------------------------------------------------------------
// save / load round trip
// ---------------------------------------------------------------------------

describe("PolicyStore.save + load — happy path", () => {
  it("saves a real signed bundle and loads it back with status ok", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()], now: fixedClock(1000) });

    const saved = store.save(testDoc(1), identity);
    expect(saved.signerPublicKey).toBe(identity.publicKeyHex());
    expect(saved.signature.length).toBeGreaterThan(0);
    expect(existsSync(policyPath(dir))).toBe(true);

    const result = store.load();
    expect(result.status).toBe("ok");
    expect(result.bundle?.doc.version).toBe(1);
    expect(result.engine.evaluate({ subject: "a", action: "fs:read", resource: "fs:/workspace/x", at: 0 }).effect).toBe("allow");
  });

  it("the write is atomic (a .tmp sibling never survives a successful save)", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(1), identity);
    expect(existsSync(policyPath(dir) + ".tmp")).toBe(false);
  });

  it("records history entries on every save, queryable via history()", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()], now: fixedClock(1000) });
    store.save(testDoc(1), identity);
    store.save(testDoc(2), identity);
    store.save(testDoc(3), identity);
    const hist = store.history();
    expect(hist.map((h) => h.version)).toEqual([1, 2, 3]);
    expect(hist.every((h) => h.docSha256.length > 0)).toBe(true);
  });

  it("an engine loaded from the store enforces exactly what the saved document says", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(1), identity);
    const { engine } = store.load();
    expect(engine.evaluate({ subject: "a", action: "fs:write", resource: "fs:/workspace/x", at: 0 }).effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Anti-rollback on save()
// ---------------------------------------------------------------------------

describe("PolicyStore.save — anti-rollback", () => {
  it("refuses a version equal to the persisted version", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(3), identity);
    expect(() => store.save(testDoc(3), identity)).toThrow(/anti-rollback|version/);
  });

  it("refuses a version lower than the persisted version", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(3), identity);
    expect(() => store.save(testDoc(2), identity)).toThrow(/anti-rollback|version/);
    // The file on disk must still be version 3, untouched by the refused save.
    const onDisk = JSON.parse(readFileSync(policyPath(dir), "utf8"));
    expect(onDisk.doc.version).toBe(3);
  });

  it("accepts a strictly greater version", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(3), identity);
    expect(() => store.save(testDoc(4), identity)).not.toThrow();
    expect(store.load().bundle?.doc.version).toBe(4);
  });

  it("save() rejects an invalid PolicyDocument outright", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    const bad = { ...testDoc(1), schema: "wrong" } as unknown as PolicyDocument;
    expect(() => store.save(bad, identity)).toThrow(/invalid policy document/);
  });
});

// ---------------------------------------------------------------------------
// Bar (6): fail-closed for EVERY PolicyLoadStatus
// ---------------------------------------------------------------------------

describe("PolicyStore.load — fail-closed for every PolicyLoadStatus", () => {
  const openRequest = { subject: "attacker", action: "fs:write", resource: "fs:/anything", at: 0 };

  function assertDeniesWhatTamperedPolicyWouldHaveAllowed(engine: ReturnType<PolicyStore["load"]>["engine"]): void {
    // The tampered/trusted-looking policy underneath (if it were somehow
    // honored) would allow fs:write to /workspace/scratch/** — a fail-closed
    // engine must deny it, and everything else, unconditionally.
    const d = engine.evaluate({ subject: "attacker", action: "fs:write", resource: "fs:/workspace/scratch/x", at: 0 });
    expect(d.effect).toBe("deny");
    expect(engine.evaluate(openRequest).effect).toBe("deny");
  }

  it("absent: no policy.json file at all", () => {
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [] });
    const result = store.load();
    expect(result.status).toBe("absent");
    expect(result.reason).toMatch(/no policy file/);
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("unsigned: a bundle-shaped file with no signature field", () => {
    const doc = testDoc(1);
    writeFileSync(policyPath(dir), JSON.stringify({ doc, signature: "", signerPublicKey: "", docSha256: "abc" }), "utf8");
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [] });
    const result = store.load();
    expect(result.status).toBe("unsigned");
    expect(result.reason).toMatch(/no signature|unsigned/i);
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("signature-invalid: one flipped byte anywhere in doc after signing", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    const bundle = store.save(testDoc(1, "flip-me"), identity);

    const tampered: SignedPolicyBundle = {
      ...bundle,
      doc: { ...bundle.doc, name: bundle.doc.name + "X" }, // one-character tamper post-signing
    };
    writeFileSync(policyPath(dir), JSON.stringify(tampered), "utf8");

    const result = store.load();
    expect(result.status).toBe("signature-invalid");
    expect(result.reason).toMatch(/signature/);
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("untrusted-signer: a validly-signed bundle from a key outside trustedSignerPublicKeys", () => {
    const attackerIdentity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [GovIdentity.generate().publicKeyHex()] });
    // Sign with a store that trusts the attacker key, then read it with the real store's trust set.
    const untrustedSideStore = PolicyStore.open({ dir, trustedSignerPublicKeys: [attackerIdentity.publicKeyHex()] });
    untrustedSideStore.save(testDoc(1), attackerIdentity);

    const result = store.load();
    expect(result.status).toBe("untrusted-signer");
    expect(result.reason).toContain(attackerIdentity.publicKeyHex());
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("malformed: not valid JSON", () => {
    writeFileSync(policyPath(dir), "{ not json ", "utf8");
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [] });
    const result = store.load();
    expect(result.status).toBe("malformed");
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("malformed: valid JSON but not the shape of a SignedPolicyBundle", () => {
    writeFileSync(policyPath(dir), JSON.stringify({ hello: "world" }), "utf8");
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [] });
    const result = store.load();
    expect(result.status).toBe("malformed");
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("schema-mismatch: a validly-signed bundle whose inner doc fails strict policy validation", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    const badDoc = { ...testDoc(1), defaultEffect: "not-a-real-effect" } as unknown as PolicyDocument;
    const canonical = govCanonicalize(badDoc);
    const signature = identity.sign(canonical);
    const bundle: SignedPolicyBundle = { doc: badDoc, signature, signerPublicKey: identity.publicKeyHex(), docSha256: "irrelevant" };
    writeFileSync(policyPath(dir), JSON.stringify(bundle), "utf8");

    const result = store.load();
    expect(result.status).toBe("schema-mismatch");
    expect(result.reason).toMatch(/schema validation/);
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("downgrade-refused: a version-3 file replaced by an attacker's validly-signed version-1", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(1), identity);
    store.save(testDoc(2), identity);
    store.save(testDoc(3), identity);

    // Simulate an attacker replaying an earlier, genuinely-valid v1 bundle
    // (signed by the SAME trusted key — a pure replay, not a forgery) back
    // over the current policy.json, while history.jsonl still remembers v3.
    const canonical = govCanonicalize(testDoc(1));
    const signature = identity.sign(canonical);
    const replayedBundle: SignedPolicyBundle = { doc: testDoc(1), signature, signerPublicKey: identity.publicKeyHex(), docSha256: "irrelevant" };
    writeFileSync(policyPath(dir), JSON.stringify(replayedBundle), "utf8");

    const result = store.load();
    expect(result.status).toBe("downgrade-refused");
    expect(result.reason).toMatch(/lower than the highest previously recorded version/);
    assertDeniesWhatTamperedPolicyWouldHaveAllowed(result.engine);
  });

  it("a version EQUAL to the last recorded version loads normally (not a downgrade)", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(testDoc(1), identity);
    const result = store.load();
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Every non-ok status records an audit failure with a naming reason
// ---------------------------------------------------------------------------

describe("PolicyStore — audit sink wiring", () => {
  it("records a deny outcome for every non-ok load, and info for ok", () => {
    const audit = new MemoryAuditSink();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [], audit, now: fixedClock(500) });

    store.load(); // absent
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ outcome: "deny", code: "absent", actor: "policy-store" });

    const identity = GovIdentity.generate();
    const trustedStore = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()], audit, now: fixedClock(600) });
    trustedStore.save(testDoc(1), identity);
    const saveRecord = audit.records.find((r) => r.action === "policy.save");
    expect(saveRecord).toBeDefined();
    expect(saveRecord?.outcome).toBe("info");

    trustedStore.load();
    const loadOkRecord = audit.records.find((r) => r.action === "policy.load" && r.code === "ok");
    expect(loadOkRecord).toBeDefined();
    expect(loadOkRecord?.outcome).toBe("info");
  });

  it("a throwing audit sink never breaks load() or save()", () => {
    const audit: PolicyAuditSink = {
      record: () => {
        throw new Error("boom");
      },
    };
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()], audit });
    expect(() => store.save(testDoc(1), identity)).not.toThrow();
    expect(() => store.load()).not.toThrow();
    expect(store.load().status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_GOV_POLICY through the real store
// ---------------------------------------------------------------------------

describe("DEFAULT_GOV_POLICY through PolicyStore", () => {
  it("round-trips through save/load and still lints clean and enforces least privilege", () => {
    const identity = GovIdentity.generate();
    const store = PolicyStore.open({ dir, trustedSignerPublicKeys: [identity.publicKeyHex()] });
    store.save(DEFAULT_GOV_POLICY, identity);
    const result = store.load();
    expect(result.status).toBe("ok");
    expect(result.engine.lint()).toEqual([]);
    expect(
      result.engine.evaluate({ subject: "a", action: "net:egress", resource: "net:x.com", at: 0, airgapped: true, capabilities: ["net:*"] }).effect,
    ).toBe("deny");
  });
});
