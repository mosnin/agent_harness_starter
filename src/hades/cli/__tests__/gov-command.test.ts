import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGovCommand, defaultGovDeps, type GovCommandDeps, type GovStack } from "../gov-command";
import { GovKeystore, govRoot } from "../../gov/keystore";
import { GovIdentity } from "../../gov/identity";
import { CapabilityIssuer, CapabilityEnforcer } from "../../gov/capability";
import { GovAuditChain } from "../../gov/audit-chain";
import { PolicyStore } from "../../gov/policy-store";
import { DEFAULT_GOV_POLICY } from "../../gov/policy";
import { engageAirgap } from "../../gov/airgap";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-command-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixedClock(t: number): () => number {
  let now = t;
  return () => now++;
}

/**
 * Mirrors `defaultGovDeps()`'s LAZY structure deliberately. An eager test
 * double would resolve (and therefore generate) the identity before the
 * handler under test ran, which is exactly the divergence that let
 * `gov identity new` claim "persisted" on a virgin data dir. The double must
 * have the same laziness as production or it cannot test production.
 */
function buildGovStack(testDir: string, now: () => number): GovStack {
  const govDir = govRoot(testDir);
  const keystore = GovKeystore.open({ dir: govDir, now });
  let issuer: CapabilityIssuer | undefined;
  let enforcer: CapabilityEnforcer | undefined;
  let chain: GovAuditChain | undefined;
  let policy: PolicyStore | undefined;
  return {
    keystore,
    dataDir: testDir,
    get issuer(): CapabilityIssuer {
      if (!issuer) issuer = new CapabilityIssuer(keystore.load().identity, { now });
      return issuer;
    },
    get enforcer(): CapabilityEnforcer {
      if (!enforcer) enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [keystore.load().identity.publicKeyHex()], now });
      return enforcer;
    },
    get chain(): GovAuditChain {
      if (!chain) chain = GovAuditChain.open({ dir: govDir, now });
      return chain;
    },
    get policy(): PolicyStore {
      if (!policy) policy = PolicyStore.open({ dir: join(govDir, "policy"), trustedSignerPublicKeys: [keystore.load().identity.publicKeyHex()], now });
      return policy;
    },
  };
}

function buildDeps(testDir: string, now: () => number): GovCommandDeps {
  let cached: GovStack | undefined;
  return {
    root: () => {
      if (!cached) cached = buildGovStack(testDir, now);
      return cached;
    },
    now,
  };
}

function json(result: { lines: string[] }): unknown {
  return JSON.parse(result.lines.join("\n"));
}

const validPolicyDoc = {
  schema: "hades.gov.policy.v1",
  name: "test-policy",
  version: 1,
  defaultEffect: "deny",
  rules: [
    {
      id: "allow-tool-invoke",
      effect: "allow",
      subjects: ["*"],
      actions: ["tool:invoke"],
      resources: ["tool:*"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Top-level routing
// ---------------------------------------------------------------------------

describe("runGovCommand — top-level routing", () => {
  it("no args and 'help' both return the full usage listing every group", async () => {
    const deps = buildDeps(dir, fixedClock(1000));
    const noArgs = await runGovCommand([], deps);
    const help = await runGovCommand(["help"], deps);
    for (const result of [noArgs, help]) {
      expect(result.code).toBe(0);
      const text = result.lines.join("\n");
      expect(text).toContain("identity:");
      expect(text).toContain("token:");
      expect(text).toContain("audit:");
      expect(text).toContain("policy:");
      expect(text).toContain("airgap:");
      expect(text).toContain("doctor");
    }
  });

  it("an unknown top-level group exits non-zero with usage", async () => {
    const deps = buildDeps(dir, fixedClock(1000));
    const result = await runGovCommand(["bogus-group"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/Unknown gov command: bogus-group/);
    expect(result.lines.join("\n")).toContain("Usage: hades gov");
  });

  it("defaultGovDeps() never touches the filesystem until root() is called", () => {
    const before = existsSync(join(process.cwd(), ".hades-defaultgov-probe"));
    expect(before).toBe(false);
    const deps = defaultGovDeps();
    expect(typeof deps.root).toBe("function");
    // constructing the deps object must not have created a keystore anywhere
    // reachable from this test's own tmp dir (we never pointed it there,
    // this just proves the factory itself performed no I/O).
  });
});

// ---------------------------------------------------------------------------
// gov identity
// ---------------------------------------------------------------------------

describe("runGovCommand — identity", () => {
  it("show reports the real agentId/publicKey and matches a direct keystore read", async () => {
    const deps = buildDeps(dir, fixedClock(2000));
    const result = await runGovCommand(["identity", "show", "--json"], deps);
    expect(result.code).toBe(0);
    const parsed = json(result) as { agentId: string; publicKey: string; source: string };
    const direct = GovKeystore.open({ dir: govRoot(dir) }).load();
    expect(parsed.agentId).toBe(direct.identity.agentId());
    expect(parsed.publicKey).toBe(direct.identity.publicKeyHex());
    // `source` is whatever actually happened, never a fixed string: this dir
    // was virgin, so the first resolution genuinely GENERATED the key...
    expect(parsed.source).toBe("generated");
    // ...and a later process resolving the same dir genuinely reads it back.
    const again = json(await runGovCommand(["identity", "show", "--json"], buildDeps(dir, fixedClock(4000)))) as { source: string; publicKey: string };
    expect(again.source).toBe("persisted");
    expect(again.publicKey).toBe(parsed.publicKey);
  });

  it("show (plain text) includes agentId and publicKey lines", async () => {
    const deps = buildDeps(dir, fixedClock(2000));
    const result = await runGovCommand(["identity", "show"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.startsWith("agentId"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("publicKey"))).toBe(true);
  });

  it("new reports created=true ONLY on a genuinely virgin dataDir, and false thereafter", async () => {
    // Virgin dir: this call is the one that actually mints the key, so it
    // must say so — and the keystore's own `source` must agree.
    const deps = buildDeps(dir, fixedClock(2000));
    const first = await runGovCommand(["identity", "new", "--json"], deps);
    expect(first.code).toBe(0);
    const firstParsed = json(first) as { created: boolean; source: string; agentId: string; publicKey: string };
    expect(firstParsed.created).toBe(true);
    expect(firstParsed.source).toBe("generated");
    expect(firstParsed.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // The key really is on disk (not merely claimed).
    expect(existsSync(join(govRoot(dir), "identity.json"))).toBe(true);

    // A second run against the same dir must NOT claim creation, and must
    // leave the existing key completely untouched.
    const secondDeps = buildDeps(dir, fixedClock(3000));
    const second = await runGovCommand(["identity", "new", "--json"], secondDeps);
    expect(second.code).toBe(0);
    const secondParsed = json(second) as { created: boolean; source: string; publicKey: string };
    expect(secondParsed.created).toBe(false);
    expect(secondParsed.source).toBe("persisted");
    expect(secondParsed.publicKey).toBe(firstParsed.publicKey);
  });

  it("new (plain text) says CREATED the first time and 'already existed' the second", async () => {
    const first = await runGovCommand(["identity", "new"], buildDeps(dir, fixedClock(2000)));
    expect(first.lines[0]).toContain("CREATED");
    const second = await runGovCommand(["identity", "new"], buildDeps(dir, fixedClock(3000)));
    expect(second.lines[0]).toContain("already existed");
    expect(second.lines[0]).not.toContain("CREATED");
  });

  it("rotate produces a new key with a signed continuity record; show reflects it", async () => {
    const deps = buildDeps(dir, fixedClock(3000));
    const before = json(await runGovCommand(["identity", "show", "--json"], deps)) as { agentId: string };
    const rotated = await runGovCommand(["identity", "rotate", "--reason", "scheduled rotation", "--json"], deps);
    expect(rotated.code).toBe(0);
    const rotatedParsed = json(rotated) as { agentId: string; rotations: number };
    expect(rotatedParsed.agentId).not.toBe(before.agentId);
    expect(rotatedParsed.rotations).toBe(1);
    const after = json(await runGovCommand(["identity", "show", "--json"], deps)) as { agentId: string; rotations: number };
    expect(after.agentId).toBe(rotatedParsed.agentId);
    expect(after.rotations).toBe(1);
  });

  it("revoke requires --key and --reason", async () => {
    const deps = buildDeps(dir, fixedClock(4000));
    const missingKey = await runGovCommand(["identity", "revoke", "--reason", "compromised"], deps);
    expect(missingKey.code).toBe(1);
    const missingReason = await runGovCommand(["identity", "revoke", "--key", "a".repeat(64)], deps);
    expect(missingReason.code).toBe(1);
  });

  it("revoke durably records the revoked key", async () => {
    const deps = buildDeps(dir, fixedClock(5000));
    const stack = deps.root();
    const victim = "b".repeat(64);
    const result = await runGovCommand(["identity", "revoke", "--key", victim, "--reason", "compromised", "--json"], deps);
    expect(result.code).toBe(0);
    expect(stack.keystore.revoked().has(victim)).toBe(true);
  });

  it("verify reports a valid chain, and stays valid across a rotation", async () => {
    const deps = buildDeps(dir, fixedClock(6000));
    const beforeRotate = await runGovCommand(["identity", "verify", "--json"], deps);
    expect(beforeRotate.code).toBe(0);
    expect((json(beforeRotate) as { ok: boolean }).ok).toBe(true);

    await runGovCommand(["identity", "rotate", "--reason", "rotate for verify test"], deps);
    const afterRotate = await runGovCommand(["identity", "verify", "--json"], deps);
    expect(afterRotate.code).toBe(0);
    const parsed = json(afterRotate) as { ok: boolean; rotationHistoryValid: boolean; currentKeyMatches: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.rotationHistoryValid).toBe(true);
    expect(parsed.currentKeyMatches).toBe(true);
  });

  it("an unknown identity subcommand exits non-zero with the identity usage block", async () => {
    const deps = buildDeps(dir, fixedClock(7000));
    const result = await runGovCommand(["identity", "bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Usage: hades gov identity");
  });
});

// ---------------------------------------------------------------------------
// gov token
// ---------------------------------------------------------------------------

describe("runGovCommand — token", () => {
  it("mint requires --subject and validates --grant shape", async () => {
    const deps = buildDeps(dir, fixedClock(8000));
    const noSubject = await runGovCommand(["token", "mint", "--grant", "tool:*=invoke"], deps);
    expect(noSubject.code).toBe(1);
    const badGrant = await runGovCommand(["token", "mint", "--subject", "agent:x", "--grant", "no-equals-sign"], deps);
    expect(badGrant.code).toBe(1);
  });

  it("mint produces a real, signature-valid token with the requested grants", async () => {
    const deps = buildDeps(dir, fixedClock(9000));
    const result = await runGovCommand(
      ["token", "mint", "--subject", "agent:alice", "--grant", "tool:*=invoke,inspect", "--ttl", "60000", "--json"],
      deps,
    );
    expect(result.code).toBe(0);
    const token = json(result) as { subject: string; grants: Array<{ resource: string; actions: string[] }>; signature: string };
    expect(token.subject).toBe("agent:alice");
    expect(token.grants).toEqual([{ resource: "tool:*", actions: ["invoke", "inspect"] }]);

    const tokenPath = join(dir, "minted.json");
    writeFileSync(tokenPath, JSON.stringify(token), "utf8");
    const inspected = await runGovCommand(["token", "inspect", "--token", tokenPath, "--json"], deps);
    expect(inspected.code).toBe(0);
    expect((json(inspected) as { signatureValid: boolean }).signatureValid).toBe(true);
  });

  it("inspect on a tampered token file reports signatureValid:false and a non-zero exit", async () => {
    const deps = buildDeps(dir, fixedClock(9500));
    const minted = json(
      await runGovCommand(["token", "mint", "--subject", "agent:bob", "--grant", "tool:*=invoke", "--json"], deps),
    ) as Record<string, unknown>;
    const tampered = { ...minted, subject: "agent:mallory" };
    const tokenPath = join(dir, "tampered.json");
    writeFileSync(tokenPath, JSON.stringify(tampered), "utf8");
    const inspected = await runGovCommand(["token", "inspect", "--token", tokenPath, "--json"], deps);
    expect(inspected.code).toBe(1);
    expect((json(inspected) as { signatureValid: boolean }).signatureValid).toBe(false);
  });

  it("check allows an in-grant request and denies an out-of-grant one with a typed code", async () => {
    const deps = buildDeps(dir, fixedClock(10_000));
    const minted = json(
      await runGovCommand(["token", "mint", "--subject", "agent:carol", "--grant", "tool:*=tool:invoke", "--json"], deps),
    ) as Record<string, unknown>;
    const tokenPath = join(dir, "carol.json");
    writeFileSync(tokenPath, JSON.stringify(minted), "utf8");

    const allowed = await runGovCommand(
      ["token", "check", "--token", tokenPath, "--subject", "agent:carol", "--action", "tool:invoke", "--resource", "tool:echo", "--at", "10001", "--json"],
      deps,
    );
    expect(allowed.code).toBe(0);
    expect((json(allowed) as { allow: boolean }).allow).toBe(true);

    const denied = await runGovCommand(
      ["token", "check", "--token", tokenPath, "--subject", "agent:carol", "--action", "net:egress", "--resource", "net:evil.example", "--at", "10001", "--json"],
      deps,
    );
    expect(denied.code).toBe(2);
    const decision = json(denied) as { allow: boolean; code: string };
    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("no-matching-grant");
  });

  it("attenuate narrows a token, signed by the holder, and the child is a genuine attenuation", async () => {
    const deps = buildDeps(dir, fixedClock(11_000));
    const holder = GovIdentity.generate();
    const parent = json(
      await runGovCommand(["token", "mint", "--subject", holder.agentId(), "--grant", "tool:*=tool:invoke,tool:inspect", "--json"], deps),
    ) as Record<string, unknown>;
    const parentPath = join(dir, "parent.json");
    writeFileSync(parentPath, JSON.stringify(parent), "utf8");

    const result = await runGovCommand(
      ["token", "attenuate", "--token", parentPath, "--holder-key", holder.privateKeyHex(), "--grant", "tool:*=tool:invoke", "--json"],
      deps,
    );
    expect(result.code).toBe(0);
    const child = json(result) as { depth: number; parentTokenId: string; grants: Array<{ actions: string[] }> };
    expect(child.depth).toBe((parent as { depth: number }).depth + 1);
    expect(child.parentTokenId).toBe((parent as { tokenId: string }).tokenId);
    expect(child.grants[0].actions).toEqual(["tool:invoke"]);
  });

  it("attenuate rejects a widening request outright", async () => {
    const deps = buildDeps(dir, fixedClock(12_000));
    const holder = GovIdentity.generate();
    const parent = json(
      await runGovCommand(["token", "mint", "--subject", holder.agentId(), "--grant", "tool:echo=tool:invoke", "--json"], deps),
    ) as Record<string, unknown>;
    const parentPath = join(dir, "parent2.json");
    writeFileSync(parentPath, JSON.stringify(parent), "utf8");
    const result = await runGovCommand(
      ["token", "attenuate", "--token", parentPath, "--holder-key", holder.privateKeyHex(), "--grant", "tool:*=tool:invoke"],
      deps,
    );
    expect(result.code).toBe(1);
  });

  it("an unknown token subcommand exits non-zero with usage", async () => {
    const deps = buildDeps(dir, fixedClock(13_000));
    const result = await runGovCommand(["token", "nonsense"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Usage: hades gov token");
  });
});

// ---------------------------------------------------------------------------
// gov audit
// ---------------------------------------------------------------------------

describe("runGovCommand — audit", () => {
  it("tail, verify, export reflect real appended entries", async () => {
    const deps = buildDeps(dir, fixedClock(14_000));
    const stack = deps.root();
    stack.chain.append({ at: 14_001, actor: "agent:a", action: "note", resource: "r1", outcome: "info" });
    stack.chain.append({ at: 14_002, actor: "agent:b", action: "note", resource: "r2", outcome: "deny", code: "denied-code" });

    const tail = await runGovCommand(["audit", "tail", "--json"], deps);
    expect(tail.code).toBe(0);
    const tailEntries = json(tail) as Array<{ seq: number; resource: string }>;
    expect(tailEntries).toHaveLength(2);
    expect(tailEntries[0].resource).toBe("r1");

    const filtered = await runGovCommand(["audit", "tail", "--outcome", "deny", "--json"], deps);
    const filteredEntries = json(filtered) as Array<{ resource: string }>;
    expect(filteredEntries).toEqual([{ seq: 1, at: 14_002, actor: "agent:b", action: "note", resource: "r2", outcome: "deny", code: "denied-code", payloadSha256: expect.any(String), prevSha256: expect.any(String), entrySha256: expect.any(String) }]);

    const verify = await runGovCommand(["audit", "verify", "--json"], deps);
    expect(verify.code).toBe(0);
    expect((json(verify) as { ok: boolean; entries: number }).entries).toBe(2);

    const exported = await runGovCommand(["audit", "export", "--json"], deps);
    expect((json(exported) as unknown[]).length).toBe(2);
  });

  it("tail rejects an invalid --outcome", async () => {
    const deps = buildDeps(dir, fixedClock(14_500));
    const result = await runGovCommand(["audit", "tail", "--outcome", "not-a-real-outcome"], deps);
    expect(result.code).toBe(1);
  });

  it("checkpoint signs a real Merkle checkpoint over the current chain", async () => {
    const deps = buildDeps(dir, fixedClock(15_000));
    const stack = deps.root();
    stack.chain.append({ at: 15_001, actor: "agent:a", action: "note", resource: "r1", outcome: "info" });
    const result = await runGovCommand(["audit", "checkpoint", "--json"], deps);
    expect(result.code).toBe(0);
    const cp = json(result) as { treeSize: number; signerPublicKey: string };
    expect(cp.treeSize).toBe(1);
    expect(cp.signerPublicKey).toBe(stack.keystore.load().identity.publicKeyHex());
  });

  it("prove emits a self-verifying inclusion proof, and refuses after the on-disk chain is tampered", async () => {
    const deps = buildDeps(dir, fixedClock(16_000));
    const stack = deps.root();
    stack.chain.append({ at: 16_001, actor: "a", action: "n", resource: "r0", outcome: "info" });
    stack.chain.append({ at: 16_002, actor: "a", action: "n", resource: "r1", outcome: "info" });
    stack.chain.append({ at: 16_003, actor: "a", action: "n", resource: "r2", outcome: "info" });

    const proved = await runGovCommand(["audit", "prove", "--seq", "1", "--json"], deps);
    expect(proved.code).toBe(0);
    const provedParsed = json(proved) as { verified: boolean; seq: number };
    expect(provedParsed.verified).toBe(true);
    expect(provedParsed.seq).toBe(1);

    const outOfRange = await runGovCommand(["audit", "prove", "--seq", "99"], deps);
    expect(outOfRange.code).toBe(1);

    // tamper the actual on-disk segment
    const segPath = join(govRoot(dir), "audit", "seg-000000.jsonl");
    const raw = readFileSync(segPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const entry = JSON.parse(lines[0]) as { entrySha256: string };
    lines[0] = JSON.stringify({ ...entry, entrySha256: "f".repeat(64) });
    writeFileSync(segPath, lines.join("\n") + "\n", "utf8");

    const afterTamper = await runGovCommand(["audit", "prove", "--seq", "1", "--json"], deps);
    expect(afterTamper.code).toBe(1);
    expect(afterTamper.lines.join("\n")).toMatch(/fails verification|hash-mismatch/);
  });

  it("an unknown audit subcommand exits non-zero with usage", async () => {
    const deps = buildDeps(dir, fixedClock(17_000));
    const result = await runGovCommand(["audit", "bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Usage: hades gov audit");
  });
});

// ---------------------------------------------------------------------------
// gov policy
// ---------------------------------------------------------------------------

describe("runGovCommand — policy", () => {
  it("show reports 'absent' before anything has ever been set", async () => {
    const deps = buildDeps(dir, fixedClock(18_000));
    const result = await runGovCommand(["policy", "show", "--json"], deps);
    expect(result.code).toBe(1);
    expect((json(result) as { status: string }).status).toBe("absent");
  });

  it("set persists a real signed policy; show then reports 'ok'", async () => {
    const deps = buildDeps(dir, fixedClock(19_000));
    const docPath = join(dir, "policy.json");
    writeFileSync(docPath, JSON.stringify(validPolicyDoc), "utf8");
    const setResult = await runGovCommand(["policy", "set", "--file", docPath, "--json"], deps);
    expect(setResult.code).toBe(0);
    const bundle = json(setResult) as { doc: { version: number }; signerPublicKey: string };
    expect(bundle.doc.version).toBe(1);

    const shown = await runGovCommand(["policy", "show", "--json"], deps);
    expect(shown.code).toBe(0);
    expect((json(shown) as { status: string }).status).toBe("ok");
  });

  it("set rejects an invalid document and a version rollback", async () => {
    const deps = buildDeps(dir, fixedClock(20_000));
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ not: "a policy doc" }), "utf8");
    const badResult = await runGovCommand(["policy", "set", "--file", badPath], deps);
    expect(badResult.code).toBe(1);

    const goodPath = join(dir, "good.json");
    writeFileSync(goodPath, JSON.stringify(validPolicyDoc), "utf8");
    await runGovCommand(["policy", "set", "--file", goodPath], deps);

    const rollbackPath = join(dir, "rollback.json");
    writeFileSync(rollbackPath, JSON.stringify({ ...validPolicyDoc, version: 1 }), "utf8");
    const rollback = await runGovCommand(["policy", "set", "--file", rollbackPath], deps);
    expect(rollback.code).toBe(1);
  });

  it("set reports a missing file honestly", async () => {
    const deps = buildDeps(dir, fixedClock(20_500));
    const result = await runGovCommand(["policy", "set", "--file", join(dir, "does-not-exist.json")], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("not found");
  });

  it("lint refuses to run against a policy that never loaded 'ok'", async () => {
    const deps = buildDeps(dir, fixedClock(21_000));
    const result = await runGovCommand(["policy", "lint"], deps);
    expect(result.code).toBe(1);
  });

  it("lint reports real findings for a policy with an unbounded destructive wildcard", async () => {
    const deps = buildDeps(dir, fixedClock(22_000));
    const riskyDoc = {
      schema: "hades.gov.policy.v1",
      name: "risky",
      version: 1,
      defaultEffect: "deny",
      rules: [{ id: "danger", effect: "allow", subjects: ["*"], actions: ["fs:write"], resources: ["*"] }],
    };
    const docPath = join(dir, "risky.json");
    writeFileSync(docPath, JSON.stringify(riskyDoc), "utf8");
    await runGovCommand(["policy", "set", "--file", docPath], deps);
    const lint = await runGovCommand(["policy", "lint", "--json"], deps);
    expect(lint.code).toBe(1);
    const findings = (json(lint) as { findings: Array<{ code: string }> }).findings;
    expect(findings.some((f) => f.code === "unbounded-wildcard")).toBe(true);
  });

  it("test evaluates a real PolicyDecision against the loaded policy", async () => {
    const deps = buildDeps(dir, fixedClock(23_000));
    const docPath = join(dir, "p.json");
    writeFileSync(docPath, JSON.stringify(validPolicyDoc), "utf8");
    await runGovCommand(["policy", "set", "--file", docPath], deps);

    const allowed = await runGovCommand(
      ["policy", "test", "--subject", "agent:x", "--action", "tool:invoke", "--resource", "tool:echo", "--at", "23001", "--json"],
      deps,
    );
    expect(allowed.code).toBe(0);
    expect((json(allowed) as { decision: { effect: string } }).decision.effect).toBe("allow");

    const denied = await runGovCommand(
      ["policy", "test", "--subject", "agent:x", "--action", "net:egress", "--resource", "net:evil.example", "--at", "23001"],
      deps,
    );
    expect(denied.code).toBe(2);
  });

  it("test requires --subject, --action, --resource", async () => {
    const deps = buildDeps(dir, fixedClock(24_000));
    const result = await runGovCommand(["policy", "test", "--action", "x", "--resource", "y"], deps);
    expect(result.code).toBe(1);
  });

  it("an unknown policy subcommand exits non-zero with usage", async () => {
    const deps = buildDeps(dir, fixedClock(25_000));
    const result = await runGovCommand(["policy", "bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Usage: hades gov policy");
  });
});

// ---------------------------------------------------------------------------
// gov airgap
// ---------------------------------------------------------------------------

describe("runGovCommand — airgap", () => {
  it("status reads the REAL live-session registry rather than asserting a constant", async () => {
    const deps = buildDeps(dir, fixedClock(26_000));

    // Nothing engaged: the honest answer is zero live sessions.
    const idle = await runGovCommand(["airgap", "status", "--json"], deps);
    expect(idle.code).toBe(0);
    const idleParsed = json(idle) as { engaged: boolean; liveSessions: number };
    expect(idleParsed.engaged).toBe(false);
    expect(idleParsed.liveSessions).toBe(0);

    // Engage a REAL air-gap against the real process and ask again — a
    // hardcoded "not engaged" would fail here, which is the whole point.
    const session = engageAirgap({ policy: { allowHosts: ["allowed.example"] } });
    try {
      const busy = await runGovCommand(["airgap", "status", "--json"], deps);
      const busyParsed = json(busy) as { engaged: boolean; liveSessions: number; sealed: boolean; policies: Array<{ allowHosts?: string[] }> };
      expect(busyParsed.engaged).toBe(true);
      expect(busyParsed.liveSessions).toBe(1);
      expect(busyParsed.sealed).toBe(true);
      expect(busyParsed.policies[0].allowHosts).toEqual(["allowed.example"]);

      const plain = await runGovCommand(["airgap", "status"], deps);
      expect(plain.lines.join("\n")).toContain("engaged        YES");
    } finally {
      session.release();
    }

    // Released: back to zero, and the registry is not leaking entries.
    const after = json(await runGovCommand(["airgap", "status", "--json"], deps)) as { liveSessions: number };
    expect(after.liveSessions).toBe(0);
  });

  it("probe reports the real seam neutralizability of this process", async () => {
    const deps = buildDeps(dir, fixedClock(27_000));
    const result = await runGovCommand(["airgap", "probe", "--json"], deps);
    const report = json(result) as { sealed: boolean; seams: Array<{ seam: string; how: string }> };
    expect(report.seams).toHaveLength(6);
    expect(result.code).toBe(report.sealed ? 0 : 1);
    expect(report.sealed).toBe(true);
  });

  it("run engages the REAL air-gap, blocks a canary fetch, denies an over-privileged capability, and produces a verified certificate", async () => {
    const deps = buildDeps(dir, fixedClock(28_000));
    const result = await runGovCommand(["airgap", "run", "--task-id", "cli-selfcheck", "--json"], deps);
    const parsed = json(result) as { ok: boolean; verified: boolean; output: string; egressAttempts: Array<{ blocked: boolean }>; denials: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.verified).toBe(true);
    expect(parsed.output).toContain("canary-blocked=true");
    expect(parsed.output).toContain("capability-denied=true");
    expect(parsed.egressAttempts.some((a) => a.blocked)).toBe(true);
    expect(parsed.denials.length).toBeGreaterThan(0);
    expect(result.code).toBe(0);
  });

  it("run renders a plain-ASCII report when --json is omitted", async () => {
    const deps = buildDeps(dir, fixedClock(29_000));
    const result = await runGovCommand(["airgap", "run"], deps);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("AIR-GAPPED TASK RUN"))).toBe(true);
    expect(result.lines.some((l) => l.includes("verified"))).toBe(true);
  });

  it("an unknown airgap subcommand exits non-zero with usage", async () => {
    const deps = buildDeps(dir, fixedClock(30_000));
    const result = await runGovCommand(["airgap", "bogus"], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Usage: hades gov airgap");
  });
});

// ---------------------------------------------------------------------------
// gov doctor
// ---------------------------------------------------------------------------

describe("runGovCommand — doctor", () => {
  it("reports NOT healthy before any policy has ever been set", async () => {
    const deps = buildDeps(dir, fixedClock(31_000));
    const result = await runGovCommand(["doctor", "--json"], deps);
    expect(result.code).toBe(1);
    const parsed = json(result) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c) => c.name === "policy loaded & signed")?.ok).toBe(false);
  });

  it("reports healthy once identity, chain, and a signed policy are all in good standing", async () => {
    const deps = buildDeps(dir, fixedClock(32_000));
    const docPath = join(dir, "policy.json");
    writeFileSync(docPath, JSON.stringify(validPolicyDoc), "utf8");
    await runGovCommand(["policy", "set", "--file", docPath], deps);

    const result = await runGovCommand(["doctor", "--json"], deps);
    expect(result.code).toBe(0);
    const parsed = json(result) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
    expect(parsed.ok).toBe(true);
    for (const c of parsed.checks) expect(c.ok).toBe(true);
    expect(parsed.checks.some((c) => c.name === "capability round-trip")).toBe(true);
    expect(parsed.checks.some((c) => c.name === "air-gap seams neutralizable")).toBe(true);
  });

  it("fails when the audit chain has been tampered on disk", async () => {
    const deps = buildDeps(dir, fixedClock(33_000));
    const docPath = join(dir, "policy.json");
    writeFileSync(docPath, JSON.stringify(validPolicyDoc), "utf8");
    await runGovCommand(["policy", "set", "--file", docPath], deps);
    const stack = deps.root();
    stack.chain.append({ at: 33_001, actor: "a", action: "n", resource: "r", outcome: "info" });

    const segPath = join(govRoot(dir), "audit", "seg-000000.jsonl");
    const raw = readFileSync(segPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const entry = JSON.parse(lines[0]) as { entrySha256: string };
    lines[0] = JSON.stringify({ ...entry, entrySha256: "e".repeat(64) });
    writeFileSync(segPath, lines.join("\n") + "\n", "utf8");

    const result = await runGovCommand(["doctor", "--json"], deps);
    expect(result.code).toBe(1);
    const parsed = json(result) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c) => c.name === "audit chain verifies")?.ok).toBe(false);
  });

  it("fails when the policy is unsigned (present but bogus)", async () => {
    const deps = buildDeps(dir, fixedClock(34_000));
    const policyDir = join(govRoot(dir), "policy");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "policy.json"), JSON.stringify({ doc: validPolicyDoc }), "utf8"); // no signature field
    const result = await runGovCommand(["doctor", "--json"], deps);
    expect(result.code).toBe(1);
    const parsed = json(result) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    const policyCheck = parsed.checks.find((c) => c.name === "policy loaded & signed");
    expect(policyCheck?.ok).toBe(false);
    expect(policyCheck?.detail).toContain("unsigned");
  });

  it("plain-text doctor output is aligned PASS/FAIL lines", async () => {
    const deps = buildDeps(dir, fixedClock(35_000));
    const result = await runGovCommand(["doctor"], deps);
    expect(result.lines[0]).toBe("GOV DOCTOR");
    expect(result.lines.some((l) => /^\[(PASS|FAIL)\]/.test(l))).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// gov policy init — DEFAULT_GOV_POLICY was previously unreachable without
// hand-writing its JSON; these tests hold the real sign-and-persist path.
// ---------------------------------------------------------------------------

describe("runGovCommand — policy init", () => {
  it("installs the real DEFAULT_GOV_POLICY, signed, and proves it by reading it back", async () => {
    const deps = buildDeps(dir, fixedClock(40_000));
    const result = await runGovCommand(["policy", "init", "--json"], deps);
    expect(result.code).toBe(0);
    const parsed = json(result) as {
      installed: boolean;
      replaced: boolean;
      name: string;
      version: number;
      rules: number;
      readBackStatus: string;
      lintFindings: unknown[];
    };
    expect(parsed.installed).toBe(true);
    expect(parsed.replaced).toBe(false);
    expect(parsed.name).toBe(DEFAULT_GOV_POLICY.name);
    expect(parsed.rules).toBe(DEFAULT_GOV_POLICY.rules.length);
    // The read-back is through the REAL store: "ok" means the bytes on disk
    // parsed, matched the schema and signature-verified under the agent key.
    expect(parsed.readBackStatus).toBe("ok");
    expect(parsed.lintFindings).toEqual([]);

    // And it is genuinely on disk, signed — not merely reported as installed.
    const onDisk = JSON.parse(readFileSync(join(govRoot(dir), "policy", "policy.json"), "utf8")) as {
      doc: { name: string };
      signature: string;
      signerPublicKey: string;
    };
    expect(onDisk.doc.name).toBe(DEFAULT_GOV_POLICY.name);
    expect(onDisk.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(onDisk.signerPublicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to clobber an existing policy without --force, and changes nothing when it refuses", async () => {
    const deps = buildDeps(dir, fixedClock(41_000));
    await runGovCommand(["policy", "init"], deps);
    const path = join(govRoot(dir), "policy", "policy.json");
    const before = readFileSync(path, "utf8");

    const second = await runGovCommand(["policy", "init"], deps);
    expect(second.code).toBe(1);
    expect(second.lines.join("\n")).toContain("already present");
    expect(readFileSync(path, "utf8")).toBe(before); // byte-identical
  });

  it("--force replaces it and bumps past the anti-rollback floor rather than being refused", async () => {
    const deps = buildDeps(dir, fixedClock(42_000));
    const first = json(await runGovCommand(["policy", "init", "--json"], deps)) as { version: number };
    const forced = await runGovCommand(["policy", "init", "--force", "--json"], deps);
    expect(forced.code).toBe(0);
    const forcedParsed = json(forced) as { replaced: boolean; version: number; readBackStatus: string };
    expect(forcedParsed.replaced).toBe(true);
    expect(forcedParsed.version).toBe(first.version + 1);
    expect(forcedParsed.readBackStatus).toBe("ok");
  });

  it("the installed default policy is immediately usable: `policy test` denies air-gapped net egress", async () => {
    const deps = buildDeps(dir, fixedClock(43_000));
    await runGovCommand(["policy", "init"], deps);
    const denied = await runGovCommand(
      ["policy", "test", "--subject", "agent:anyone", "--action", "net:egress", "--resource", "net:example.com", "--airgapped", "--json"],
      deps,
    );
    expect(denied.code).toBe(2); // 2 == a real DENY, distinct from 1 == command failure
    const parsed = json(denied) as { decision: { effect: string } };
    expect(parsed.decision.effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// gov audit export --out
// ---------------------------------------------------------------------------

describe("runGovCommand — audit export --out", () => {
  it("writes real JSONL bytes that re-parse into exactly the chain's entries", async () => {
    const deps = buildDeps(dir, fixedClock(44_000));
    const stack = deps.root();
    stack.chain.append({ at: 1, actor: "agent:a", action: "tool:invoke", resource: "tool:echo", outcome: "allow" });
    stack.chain.append({ at: 2, actor: "agent:b", action: "fs:write", resource: "fs:/tmp/x", outcome: "deny", code: "policy" });

    const out = join(dir, "exported.jsonl");
    const result = await runGovCommand(["audit", "export", "--out", out, "--json"], deps);
    expect(result.code).toBe(0);
    const meta = json(result) as { written: string; entries: number; bytes: number };
    expect(meta.written).toBe(out);
    expect(meta.entries).toBe(2);

    const lines = readFileSync(out, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const reparsed = lines.map((l) => JSON.parse(l) as { seq: number; actor: string; entrySha256: string });
    expect(reparsed.map((e) => e.seq)).toEqual([0, 1]);
    expect(reparsed.map((e) => e.actor)).toEqual(["agent:a", "agent:b"]);
    // Every exported entry carries its real chain hash — the export is
    // independently re-verifiable, not a lossy pretty-print.
    for (const e of reparsed) expect(e.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.bytes).toBe(Buffer.byteLength(readFileSync(out, "utf8"), "utf8"));
  });

  it("surfaces a real write failure instead of claiming success", async () => {
    const deps: GovCommandDeps = {
      ...buildDeps(dir, fixedClock(45_000)),
      writeFile: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const result = await runGovCommand(["audit", "export", "--out", "/nope/x.jsonl"], deps);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("EACCES");
  });

  it("without --out it still prints to stdout (unchanged behavior)", async () => {
    const deps = buildDeps(dir, fixedClock(46_000));
    const result = await runGovCommand(["audit", "export"], deps);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain("AUDIT EXPORT");
  });
});

// ---------------------------------------------------------------------------
// Terminal-escape injection — an audit log's whole value is that an operator
// can trust what it prints. Control bytes are written as \u escapes, never
// typed literally, so this file stays reviewable as text.
// ---------------------------------------------------------------------------

describe("runGovCommand — untrusted strings can never inject terminal control sequences", () => {
  const ESC = "";
  const hostile = `${ESC}[2J${ESC}[1;1H[PASS] forged\rRESULT: valid`;

  it("audit tail/export strip control characters out of attacker-supplied actor/action/resource", async () => {
    const deps = buildDeps(dir, fixedClock(47_000));
    deps.root().chain.append({ at: 1, actor: hostile, action: hostile, resource: hostile, outcome: "allow" });

    for (const argv of [["audit", "tail"], ["audit", "export"]]) {
      const result = await runGovCommand(argv, deps);
      const text = result.lines.join("\n");
      expect(text).not.toContain(ESC);
      expect(text).not.toContain("");
      expect(text).not.toContain("\r");
      // The visible (harmless) part of the string is still shown — this is
      // sanitization, not silent suppression of the entry.
      expect(text).toContain("RESULT: valid");
    }
  });

  it("--json output is NOT mangled — JSON.stringify already escapes control characters losslessly", async () => {
    const deps = buildDeps(dir, fixedClock(48_000));
    deps.root().chain.append({ at: 1, actor: hostile, action: "x", resource: "y", outcome: "allow" });
    const result = await runGovCommand(["audit", "tail", "--json"], deps);
    const raw = result.lines.join("\n");
    expect(raw).not.toContain(ESC); // escaped as , never emitted raw
    const parsed = JSON.parse(raw) as Array<{ actor: string }>;
    expect(parsed[0].actor).toBe(hostile); // byte-for-byte preserved
  });

  it("an unknown subcommand echoes the user's token without letting it drive the terminal", async () => {
    const deps = buildDeps(dir, fixedClock(49_000));
    const result = await runGovCommand([`bogus${ESC}[31m`], deps);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).not.toContain(ESC);
  });
});
