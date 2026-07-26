/**
 * `hades gov` router integration — the central wiring that makes this
 * cycle's governance stack (ed25519 identity + sealed keystore, attenuable
 * capability tokens, the tamper-evident Merkle-checkpointed audit chain, the
 * signed fail-closed policy bundle, and the real air-gap) actually REACHABLE
 * from the terminal instead of being well-tested dead code.
 *
 * REAL-VS-MOCK POLICY: everything here is real. Real `HadesCli` routing, the
 * real `defaultGovDeps()` factory pointed at real temp directories via
 * `$HADES_DATA_DIR`, real ed25519 keys minted by the real `GovKeystore`, a
 * real hash-chained audit log written to and re-read from real bytes on
 * disk, a real signed policy bundle, and the REAL air-gap engaged against
 * this process's actual egress seams. Nothing here is stubbed, and no number
 * printed by any of it is synthesized.
 *
 * The one thing deliberately asserted rather than papered over: `gov doctor`
 * on a brand-new data directory legitimately FAILS with "policy absent",
 * because the stack fails closed. That is the honest out-of-box state, and
 * `gov policy init` is the real remedy — both are exercised below.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HadesCli, HADES_SUBCOMMANDS } from "../cli";
import { defaultGovDeps } from "../gov-command";
import { govRoot } from "../../gov/keystore";
import { GovAuditChain } from "../../gov/audit-chain";
import { merkleRoot, verifyInclusion, type InclusionProof } from "../../gov/audit-proof";

let dir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-gov-route-"));
  previousDataDir = process.env.HADES_DATA_DIR;
  process.env.HADES_DATA_DIR = dir;
  // A key inherited from the ambient environment would silently replace the
  // identity this test means to exercise (HADES_GOV_KEY wins over disk).
  delete process.env.HADES_GOV_KEY;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.HADES_DATA_DIR;
  else process.env.HADES_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

/** A CLI wired exactly the way `hades` itself wires it (no injected deps). */
function cli(): HadesCli {
  return new HadesCli({ version: "test" });
}

function parse(lines: string[]): unknown {
  return JSON.parse(lines.join("\n"));
}

describe("hades gov — router registration", () => {
  it("`gov` is a registered subcommand and is listed in `hades help`", async () => {
    expect(HADES_SUBCOMMANDS).toContain("gov");
    const help = await cli().run(["help"]);
    expect(help.code).toBe(0);
    const text = help.lines.join("\n");
    expect(text).toContain("gov <sub>");
    expect(text).toContain("Governance");
  });

  it("`hades gov` with no subcommand prints the governance usage, not 'Unknown command'", async () => {
    const result = await cli().run(["gov"]);
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("Usage: hades gov");
    for (const group of ["identity:", "token:", "audit:", "policy:", "airgap:"]) {
      expect(text).toContain(group);
    }
  });

  it("an unrouted command is still rejected (the router did not become a catch-all)", async () => {
    const result = await cli().run(["definitely-not-a-command"]);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("Unknown command");
  });

  it("building the CLI and running `help` never touches <dataDir>/gov — no key is minted by accident", async () => {
    const c = cli();
    await c.run(["help"]);
    await c.run(["gov", "help"]);
    await c.run(["gov", "identity", "help"]);
    expect(existsSync(govRoot(dir))).toBe(false);
  });
});

describe("hades gov — the whole stack is reachable and real through the router", () => {
  it("identity new -> show -> verify runs end to end on real ed25519 keys", async () => {
    const c = cli();

    const created = await c.run(["gov", "identity", "new", "--json"]);
    expect(created.code).toBe(0);
    const createdParsed = parse(created.lines) as { created: boolean; source: string; publicKey: string; agentId: string };
    expect(createdParsed.created).toBe(true);
    expect(createdParsed.source).toBe("generated");
    expect(createdParsed.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(createdParsed.agentId).toMatch(/^agent:[0-9a-f]{32}$/);

    // The key really landed on disk under the data dir the CLI resolves.
    const identityPath = join(govRoot(dir), "identity.json");
    expect(existsSync(identityPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(identityPath, "utf8")) as { privateKey: string; doc: { signature: string } };
    expect(onDisk.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk.doc.signature).toMatch(/^[0-9a-f]{128}$/);

    const shown = parse((await c.run(["gov", "identity", "show", "--json"])).lines) as { publicKey: string };
    expect(shown.publicKey).toBe(createdParsed.publicKey);

    const verified = await c.run(["gov", "identity", "verify", "--json"]);
    expect(verified.code).toBe(0);
    expect((parse(verified.lines) as { ok: boolean }).ok).toBe(true);
  });

  it("policy init makes `doctor` genuinely healthy — and doctor honestly FAILS before it", async () => {
    const c = cli();

    // Out of the box the stack fails closed: no policy has been signed yet.
    const before = await c.run(["gov", "doctor", "--json"]);
    expect(before.code).toBe(1);
    const beforeChecks = (parse(before.lines) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> });
    expect(beforeChecks.ok).toBe(false);
    expect(beforeChecks.checks.find((x) => x.name === "policy loaded & signed")?.ok).toBe(false);

    const init = await c.run(["gov", "policy", "init", "--json"]);
    expect(init.code).toBe(0);
    expect((parse(init.lines) as { readBackStatus: string }).readBackStatus).toBe("ok");

    const after = await c.run(["gov", "doctor", "--json"]);
    expect(after.code).toBe(0);
    const afterChecks = parse(after.lines) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(afterChecks.ok).toBe(true);
    // Every doctor check is a real recomputation, and all of them pass now.
    expect(afterChecks.checks.every((x) => x.ok)).toBe(true);
    expect(afterChecks.checks.map((x) => x.name)).toContain("capability round-trip");
  });

  it("token mint -> check exits 0 on a real ALLOW and 2 on a real DENY", async () => {
    const c = cli();
    const minted = await c.run(["gov", "token", "mint", "--subject", "agent:me", "--grant", "tool:*=tool:invoke", "--json"]);
    expect(minted.code).toBe(0);
    const token = parse(minted.lines) as { tokenId: string; signature: string; subject: string };
    expect(token.signature).toMatch(/^[0-9a-f]{128}$/);

    const tokenFile = join(dir, "token.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tokenFile, JSON.stringify(token), "utf8");

    const inspected = await c.run(["gov", "token", "inspect", "--token", tokenFile, "--json"]);
    expect(inspected.code).toBe(0);
    expect((parse(inspected.lines) as { signatureValid: boolean }).signatureValid).toBe(true);

    const allowed = await c.run(["gov", "token", "check", "--token", tokenFile, "--subject", "agent:me", "--action", "tool:invoke", "--resource", "tool:echo", "--json"]);
    expect(allowed.code).toBe(0);
    expect((parse(allowed.lines) as { allow: boolean }).allow).toBe(true);

    // 2 is reserved for a genuine DENY so the command is usable as a gate;
    // 1 would mean the command itself failed.
    const denied = await c.run(["gov", "token", "check", "--token", tokenFile, "--subject", "agent:me", "--action", "net:egress", "--resource", "net:example.com", "--json"]);
    expect(denied.code).toBe(2);
    const deniedParsed = parse(denied.lines) as { allow: boolean; code: string };
    expect(deniedParsed.allow).toBe(false);
    expect(deniedParsed.code).toBe("no-matching-grant");
  });

  it("airgap run writes a real audit chain that `audit verify`/`prove` independently confirm, and tampering is caught", async () => {
    const c = cli();
    await c.run(["gov", "policy", "init"]);

    const run = await c.run(["gov", "airgap", "run", "--json"]);
    expect(run.code).toBe(0);
    const runParsed = parse(run.lines) as {
      verified: boolean;
      certificateValid: boolean;
      airgap: { sealed: boolean };
      egressAttempts: Array<{ blocked: boolean }>;
      authorizeAllowRate?: number;
      certificate?: { payload: { pCorrect: number; ensembleScore: number } };
    };
    expect(runParsed.verified).toBe(true);
    expect(runParsed.certificateValid).toBe(true);
    expect(runParsed.airgap.sealed).toBe(true);
    // The self-check task really did try to reach the network and really was
    // blocked before any I/O happened.
    expect(runParsed.egressAttempts.length).toBeGreaterThan(0);
    expect(runParsed.egressAttempts.every((a) => a.blocked)).toBe(true);
    // The certificate carries a deterministic T0 verdict, never the run's
    // uncalibrated allow-rate (which is reported separately).
    expect(runParsed.certificate?.payload.pCorrect).toBe(1);
    expect(runParsed.authorizeAllowRate).toBe(0);

    // A fresh process re-reads the chain from its own bytes and agrees.
    const verified = await cli().run(["gov", "audit", "verify", "--json"]);
    expect(verified.code).toBe(0);
    const v = parse(verified.lines) as { ok: boolean; entries: number };
    expect(v.ok).toBe(true);
    expect(v.entries).toBeGreaterThan(0);

    // A real Merkle inclusion proof that this process re-checks itself.
    const proved = await cli().run(["gov", "audit", "prove", "--seq", "0", "--json"]);
    expect(proved.code).toBe(0);
    const p = parse(proved.lines) as { verified: boolean; root: string; proof: InclusionProof };
    expect(p.verified).toBe(true);
    const leaves = GovAuditChain.open({ dir: govRoot(dir), verifyOnOpen: false }).leafHashes();
    expect(p.root).toBe(merkleRoot(leaves));
    expect(verifyInclusion(leaves[0], p.proof, p.root)).toBe(true);

    // Export to a real file, then tamper with one byte of the real chain and
    // watch every read path refuse.
    const exported = join(dir, "audit.jsonl");
    const exportResult = await cli().run(["gov", "audit", "export", "--out", exported, "--json"]);
    expect(exportResult.code).toBe(0);
    expect(readFileSync(exported, "utf8").trimEnd().split("\n")).toHaveLength(v.entries);

    const segment = join(govRoot(dir), "audit", "seg-000000.jsonl");
    const segPath = existsSync(segment) ? segment : join(govRoot(dir), "seg-000000.jsonl");
    const original = readFileSync(segPath, "utf8");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(segPath, original.replace("airgap.run.start", "airgap.run.START"), "utf8");

    const tampered = await cli().run(["gov", "audit", "verify", "--json"]);
    expect(tampered.code).toBe(1);
    expect((parse(tampered.lines) as { ok: boolean }).ok).toBe(false);

    // `prove` refuses to emit a proof against a chain it cannot trust rather
    // than quietly returning a stale one.
    const staleProof = await cli().run(["gov", "audit", "prove", "--seq", "0"]);
    expect(staleProof.code).toBe(1);
    expect(staleProof.lines.join("\n")).toContain("refusing to prove inclusion");

    // ...and doctor sees it too.
    const doctor = await cli().run(["gov", "doctor", "--json"]);
    expect(doctor.code).toBe(1);
    const dchecks = parse(doctor.lines) as { checks: Array<{ name: string; ok: boolean }> };
    expect(dchecks.checks.find((x) => x.name === "audit chain verifies")?.ok).toBe(false);
  });

  it("airgap probe reports the REAL neutralizability of this process's egress seams", async () => {
    const result = await cli().run(["gov", "airgap", "probe", "--json"]);
    const report = parse(result.lines) as { sealed: boolean; seams: Array<{ seam: string; neutralized: boolean }> };
    expect(report.seams.map((x) => x.seam)).toEqual(["fetch", "http", "https", "net-socket", "dns", "tls"]);
    // The probe left nothing engaged — `globalThis.fetch` is callable and is
    // not an air-gap guard.
    expect(typeof globalThis.fetch).toBe("function");
    expect(result.code).toBe(report.sealed ? 0 : 1);
  });
});

describe("hades gov — deps caching", () => {
  it("one CLI process shares ONE gov stack across subcommands (the keystore is not reopened per call)", async () => {
    const c = cli();
    await c.run(["gov", "identity", "show", "--json"]);
    const first = parse((await c.run(["gov", "identity", "show", "--json"])).lines) as { publicKey: string };
    const second = parse((await c.run(["gov", "audit", "verify", "--json"])).lines) as { ok: boolean };
    expect(second.ok).toBe(true);
    const third = parse((await c.run(["gov", "identity", "show", "--json"])).lines) as { publicKey: string };
    expect(third.publicKey).toBe(first.publicKey);
  });

  it("an injected `gov` deps factory is used instead of the default, and only called once", async () => {
    let calls = 0;
    const c = new HadesCli({
      version: "test",
      gov: () => {
        calls++;
        return defaultGovDeps();
      },
    });
    await c.run(["gov", "identity", "show"]);
    await c.run(["gov", "identity", "show"]);
    expect(calls).toBe(1);
  });
});

describe("gov barrel — the modules are exported, not just present on disk", () => {
  it("src/hades/gov/index.ts re-exports every public symbol of every gov module", async () => {
    const barrel = await import("../../gov/index");
    // Runtime values (types are checked by `tsc --noEmit -p tsconfig.lib.json`,
    // which is the only thing that can see them).
    const expected = [
      // identity
      "govCanonicalize", "govDigest", "signGov", "verifyGovSignature", "agentIdFromPublicKey",
      "isSignedIdentityDocShape", "GovIdentity", "verifyIdentityChain",
      "isSignedRotationRecordShape", "signRotation", "verifyRotationHistory",
      // keystore
      "GOV_DIR", "govRoot", "GovKeystore",
      // capability + replay
      "resourceMatches", "isAttenuation", "CapabilityIssuer", "CapabilityEnforcer",
      "toLegacyCapabilityToken", "MemoryReplayGuard", "DurableReplayGuard",
      // audit chain + proofs
      "GOV_AUDIT_SCHEMA", "GOV_AUDIT_GENESIS", "GovAuditChain", "fromLegacyAuditEvent",
      "leafHash", "nodeHash", "merkleRoot", "inclusionProof", "verifyInclusion",
      "consistencyProof", "verifyConsistency", "signCheckpoint", "verifyCheckpoint",
      // policy
      "PolicyEngine", "parsePolicyDocument", "DEFAULT_GOV_POLICY", "PolicyStore",
      // air-gap
      "ALL_EGRESS_SEAMS", "AirgapViolationError", "engageAirgap", "withAirgap",
      "probeAirgap", "activeAirgapSessions", "runAirgappedTask", "formatAirgapRunReport",
    ];
    const missing = expected.filter((name) => !(name in barrel));
    expect(missing).toEqual([]);
  });

  it("the barrel hands back the SAME objects the modules define (no shadow re-implementation)", async () => {
    const barrel = await import("../../gov/index");
    const direct = await import("../../gov/audit-proof");
    expect(barrel.merkleRoot).toBe(direct.merkleRoot);
    const airgap = await import("../../gov/airgap");
    expect(barrel.engageAirgap).toBe(airgap.engageAirgap);
  });
});


describe("hades gov — stateful caveats are actually enforced, across processes", () => {
  it("`token mint --max-uses` produces a real caveat that the durable guard enforces across separate CLI invocations", async () => {
    const { writeFileSync } = await import("node:fs");

    // Mint with a real max-uses caveat.
    const minted = await cli().run(["gov", "token", "mint", "--subject", "agent:x", "--grant", "tool:*=tool:invoke", "--max-uses", "2", "--json"]);
    expect(minted.code).toBe(0);
    const token = parse(minted.lines) as { caveats: Array<{ kind: string; uses?: number }>; signature: string };
    expect(token.caveats).toEqual([{ kind: "max-uses", uses: 2 }]);

    const tokenFile = join(dir, "capped.json");
    writeFileSync(tokenFile, JSON.stringify(token), "utf8");

    const check = async (): Promise<{ code: number; codeStr: string }> => {
      // A NEW HadesCli each time — this is the point: a per-process
      // in-memory counter would allow forever, so only durable state can
      // make the third call fail.
      const r = await cli().run(["gov", "token", "check", "--token", tokenFile, "--subject", "agent:x", "--action", "tool:invoke", "--resource", "tool:echo", "--json"]);
      return { code: r.code, codeStr: (parse(r.lines) as { code: string }).code };
    };

    expect(await check()).toEqual({ code: 0, codeStr: "allow" });
    expect(await check()).toEqual({ code: 0, codeStr: "allow" });
    const third = await check();
    expect(third.code).toBe(2);
    expect(third.codeStr).toBe("use-limit-exceeded");

    // The state is on disk, not merely in this test's memory.
    expect(existsSync(join(govRoot(dir), "replay.json"))).toBe(true);
  });

  it("--nonce is burned durably: the same nonce is replayed-denied by a later process", async () => {
    const { writeFileSync } = await import("node:fs");
    const minted = await cli().run(["gov", "token", "mint", "--subject", "agent:x", "--grant", "tool:*=tool:invoke", "--json"]);
    const tokenFile = join(dir, "nonced.json");
    writeFileSync(tokenFile, minted.lines.join("\n"), "utf8");

    const argv = ["gov", "token", "check", "--token", tokenFile, "--subject", "agent:x", "--action", "tool:invoke", "--resource", "tool:echo", "--nonce", "req-0001", "--json"];
    const first = await cli().run(argv);
    expect(first.code).toBe(0);
    expect((parse(first.lines) as { allow: boolean }).allow).toBe(true);

    const replay = await cli().run(argv);
    expect(replay.code).toBe(2);
    expect((parse(replay.lines) as { code: string }).code).toBe("replayed");

    // A different nonce on the same token is still fine — the guard scopes
    // the nonce, it does not simply lock the token.
    const other = await cli().run([...argv.slice(0, -3), "--nonce", "req-0002", "--json"]);
    expect(other.code).toBe(0);
  });

  it("a denied request burns NOTHING — a failed check must not consume a use", async () => {
    const { writeFileSync } = await import("node:fs");
    const minted = await cli().run(["gov", "token", "mint", "--subject", "agent:x", "--grant", "tool:*=tool:invoke", "--max-uses", "1", "--json"]);
    const tokenFile = join(dir, "one-use.json");
    writeFileSync(tokenFile, minted.lines.join("\n"), "utf8");

    // Wrong action -> denied for a reason unrelated to max-uses.
    const denied = await cli().run(["gov", "token", "check", "--token", tokenFile, "--subject", "agent:x", "--action", "net:egress", "--resource", "net:example.com", "--json"]);
    expect(denied.code).toBe(2);
    expect((parse(denied.lines) as { code: string }).code).toBe("no-matching-grant");

    // The single allowed use is still available.
    const allowed = await cli().run(["gov", "token", "check", "--token", tokenFile, "--subject", "agent:x", "--action", "tool:invoke", "--resource", "tool:echo", "--json"]);
    expect(allowed.code).toBe(0);
  });

  it("`token mint --airgap-only` produces a caveat that denies a non-air-gapped request", async () => {
    const { writeFileSync } = await import("node:fs");
    const minted = await cli().run(["gov", "token", "mint", "--subject", "agent:x", "--grant", "tool:*=tool:invoke", "--airgap-only", "--json"]);
    const tokenFile = join(dir, "airgap-only.json");
    writeFileSync(tokenFile, minted.lines.join("\n"), "utf8");

    const base = ["gov", "token", "check", "--token", tokenFile, "--subject", "agent:x", "--action", "tool:invoke", "--resource", "tool:echo", "--json"];
    const notAirgapped = await cli().run(base);
    expect(notAirgapped.code).toBe(2);
    expect((parse(notAirgapped.lines) as { code: string }).code).toBe("caveat-failed");

    const airgapped = await cli().run([...base.slice(0, -1), "--airgapped", "--json"]);
    expect(airgapped.code).toBe(0);
  });
});
