/**
 * Central-integration tests for `../swarm-session.ts`: the PRODUCT wiring of
 * `swarm_run_verified` to the real inline engine. No scripted engine fakes —
 * `realSwarmSessionFactory` builds a genuine `SwarmManager` via
 * `createInlineSwarm` (default deterministic planner + demo executor, no LLM,
 * no network), and the tool is exercised end-to-end over a real
 * `McpServer`/`McpClient` loopback pair.
 */
import { describe, expect, it } from "vitest";
import { McpServer, loopbackTransportPair } from "../server";
import { McpClient } from "../client";
import {
  realSwarmSessionFactory,
  registerSwarmTaskTool,
  registerCertifiedSwarmTool,
  adaptSwarmManager,
  mergeGateWithBridge,
} from "../swarm-session";
import { VerificationGate, type GateConfig } from "../../../swarm-runtime/verification/gate";
import type { VerifiedSwarmResult } from "../swarm-task-tool";
import { verifyHandoffAtBoundary, type CertifiedHandoff } from "../cert-handoff";
import { CertificateAuthority, generatePrivateKeyHex } from "../../styx/certificate";
import { createInlineSwarm } from "../../../swarm-runtime/factory";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((c) => c.type === "text");
  if (!item?.text) throw new Error("tool returned no text content");
  return item.text;
}

describe("registerSwarmTaskTool + realSwarmSessionFactory (real engine)", () => {
  it("advertises swarm_run_verified over tools/list and runs a genuinely verified goal", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    const registered = registerSwarmTaskTool(server, realSwarmSessionFactory(), {
      defaultTimeoutMs: 30_000,
    });
    expect(registered.name).toBe("swarm_run_verified");
    server.serve();

    const client = new McpClient(pair.client);
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("swarm_run_verified");

    const result = await client.callTool("swarm_run_verified", {
      objective: "summarize the release notes",
      poolSize: 2,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(firstText(result)) as VerifiedSwarmResult;
    expect(parsed.status).toBe("verified");
    expect(parsed.goalId).not.toBe("");
    expect(parsed.tasks.length).toBeGreaterThan(0);
    expect(parsed.certificates.length).toBeGreaterThan(0);
    // Every certificate is the gate's own verbatim report: accept verdicts only
    // on a clean verified run, and each maps back to a real task id.
    const taskIds = new Set(parsed.tasks.map((t) => t.id));
    for (const v of parsed.verifications) {
      expect(v.verdict).toBe("accept");
      expect(taskIds.has(v.taskId)).toBe(true);
    }
  }, 30_000);

  it("input validation rejects before the engine is ever built", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    registerSwarmTaskTool(server); // default real factory
    server.serve();

    const client = new McpClient(pair.client);
    await client.initialize();
    const result = await client.callTool("swarm_run_verified", { objective: "", poolSize: 0 });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("invalid input");
  });

  it("registerCertifiedSwarmTool advertises swarm_run_certified and a real run's handoff re-verifies at the boundary", async () => {
    const pair = loopbackTransportPair();
    const server = new McpServer(pair.server);
    const authority = new CertificateAuthority(generatePrivateKeyHex());
    const registered = registerCertifiedSwarmTool(server, authority, realSwarmSessionFactory(), {
      defaultTimeoutMs: 30_000,
    });
    expect(registered.name).toBe("swarm_run_certified");
    server.serve();

    const client = new McpClient(pair.client);
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("swarm_run_certified");

    const result = await client.callTool("swarm_run_certified", {
      objective: "summarize the release notes",
      poolSize: 2,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(firstText(result)) as VerifiedSwarmResult & { handoff: CertifiedHandoff };
    expect(parsed.status).toBe("verified");
    expect(parsed.handoff).toBeDefined();
    // The gate's own outcome, honestly encoded: accept, only because the run
    // really was fully verified.
    expect(parsed.handoff.certificate.payload.verifierTier).toBe("mcp-handoff:accept");
    // Independent boundary re-verification with the REAL ed25519 check.
    const verdict = await verifyHandoffAtBoundary(parsed.handoff);
    expect(verdict).toEqual({ ok: true, reasons: [] });
    // And a tampered copy fails it.
    const tampered = JSON.parse(JSON.stringify(parsed.handoff)) as CertifiedHandoff;
    tampered.resultText += " (tampered)";
    const tamperedVerdict = await verifyHandoffAtBoundary(tampered);
    expect(tamperedVerdict.ok).toBe(false);
  }, 30_000);

  it("adaptSwarmManager drives a live manager through the port surface", async () => {
    const manager = await createInlineSwarm({ poolSize: 1 });
    const port = adaptSwarmManager(manager);
    try {
      await port.start();
      const completed = new Promise<void>((resolve) => {
        port.manager.on("goal:completed", () => resolve());
      });
      const dispatched = (await port.manager.dispatchGoal("check the port adaptation")) as {
        goalId: string;
      };
      expect(typeof dispatched.goalId).toBe("string");
      expect(dispatched.goalId.length).toBeGreaterThan(0);
      await completed;
    } finally {
      await port.stop();
    }
  }, 30_000);
});

/**
 * The gate a host gets when it configures the session factory.
 *
 * Losing correctness checking must never be a SIDE EFFECT of configuring
 * something else. The first spelling of this wiring spread the default gate
 * before `...base`, so `realSwarmSessionFactory({ gate: { acceptThreshold: 0.9 } })`
 * — a host tuning one number — silently dropped the STYX bridge entirely.
 */
describe("mergeGateWithBridge", () => {
  it("keeps the bridge when a host sets an unrelated gate field", () => {
    const merged = mergeGateWithBridge({ acceptThreshold: 0.9 });
    expect(merged).not.toBeInstanceOf(VerificationGate);
    const cfg = merged as GateConfig;
    expect(cfg.acceptThreshold).toBe(0.9); // the host's value wins
    expect(cfg.externalVerifier).toBeDefined(); // and the bridge survives
  });

  it("wires the bridge when the host configured no gate at all", () => {
    expect((mergeGateWithBridge(undefined) as GateConfig).externalVerifier).toBeDefined();
  });

  it("lets a host replace the oracle outright — an explicit choice, not a side effect", () => {
    const mine = { verify: async () => ({ passed: true, abstained: true, tier: "t", reasons: ["r"] }) };
    expect((mergeGateWithBridge({ externalVerifier: mine }) as GateConfig).externalVerifier).toBe(mine);
  });

  it("honours a fully-constructed VerificationGate as-is — there is no field to merge into", () => {
    const gate = new VerificationGate({ acceptThreshold: 0.5 });
    expect(mergeGateWithBridge(gate)).toBe(gate);
  });
});
