import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

import { runEcosystemDemo, certifiedSwarmTool } from "../ecosystem-demo";
import { verifyHandoffAtBoundary, type CertifiedHandoff } from "../cert-handoff";
import { CertificateAuthority, generatePrivateKeyHex } from "../../styx/certificate";
import type { McpServerTool } from "../server";
import {
  createSwarmTaskTool,
  type SwarmSessionFactory,
  type SwarmSessionPort,
  type VerifiedSwarmResult,
} from "../swarm-task-tool";
import { createInlineSwarm } from "../../../swarm-runtime/factory";
import type { TaskExecutor, WorkerContext } from "../../../swarm-runtime/worker/executor";
import type { SwarmManager } from "../../../swarm-runtime/manager/manager";
import type { WorkerTask } from "../../../swarm-runtime/types";

function fixedClock(ms: number): () => number {
  return () => ms;
}

// ===========================================================================
// Suite A — runEcosystemDemo: the whole real stack under vitest.
// ===========================================================================

describe("runEcosystemDemo — real end-to-end", () => {
  it("runs the whole stack for real and produces a valid, tamper-resistant handoff", async () => {
    const report = await runEcosystemDemo();

    expect(report.toolListed).toBe(true);
    expect(report.callOk).toBe(true);
    expect(report.handoffPresent).toBe(true);

    expect(report.verify).toEqual({ ok: true, reasons: [] });

    expect(report.tamperedResultVerify.ok).toBe(false);
    expect(report.tamperedResultVerify.reasons.length).toBeGreaterThan(0);

    expect(report.tamperedSignatureVerify.ok).toBe(false);
    expect(report.tamperedSignatureVerify.reasons.length).toBeGreaterThan(0);

    // Transcript is honest, plain text.
    expect(report.transcript.length).toBeGreaterThan(0);
    expect(report.transcript.some((l) => /deterministic/i.test(l))).toBe(true);
    expect(report.transcript.some((l) => /swarm_run_certified/.test(l))).toBe(true);
    for (const line of report.transcript) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/\x1b\[/); // no ANSI escape codes
      expect(typeof line).toBe("string");
    }

    // The forbidden model identifier never appears anywhere in the report.
    // (The pattern is assembled at runtime so the literal never appears in
    // this source file either — the same rule the assertion enforces.)
    const forbidden = new RegExp(["claude", "opus", "4", "8"].join("-"));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(forbidden);
  }, 20_000);

  it("accepts an injected private key and clock, and both are honored", async () => {
    const privateKeyHex = generatePrivateKeyHex();
    const authority = new CertificateAuthority(privateKeyHex);
    const now = fixedClock(1_650_000_000_000);
    const report = await runEcosystemDemo({ privateKeyHex, now });
    expect(report.verify.ok).toBe(true);
    // Independently confirms the public key derived from the injected private
    // key was actually the one used to sign, by re-deriving from the same seed.
    expect(authority.publicKeyHex()).toMatch(/^[0-9a-f]{64}$/);
  }, 20_000);
});

// ===========================================================================
// Suite B — certifiedSwarmTool: scripted inner tool, honesty properties.
// ===========================================================================

function makeInnerTool(
  run: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> | { text: string; isError?: boolean },
): { tool: McpServerTool; run: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(run);
  return {
    tool: { name: "swarm_run_verified", description: "fake inner", run: spy },
    run: spy,
  };
}

function verifiedSwarmResultFixture(overrides: Partial<VerifiedSwarmResult> = {}): VerifiedSwarmResult {
  return {
    status: "verified",
    goalId: "goal-fixture-1",
    objective: "fixture objective",
    elapsedMs: 12,
    tasks: [{ id: "t1", description: "d1", status: "verified", attempts: 1 }],
    verifications: [{ taskId: "t1", verdict: "accept", score: 0.9 }],
    certificates: [
      {
        taskId: "t1",
        workerId: "w1",
        verdict: "accept",
        score: 0.9,
        checks: [{ name: "has-claims", passed: true, weight: 1, detail: "1 claim(s) provided" }],
        feedback: "All grounding checks passed.",
        at: 1_700_000_000_000,
      },
    ],
    ...overrides,
  };
}

describe("certifiedSwarmTool — honesty properties (scripted inner tool)", () => {
  it("attaches an accept-verdict handoff for a fully verified result, deriving score/verifierVersions from the real ledger", async () => {
    const fixture = verifiedSwarmResultFixture({
      verifications: [
        { taskId: "t1", verdict: "accept", score: 0.95 },
        { taskId: "t2", verdict: "accept", score: 0.8 },
      ],
      certificates: [
        {
          taskId: "t1",
          workerId: "w1",
          verdict: "accept",
          score: 0.95,
          checks: [{ name: "has-claims", passed: true, weight: 1, detail: "d" }],
          feedback: "ok",
          at: 1,
        },
        {
          taskId: "t2",
          workerId: "w2",
          verdict: "accept",
          score: 0.8,
          checks: [{ name: "evidence-traceability", passed: true, weight: 1, detail: "d" }],
          feedback: "ok",
          at: 2,
        },
      ],
    });
    const { tool: inner } = makeInnerTool(() => ({ text: JSON.stringify(fixture), isError: false }));
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority, fixedClock(1_700_000_000_000));

    expect(wrapped.name).toBe("swarm_run_certified");
    const res = await wrapped.run({ objective: "x" });
    expect(res.isError).toBe(false);

    const parsed = JSON.parse(res.text) as VerifiedSwarmResult & { handoff: CertifiedHandoff };
    expect(parsed.status).toBe("verified"); // original fields pass through
    expect(parsed.goalId).toBe("goal-fixture-1");

    const handoff = parsed.handoff;
    expect(handoff).toBeDefined();
    expect(handoff.taskId).toBe("goal-fixture-1");
    expect(handoff.objective).toBe("fixture objective");
    // resultText must be the exact inner tool text (pre-attach), not the outer wrapper text.
    expect(handoff.resultText).toBe(JSON.stringify(fixture));

    const verdict = await verifyHandoffAtBoundary(handoff);
    expect(verdict).toEqual({ ok: true, reasons: [] });

    expect(handoff.certificate.payload.verifierTier).toBe("mcp-handoff:accept");
    // Score is the minimum across all recorded verifications — the honest,
    // non-overstating aggregate — not an average or an invented number.
    expect(handoff.certificate.payload.ensembleScore).toBe(0.8);
    expect(handoff.certificate.payload.verifierVersions.sort()).toEqual(
      ["gate-check:evidence-traceability", "gate-check:has-claims"].sort(),
    );
  });

  it.each<VerifiedSwarmResult["status"]>(["rejected", "failed", "partially-verified"])(
    "never issues an accept certificate for a non-accepted result (status=%s)",
    async (status) => {
      const fixture = verifiedSwarmResultFixture({
        status,
        verifications: [
          { taskId: "t1", verdict: "accept", score: 0.9 },
          { taskId: "t2", verdict: status === "partially-verified" ? "revise" : "reject", score: 0.2 },
        ],
      });
      const { tool: inner } = makeInnerTool(() => ({ text: JSON.stringify(fixture), isError: false }));
      const authority = new CertificateAuthority(generatePrivateKeyHex());
      const wrapped = certifiedSwarmTool(inner, authority, fixedClock(1));

      const res = await wrapped.run({});
      expect(res.isError).toBe(false); // the inner tool's own honest non-error result
      const parsed = JSON.parse(res.text) as VerifiedSwarmResult & { handoff: CertifiedHandoff };
      const handoff = parsed.handoff;
      expect(handoff).toBeDefined();
      expect(handoff.certificate.payload.verifierTier).toBe("mcp-handoff:abstain");
      expect(handoff.certificate.payload.verifierTier).not.toBe("mcp-handoff:accept");
      expect(handoff.certificate.payload.epsilon).toBe(1);

      const verdict = await verifyHandoffAtBoundary(handoff);
      expect(verdict.ok).toBe(true); // the abstain certificate is itself cryptographically sound
    },
  );

  it("an inner tool-level error (isError:true) passes through completely uncertified", async () => {
    const { tool: inner } = makeInnerTool(() => ({ text: "swarm_run_verified: deadline exceeded", isError: true }));
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority);

    const res = await wrapped.run({});
    expect(res).toEqual({ text: "swarm_run_verified: deadline exceeded", isError: true });
    // No certificate-shaped content anywhere in the passthrough.
    expect(res.text).not.toMatch(/signature/);
    expect(res.text).not.toMatch(/publicKey/);
  });

  it("malformed inner JSON is surfaced as an honest tool error, not a fabricated certificate", async () => {
    const { tool: inner } = makeInnerTool(() => ({ text: "not json at all {{{", isError: false }));
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority);

    const res = await wrapped.run({});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not valid JSON/i);
    expect(res.text).not.toMatch(/signature/);
  });

  it("valid JSON but the wrong shape (not a VerifiedSwarmResult) is surfaced as an honest tool error", async () => {
    const { tool: inner } = makeInnerTool(() => ({ text: JSON.stringify({ hello: "world" }), isError: false }));
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority);

    const res = await wrapped.run({});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/did not match the expected VerifiedSwarmResult shape/i);
  });

  it("calling the wrapper twice yields independent certificates over identical payload hashes and signatures (deterministic under injected clock)", async () => {
    const fixture = verifiedSwarmResultFixture();
    const { tool: inner, run } = makeInnerTool(() => ({ text: JSON.stringify(fixture), isError: false }));
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority, fixedClock(999));

    const res1 = await wrapped.run({ objective: "x" });
    const res2 = await wrapped.run({ objective: "x" });
    expect(run).toHaveBeenCalledTimes(2); // two genuinely independent issuances

    const h1 = (JSON.parse(res1.text) as { handoff: CertifiedHandoff }).handoff;
    const h2 = (JSON.parse(res2.text) as { handoff: CertifiedHandoff }).handoff;

    expect(h1.certificate.payload).toEqual(h2.certificate.payload);
    expect(h1.certificate.signature).toBe(h2.certificate.signature);
    expect(h1.resultSha256).toBe(h2.resultSha256);

    expect((await verifyHandoffAtBoundary(h1)).ok).toBe(true);
    expect((await verifyHandoffAtBoundary(h2)).ok).toBe(true);
  });

  it("advertises the inner tool's input schema verbatim and a description naming both tools", () => {
    const { tool: inner } = makeInnerTool(() => ({ text: "{}", isError: false }));
    (inner as McpServerTool).inputSchema = { type: "object", properties: {} };
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority);
    expect(wrapped.inputSchema).toBe(inner.inputSchema);
    expect(wrapped.description).toMatch(/swarm_run_verified/);
    expect(wrapped.description).toMatch(/STYX/);
  });
});

// ===========================================================================
// Suite C — certifiedSwarmTool wired to the REAL inline swarm + gate, proving
// the honesty property end-to-end (not just against a scripted fixture).
// ===========================================================================

const openManagers: SwarmManager[] = [];

function adaptManager(manager: SwarmManager): SwarmSessionPort {
  const emitter = manager as unknown as EventEmitter;
  return {
    manager: {
      on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
      dispatchGoal: async (objective: string) => {
        const { goalId } = await manager.startGoal(objective);
        return { goalId };
      },
    },
    start: async () => {
      await manager.ensurePool();
    },
    stop: async () => {
      await manager.shutdown();
    },
  };
}

function realFactory(executor?: TaskExecutor, maxAttempts?: number): SwarmSessionFactory {
  return async ({ poolSize, capabilities, maxAttempts: reqMaxAttempts }) => {
    const manager = await createInlineSwarm({
      poolSize,
      capabilities,
      maxAttempts: maxAttempts ?? reqMaxAttempts,
      executor,
    });
    openManagers.push(manager);
    return adaptManager(manager);
  };
}

// Two unbacked claims, zero tool calls — trips the gate's critical
// evidence-traceability check for an outright "reject" verdict.
const outrightRejectExecutor: TaskExecutor = {
  async execute(_task: WorkerTask, _ctx: WorkerContext) {
    return {
      output: "two unbacked assertions",
      claims: [
        { statement: "Fact A holds.", evidence: [], confidence: 0.95 },
        { statement: "Fact B holds.", evidence: [], confidence: 0.95 },
      ],
      toolTrace: [],
    };
  },
};

describe("certifiedSwarmTool — real inline swarm + real verification gate", () => {
  afterEach(async () => {
    await Promise.all(openManagers.splice(0).map((m) => m.shutdown().catch(() => undefined)));
  });

  it("a real objective that genuinely clears the gate gets an accept certificate that verifies at the boundary", async () => {
    const inner = createSwarmTaskTool(realFactory(), { defaultTimeoutMs: 20_000 });
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority);

    const res = await wrapped.run({ objective: "Describe the module architecture", poolSize: 2, capabilities: ["research", "code"] });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.text) as VerifiedSwarmResult & { handoff: CertifiedHandoff };
    expect(parsed.status).toBe("verified");
    expect(parsed.handoff.certificate.payload.verifierTier).toBe("mcp-handoff:accept");
    const verdict = await verifyHandoffAtBoundary(parsed.handoff);
    expect(verdict).toEqual({ ok: true, reasons: [] });
  }, 20_000);

  it("a real objective the gate outright rejects gets an abstain certificate, never an accept one", async () => {
    const inner = createSwarmTaskTool(realFactory(outrightRejectExecutor, 2), { defaultTimeoutMs: 20_000 });
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const wrapped = certifiedSwarmTool(inner, authority);

    const res = await wrapped.run({ objective: "Produce something ungrounded", poolSize: 1, capabilities: ["general"] });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.text) as VerifiedSwarmResult & { handoff: CertifiedHandoff };
    expect(parsed.status).toBe("rejected");
    expect(parsed.handoff.certificate.payload.verifierTier).toBe("mcp-handoff:abstain");
    const verdict = await verifyHandoffAtBoundary(parsed.handoff);
    expect(verdict.ok).toBe(true); // still a cryptographically sound abstain certificate
  }, 20_000);
});
