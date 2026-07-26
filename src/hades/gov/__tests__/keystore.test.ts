import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GovIdentity, agentIdFromPublicKey, govCanonicalize, verifyGovSignature, verifyRotationHistory } from "../identity";
import { GOV_DIR, GovKeystore, govRoot } from "../keystore";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-keystore-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixedClock(t: number): () => number {
  let now = t;
  return () => now++;
}

describe("GOV_DIR / govRoot", () => {
  it("GOV_DIR is 'gov' and govRoot joins it under dataDir", () => {
    expect(GOV_DIR).toBe("gov");
    expect(govRoot("/data")).toBe(join("/data", "gov"));
  });
});

describe("GovKeystore.load — generation and persistence", () => {
  it("opening an empty dir generates and durably persists an identity", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const loaded = ks.load();
    expect(loaded.source).toBe("generated");
    expect(loaded.rotations).toEqual([]);
    expect(loaded.doc.doc.publicKey).toBe(loaded.identity.publicKeyHex());
    expect(loaded.doc.doc.agentId).toBe(agentIdFromPublicKey(loaded.identity.publicKeyHex()));

    expect(existsSync(join(dir, "identity.json"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    expect(onDisk.privateKey).toBe(loaded.identity.privateKeyHex());
    expect(onDisk.doc.doc.publicKey).toBe(loaded.identity.publicKeyHex());
  });

  it("reopening returns the SAME agentId with source 'persisted'", () => {
    const first = GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const second = GovKeystore.open({ dir, now: fixedClock(5000) }).load();

    expect(second.source).toBe("persisted");
    expect(second.identity.agentId()).toBe(first.identity.agentId());
    expect(second.identity.publicKeyHex()).toBe(first.identity.publicKeyHex());
    expect(second.identity.privateKeyHex()).toBe(first.identity.privateKeyHex());
  });

  it("persisted identity doc is self-signed and verifies", () => {
    const loaded = GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const canonical = govCanonicalize(loaded.doc.doc);
    expect(verifyGovSignature(loaded.doc.signerPublicKey, canonical, loaded.doc.signature)).toBe(true);
    expect(loaded.doc.signerPublicKey).toBe(loaded.identity.publicKeyHex());
  });

  it("chmods the identity file to 0o600 best-effort and reports failure via permissionWarning() if it could not", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    ks.load();
    // We cannot force a chmod failure portably in a sandboxed test runner,
    // but we CAN assert the real permission bit was actually applied when
    // chmod succeeds (as it should on a normal POSIX temp dir), and that the
    // reporting channel exists and reflects that success (null = no failure).
    if (process.platform !== "win32") {
      const mode = statSync(join(dir, "identity.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    expect(ks.permissionWarning()).toBeNull();
  });

  it("a leftover .tmp file is not mistaken for state — a fresh identity is still generated", () => {
    writeFileSync(join(dir, "identity.json.tmp"), "{ not even valid json", "utf8");
    const loaded = GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    expect(loaded.source).toBe("generated");
    expect(existsSync(join(dir, "identity.json"))).toBe(true);
  });

  it("a truncated/half-written identity.json is rejected loudly, never healed into a fresh identity", () => {
    // First produce a REAL identity file, then truncate it mid-write to
    // simulate a crash between write and full flush.
    GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const full = readFileSync(join(dir, "identity.json"), "utf8");
    writeFileSync(join(dir, "identity.json"), full.slice(0, Math.floor(full.length / 2)), "utf8");

    expect(() => GovKeystore.open({ dir, now: fixedClock(2000) }).load()).toThrow(/corrupt|invalid JSON/i);
  });

  it("an identity.json with a doc signature that does not verify under its own stored key throws", () => {
    const loaded = GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const onDisk = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    // Tamper with the roles after signing — signature no longer verifies.
    onDisk.doc.doc.roles = ["admin"];
    writeFileSync(join(dir, "identity.json"), JSON.stringify(onDisk), "utf8");

    expect(loaded).toBeDefined();
    expect(() => GovKeystore.open({ dir, now: fixedClock(2000) }).load()).toThrow(/signature does not verify/i);
  });

  it("an identity.json whose stored doc.publicKey does not match its own stored private key throws", () => {
    GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const onDisk = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    const other = GovIdentity.generate();
    onDisk.doc.doc.publicKey = other.publicKeyHex();
    onDisk.doc.signerPublicKey = other.publicKeyHex();
    onDisk.doc.doc.agentId = other.agentId();
    writeFileSync(join(dir, "identity.json"), JSON.stringify(onDisk), "utf8");

    expect(() => GovKeystore.open({ dir, now: fixedClock(2000) }).load()).toThrow(/does not match its own stored private key/i);
  });

  it("an identity.json with an unrecognized shape throws rather than regenerating", () => {
    writeFileSync(join(dir, "identity.json"), JSON.stringify({ totally: "wrong" }), "utf8");
    expect(() => GovKeystore.open({ dir, now: fixedClock(1000) }).load()).toThrow(/unrecognized shape/i);
  });

  it("calling open()/load() twice against the same dir in sequence does not corrupt identity.json", () => {
    const ksA = GovKeystore.open({ dir, now: fixedClock(1000) });
    const ksB = GovKeystore.open({ dir, now: fixedClock(2000) });
    const a = ksA.load();
    const b = ksB.load();
    // Whichever instance actually created the file, the other must observe
    // exactly the same persisted identity — never two different identities,
    // never a corrupt file.
    expect(a.identity.publicKeyHex()).toBe(b.identity.publicKeyHex());
    const raw = readFileSync(join(dir, "identity.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("GovKeystore.load — HADES_GOV_KEY env override", () => {
  it("env key wins over disk and yields source 'env'", () => {
    const persisted = GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const envIdentity = GovIdentity.generate();
    expect(envIdentity.publicKeyHex()).not.toBe(persisted.identity.publicKeyHex());

    const ks = GovKeystore.open({ dir, now: fixedClock(2000), env: { ...process.env, HADES_GOV_KEY: envIdentity.privateKeyHex() } });
    const loaded = ks.load();

    expect(loaded.source).toBe("env");
    expect(loaded.identity.publicKeyHex()).toBe(envIdentity.publicKeyHex());
    expect(loaded.doc.doc.publicKey).toBe(envIdentity.publicKeyHex());
  });

  it("a malformed HADES_GOV_KEY throws and refuses to fall back to a different identity", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000), env: { ...process.env, HADES_GOV_KEY: "not-a-valid-64-hex-key" } });
    expect(() => ks.load()).toThrow(/HADES_GOV_KEY/);
    expect(() => ks.load()).toThrow(/64-character hex/i);
    // Disk must remain untouched by the failed attempt.
    expect(existsSync(join(dir, "identity.json"))).toBe(false);
  });

  it("env override does not write to or otherwise mutate disk state", () => {
    const envIdentity = GovIdentity.generate();
    GovKeystore.open({ dir, now: fixedClock(1000), env: { ...process.env, HADES_GOV_KEY: envIdentity.privateKeyHex() } }).load();
    expect(existsSync(join(dir, "identity.json"))).toBe(false);
  });

  it("env override reuses a matching persisted doc's issuedAt for continuity when the public keys coincide", () => {
    const first = GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    const second = GovKeystore.open({ dir, now: fixedClock(9999), env: { ...process.env, HADES_GOV_KEY: first.identity.privateKeyHex() } }).load();
    expect(second.source).toBe("env");
    expect(second.doc.doc.issuedAt).toBe(first.doc.doc.issuedAt);
  });
});

describe("GovKeystore.rotate", () => {
  it("rotates to a new key, signs a continuity record, and persists both", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const before = ks.load();
    const after = ks.rotate("scheduled-rotation");

    expect(after.identity.publicKeyHex()).not.toBe(before.identity.publicKeyHex());
    expect(after.source).toBe("generated");
    expect(after.rotations.length).toBe(1);
    expect(after.rotations[0].record.oldPublicKey).toBe(before.identity.publicKeyHex());
    expect(after.rotations[0].record.newPublicKey).toBe(after.identity.publicKeyHex());
    expect(after.rotations[0].record.reason).toBe("scheduled-rotation");
    expect(after.rotations[0].record.sequence).toBe(0);

    const verification = verifyRotationHistory(after.rotations, { genesisPublicKey: before.identity.publicKeyHex() });
    expect(verification.ok).toBe(true);
    expect(verification.currentPublicKey).toBe(after.identity.publicKeyHex());

    // Persisted identity.json now reflects the NEW key.
    const onDisk = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    expect(onDisk.doc.doc.publicKey).toBe(after.identity.publicKeyHex());

    // Persisted rotations.json round-trips.
    const rotationsOnDisk = JSON.parse(readFileSync(join(dir, "rotations.json"), "utf8"));
    expect(rotationsOnDisk).toHaveLength(1);
    expect(rotationsOnDisk[0].record.oldPublicKey).toBe(before.identity.publicKeyHex());
  });

  it("preserves the previously issued roles across rotation", () => {
    // Roles are only assignable via issueSelf; simulate by rotating twice
    // and asserting the role set (empty, since generation defaults to no
    // roles) is carried forward rather than reset to something else.
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const before = ks.load();
    const after = ks.rotate("r1");
    expect(after.doc.doc.roles).toEqual(before.doc.doc.roles);
  });

  it("supports multiple sequential rotations forming a verifiable N-step history", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const gen0 = ks.load();
    const gen1 = ks.rotate("first");
    const gen2 = ks.rotate("second");
    const gen3 = ks.rotate("third");

    expect(gen3.rotations.length).toBe(3);
    expect(gen3.rotations.map((r) => r.record.sequence)).toEqual([0, 1, 2]);

    const verification = verifyRotationHistory(gen3.rotations, { genesisPublicKey: gen0.identity.publicKeyHex() });
    expect(verification.ok).toBe(true);
    expect(verification.currentPublicKey).toBe(gen3.identity.publicKeyHex());
    expect(gen1.identity.publicKeyHex()).not.toBe(gen2.identity.publicKeyHex());
  });

  it("a freshly opened keystore after rotation reports source 'persisted' at the NEW key with full rotation history", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const gen0 = ks.load();
    const gen1 = ks.rotate("rotate-once");

    const reopened = GovKeystore.open({ dir, now: fixedClock(9000) }).load();
    expect(reopened.source).toBe("persisted");
    expect(reopened.identity.publicKeyHex()).toBe(gen1.identity.publicKeyHex());
    expect(reopened.identity.publicKeyHex()).not.toBe(gen0.identity.publicKeyHex());
    expect(reopened.rotations.length).toBe(1);
  });

  it("rotate() implicitly loads if load() was not called first", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const after = ks.rotate("implicit-load");
    expect(after.rotations.length).toBe(1);
    expect(existsSync(join(dir, "identity.json"))).toBe(true);
  });
});

describe("GovKeystore.revoke / revoked", () => {
  it("starts with an empty revoked set", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    expect(ks.revoked().size).toBe(0);
  });

  it("revoke() durably adds a public key, visible from a freshly opened instance", () => {
    const target = GovIdentity.generate();
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    ks.revoke(target.publicKeyHex(), "compromised");
    expect(ks.revoked().has(target.publicKeyHex())).toBe(true);

    const reopened = GovKeystore.open({ dir, now: fixedClock(2000) });
    expect(reopened.revoked().has(target.publicKeyHex())).toBe(true);
  });

  it("revoke() is idempotent", () => {
    const target = GovIdentity.generate();
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    ks.revoke(target.publicKeyHex(), "first");
    ks.revoke(target.publicKeyHex(), "second");
    expect(ks.revoked().size).toBe(1);
  });

  it("rejects a malformed public key rather than silently no-oping", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    expect(() => ks.revoke("not-a-key", "x")).toThrow();
    expect(ks.revoked().size).toBe(0);
  });

  it("a corrupt revoked.json is rejected loudly rather than silently treated as empty", () => {
    writeFileSync(join(dir, "revoked.json"), "{ broken", "utf8");
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    expect(() => ks.revoked()).toThrow(/corrupt|invalid JSON/i);
  });
});

describe("GovKeystore.publicRecord", () => {
  it("reports agentId, publicKey, and rotation count, auto-loading if needed", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const record = ks.publicRecord();
    expect(record.agentId).toMatch(/^agent:[0-9a-f]{32}$/);
    expect(record.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(record.rotations).toBe(0);

    ks.rotate("r");
    expect(ks.publicRecord().rotations).toBe(1);
    expect(ks.publicRecord().agentId).not.toBe(record.agentId);
  });

  it("never leaks the private key", () => {
    const ks = GovKeystore.open({ dir, now: fixedClock(1000) });
    const record = ks.publicRecord();
    expect(Object.keys(record).sort()).toEqual(["agentId", "publicKey", "rotations"]);
  });
});

describe("GovKeystore — a corrupt rotations.json is rejected loudly", () => {
  it("throws rather than silently dropping rotation history", () => {
    GovKeystore.open({ dir, now: fixedClock(1000) }).load();
    writeFileSync(join(dir, "rotations.json"), "not json at all", "utf8");
    expect(() => GovKeystore.open({ dir, now: fixedClock(2000) }).load()).toThrow(/corrupt|invalid JSON/i);
  });
});
